import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createPublicClient, decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, formatEther, formatUnits, keccak256, parseAbi, parseEther, parseUnits, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import { reliableHttp } from "../rpc-http";
import { explorerLiquidityNativePayout } from "../liquidity-payouts";
import { mapLiquidityBounded } from "../liquidity-concurrency";
import { DELTA_LIQUIDITY as A, liquidityDraftSchema, newLiquidityDraft, liquidityOwnerAllowed, liquidityWalletAllowed } from "../liquidity-workflow";
import { liquidityRpc, liquidityReferencePrice } from "../liquidity-markets";
import { assertLiquidityOwnership, deltaLiquidityAbi, liquidityPoolId, liquidityPoolKey, liquidityReadAbi, prepareLiquidityClaim, prepareLiquidityClose, prepareLiquidityOpen, type LiquidityLeg, type LiquidityTransaction } from "../liquidity-contracts";
import { fundLiquidityBands, liquidityAmounts, liquidityBands, liquidityMarketCapBands, liquiditySqrtTick, liquidityTickAtSqrt } from "../liquidity-math";
import { formatLiquidityMarketCap } from "../liquidity-market-cap";
import { ethUsdPrice } from "./pricing";
import { prepareSigned, prepareUnsigned, signPreparedEnvelope, quoteLiquidityPurchase, quoteLiquidityUsdgToEth, tokenValueAtBlock } from "./service";
import { planLiquidityFunding, type LiquidityAssetRequirement } from "../liquidity-funding";
import { estimateResilientAutomationFees, transactionMaximumCost } from "./gas";
import { quoteDetails } from "../token-market-cap";
import type { LiquidityQuotePlan } from "../liquidity-quote";
import { liquidityClaimPositionSchema, liquidityMarketCapRangeSchema } from "../liquidity-quote";
import { liquidityExecutionWindowOpen } from "../liquidity-recovery";
import { LIQUIDITY_CALLDATA_DEADLINE_MS, LIQUIDITY_MINIMUM_QUOTE_LIFETIME_MS, LIQUIDITY_QUOTE_EXECUTION_ALLOWANCE_MS } from "../liquidity-timing";
export type { LiquidityQuotePlan } from "../liquidity-quote";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const leg = z.object({ tokenId: z.string().regex(/^[1-9]\d*$/), tickLower: z.number().int(), tickUpper: z.number().int(), liquidity: z.string().regex(/^\d+$/) }).strict();
const accessFields = { ownerXUserId: z.string().regex(/^[1-9]\d{0,31}$/), source: z.enum(["x", "terminal"]).default("x") };
function validateAccess(input: { ownerXUserId: string; source: "x" | "terminal"; walletRef: string; expectedFrom?: string }, ctx: z.RefinementCtx) {
  if (!liquidityOwnerAllowed(input.ownerXUserId, input.source) || !liquidityWalletAllowed(input.ownerXUserId, input.walletRef)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "LP access denied", path: ["ownerXUserId"] });
  }
}
export const liquiditySignerRequest = z.object({
  ...accessFields, expectedFrom: address, walletRef: address,
  draft: liquidityDraftSchema, legs: z.array(leg).max(100).default([]),
  claimPositions: z.array(liquidityClaimPositionSchema).min(1).max(20).optional(),
}).strict().superRefine(validateAccess);
export type LiquidityFundingCheck = {
  sufficient: boolean; requiredUsd: number; availableUsd: number;
  missing?: "ETH" | "USDG" | "POSITION_ASSET" | "FUNDING";
};
export function assessLiquidityFunding(input: {
  requiredUsd: number; ethUsd: number; usdgUsd: number; positionAssetUsd?: number;
  pair?: "ETH" | "USDG";
}): LiquidityFundingCheck {
  const values = [input.requiredUsd, input.ethUsd, input.usdgUsd];
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error("LP_FUNDING_CHECK_UNAVAILABLE");
  // An unavailable non-zero position-token value must fail open. Exact quote
  // construction will make the authoritative determination later.
  if (input.positionAssetUsd === undefined) return { sufficient: true, requiredUsd: input.requiredUsd, availableUsd: input.ethUsd + input.usdgUsd };
  if (!Number.isFinite(input.positionAssetUsd) || input.positionAssetUsd < 0) throw new Error("LP_FUNDING_CHECK_UNAVAILABLE");
  const availableUsd = input.ethUsd + input.usdgUsd + input.positionAssetUsd;
  const sufficient = availableUsd + 0.000001 >= input.requiredUsd;
  return {
    sufficient, requiredUsd: input.requiredUsd, availableUsd,
    ...(sufficient ? {} : { missing: input.pair === "USDG" ? "USDG" as const : input.pair === "ETH" ? "ETH" as const : "FUNDING" as const }),
  };
}
async function liquidityUsdgUsdPrice(client: ReturnType<typeof liquidityRpc>, blockNumber: bigint, ethUsd: number) {
  const pool = await client.readContract({ address: A.v3Factory, abi: liquidityReadAbi, functionName: "getPool", args: [A.weth, A.usdg, 100], blockNumber });
  if (pool === zeroAddress) throw new Error("USDG reference pool unavailable");
  const [slot, liquidity] = await Promise.all([
    client.readContract({ address: pool, abi: liquidityReadAbi, functionName: "slot0", blockNumber }),
    client.readContract({ address: pool, abi: liquidityReadAbi, functionName: "liquidity", blockNumber }),
  ]);
  const usdgPerEth = (Number(slot[0]) / 2 ** 96) ** 2 * 10 ** 12;
  if (liquidity <= 0n || !Number.isFinite(usdgPerEth) || usdgPerEth <= 0) throw new Error("USDG reference price unavailable");
  return ethUsd / usdgPerEth;
}

/** New pools have no spot price to cross-check. Require independent live
 * sources to agree before choosing the irreversible initialization price. */
