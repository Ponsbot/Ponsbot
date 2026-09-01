import { z } from "zod";
import { decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex, type TransactionSerialized } from "viem";
import type { LiquidityQuotePlan } from "./liquidity-quote";
import { liquidityClaimPositionSchema, liquidityMarketCapRangeSchema, type LiquidityClaimPosition } from "./liquidity-quote";
import { deltaLiquidityAbi, liquidityPoolId, liquidityPoolKey, type LiquidityLeg } from "./liquidity-contracts";
import { DELTA_LIQUIDITY, newLiquidityDraft, type LiquidityDraft } from "./liquidity-workflow";
import { liquidityExecutionWindowOpen } from "./liquidity-recovery";

// Shared with Convex; do not import the private signer or Next.js here.
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/);
const integer = z.string().regex(/^\d+$/);
const envelopeSchema = z.object({
  unsignedTransaction: bytes, toAddress: address, valueWei: integer,
  nonce: z.number().int().nonnegative().safe(), envelopeProof: z.string().min(1),
});
const signedSchema = z.object({
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), signedTransaction: bytes,
  toAddress: address, valueWei: integer, nonce: z.number().int().nonnegative().safe(),
});
export type LiquidityEnvelope = z.infer<typeof envelopeSchema>;

export function validateLiquidityEnvelope(value: unknown, plan: Pick<LiquidityQuotePlan, "calls">, step: number, minimumNonce = 0): LiquidityEnvelope {
  try {
    const envelope = envelopeSchema.parse(value), call = plan.calls[step];
    const tx = parseTransaction(envelope.unsignedTransaction as Hex);
    if (!call || tx.type !== "eip1559" || tx.chainId !== 4663 || tx.r || tx.s
      || tx.to?.toLowerCase() !== call.to.toLowerCase() || envelope.toAddress.toLowerCase() !== call.to.toLowerCase()
      || (tx.data ?? "0x").toLowerCase() !== call.data.toLowerCase() || (tx.value ?? 0n) !== BigInt(call.value)
      || BigInt(envelope.valueWei) !== BigInt(call.value) || (tx.nonce ?? 0) !== envelope.nonce || envelope.nonce < minimumNonce)
      throw new Error();
    return envelope;
  } catch { throw new Error("LP_SIGNER_ENVELOPE_INVALID"); }
}

export async function validateLiquiditySignature(value: unknown, envelope: LiquidityEnvelope, owner: string) {
  try {
    // Strip extra fields: a response cannot inject confirmed/reverted flags.
    const signed = signedSchema.parse(value);
    const tx = parseTransaction(signed.signedTransaction as Hex), unsigned = parseTransaction(envelope.unsignedTransaction as Hex);
    if (signed.transactionHash.toLowerCase() !== keccak256(signed.signedTransaction as Hex)
      || signed.toAddress.toLowerCase() !== envelope.toAddress.toLowerCase()
      || BigInt(signed.valueWei) !== BigInt(envelope.valueWei) || signed.nonce !== envelope.nonce)
      throw new Error();
    for (const key of ["type", "chainId", "nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "value", "data", "to"] as const)
      if (tx[key] !== unsigned[key]) throw new Error();
    if (JSON.stringify(tx.accessList ?? []) !== JSON.stringify(unsigned.accessList ?? [])
      || (await recoverTransactionAddress({ serializedTransaction: signed.signedTransaction as TransactionSerialized })).toLowerCase() !== owner.toLowerCase())
      throw new Error();
    return signed;
  } catch { throw new Error("LP_SIGNER_SIGNATURE_INVALID"); }
}

const legSchema = z.object({
  tokenId: integer.refine(value => BigInt(value) > 0n), liquidity: integer,
  tickLower: z.number().int().min(-887272).max(887272), tickUpper: z.number().int().min(-887272).max(887272),
}).refine(leg => leg.tickLower < leg.tickUpper);
const quoteSchema = z.object({
  owner: address, token: address, symbol: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/),
  version: z.union([z.literal(3), z.literal(4)]), poolId: z.string().regex(/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/),
  operation: z.enum(["open", "claim", "withdraw"]), quoteId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  expiresAt: z.number().int().positive().safe(), executionDeadline: z.number().int().positive().safe(),
  calls: z.array(z.object({ to: address, data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/), value: integer, purpose: z.string().min(1).max(100) }).strict()).min(1).max(32),
  summary: z.array(z.string().min(1).max(300)).min(1).max(20), proof: z.string().regex(/^[0-9a-f]{64}$/),
  requestedBudgetUsd: z.number().finite().positive().optional(), minimumFillBps: z.number().int().min(9000).max(10000).optional(), slippageBps: z.number().int().min(0).max(1000).optional(),
  bandWeights: z.array(z.number().int().min(1).max(100)).min(1).max(20).optional(),
  expectedDepositUsd: z.number().finite().positive().optional(), expectedFillBps: z.number().int().min(1).max(10000).optional(), partialReprice: z.boolean().optional(),
  priorLegs: z.array(legSchema).max(100),
  claimPositions: z.array(liquidityClaimPositionSchema).min(1).max(20).optional(),
  marketCapRange: liquidityMarketCapRangeSchema.optional(),
}).strict();

