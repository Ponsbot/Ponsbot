import { erc20Abi, formatUnits, parseAbi, toHex, zeroAddress, type Address } from "viem";
import { DELTA_LIQUIDITY as A } from "../liquidity-workflow";
import { liquidityRpc } from "../liquidity-markets";
import { assertLiquidityOwnership, deltaLiquidityAbi, liquidityPoolId, liquidityPoolKey, liquidityReadAbi } from "../liquidity-contracts";
import { liquidityAmounts } from "../liquidity-math";
import { liquidityAccruedFees, liquidityInsideGrowth, liquidityAssetValue, type LiquidityPositionStatus } from "../liquidity-status";
import { mapLiquidityBounded } from "../liquidity-concurrency";
import { liquiditySignerRequest } from "./liquidity";
import { ethUsdPrice } from "./pricing";

export const liquidityFeeReadAbi = parseAbi([
  "function feeGrowthGlobal0X128() view returns(uint256)", "function feeGrowthGlobal1X128() view returns(uint256)",
  "function ticks(int24) view returns(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)",
  "function getPositionInfo(bytes32,address,int24,int24,bytes32) view returns(uint128,uint256,uint256)",
  "function getFeeGrowthInside(bytes32,int24,int24) view returns(uint256,uint256)",
]);
/** Read-only, block-pinned inventory and fee growth. Does not collect/claim. */
export async function inspectLiquidityPosition(raw: unknown): Promise<LiquidityPositionStatus> {
  const input = liquiditySignerRequest.parse(raw), f = input.draft.fields;
  if (input.walletRef.toLowerCase() !== input.expectedFrom.toLowerCase()) throw new Error("Wallet mismatch");
  if (!input.draft.tokenAddress || !f.version || !f.pair || !f.feePips || !f.tickSpacing || !input.legs.length) throw new Error("Incomplete position parameters");
  const c = liquidityRpc(), block = await c.getBlockNumber(), version = f.version;
  const token = input.draft.tokenAddress as Address, key = liquidityPoolKey(token, f.pair, version, f.feePips, f.tickSpacing);
  const npm = version === 3 ? A.v3Npm : A.v4Npm;
  const pool = version === 3 ? await c.readContract({ address: A.v3Factory, abi: liquidityReadAbi, functionName: "getPool", args: [key.currency0, key.currency1, key.fee], blockNumber: block }) : liquidityPoolId(key);
  const slot = version === 3
    ? await c.readContract({ address: pool as Address, abi: liquidityReadAbi, functionName: "slot0", blockNumber: block })
    : await c.readContract({ address: A.v4View, abi: liquidityReadAbi, functionName: "getSlot0", args: [pool], blockNumber: block });
  if (slot[0] <= 0n) throw new Error("LP_POOL_UNAVAILABLE");
  // Price failure must not hide successful inventory/fee reads.
  const pricing = Promise.race([ethUsdPrice(AbortSignal.timeout(4000)).catch(() => null), new Promise<null>(resolve => { const timer = setTimeout(() => resolve(null), 4000); timer.unref?.(); })]);
  const supplyRead = Promise.race([c.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply", blockNumber: block }).catch(() => null), new Promise<null>(resolve => { const timer = setTimeout(() => resolve(null), 4000); timer.unref?.(); })]);
  const metadata = await Promise.all([key.currency0, key.currency1].map(async asset => {
    if (asset === zeroAddress) return { symbol: "ETH", decimals: 18 };
    const [symbol, decimals] = await Promise.all([
      c.readContract({ address: asset, abi: erc20Abi, functionName: "symbol", blockNumber: block }),
      c.readContract({ address: asset, abi: erc20Abi, functionName: "decimals", blockNumber: block }),
    ]);
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(symbol) || decimals > 36) throw new Error("Invalid asset metadata");
    return { symbol, decimals };
  }));
  const globals = version === 3 ? await Promise.all([
    c.readContract({ address: pool as Address, abi: liquidityFeeReadAbi, functionName: "feeGrowthGlobal0X128", blockNumber: block }),
    c.readContract({ address: pool as Address, abi: liquidityFeeReadAbi, functionName: "feeGrowthGlobal1X128", blockNumber: block }),
  ]).catch(() => null) : null;
  const observations = await mapLiquidityBounded(input.legs, async leg => {
    const id = BigInt(leg.tokenId);
    const [beneficialOwner, nftOwner] = await Promise.all([
      c.readContract({ address: A.manager, abi: deltaLiquidityAbi, functionName: version === 3 ? "ownerOfV3" : "ownerOfV4", args: [id], blockNumber: block }),
      c.readContract({ address: npm, abi: liquidityReadAbi, functionName: "ownerOf", args: [id], blockNumber: block }),
    ]);
    let liquidity: bigint, fees: readonly [bigint, bigint] | null = null;
    if (version === 3) {
      const p = await c.readContract({ address: npm, abi: liquidityReadAbi, functionName: "positions", args: [id], blockNumber: block });
      if (p[2].toLowerCase() !== key.currency0 || p[3].toLowerCase() !== key.currency1 || p[4] !== key.fee || p[5] !== leg.tickLower || p[6] !== leg.tickUpper) throw new Error("LP_POSITION_SETTINGS_CONFLICT");
      liquidity = p[7];
      if (globals) fees = await Promise.all([leg.tickLower, leg.tickUpper].map(tick => c.readContract({ address: pool as Address, abi: liquidityFeeReadAbi, functionName: "ticks", args: [tick], blockNumber: block }))).then(([lower, upper]) => [
        liquidityAccruedFees(liquidity, liquidityInsideGrowth(globals[0], lower[2], upper[2], slot[1], leg.tickLower, leg.tickUpper), p[8], p[10]),
        liquidityAccruedFees(liquidity, liquidityInsideGrowth(globals[1], lower[3], upper[3], slot[1], leg.tickLower, leg.tickUpper), p[9], p[11]),
      ] as const).catch(() => null);
    } else {
      const [info, actual] = await Promise.all([
        c.readContract({ address: npm, abi: liquidityReadAbi, functionName: "getPoolAndPositionInfo", args: [id], blockNumber: block }),
        c.readContract({ address: npm, abi: liquidityReadAbi, functionName: "getPositionLiquidity", args: [id], blockNumber: block }),
      ]);
      if (liquidityPoolId(info[0]) !== pool || Number(BigInt.asIntN(24, info[1] >> 8n)) !== leg.tickLower || Number(BigInt.asIntN(24, info[1] >> 32n)) !== leg.tickUpper) throw new Error("LP_POSITION_SETTINGS_CONFLICT");
      liquidity = actual;
      // The core position is owned by the NPM, with the NFT ID as salt.
      fees = await Promise.all([
        c.readContract({ address: A.v4View, abi: liquidityFeeReadAbi, functionName: "getPositionInfo", args: [pool, npm, leg.tickLower, leg.tickUpper, toHex(id, { size: 32 })], blockNumber: block }),
        c.readContract({ address: A.v4View, abi: liquidityFeeReadAbi, functionName: "getFeeGrowthInside", args: [pool, leg.tickLower, leg.tickUpper], blockNumber: block }),
      ]).then(([p, inside]) => {
        if (p[0] !== actual) throw new Error("LP_FEE_POSITION_MISMATCH");
        return [liquidityAccruedFees(actual, inside[0], p[1]), liquidityAccruedFees(actual, inside[1], p[2])] as const;
      }).catch(() => null);
    }
    return { tokenId: leg.tokenId, beneficialOwner, nftOwner, liquidity, fees, amounts: liquidityAmounts(liquidity, leg.tickLower, leg.tickUpper, slot[0], false), inRange: liquidity > 0n && slot[1] >= leg.tickLower && slot[1] < leg.tickUpper };
  });
  assertLiquidityOwnership(input.expectedFrom, version, input.legs, observations);
  let quoteUsd = await pricing;
  if (f.pair === "USDG" && quoteUsd !== null) {
    const ethUsd = quoteUsd;
    quoteUsd = await (async () => {
      const reference = await c.readContract({ address: A.v3Factory, abi: liquidityReadAbi, functionName: "getPool", args: [A.weth, A.usdg, 100], blockNumber: block });
      const [referenceSlot, active] = await Promise.all([
        c.readContract({ address: reference, abi: liquidityReadAbi, functionName: "slot0", blockNumber: block }),
        c.readContract({ address: reference, abi: liquidityReadAbi, functionName: "liquidity", blockNumber: block }),
      ]);
      const usdgPerEth = (Number(referenceSlot[0]) / 2 ** 96) ** 2 * 1e12;
      return active > 0n && usdgPerEth > 0 ? ethUsd / usdgPerEth : null;
    })().catch(() => null);
  }
  const ratio = (Number(slot[0]) / 2 ** 96) ** 2 * 10 ** (metadata[0].decimals - metadata[1].decimals);
  const tokenIs0 = key.currency0 === token.toLowerCase();
  const tokenPrice = quoteUsd === null ? null : (tokenIs0 ? ratio : 1 / ratio) * quoteUsd;
  const prices = tokenIs0 ? [tokenPrice, quoteUsd] : [quoteUsd, tokenPrice];
  const rangeAt = (tick: number) => { const ratio = 1.0001 ** tick * 10 ** (metadata[0].decimals - metadata[1].decimals); return tokenIs0 ? ratio : 1 / ratio; };
  const boundaries = [rangeAt(Math.min(...input.legs.map(l => l.tickLower))), rangeAt(Math.max(...input.legs.map(l => l.tickUpper)))].sort((a, b) => a - b);
  const supplyRaw = await supplyRead;
  const supply = supplyRaw === null ? NaN : Number(formatUnits(supplyRaw, metadata[tokenIs0 ? 0 : 1].decimals));
  const capBounds = boundaries.map(boundary => boundary * (quoteUsd ?? NaN) * supply);
  const marketCapRangeUsd = capBounds.every(n => Number.isFinite(n) && n > 0) ? { lower: capBounds[0], upper: capBounds[1] } : null;
  return { block: block.toString(), assets: metadata.map((m, i) => {
    const amount = observations.reduce((n, p) => n + p.amounts[i], 0n);
    const fees = observations.some(p => p.fees === null) ? null : observations.reduce((n, p) => n + p.fees![i], 0n);
    return { symbol: m.symbol, amount: formatUnits(amount, m.decimals), usd: liquidityAssetValue(amount, m.decimals, prices[i]), unclaimed: fees === null ? null : formatUnits(fees, m.decimals), unclaimedUsd: fees === null ? null : liquidityAssetValue(fees, m.decimals, prices[i]) };
  }), range: { lower: boundaries[0], upper: boundaries[1], unit: f.pair, inRange: observations.some(p => p.inRange) }, marketCapRangeUsd };
}