export function liquidityPriceConsensus(values: Array<number | null | undefined>, tolerance = .2) {
  const valid = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (valid.length < 2) throw new Error("LP_NEW_POOL_PRICE_UNVERIFIED");
  if (valid.at(-1)! / valid[0] - 1 > tolerance) throw new Error("LP_REFERENCE_PRICE_DISAGREEMENT");
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

export function liquidityPriceConsensusBySource(values: Array<{ source: "pons_onchain" | "robinhood_reference" | "delta_market"; value: number | null | undefined }>, tolerance = .2) {
  const independent = new Map<string, number>();
  for (const item of values) if (item.value !== null && item.value !== undefined && Number.isFinite(item.value) && item.value > 0 && !independent.has(item.source)) independent.set(item.source, item.value);
  return liquidityPriceConsensus([...independent.values()], tolerance);
}

let liquidityStatusModule: Promise<typeof import("./liquidity-status")> | undefined;
async function claimableLiquidityFees(raw: unknown): Promise<true | false | "unknown"> {
  try {
    const { inspectLiquidityPosition } = await (liquidityStatusModule ??= import("./liquidity-status"));
    const status = await inspectLiquidityPosition(raw);
    return status.assets.some(asset => asset.unclaimed !== null && Number(asset.unclaimed) > 0);
  } catch {
    // A failed advisory fee read must not incorrectly claim that fees are zero.
    // The authoritative simulation and receipt checks still run below.
    return "unknown";
  }
}

/** Conservative budget gate. It never signs, simulates or prepares a write.
 * If position-token pricing is unavailable while the wallet holds that token,
 * it fails open so an advisory check cannot reject a potentially funded user.
 */
export async function checkLiquidityFunding(raw: unknown): Promise<LiquidityFundingCheck> {
  const input = liquiditySignerRequest.parse(raw), d = input.draft, f = d.fields;
  if (input.walletRef.toLowerCase() !== input.expectedFrom.toLowerCase()) throw new Error("Wallet mismatch");
  if (d.operation !== "open" || !d.tokenAddress || !f.amount || !f.unit) throw new Error("LP_FUNDING_CHECK_INCOMPLETE");
  const owner = input.expectedFrom.toLowerCase() as Address, token = d.tokenAddress.toLowerCase() as Address;
  const c = liquidityRpc(), block = await c.getBlock();
  const [ethBalance, usdgBalance, tokenBalance, tokenDecimals, ethUsd] = await Promise.all([
    c.getBalance({ address: owner, blockNumber: block.number }),
    c.readContract({ address: A.usdg, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: block.number }),
    token === A.usdg
      ? c.readContract({ address: A.usdg, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: block.number })
      : token === A.weth ? Promise.resolve(0n)
        : c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: block.number }),
    token === A.usdg ? Promise.resolve(6) : token === A.weth ? Promise.resolve(18)
      : c.readContract({ address: token, abi: erc20Abi, functionName: "decimals", blockNumber: block.number }),
    ethUsdPrice(),
  ]);
  const usdgUsd = await liquidityUsdgUsdPrice(c, block.number, ethUsd);
  const requiredUsd = Number(f.amount) * (f.unit === "eth" ? ethUsd : 1);
  const ethValue = Number(formatEther(ethBalance)) * ethUsd;
  const usdgValue = Number(formatUnits(usdgBalance, 6)) * usdgUsd;
  let positionAssetUsd: number | undefined = token === A.weth ? 0 : token === A.usdg ? 0 : 0;
  if (tokenBalance > 0n && token !== A.weth && token !== A.usdg) {
    const amount = formatUnits(tokenBalance, tokenDecimals);
    positionAssetUsd = await tokenValueAtBlock(token, amount, block.number.toString()).then(value => value.usdValue)
      .catch(async () => Number(amount) * (await quoteDetails(c, token)).usd)
      .catch(() => undefined);
  }
  return assessLiquidityFunding({ requiredUsd, ethUsd: ethValue, usdgUsd: usdgValue, positionAssetUsd, pair: f.pair });
}
const quoteSchema = z.object({ owner: address, token: address, symbol: z.string().max(32), version: z.union([z.literal(3), z.literal(4)]), poolId: z.string(), operation: z.string(), quoteId: z.string(), expiresAt: z.number(), executionDeadline: z.number(),
  calls: z.array(z.object({ to: address, data: z.string().regex(/^0x[a-fA-F0-9]*$/), value: z.string().regex(/^\d+$/), purpose: z.string() }).strict()).min(1).max(32), summary: z.array(z.string()), proof: z.string(), priorLegs: z.array(leg),
  requestedBudgetUsd: z.number().finite().positive().optional(), minimumFillBps: z.number().int().min(9000).max(10000).optional(), slippageBps: z.number().int().min(0).max(1000).optional(),
  bandWeights: z.array(z.number().int().min(1).max(100)).min(1).max(20).optional(),
  expectedDepositUsd: z.number().finite().positive().optional(), expectedFillBps: z.number().int().min(1).max(10000).optional(), partialReprice: z.boolean().optional(),
  claimPositions: z.array(liquidityClaimPositionSchema).min(1).max(20).optional(),
  marketCapRange: liquidityMarketCapRangeSchema.optional(),
}).strict();
function proof(plan: Omit<LiquidityQuotePlan, "proof">) {
  const secret = process.env.LIQUIDITY_QUOTE_SIGNING_SECRET; if (!secret || secret.length < 32 || secret === process.env.WALLET_SIGNER_TOKEN) throw new Error("LP_QUOTE_SIGNING_NOT_CONFIGURED");
  return createHmac("sha256", secret).update(`liquidity-quote-v1:${JSON.stringify(plan)}`).digest("hex");
}
function checkQuote(raw: unknown): LiquidityQuotePlan {
  const parsed = quoteSchema.parse(raw), { proof: supplied, ...body } = parsed;
  const expected = proof(body as Omit<LiquidityQuotePlan, "proof">);
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new Error("Invalid liquidity quote");
  return parsed as LiquidityQuotePlan;
}
const liquidityRefreshOpenSchema = z.object({
  ...accessFields, expectedFrom: address, walletRef: address, plan: quoteSchema,
  step: z.number().int().nonnegative(),
  confirmedTransactions: z.array(z.string().regex(/^0x[a-fA-F0-9]{64}$/)).max(31),
}).strict().superRefine(validateAccess);

/** Rebuild only the final Delta open at the latest confirmed pool price.
 * Every earlier transaction is receipt-verified against the signed plan. The
 * same pool, ticks, weights, budget, slippage and deadline remain binding.
 */