/** Validate the preview before offering confirmation, not only at signing time.
 * HMAC verification still belongs to the signer. Preserve the original object
 * and property order: rebuilding it here can change its signed JSON payload.
 */
export function validateLiquidityQuote(value: unknown, expected: {
  owner: string; draft: LiquidityDraft; legs: LiquidityLeg[]; poolId?: string; claimPositions?: LiquidityClaimPosition[];
}, now = Date.now()): LiquidityQuotePlan {
  try {
    const p = quoteSchema.parse(value), d = expected.draft, f = d.fields;
    if (expected.claimPositions || p.claimPositions) {
      if (!expected.claimPositions?.length || d.operation !== "claim" || p.operation !== "claim" || p.calls.length !== expected.claimPositions.length
        // Convex serializes object keys in a different order. Compare canonical
        // schema copies, leaving the original HMAC-signed plan untouched.
        || JSON.stringify(p.claimPositions) !== JSON.stringify(expected.claimPositions.map(position => liquidityClaimPositionSchema.parse(position))) || JSON.stringify(value).length > 60000) throw new Error();
      const first = expected.claimPositions[0];
      if (p.token.toLowerCase() !== first.token.toLowerCase() || p.symbol !== first.symbol || p.version !== first.version
        || p.poolId.toLowerCase() !== first.poolId.toLowerCase()) throw new Error();
      const seen = new Set<string>();
      for (const [i, position] of expected.claimPositions.entries()) {
        for (const leg of position.legs) { const key = `${position.version}:${BigInt(leg.tokenId)}`; if (seen.has(key)) throw new Error(); seen.add(key); }
        const draft = newLiquidityDraft("claim", { ...position.fields, position: position.positionId });
        draft.tokenAddress = position.token; draft.symbol = position.symbol;
        const { claimPositions: _groups, ...single } = p;
        validateLiquidityQuote({ ...single, token: position.token, symbol: position.symbol, version: position.version, poolId: position.poolId, priorLegs: position.legs, calls: [p.calls[i]] }, { owner: expected.owner, draft, legs: position.legs, poolId: position.poolId }, now);
      }
      return value as LiquidityQuotePlan;
    }
    if (JSON.stringify(value).length > 60000 || !d.tokenAddress || !f.pair || !f.version || !f.feePips || !f.tickSpacing
      || p.owner.toLowerCase() !== expected.owner.toLowerCase() || p.token.toLowerCase() !== d.tokenAddress.toLowerCase()
      || p.symbol !== d.symbol || p.operation !== d.operation || p.version !== f.version
      || p.expiresAt <= now || !liquidityExecutionWindowOpen(p, p.expiresAt)) throw new Error();
    const pool = expected.poolId ?? d.selected?.id;
    if (pool && p.poolId.toLowerCase() !== pool.toLowerCase()) throw new Error();
    if (p.version === 3 && !address.safeParse(p.poolId).success) throw new Error();
    const key = liquidityPoolKey(p.token as Address, f.pair, p.version, f.feePips, f.tickSpacing);
    if (p.version === 4 && p.poolId.toLowerCase() !== liquidityPoolId(key)) throw new Error();
    const legKey = (leg: LiquidityLeg) => `${BigInt(leg.tokenId)}:${leg.tickLower}:${leg.tickUpper}:${BigInt(leg.liquidity)}`;
    if (p.priorLegs.length !== expected.legs.length || p.priorLegs.some((leg, i) => legKey(leg) !== legKey(expected.legs[i]))
      || new Set(p.priorLegs.map(leg => BigInt(leg.tokenId).toString())).size !== p.priorLegs.length
      || (p.operation === "open" ? p.priorLegs.length !== 0 : p.priorLegs.length === 0)) throw new Error();
    const final = p.calls[p.calls.length - 1];
    if (final.to.toLowerCase() !== DELTA_LIQUIDITY.manager || final.purpose !== p.operation) throw new Error();
    const decoded = decodeFunctionData({ abi: deltaLiquidityAbi, data: final.data as Hex });
    if (p.operation === "open") {
      // Older already-issued quotes remain executable. New opening quotes add
      // all repricing fields as one complete signed set.
      const repriceFields = [p.requestedBudgetUsd, p.minimumFillBps, p.slippageBps, p.bandWeights, p.expectedDepositUsd, p.expectedFillBps, p.partialReprice];
      if (repriceFields.some(value => value !== undefined) && (p.requestedBudgetUsd === undefined || p.minimumFillBps === undefined || p.slippageBps === undefined
        || p.bandWeights?.length !== f.bands || p.expectedDepositUsd === undefined || p.expectedFillBps === undefined || p.partialReprice === undefined)) throw new Error();
      const dollarRange = f.lowerMarketCapUsd !== undefined || f.upperMarketCapUsd !== undefined;
      if (dollarRange && (!p.marketCapRange || p.marketCapRange.lowerUsd !== f.lowerMarketCapUsd || p.marketCapRange.upperUsd !== f.upperMarketCapUsd)) throw new Error();
      if (!dollarRange && p.marketCapRange) throw new Error();
      if (p.version === 3) {
        if (decoded.functionName !== "openV3" || decoded.args[0].toLowerCase() !== p.poolId.toLowerCase()
          || decoded.args[1].length !== f.bands || decoded.args[4] * 1000n !== BigInt(p.executionDeadline)) throw new Error();
      } else if (decoded.functionName !== "openV4" || liquidityPoolId(decoded.args[0]) !== p.poolId.toLowerCase()
        || decoded.args[1].length !== f.bands || decoded.args[2] * 1000n !== BigInt(p.executionDeadline)) throw new Error();
      if (p.marketCapRange && (decoded.functionName === "openV3" || decoded.functionName === "openV4")) {
        const rungs = decoded.args[1];
        if (rungs[0].tickLower !== p.marketCapRange.tickLower || rungs.at(-1)!.tickUpper !== p.marketCapRange.tickUpper) throw new Error();
      }
    } else {
      if (final.value !== "0") throw new Error();
      if (p.operation === "withdraw" && f.withdrawPercent !== 100) throw new Error();
      const method = `${p.operation === "claim" ? "collect" : "close"}V${p.version}Batch`;
      if (decoded.functionName !== method) throw new Error();
      // Withdrawals collect first when the fee read found anything claimable.
      // A definitively empty fee balance may safely omit that no-op call.
      if (p.operation === "withdraw") {
        if (p.calls.length < 1 || p.calls.length > 2) throw new Error();
        if (p.calls.length === 2) {
          const collect = p.calls[0], decodedCollect = decodeFunctionData({ abi: deltaLiquidityAbi, data: collect.data as Hex });
          if (collect.to.toLowerCase() !== DELTA_LIQUIDITY.manager || collect.value !== "0" || collect.purpose !== "claim" || decodedCollect.functionName !== `collectV${p.version}Batch`
            || JSON.stringify((decodedCollect.args[0] as readonly bigint[]).map(String)) !== JSON.stringify(p.priorLegs.map(l => BigInt(l.tokenId).toString()))) throw new Error();
        }
      } else if (p.calls.length !== 1) throw new Error();
      const ids = decoded.args[0] as readonly bigint[];
      if (ids.length !== p.priorLegs.length || ids.some((id, i) => id !== BigInt(p.priorLegs[i].tokenId))) throw new Error();
    }
    return value as LiquidityQuotePlan;
  } catch { throw new Error("LP_SIGNER_QUOTE_INVALID"); }
}