export async function refreshLiquidityOpen(raw: unknown): Promise<LiquidityQuotePlan> {
  const input = liquidityRefreshOpenSchema.parse(raw), plan = checkQuote(input.plan);
  if (input.walletRef.toLowerCase() !== input.expectedFrom.toLowerCase() || input.expectedFrom.toLowerCase() !== plan.owner.toLowerCase()
    || plan.operation !== "open" || input.step !== plan.calls.length - 1 || plan.calls[input.step]?.purpose !== "open"
    || input.confirmedTransactions.length !== input.step || !plan.requestedBudgetUsd || !plan.minimumFillBps
    || plan.slippageBps === undefined || plan.bandWeights?.length === undefined
    || Date.now() >= plan.executionDeadline - 15_000) throw new Error("LP_OPEN_REFRESH_NOT_ALLOWED");
  const c = liquidityRpc(), owner = plan.owner as Address;
  for (const [index, hash] of input.confirmedTransactions.entries()) {
    const [receipt, transaction] = await Promise.all([
      c.getTransactionReceipt({ hash: hash as Hex }), c.getTransaction({ hash: hash as Hex }),
    ]);
    const expected = plan.calls[index];
    if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()
      || transaction.from.toLowerCase() !== owner || transaction.to?.toLowerCase() !== expected.to.toLowerCase()
      || transaction.input.toLowerCase() !== expected.data.toLowerCase() || transaction.value !== BigInt(expected.value))
      throw new Error("LP_REFRESH_PREREQUISITE_MISMATCH");
  }
  const final = plan.calls.at(-1)!, decoded = decodeFunctionData({ abi: deltaLiquidityAbi, data: final.data });
  if (decoded.functionName !== "openV3" && decoded.functionName !== "openV4") throw new Error("LP_OPEN_REFRESH_NOT_ALLOWED");
  const originalBands = decoded.args[1];
  if (originalBands.length !== plan.bandWeights.length) throw new Error("LP_OPEN_REFRESH_NOT_ALLOWED");
  const block = await c.getBlock();
  let key: ReturnType<typeof liquidityPoolKey>, pool: Address | Hex, sqrt: bigint;
  if (decoded.functionName === "openV4") {
    key = decoded.args[0]; pool = liquidityPoolId(key);
    if (pool.toLowerCase() !== plan.poolId.toLowerCase()) throw new Error("LP_POSITION_SETTINGS_CONFLICT");
    sqrt = (await c.readContract({ address: A.v4View, abi: liquidityReadAbi, functionName: "getSlot0", args: [pool], blockNumber: block.number }))[0];
  } else {
    pool = decoded.args[0];
    if (pool.toLowerCase() !== plan.poolId.toLowerCase()) throw new Error("LP_POSITION_SETTINGS_CONFLICT");
    const [currency0, currency1, fee, tickSpacing, slot] = await Promise.all([
      c.readContract({ address: pool, abi: liquidityReadAbi, functionName: "token0", blockNumber: block.number }),
      c.readContract({ address: pool, abi: liquidityReadAbi, functionName: "token1", blockNumber: block.number }),
      c.readContract({ address: pool, abi: liquidityReadAbi, functionName: "fee", blockNumber: block.number }),
      c.readContract({ address: pool, abi: liquidityReadAbi, functionName: "tickSpacing", blockNumber: block.number }),
      c.readContract({ address: pool, abi: liquidityReadAbi, functionName: "slot0", blockNumber: block.number }),
    ]);
    key = { currency0, currency1, fee, tickSpacing, hooks: zeroAddress }; sqrt = slot[0];
  }
  if (sqrt <= 0n || (plan.version === 4 && liquidityPoolId(key) !== plan.poolId.toLowerCase())) throw new Error("LP_POOL_UNAVAILABLE");
  const token = plan.token as Address, tokenIs0 = key.currency0.toLowerCase() === token;
  if (!tokenIs0 && key.currency1.toLowerCase() !== token) throw new Error("LP_POSITION_SETTINGS_CONFLICT");
  const quote = tokenIs0 ? key.currency1 : key.currency0;
  const pair = quote === zeroAddress || quote.toLowerCase() === A.weth ? "ETH" : quote.toLowerCase() === A.usdg ? "USDG" : null;
  if (!pair) throw new Error("LP_POSITION_SETTINGS_CONFLICT");
  const [tokenDecimals, ethUsd] = await Promise.all([
    c.readContract({ address: token, abi: erc20Abi, functionName: "decimals", blockNumber: block.number }), ethUsdPrice(),
  ]);
  const quoteDecimals = pair === "ETH" ? 18 : 6;
  const usdgUsd = async () => {
    const reference = await c.readContract({ address: A.v3Factory, abi: liquidityReadAbi, functionName: "getPool", args: [A.weth, A.usdg, 100], blockNumber: block.number });
    if (reference === zeroAddress) throw new Error("USDG reference pool unavailable");
    const [slot, active] = await Promise.all([
      c.readContract({ address: reference, abi: liquidityReadAbi, functionName: "slot0", blockNumber: block.number }),
      c.readContract({ address: reference, abi: liquidityReadAbi, functionName: "liquidity", blockNumber: block.number }),
    ]);
    const perEth = (Number(slot[0]) / 2 ** 96) ** 2 * 1e12;
    if (active <= 0n || !Number.isFinite(perEth) || perEth <= 0) throw new Error("USDG reference price unavailable");
    return ethUsd / perEth;
  };
  const quoteUsd = pair === "ETH" ? ethUsd : await usdgUsd();
  const decimals0 = tokenIs0 ? tokenDecimals : quoteDecimals, decimals1 = tokenIs0 ? quoteDecimals : tokenDecimals;
  const rawRatio = (Number(sqrt) / 2 ** 96) ** 2 * 10 ** (decimals0 - decimals1);
  const tokenUsd = (tokenIs0 ? rawRatio : 1 / rawRatio) * quoteUsd;
  if (![quoteUsd, tokenUsd].every(value => Number.isFinite(value) && value > 0)) throw new Error("LP_REFERENCE_PRICE_DISAGREEMENT");
  const externalTokenUsd = await tokenValueAtBlock(token, "1", block.number.toString()).then(value => value.usdValue)
    .catch(async () => (await quoteDetails(c, token)).usd).catch(() => tokenUsd);
  if (!Number.isFinite(externalTokenUsd) || externalTokenUsd <= 0 || Math.abs(Math.log(tokenUsd / externalTokenUsd)) > Math.log(1.2)) throw new Error("LP_REFERENCE_PRICE_DISAGREEMENT");
  const bands = originalBands.map((band, index) => ({ tickLower: band.tickLower, tickUpper: band.tickUpper, weight: plan.bandWeights![index] }));
  const samples = bands.map(band => liquidityAmounts(10n ** 18n * BigInt(band.weight), band.tickLower, band.tickUpper, sqrt));
  const sample0 = samples.reduce((sum, amount) => sum + amount[0], 0n), sample1 = samples.reduce((sum, amount) => sum + amount[1], 0n);
  const usd0 = tokenIs0 ? tokenUsd : quoteUsd, usd1 = tokenIs0 ? quoteUsd : tokenUsd;
  const value0 = Number(formatUnits(sample0, decimals0)) * usd0, value1 = Number(formatUnits(sample1, decimals1)) * usd1;
  if (!(value0 + value1 > 0)) throw new Error("LP_OPEN_REFRESH_NOT_ALLOWED");
  const target0 = parseUnits((plan.requestedBudgetUsd * value0 / (value0 + value1) / usd0).toFixed(Math.min(decimals0, 18)), decimals0);
  const target1 = parseUnits((plan.requestedBudgetUsd * value1 / (value0 + value1) / usd1).toFixed(Math.min(decimals1, 18)), decimals1);
  const capacity = async (asset: Address, target: bigint) => {
    if (asset === zeroAddress) {
      const balance = await c.getBalance({ address: owner, blockNumber: block.number }), reserve = parseEther("0.002");
      return balance > reserve ? target < balance - reserve ? target : balance - reserve : 0n;
    }
    const [balance, allowance] = await Promise.all([
      c.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: block.number }),
      c.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [owner, A.manager], blockNumber: block.number }),
    ]);
    return [target, balance, allowance].reduce((minimum, value) => value < minimum ? value : minimum);
  };
  const [maximum0, maximum1] = await Promise.all([capacity(key.currency0, target0), capacity(key.currency1, target1)]);
  const rungs = fundLiquidityBands(bands, sqrt, maximum0, maximum1, plan.version === 4 ? plan.slippageBps : 0);
  const actual0 = rungs.reduce((sum, rung) => sum + rung.amount0, 0n), actual1 = rungs.reduce((sum, rung) => sum + rung.amount1, 0n);
  const depositedUsd = Number(formatUnits(actual0, decimals0)) * usd0 + Number(formatUnits(actual1, decimals1)) * usd1;
  const fillBps = Math.floor(depositedUsd / plan.requestedBudgetUsd * 10_000);
  // A fast market can leave the wallet with the wrong asset ratio after its
  // funding swaps. As the final recovery only, preserve every chosen band and
  // weight, scale them all together to the limiting asset, and leave the
  // surplus untouched. Never open dust just to report success.
  const partialReprice = fillBps < plan.minimumFillBps;
  if (!Number.isFinite(fillBps) || fillBps <= 0 || partialReprice && (fillBps < 1000 || depositedUsd < 10)) throw new Error(`LP_REPRICE_UNDERFILLED:${fillBps}`);
  const tick = liquidityTickAtSqrt(sqrt), guard = Math.ceil(Math.log(1 + plan.slippageBps / 10_000) / Math.log(1.0001));
  const deadline = decoded.functionName === "openV4" ? decoded.args[2] : decoded.args[4];
  const refreshedCall = prepareLiquidityOpen({ version: plan.version, pool: plan.poolId as Address, key, bands: rungs, deadline,
    minimumTick: tick - guard, maximumTick: tick + guard, slippageBps: plan.slippageBps });
  await c.call({ account: owner, to: refreshedCall.to, data: refreshedCall.data, value: BigInt(refreshedCall.value), blockNumber: block.number });
  const body = { ...plan };
  Reflect.deleteProperty(body, "proof");
  const unsigned = { ...body, quoteId: keccak256(stringToHex(`${plan.quoteId}:${block.number}:${refreshedCall.data}`)), calls: [...plan.calls.slice(0, -1), refreshedCall],
    expectedDepositUsd: depositedUsd, expectedFillBps: Math.min(10_000, fillBps), partialReprice };
  const canonical = quoteSchema.parse({ ...unsigned, proof: "" });
  Reflect.deleteProperty(canonical, "proof");
  return { ...canonical, proof: proof(canonical as Omit<LiquidityQuotePlan, "proof">) } as LiquidityQuotePlan;
}
export async function inspectLiquidityLegs(owner: Address, version: 3 | 4, legs: LiquidityLeg[], expectedPool?: string) {
  const c = liquidityRpc(), block = await c.getBlockNumber(), npm = version === 3 ? A.v3Npm : A.v4Npm;
  const observations = await mapLiquidityBounded(legs, async leg => {
    const [beneficialOwner, nftOwner, liquidity] = await Promise.all([
      c.readContract({ address: A.manager, abi: deltaLiquidityAbi, functionName: version === 3 ? "ownerOfV3" : "ownerOfV4", args: [BigInt(leg.tokenId)], blockNumber: block }),
      c.readContract({ address: npm, abi: liquidityReadAbi, functionName: "ownerOf", args: [BigInt(leg.tokenId)], blockNumber: block }),
      version === 3 ? c.readContract({ address: npm, abi: liquidityReadAbi, functionName: "positions", args: [BigInt(leg.tokenId)], blockNumber: block }).then(p => p[7])
        : c.readContract({ address: npm, abi: liquidityReadAbi, functionName: "getPositionLiquidity", args: [BigInt(leg.tokenId)], blockNumber: block }),
    ]);
    if (expectedPool) {
      if (version === 3) {
        const p = await c.readContract({ address: npm, abi: liquidityReadAbi, functionName: "positions", args: [BigInt(leg.tokenId)], blockNumber: block });
        const pool = await c.readContract({ address: A.v3Factory, abi: liquidityReadAbi, functionName: "getPool", args: [p[2], p[3], p[4]], blockNumber: block });
        if (pool.toLowerCase() !== expectedPool.toLowerCase() || p[5] !== leg.tickLower || p[6] !== leg.tickUpper) throw new Error("LP_POSITION_SETTINGS_CONFLICT");
      } else {
        const p = await c.readContract({ address: npm, abi: liquidityReadAbi, functionName: "getPoolAndPositionInfo", args: [BigInt(leg.tokenId)], blockNumber: block });
        const signed24 = (n: bigint) => Number(BigInt.asIntN(24, n));
        if (liquidityPoolId(p[0]) !== expectedPool.toLowerCase() || signed24(p[1] >> 8n) !== leg.tickLower || signed24(p[1] >> 32n) !== leg.tickUpper) throw new Error("LP_POSITION_SETTINGS_CONFLICT");
      }
    }
    return { tokenId: leg.tokenId, beneficialOwner, nftOwner, liquidity: liquidity.toString() };
  });
  assertLiquidityOwnership(owner, version, legs, observations); return { block: block.toString(), observations };
}
export async function quoteLiquidity(raw: unknown): Promise<LiquidityQuotePlan> {
  const input = liquiditySignerRequest.parse(raw), d = input.draft, f = d.fields;
  if (input.walletRef.toLowerCase() !== input.expectedFrom.toLowerCase()) throw new Error("Wallet mismatch");
  const owner = input.expectedFrom.toLowerCase() as Address;
  const c = liquidityRpc();
  if (input.claimPositions) {
    if (d.operation !== "claim") throw new Error("LP_INVALID_CLAIM_BATCH");
    const seen = new Set<string>();
    for (const p of input.claimPositions) for (const leg of p.legs) {
      const key = `${p.version}:${BigInt(leg.tokenId)}`;
      if (seen.has(key)) throw new Error("LP_DUPLICATE_CLAIM_LEG"); seen.add(key);
    }
    const claimable = (await mapLiquidityBounded(input.claimPositions, async position => {
      const draft = newLiquidityDraft("claim", { ...position.fields, position: position.positionId });
      draft.tokenAddress = position.token; draft.symbol = position.symbol;
      return await claimableLiquidityFees({ ownerXUserId: input.ownerXUserId, source: input.source, walletRef: input.walletRef, expectedFrom: input.expectedFrom, draft, legs: position.legs }) !== false ? position : null;
    })).filter((position): position is NonNullable<(typeof input.claimPositions)[number]> => position !== null);
    if (!claimable.length) throw new Error("LP_NO_CLAIMABLE_FEES");
    const plans = await mapLiquidityBounded(claimable, async position => {
      const draft = newLiquidityDraft("claim", { ...position.fields, position: position.positionId });
      draft.tokenAddress = position.token; draft.symbol = position.symbol;
      const plan = await quoteLiquidity({ ownerXUserId: input.ownerXUserId, source: input.source, walletRef: input.walletRef, expectedFrom: input.expectedFrom, draft, legs: position.legs });
      if (plan.poolId.toLowerCase() !== position.poolId.toLowerCase() || plan.version !== position.version || plan.calls.length !== 1) throw new Error("LP_POSITION_SETTINGS_CONFLICT");
      return plan;
    });
    const calls = plans.flatMap(p => p.calls), block = await c.getBlock(), fees = await estimateResilientAutomationFees(c);
    const simulated = await c.simulateCalls({ account: owner, blockNumber: block.number, calls: calls.map(call => ({ to: call.to, data: call.data, value: BigInt(call.value) })), validation: false });
    if (simulated.results.length !== calls.length || simulated.results.some(r => r.status !== "success")) throw new Error("LP_SIMULATION_FAILED");
    const reserve = simulated.results.reduce((sum, r) => sum + transactionMaximumCost(0n, r.gasUsed, fees.maxFeePerGas), 0n);
    if (await c.getBalance({ address: owner, blockNumber: block.number }) < reserve) throw new Error("LP_INSUFFICIENT_GAS");
    const { proof: _proof, ...base } = plans[0];
    const summary = ["Collect LP fees from these positions only:", ...claimable.map(p => `${p.positionId} ($${p.symbol})`)];
    const groups = Array.from({ length: Math.ceil(claimable.length / 4) }, (_, i) => summary.slice(1 + i * 4, 1 + (i + 1) * 4).join(", ")).filter(Boolean);
    const compactSummary = [summary[0], ...groups, plans[0].summary.at(-1)!];
    const unsigned = { ...base, quoteId: keccak256(stringToHex(JSON.stringify(calls))), calls, summary: compactSummary,
      expiresAt: Math.min(...plans.map(p => p.expiresAt)), executionDeadline: Math.min(...plans.map(p => p.executionDeadline)), claimPositions: claimable };
    // Parse before signing: property order is part of the existing proof format.
    const { proof: _unused, ...canonical } = quoteSchema.parse({ ...unsigned, proof: "" });
    return { ...canonical, proof: proof(canonical as Omit<LiquidityQuotePlan, "proof">) } as LiquidityQuotePlan;
  }
  if (d.operation === "add") throw new Error("DELTA_NATIVE_ADD_UNVERIFIED");
  if (d.operation === "compound") throw new Error("DELTA_COMPOUNDING_UNVERIFIED");
  if (!["open", "claim", "withdraw"].includes(d.operation)) throw new Error("Unsupported liquidity operation");
  if (d.operation === "withdraw" && f.withdrawPercent !== 100) throw new Error("DELTA_PARTIAL_WITHDRAWAL_UNVERIFIED");
  if (!d.tokenAddress || !d.symbol || !f.version || !f.pair || !f.feePips || !f.tickSpacing) throw new Error("Incomplete position parameters");
  // LP setup is a sequential workflow: one funding purchase can move before
  // the next purchase is prepared. Three percent accommodates ordinary price
  // movement while remaining bounded. The final open is repriced against the
  // assets actually received, so a short fill reduces the formed position
  // instead of causing another purchase or forcing the original dollar size.
  const openSlippageBps = f.slippageBps ?? 300;
  const block = await c.getBlock(), version = f.version, token = d.tokenAddress.toLowerCase() as Address;
  // One clock for every deadline-bearing call. Reserve ten minutes after
  // confirmation for funding/approval steps; never extend signed calldata.
  const deadline = BigInt(Math.min(Math.floor(Date.now() / 1000), Number(block.timestamp)) + LIQUIDITY_CALLDATA_DEADLINE_MS / 1000);
  const executionDeadline = Number(deadline) * 1000;
  const expiresAt = executionDeadline - LIQUIDITY_QUOTE_EXECUTION_ALLOWANCE_MS;
  if (await c.getChainId() !== 4663) throw new Error("Chain mismatch");
  const key = liquidityPoolKey(token, f.pair, version, f.feePips, f.tickSpacing);
  if (version === 3 && await c.readContract({ address: A.v3Factory, abi: liquidityReadAbi, functionName: "feeAmountTickSpacing", args: [key.fee], blockNumber: block.number }) !== key.tickSpacing) throw new Error("LP_INVALID_POOL_SPACING");
  let pool = version === 3 ? await c.readContract({ address: A.v3Factory, abi: liquidityReadAbi, functionName: "getPool", args: [key.currency0, key.currency1, key.fee], blockNumber: block.number }) : liquidityPoolId(key);
  let sqrt = 0n;
  if (version === 4) sqrt = (await c.readContract({ address: A.v4View, abi: liquidityReadAbi, functionName: "getSlot0", args: [pool as Hex], blockNumber: block.number }))[0];
  else if (pool !== zeroAddress) sqrt = (await c.readContract({ address: pool as Address, abi: liquidityReadAbi, functionName: "slot0", blockNumber: block.number }))[0];
  const calls: LiquidityTransaction[] = [], summary: string[] = [];
  let marketCapRange: LiquidityQuotePlan["marketCapRange"], requestedBudgetUsd: number | undefined, bandWeights: number[] | undefined;
  if (d.operation === "claim" || d.operation === "withdraw") {
    await inspectLiquidityLegs(owner, version, input.legs, pool);
    const claimable = await claimableLiquidityFees(raw);
    if (d.operation === "claim") {
      if (claimable === false) throw new Error("LP_NO_CLAIMABLE_FEES");
      calls.push(prepareLiquidityClaim(version, input.legs));
    }
    else {
      const minimums = [];
      for (const leg of input.legs) {
        const actual = version === 3
          ? (await c.readContract({ address: A.v3Npm, abi: liquidityReadAbi, functionName: "positions", args: [BigInt(leg.tokenId)], blockNumber: block.number }))[7]
          : await c.readContract({ address: A.v4Npm, abi: liquidityReadAbi, functionName: "getPositionLiquidity", args: [BigInt(leg.tokenId)], blockNumber: block.number });
        const [a, b] = liquidityAmounts(actual, leg.tickLower, leg.tickUpper, sqrt, false), factor = BigInt(10000 - (f.slippageBps ?? 100));
        minimums.push({ amount0: (a * factor / 10000n).toString(), amount1: (b * factor / 10000n).toString() });
      }
      if (claimable !== false) calls.push(prepareLiquidityClaim(version, input.legs));
      calls.push(prepareLiquidityClose(version, input.legs, minimums, 100));
    }
    summary.push(`${d.operation === "claim" ? "Collect LP fees from" : "Close and withdraw"} ${input.legs.length} NFT band(s).`);
    if (d.operation === "withdraw" && claimable !== false) summary.push("Collect LP fees first, then withdraw the full position. If closing fails, already-collected fees remain in your wallet.");
    const fees = await estimateResilientAutomationFees(c);
    const simulation = await c.simulateCalls({ account: owner, blockNumber: block.number, calls: calls.map(call => ({ to: call.to, data: call.data, value: BigInt(call.value) })), validation: false });
    if (simulation.results.length !== calls.length || simulation.results.some(r => r.status !== "success")) throw new Error("LP_SIMULATION_FAILED");
    const reserve = simulation.results.reduce((total, r) => total + transactionMaximumCost(0n, r.gasUsed, fees.maxFeePerGas), 0n);
    if (await c.getBalance({ address: owner, blockNumber: block.number }) < reserve) throw new Error("LP_INSUFFICIENT_GAS");
  } else {
    const dollarRange = f.lowerMarketCapUsd !== undefined || f.upperMarketCapUsd !== undefined;
    if (!f.amount || !f.unit || !f.bands || !f.shape || (dollarRange
      ? f.lowerMarketCapUsd === undefined || f.upperMarketCapUsd === undefined
      : f.downPercent === undefined || f.upPercent === undefined)) throw new Error("Incomplete liquidity quote");
    if (dollarRange && f.lowerMarketCapUsd! >= f.upperMarketCapUsd!) throw new Error("LP_INVALID_MCAP_RANGE");
    const tokenDecimals = await c.readContract({ address: token, abi: erc20Abi, functionName: "decimals", blockNumber: block.number });
    const ethUsd = await ethUsdPrice();
    // USDG is not a Pons launch; price it through its real WETH pool rather
    // than the launch-market-cap reader (and don't assume a perfect $1 peg).
    const usdgPrice = () => liquidityUsdgUsdPrice(c, block.number, ethUsd);
    const quoteUsd = f.pair === "ETH" ? ethUsd : await usdgPrice();
    const tokenUsd = token === A.weth ? ethUsd : token === A.usdg ? await usdgPrice() : sqrt === 0n
      ? await Promise.allSettled([
          tokenValueAtBlock(token, "1", block.number.toString()).then(value => ({ source: "pons_onchain" as const, value: value.usdValue })),
          quoteDetails(c, token).then(value => ({ source: "robinhood_reference" as const, value: value.usd })),
          liquidityReferencePrice(token, { ETH: ethUsd, USDG: await usdgPrice().catch(() => 0) }).then(value => ({ source: "delta_market" as const, value })),
        ]).then(results => liquidityPriceConsensusBySource(results.map((result, index) => result.status === "fulfilled" ? result.value : {
          source: (["pons_onchain", "robinhood_reference", "delta_market"] as const)[index], value: null,
        })))
      : await tokenValueAtBlock(token, "1", block.number.toString()).then(value => value.usdValue)
        .catch(async () => (await quoteDetails(c, token)).usd)
        .catch(async () => liquidityReferencePrice(token, { ETH: ethUsd, USDG: await usdgPrice().catch(() => 0) }));
    const quoteDecimals = f.pair === "ETH" ? 18 : 6;
    const tokenIs0 = key.currency0 === token, decimals0 = tokenIs0 ? tokenDecimals : quoteDecimals, decimals1 = tokenIs0 ? quoteDecimals : tokenDecimals;
    const usd0 = tokenIs0 ? tokenUsd : quoteUsd, usd1 = tokenIs0 ? quoteUsd : tokenUsd;
    const referenceRatio = usd0 / usd1 * 10 ** (decimals1 - decimals0);
    if (!Number.isFinite(referenceRatio) || referenceRatio <= 0) throw new Error("Reference price unavailable");
    const referenceTick = Math.floor(Math.log(referenceRatio) / Math.log(1.0001));
    const referenceSqrt = liquiditySqrtTick(referenceTick);
    if (sqrt > 0n && Math.abs(Math.log(Number(sqrt) / Number(referenceSqrt)) * 2) > Math.log(1.2)) throw new Error("LP_REFERENCE_PRICE_DISAGREEMENT");
    if (sqrt === 0n) {
      sqrt = referenceSqrt;
      if (version === 4) calls.push({ to: A.v4Npm, data: encodeFunctionData({ abi: liquidityReadAbi, functionName: "initializePool", args: [key, sqrt] }), value: "0", purpose: "initialize" });
      else calls.push({ to: A.v3Npm, data: encodeFunctionData({ abi: liquidityReadAbi, functionName: "createAndInitializePoolIfNecessary", args: [key.currency0, key.currency1, key.fee, sqrt] }), value: "0", purpose: "initialize" });
      summary.push("Initialize a new pool at the quoted reference price if no matching pool exists.");
    }
    const tick = liquidityTickAtSqrt(sqrt);
    let bands: ReturnType<typeof liquidityBands>;
    if (dollarRange) {
      const totalSupply = await c.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply", blockNumber: block.number });
      const computed = liquidityMarketCapBands({ lowerUsd: f.lowerMarketCapUsd!, upperUsd: f.upperMarketCapUsd!, supply: Number(formatUnits(totalSupply, tokenDecimals)),
        pairedAssetUsd: quoteUsd, tokenDecimals, pairDecimals: quoteDecimals, tokenIs0, sqrt, spacing: key.tickSpacing, count: f.bands, shape: f.shape });
      bands = computed.bands; marketCapRange = liquidityMarketCapRangeSchema.parse(computed.range);
    } else bands = liquidityBands({ tick, spacing: key.tickSpacing, down: f.downPercent!, up: f.upPercent!, count: f.bands, shape: f.shape, tokenIs0 });
    bandWeights = bands.map(b => b.weight);
    const sample = bands.map(b => liquidityAmounts(10n ** 18n * BigInt(b.weight), b.tickLower, b.tickUpper, sqrt));
    const sample0 = sample.reduce((n, a) => n + a[0], 0n), sample1 = sample.reduce((n, a) => n + a[1], 0n);
    const value0 = Number(formatUnits(sample0, decimals0)) * usd0, value1 = Number(formatUnits(sample1, decimals1)) * usd1;
    const budget = Number(f.amount) * (f.unit === "eth" ? ethUsd : 1);
    if (!Number.isFinite(budget) || budget <= 0 || !(value0 + value1 > 0)) throw new Error("Invalid liquidity budget");
    requestedBudgetUsd = budget;
    const max0 = parseUnits((budget * value0 / (value0 + value1) / usd0).toFixed(Math.min(decimals0, 18)), decimals0);
    const max1 = parseUnits((budget * value1 / (value0 + value1) / usd1).toFixed(Math.min(decimals1, 18)), decimals1);
    const rungs = fundLiquidityBands(bands, sqrt, max0, max1, version === 4 ? openSlippageBps : 0);
    const requirements: LiquidityAssetRequirement[] = [];
    const [ethBalance, usdgBalance, fees] = await Promise.all([
      c.getBalance({ address: owner, blockNumber: block.number }),
      c.readContract({ address: A.usdg, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: block.number }),
      estimateResilientAutomationFees(c),
    ]);
    for (const [asset, maximum, decimals, label, assetUsd] of [
      [key.currency0, rungs.reduce((n, r) => n + r.amount0Max, 0n), decimals0, tokenIs0 ? d.symbol : f.pair, usd0],
      [key.currency1, rungs.reduce((n, r) => n + r.amount1Max, 0n), decimals1, tokenIs0 ? f.pair : d.symbol, usd1],
    ] as const) {
      const displayAmount = formatUnits(maximum, decimals);
      const displayUsd = Number(displayAmount) * assetUsd;
      summary.push(label === "USDG"
        ? `Maximum USDG: $${displayAmount}.`
        : `Maximum ${label}: ${displayAmount} ($${displayUsd}).`);
      if (asset === zeroAddress) continue;
      const [balance, allowance] = await Promise.all([
        c.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: block.number }),
        c.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [owner, A.manager], blockNumber: block.number }),
      ]);
      requirements.push({ asset, required: maximum, held: balance, decimals, symbol: label });
      if (allowance < maximum) {
        if (allowance > 0n) calls.push({ to: asset, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [A.manager, 0n] }), value: "0", purpose: "approval_reset" });
        calls.push({ to: asset, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [A.manager, maximum] }), value: "0", purpose: "approval" });
      }
    }
    // For V3 creation, the factory's CREATE2 pool can be obtained read-only by
    // simulating its create-and-initialize helper.
    let address = pool as Address;
    if (version === 3 && address === zeroAddress) address = (await c.simulateContract({ address: A.v3Npm, abi: liquidityReadAbi, functionName: "createAndInitializePoolIfNecessary", args: [key.currency0, key.currency1, key.fee, sqrt] })).result;
    if (version === 3) pool = address;
    calls.push(prepareLiquidityOpen({ version, pool: address, key, bands: rungs, deadline, minimumTick: tick - Math.ceil(Math.log(1 + openSlippageBps / 10000) / Math.log(1.0001)), maximumTick: tick + Math.ceil(Math.log(1 + openSlippageBps / 10000) / Math.log(1.0001)), slippageBps: openSlippageBps }));
    summary.push(marketCapRange
      ? `Current pool MCap: ${formatLiquidityMarketCap(marketCapRange.referenceUsd)}. Tick-rounded range: ${formatLiquidityMarketCap(marketCapRange.roundedLowerUsd)} to ${formatLiquidityMarketCap(marketCapRange.roundedUpperUsd)} MCap.`
      : `Range ticks ${bands[0].tickLower} to ${bands.at(-1)!.tickUpper}; ${f.bands} NFT band(s).`);
    if (marketCapRange) summary.push("MCap uses total supply and the paired asset's USD price at quote time. Later supply or paired-asset price changes affect the dollar equivalent of fixed pool ticks.");
    const funded = await planLiquidityFunding({ protectedToken: token, ethBalance, usdgBalance, requirements, positionCalls: calls }, {
      buy: (asset, minimum) => quoteLiquidityPurchase(owner, asset, minimum, openSlippageBps, 0, deadline),
      convertUsdg: (minimum, maximum) => quoteLiquidityUsdgToEth(owner, token, minimum, maximum, openSlippageBps),
      gasCosts: async sequence => {
        // Virtual ETH is used ONLY to measure the sequential calls. Funding
        // eligibility above uses the real ETH/USDG balances; it cannot treat
        // this override as money in the user's wallet.
        const simulation = await c.simulateCalls({ account: owner, blockNumber: block.number,
          calls: sequence.map(call => ({ to: call.to, data: call.data, value: BigInt(call.value) })),
          stateOverrides: [{ address: owner, balance: parseEther("1000000") }], validation: false,
        });
        if (simulation.results.length !== sequence.length) throw new Error("Incomplete liquidity simulation");
        return simulation.results.map((result, index) => {
          if (result.status !== "success") throw new Error(`LP_SIMULATION_FAILED:${sequence[index].purpose}:${result.error?.message ?? "reverted"}`);
          return transactionMaximumCost(0n, result.gasUsed, fees.maxFeePerGas);
        });
      },
    });
    calls.splice(0, calls.length, ...funded.calls);
    summary.push(...funded.summary);
    summary.push("Missing assets are bought first. Position tokens are never sold to raise ETH or USDG.");
  }
  if (expiresAt < Date.now() + LIQUIDITY_MINIMUM_QUOTE_LIFETIME_MS) throw new Error("LIQUIDITY_QUOTE_EXPIRED");
  const unsigned = { owner, token, symbol: d.symbol, version, poolId: pool, operation: d.operation, quoteId: keccak256(stringToHex(`${owner}:${block.number}:${JSON.stringify(calls)}`)), expiresAt, executionDeadline, calls, summary, priorLegs: input.legs,
    ...(requestedBudgetUsd !== undefined ? { requestedBudgetUsd, minimumFillBps: 9500, slippageBps: openSlippageBps, bandWeights,
      expectedDepositUsd: requestedBudgetUsd, expectedFillBps: 10_000, partialReprice: false } : {}),
    ...(marketCapRange ? { marketCapRange } : {}) };
  return { ...unsigned, proof: proof(unsigned) };
}
const liquidityPrepareObject = z.object({ ...accessFields, walletRef: address, plan: quoteSchema, step: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(180), minimumNonce: z.number().int().nonnegative().optional(), minimumBlock: z.string().regex(/^\d+$/).optional() }).strict();
export const liquidityPrepareSchema = liquidityPrepareObject.superRefine(validateAccess);
async function inspectQuoteStep(plan: LiquidityQuotePlan, step: number) {
  const group = plan.claimPositions?.[step];
  if (group) await inspectLiquidityLegs(plan.owner as Address, group.version, group.legs, group.poolId);
  else if (plan.priorLegs.length) await inspectLiquidityLegs(plan.owner as Address, plan.version, plan.priorLegs, plan.poolId);
}
export async function prepareLiquidityStep(raw: unknown) {
  const input = liquidityPrepareSchema.parse(raw), plan = checkQuote(input.plan), call = plan.calls[input.step];
  if (plan.operation === "add") throw new Error("DELTA_NATIVE_ADD_UNVERIFIED");
  if (!call || input.walletRef.toLowerCase() !== plan.owner || Date.now() > (input.step > 0 ? plan.executionDeadline - 15_000 : plan.expiresAt)) throw new Error("LIQUIDITY_QUOTE_EXPIRED");
  await inspectQuoteStep(plan, input.step);
  return prepareSigned({ chainId: 4663, ownerReference: `x:${input.ownerXUserId}`, walletRef: input.walletRef, expectedFrom: plan.owner, requireSimulation: true, idempotencyKey: input.idempotencyKey, minimumNonce: input.minimumNonce }, call.to, call.data, BigInt(call.value));
}
export async function prepareLiquidityEnvelope(raw: unknown) {
  const input = liquidityPrepareSchema.parse(raw), plan = checkQuote(input.plan), call = plan.calls[input.step];
  if (plan.operation === "add") throw new Error("DELTA_NATIVE_ADD_UNVERIFIED");
  if (!call || input.walletRef.toLowerCase() !== plan.owner || Date.now() > (input.step ? plan.executionDeadline - 15_000 : plan.expiresAt)) throw new Error("LIQUIDITY_QUOTE_EXPIRED");
  await inspectQuoteStep(plan, input.step);
  const envelope = await prepareUnsigned({ chainId: 4663, ownerReference: `x:${input.ownerXUserId}`, walletRef: input.walletRef, expectedFrom: plan.owner, requireSimulation: true, idempotencyKey: input.idempotencyKey, minimumNonce: input.minimumNonce }, call.to, call.data, BigInt(call.value), input.minimumBlock ? BigInt(input.minimumBlock) : undefined);
  const binding = JSON.stringify({ quote: plan.proof, step: input.step, key: input.idempotencyKey, envelope });
  const envelopeProof = createHmac("sha256", process.env.LIQUIDITY_QUOTE_SIGNING_SECRET!).update(binding).digest("hex");
  return { ...envelope, envelopeProof };
}
const envelopeSchema = z.object({ unsignedTransaction: z.string().regex(/^0x[a-fA-F0-9]+$/), toAddress: address, valueWei: z.string().regex(/^\d+$/), nonce: z.number().int().nonnegative(), envelopeProof: z.string() }).strict();
export async function signLiquidityEnvelope(raw: unknown) {
  const { envelope: supplied, ...input } = liquidityPrepareObject.extend({ envelope: envelopeSchema }).superRefine(validateAccess).parse(raw);
  const plan = checkQuote(input.plan), { envelopeProof, ...envelope } = supplied;
  if (plan.operation === "add") throw new Error("DELTA_NATIVE_ADD_UNVERIFIED");
  if (input.walletRef.toLowerCase() !== plan.owner || !plan.calls[input.step]) throw new Error("Wallet mismatch");
  const expected = createHmac("sha256", process.env.LIQUIDITY_QUOTE_SIGNING_SECRET!).update(JSON.stringify({ quote: plan.proof, step: input.step, key: input.idempotencyKey, envelope })).digest("hex");
  if (envelopeProof.length !== expected.length || !timingSafeEqual(Buffer.from(envelopeProof), Buffer.from(expected))) throw new Error("Invalid envelope proof");
  // Recover the fixed payload/key only within the execution window. Some
  // Delta calls have no contract deadline, so broadcast is guarded separately.
  if (!liquidityExecutionWindowOpen(plan, Date.now())) throw new Error("LIQUIDITY_QUOTE_EXPIRED");
  return signPreparedEnvelope({ chainId: 4663, ownerReference: `x:${input.ownerXUserId}`, walletRef: input.walletRef, expectedFrom: plan.owner, requireSimulation: true, idempotencyKey: input.idempotencyKey }, envelope as Awaited<ReturnType<typeof prepareUnsigned>>);
}
export async function inspectLiquidityReceipt(hash: Hex, suppliedPlan: LiquidityQuotePlan, stepIndex?: number) {
  const checked = checkQuote(suppliedPlan), index = stepIndex ?? checked.calls.length - 1;
  if (!Number.isInteger(index) || index < 0 || index >= checked.calls.length) throw new Error("LP_RECEIPT_PLAN_MISMATCH");
  const group = checked.claimPositions?.[index], call = checked.calls[index];
  if (!["claim", "withdraw", "open"].includes(call.purpose)) throw new Error("LP_RECEIPT_PLAN_MISMATCH");
  const plan = { ...checked, ...(group ? { token: group.token, symbol: group.symbol, version: group.version, poolId: group.poolId, priorLegs: group.legs } : {}), operation: call.purpose };
  const c = liquidityRpc(), receipt = await c.getTransactionReceipt({ hash });
  if (receipt.status !== "success") return { status: "reverted" as const, legs: [], received: [] };
  const transaction = await c.getTransaction({ hash });
  if (transaction.from.toLowerCase() !== plan.owner || transaction.to?.toLowerCase() !== call.to.toLowerCase() || transaction.input.toLowerCase() !== call.data.toLowerCase() || transaction.value !== BigInt(call.value)) throw new Error("LP_RECEIPT_PLAN_MISMATCH");
  const legs: LiquidityLeg[] = [];
  let deposited: Array<{ symbol: string; amount: string; usd: number }> | undefined, depositedUsd: number | undefined;
  if (plan.operation === "open" || plan.operation === "add") {
    const npm = plan.version === 3 ? A.v3Npm : A.v4Npm;
    const transfer = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"]);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== npm) continue;
      let id: bigint;
      try {
        const event = decodeEventLog({ abi: transfer, ...log });
        if (event.args.from !== zeroAddress || event.args.to.toLowerCase() !== A.manager) continue;
        id = event.args.tokenId;
      } catch { continue; /* Not an NFT Transfer event. */ }
      // A failed RPC read must not silently omit one of the minted bands.
      if (plan.version === 3) {
          const p = await c.readContract({ address: npm, abi: liquidityReadAbi, functionName: "positions", args: [id] });
          legs.push({ tokenId: id.toString(), tickLower: p[5], tickUpper: p[6], liquidity: p[7].toString() });
        } else {
          const [info, liquidity] = await Promise.all([c.readContract({ address: npm, abi: liquidityReadAbi, functionName: "getPoolAndPositionInfo", args: [id] }), c.readContract({ address: npm, abi: liquidityReadAbi, functionName: "getPositionLiquidity", args: [id] })]);
          const signed24 = (n: bigint) => Number(n & 0xffffffn) >= 0x800000 ? Number(n & 0xffffffn) - 0x1000000 : Number(n & 0xffffffn);
          legs.push({ tokenId: id.toString(), tickLower: signed24(info[1] >> 8n), tickUpper: signed24(info[1] >> 32n), liquidity: liquidity.toString() });
      }
    }
    const decoded = decodeFunctionData({ abi: deltaLiquidityAbi, data: call.data });
    const expectedBands = decoded.functionName === "openV3" || decoded.functionName === "openV4" ? decoded.args[1] : [];
    if (!legs.length || legs.length !== expectedBands.length || new Set(legs.map(l => l.tokenId)).size !== legs.length) throw new Error("LIQUIDITY_RECEIPT_MISSING_MINTS");
    if (legs.some(l => !expectedBands.some(b => b.tickLower === l.tickLower && b.tickUpper === l.tickUpper))) throw new Error("LP_RECEIPT_RANGE_MISMATCH");
    await inspectLiquidityLegs(plan.owner as Address, plan.version, legs, plan.poolId);
    let key: ReturnType<typeof liquidityPoolKey>, sqrt: bigint;
    if (decoded.functionName === "openV4") {
      key = decoded.args[0];
      sqrt = (await c.readContract({ address: A.v4View, abi: liquidityReadAbi, functionName: "getSlot0", args: [plan.poolId as Hex], blockNumber: receipt.blockNumber }))[0];
    } else if (decoded.functionName === "openV3") {
      const [currency0, currency1, fee, tickSpacing, slot] = await Promise.all([
        c.readContract({ address: plan.poolId as Address, abi: liquidityReadAbi, functionName: "token0", blockNumber: receipt.blockNumber }),
        c.readContract({ address: plan.poolId as Address, abi: liquidityReadAbi, functionName: "token1", blockNumber: receipt.blockNumber }),
        c.readContract({ address: plan.poolId as Address, abi: liquidityReadAbi, functionName: "fee", blockNumber: receipt.blockNumber }),
        c.readContract({ address: plan.poolId as Address, abi: liquidityReadAbi, functionName: "tickSpacing", blockNumber: receipt.blockNumber }),
        c.readContract({ address: plan.poolId as Address, abi: liquidityReadAbi, functionName: "slot0", blockNumber: receipt.blockNumber }),
      ]);
      key = { currency0, currency1, fee, tickSpacing, hooks: zeroAddress }; sqrt = slot[0];
    } else throw new Error("LP_RECEIPT_PLAN_MISMATCH");
    const metadata = await Promise.all([key.currency0, key.currency1].map(async asset => asset === zeroAddress
      ? { symbol: "ETH", decimals: 18 }
      : Promise.all([
        c.readContract({ address: asset, abi: erc20Abi, functionName: "symbol", blockNumber: receipt.blockNumber }),
        c.readContract({ address: asset, abi: erc20Abi, functionName: "decimals", blockNumber: receipt.blockNumber }),
      ]).then(([symbol, decimals]) => ({ symbol, decimals }))));
    const amounts = legs.reduce<[bigint, bigint]>((total, item) => {
      const current = liquidityAmounts(BigInt(item.liquidity), item.tickLower, item.tickUpper, sqrt, false);
      return [total[0] + current[0], total[1] + current[1]];
    }, [0n, 0n]);
    const tokenIs0 = key.currency0.toLowerCase() === plan.token, quoteAsset = tokenIs0 ? key.currency1 : key.currency0;
    const ethUsd = await ethUsdPrice();
    let quoteUsd = ethUsd;
    if (quoteAsset.toLowerCase() === A.usdg) {
      const reference = await c.readContract({ address: A.v3Factory, abi: liquidityReadAbi, functionName: "getPool", args: [A.weth, A.usdg, 100], blockNumber: receipt.blockNumber });
      if (reference === zeroAddress) throw new Error("USDG reference pool unavailable");
      const [referenceSlot, referenceLiquidity] = await Promise.all([
        c.readContract({ address: reference, abi: liquidityReadAbi, functionName: "slot0", blockNumber: receipt.blockNumber }),
        c.readContract({ address: reference, abi: liquidityReadAbi, functionName: "liquidity", blockNumber: receipt.blockNumber }),
      ]);
      const usdgPerEth = (Number(referenceSlot[0]) / 2 ** 96) ** 2 * 1e12;
      if (referenceLiquidity <= 0n || !Number.isFinite(usdgPerEth) || usdgPerEth <= 0) throw new Error("USDG reference price unavailable");
      quoteUsd = ethUsd / usdgPerEth;
    } else if (quoteAsset !== zeroAddress && quoteAsset.toLowerCase() !== A.weth) throw new Error("LP_POSITION_SETTINGS_CONFLICT");
    const ratio = (Number(sqrt) / 2 ** 96) ** 2 * 10 ** (metadata[0].decimals - metadata[1].decimals);
    const tokenUsd = (tokenIs0 ? ratio : 1 / ratio) * quoteUsd, prices = tokenIs0 ? [tokenUsd, quoteUsd] : [quoteUsd, tokenUsd];
    deposited = metadata.map((asset, index) => ({ symbol: asset.symbol, amount: formatUnits(amounts[index], asset.decimals), usd: Number(formatUnits(amounts[index], asset.decimals)) * prices[index] }));
    depositedUsd = deposited.reduce((total, asset) => total + asset.usd, 0);
  }
  const received: string[] = [];
  if (plan.operation === "claim" || plan.operation === "withdraw") {
    const receivedUsdLabel = (value: number) => Number.isFinite(value) && value >= 0
      ? ` ($${value > 0 && value < 0.01 ? "<0.01" : value.toLocaleString("en-US", { maximumFractionDigits: 2 })})`
      : "";
    const amounts = new Map<string, bigint>();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === A.v3Npm || log.address.toLowerCase() === A.v4Npm) continue;
      try {
        const event = decodeEventLog({ abi: erc20Abi, ...log });
        if (event.eventName !== "Transfer") continue;
        const delta = (event.args.to.toLowerCase() === plan.owner ? event.args.value : 0n) - (event.args.from.toLowerCase() === plan.owner ? event.args.value : 0n);
        if (delta) amounts.set(log.address.toLowerCase(), (amounts.get(log.address.toLowerCase()) ?? 0n) + delta);
      } catch { /* Other event. */ }
    }
    for (const [asset, amount] of amounts) if (amount > 0n) {
      const [decimals, symbol] = await Promise.all([c.readContract({ address: asset as Address, abi: erc20Abi, functionName: "decimals" }), c.readContract({ address: asset as Address, abi: erc20Abi, functionName: "symbol" })]);
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(symbol)) throw new Error("LP_INVALID_RECEIPT_SYMBOL");
      const displayAmount = Number(Number(formatUnits(amount, decimals)).toPrecision(6));
      const usdValue = asset.toLowerCase() === A.usdg
        ? displayAmount
        : await tokenValueAtBlock(asset as Address, String(displayAmount), receipt.blockNumber.toString()).then(value => value.usdValue).catch(() => NaN);
      received.push(`${displayAmount} ${symbol}${receivedUsdLabel(usdValue)}`);
    }
    // Transaction-scoped value transfers, not a whole-block balance delta
    // (which can include unrelated concurrent wallet activity).
    const traceClient = createPublicClient({ transport: reliableHttp(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 20_000 }) });
    let native: bigint | undefined;
    try {
      type Trace = { type?: string; from?: string; to?: string; value?: string; error?: string; calls?: Trace[] };
      const trace = await (traceClient.request as unknown as (a: unknown) => Promise<Trace>)({ method: "debug_traceTransaction", params: [hash, { tracer: "callTracer" }] });
      const sum = (frame: Trace): bigint => frame.error ? 0n : (frame.type === "CALL" || frame.type === "SELFDESTRUCT" ? (frame.to?.toLowerCase() === plan.owner ? BigInt(frame.value || "0") : 0n) - (frame.from?.toLowerCase() === plan.owner ? BigInt(frame.value || "0") : 0n) : 0n) + (frame.calls ?? []).reduce((n, f) => n + sum(f), 0n);
      if (!trace.type) throw new Error("Missing trace");
      native = sum(trace);
    } catch { native = await explorerLiquidityNativePayout(hash, plan.owner); }
    if (native !== undefined && native > 0n) {
      const nativeAmount = Number(Number(formatEther(native)).toPrecision(6));
      const nativeUsd = await ethUsdPrice().then(price => nativeAmount * price).catch(() => NaN);
      received.unshift(`${nativeAmount} ETH${receivedUsdLabel(nativeUsd)}`);
    }
    if (native === undefined) received.push("ETH payout amount unavailable; see transaction");
    else if (!received.length) received.push("0 (no payout in this transaction)");
    if (plan.operation === "withdraw") {
      for (const leg of plan.priorLegs) {
        const burned = receipt.logs.some(log => {
          if (log.address.toLowerCase() !== (plan.version === 3 ? A.v3Npm : A.v4Npm)) return false;
          try { const event = decodeEventLog({ abi: parseAbi(["event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"]), ...log }); return event.args.tokenId === BigInt(leg.tokenId) && event.args.to === zeroAddress; } catch { return false; }
        });
        if (burned) continue;
        const liquidity = plan.version === 3 ? (await c.readContract({ address: A.v3Npm, abi: liquidityReadAbi, functionName: "positions", args: [BigInt(leg.tokenId)] }))[7] : await c.readContract({ address: A.v4Npm, abi: liquidityReadAbi, functionName: "getPositionLiquidity", args: [BigInt(leg.tokenId)] });
        if (liquidity !== 0n) throw new Error("LP_WITHDRAWAL_NOT_RECONCILED");
      }
    }
  }
  return { status: "confirmed" as const, legs, received, ...(deposited ? { deposited, depositedUsd } : {}),
    blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() };
}