/** Convex cannot verify the private HMAC, so it accepts a repriced plan only
 * when every authority-bearing field and every prerequisite call is unchanged.
 * The signer verifies both HMACs and the confirmed prerequisite receipts.
 */
export function validateLiquidityOpenRefresh(oldValue: unknown, newValue: unknown): LiquidityQuotePlan {
  try {
    const oldPlan = quoteSchema.parse(oldValue), next = quoteSchema.parse(newValue);
    if (oldPlan.operation !== "open" || next.operation !== "open" || oldPlan.calls.at(-1)?.purpose !== "open" || next.calls.at(-1)?.purpose !== "open"
      || oldPlan.calls.length !== next.calls.length || oldPlan.owner.toLowerCase() !== next.owner.toLowerCase()
      || oldPlan.token.toLowerCase() !== next.token.toLowerCase() || oldPlan.symbol !== next.symbol || oldPlan.version !== next.version
      || oldPlan.poolId.toLowerCase() !== next.poolId.toLowerCase() || oldPlan.expiresAt !== next.expiresAt
      || oldPlan.executionDeadline !== next.executionDeadline || oldPlan.requestedBudgetUsd !== next.requestedBudgetUsd
      || oldPlan.minimumFillBps !== next.minimumFillBps || oldPlan.slippageBps !== next.slippageBps
      || JSON.stringify(oldPlan.bandWeights) !== JSON.stringify(next.bandWeights)
      || JSON.stringify(oldPlan.priorLegs) !== JSON.stringify(next.priorLegs)
      || JSON.stringify(oldPlan.claimPositions) !== JSON.stringify(next.claimPositions)
      || JSON.stringify(oldPlan.marketCapRange) !== JSON.stringify(next.marketCapRange)
      || JSON.stringify(oldPlan.summary) !== JSON.stringify(next.summary)) throw new Error();
    const calculatedFillBps = Math.floor(next.expectedDepositUsd! / next.requestedBudgetUsd! * 10_000);
    if (!next.expectedDepositUsd || !next.expectedFillBps || next.expectedDepositUsd > next.requestedBudgetUsd! * 1.001
      || next.expectedFillBps > 10000 || Math.abs(next.expectedFillBps - Math.min(10000, calculatedFillBps)) > 1
      || next.partialReprice !== (next.expectedFillBps < next.minimumFillBps!)) throw new Error();
    for (let i = 0; i < oldPlan.calls.length - 1; i++) if (JSON.stringify(oldPlan.calls[i]) !== JSON.stringify(next.calls[i])) throw new Error();
    const before = decodeFunctionData({ abi: deltaLiquidityAbi, data: oldPlan.calls.at(-1)!.data as Hex });
    const after = decodeFunctionData({ abi: deltaLiquidityAbi, data: next.calls.at(-1)!.data as Hex });
    const oldFinal = oldPlan.calls.at(-1)!, nextFinal = next.calls.at(-1)!;
    if (before.functionName !== after.functionName || !["openV3", "openV4"].includes(before.functionName) || before.functionName !== after.functionName
      || oldFinal.to.toLowerCase() !== DELTA_LIQUIDITY.manager || nextFinal.to.toLowerCase() !== DELTA_LIQUIDITY.manager) throw new Error();
    let oldBands: ReadonlyArray<{ tickLower: number; tickUpper: number }>, newBands: ReadonlyArray<{ tickLower: number; tickUpper: number }>;
    let weightedV4Bands: ReadonlyArray<{ liquidity: bigint; amount0Max: bigint; amount1Max: bigint }> | undefined;
    let expectedNativeValue = 0n;
    if (before.functionName === "openV4" && after.functionName === "openV4") {
      oldBands = before.args[1]; newBands = after.args[1];
      weightedV4Bands = after.args[1];
      if (liquidityPoolId(before.args[0]) !== liquidityPoolId(after.args[0]) || before.args[2] !== after.args[2]) throw new Error();
      expectedNativeValue = after.args[0].currency0 === "0x0000000000000000000000000000000000000000"
        ? weightedV4Bands.reduce((total, band) => total + band.amount0Max, 0n)
        : after.args[0].currency1 === "0x0000000000000000000000000000000000000000"
          ? weightedV4Bands.reduce((total, band) => total + band.amount1Max, 0n) : 0n;
    } else if (before.functionName === "openV3" && after.functionName === "openV3") {
      oldBands = before.args[1]; newBands = after.args[1];
      if (before.args[0].toLowerCase() !== after.args[0].toLowerCase() || before.args[4] !== after.args[4]) throw new Error();
    } else throw new Error();
    if (BigInt(nextFinal.value) !== expectedNativeValue || oldBands.length !== newBands.length
      || oldBands.some((band, index) => band.tickLower !== newBands[index].tickLower || band.tickUpper !== newBands[index].tickUpper)) throw new Error();
    const weights = next.bandWeights!;
    if (weightedV4Bands && (weightedV4Bands.some((band, index) => band.liquidity <= 0n || band.liquidity % BigInt(weights[index]) !== 0n)
      || new Set(weightedV4Bands.map((band, index) => band.liquidity / BigInt(weights[index]))).size !== 1)) throw new Error();
    return newValue as LiquidityQuotePlan;
  } catch { throw new Error("LP_REFRESHED_QUOTE_INVALID"); }
}

const receiptSchema = z.object({
  status: z.enum(["confirmed", "reverted"]), legs: z.array(legSchema).max(100),
  blockNumber: integer.optional(),
  received: z.array(z.string().min(1).max(200)).max(32).optional(),
  deposited: z.array(z.object({ symbol: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/), amount: z.string().regex(/^\d+(?:\.\d+)?$/), usd: z.number().finite().nonnegative() }).strict()).length(2).optional(),
  depositedUsd: z.number().finite().nonnegative().optional(),
});
export function validateLiquidityFinalReceipt(value: unknown, operation: string) {
  try {
    const receipt = receiptSchema.parse(value);
    if (receipt.status === "confirmed" && (operation === "open" || operation === "add") && !receipt.legs.length) throw new Error();
    if (new Set(receipt.legs.map(leg => BigInt(leg.tokenId).toString())).size !== receipt.legs.length) throw new Error();
    return receipt;
  } catch { throw new Error("LP_SIGNER_RECEIPT_INVALID"); }
}
