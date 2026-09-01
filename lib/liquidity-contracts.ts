import { encodeFunctionData, keccak256, encodeAbiParameters, parseAbi, parseAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import { DELTA_LIQUIDITY } from "./liquidity-workflow";
import { LIQUIDITY_MAX_BANDS } from "./liquidity-limits";

// Selectors were matched against the deployed manager and the successful
// V3/V4 open/collect/close receipts. Do not guess partial-withdraw selectors.
export const deltaLiquidityAbi = parseAbi([
  "function openV3(address,(int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min)[],int24,int24,uint256) payable",
  "function openV4((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),(int24 tickLower,int24 tickUpper,uint256 liquidity,uint128 amount0Max,uint128 amount1Max)[],uint256) payable",
  "function collectV3Batch(uint256[])", "function collectV4Batch(uint256[])",
  "function closeV3Batch(uint256[],uint256[],uint256[])",
  "function closeV4Batch(uint256[],uint128[],uint128[])",
  "function ownerOfV3(uint256) view returns(address)", "function ownerOfV4(uint256) view returns(address)",
  "function depositV3(uint256)", "function depositV4(uint256)",
  "function feeBps() view returns(uint16)",
]);
export const liquidityReadAbi = parseAbi([
  "function ownerOf(uint256) view returns(address)",
  "function getPool(address,address,uint24) view returns(address)",
  "function feeAmountTickSpacing(uint24) view returns(int24)",
  "function token0() view returns(address)", "function token1() view returns(address)",
  "function fee() view returns(uint24)", "function tickSpacing() view returns(int24)",
  "function liquidity() view returns(uint128)",
  "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)",
  "function getLiquidity(bytes32) view returns(uint128)",
  "function getPoolAndPositionInfo(uint256) view returns((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint256)",
  "function getPositionLiquidity(uint256) view returns(uint128)",
  "function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns(address)",
  "function initializePool((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),uint160) payable returns(int24)",
]);
export type LiquidityPoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
export function liquidityPoolKey(token: Address, pair: "ETH" | "USDG", version: 3 | 4, fee: number, tickSpacing: number): LiquidityPoolKey {
  const quote = pair === "USDG" ? DELTA_LIQUIDITY.usdg : version === 3 ? DELTA_LIQUIDITY.weth : zeroAddress;
  const ordered = [token.toLowerCase(), quote].sort() as [Address, Address];
  if (ordered[0] === ordered[1]) throw new Error("SELF_PAIR");
  return { currency0: ordered[0], currency1: ordered[1], fee, tickSpacing, hooks: zeroAddress };
}
export function liquidityPoolId(key: LiquidityPoolKey) {
  return keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}
export type LiquidityLeg = { tokenId: string; tickLower: number; tickUpper: number; liquidity: string };
export type LiquidityTransaction = { to: Address; data: Hex; value: string; purpose: string };
function tx(data: Hex, purpose: string, value = 0n): LiquidityTransaction {
  return { to: DELTA_LIQUIDITY.manager, data, value: value.toString(), purpose };
}
function ids(legs: LiquidityLeg[]) {
  if (!legs.length || legs.length > 100 || new Set(legs.map(l => l.tokenId)).size !== legs.length) throw new Error("INVALID_POSITION_LEGS");
  return legs.map(l => { if (!/^\d+$/.test(l.tokenId) || BigInt(l.tokenId) <= 0n) throw new Error("INVALID_NFT"); return BigInt(l.tokenId); });
}
export function prepareLiquidityClaim(version: 3 | 4, legs: LiquidityLeg[]) {
  return tx(encodeFunctionData({ abi: deltaLiquidityAbi, functionName: version === 3 ? "collectV3Batch" : "collectV4Batch", args: [ids(legs)] }), "claim");
}
export function prepareLiquidityClose(version: 3 | 4, legs: LiquidityLeg[], minimums: Array<{ amount0: string; amount1: string }>, percent = 100) {
  if (percent !== 100) throw new Error("DELTA_PARTIAL_WITHDRAWAL_UNVERIFIED");
  if (minimums.length !== legs.length) throw new Error("INVALID_WITHDRAWAL_MINIMUMS");
  const values = minimums.map(m => [m.amount0, m.amount1].map(a => {
    if (!/^\d+$/.test(a)) throw new Error("INVALID_WITHDRAWAL_MINIMUMS");
    const n = BigInt(a); if (n >= 1n << BigInt(version === 4 ? 128 : 256)) throw new Error("INVALID_WITHDRAWAL_MINIMUMS"); return n;
  }));
  return tx(encodeFunctionData({ abi: deltaLiquidityAbi, functionName: version === 3 ? "closeV3Batch" : "closeV4Batch", args: [ids(legs), values.map(x => x[0]), values.map(x => x[1])] }), "withdraw");
}
export type FundedLiquidityBand = { tickLower: number; tickUpper: number; liquidity: bigint; amount0: bigint; amount1: bigint; amount0Max: bigint; amount1Max: bigint };
export function prepareLiquidityOpen(input: { version: 3 | 4; pool: Address; key: LiquidityPoolKey; bands: FundedLiquidityBand[]; deadline: bigint; minimumTick: number; maximumTick: number; slippageBps: number }) {
  const { version, bands, key, deadline } = input;
  if (!bands.length || bands.length > LIQUIDITY_MAX_BANDS || input.slippageBps < 0 || input.slippageBps > 1000) throw new Error("INVALID_LIQUIDITY_BANDS");
  if (key.hooks !== zeroAddress) throw new Error("UNVERIFIED_POOL_HOOK");
  for (const b of bands) {
    if (b.tickLower >= b.tickUpper || b.tickLower % key.tickSpacing || b.tickUpper % key.tickSpacing || b.liquidity <= 0n || b.amount0Max < b.amount0 || b.amount1Max < b.amount1) throw new Error("INVALID_LIQUIDITY_BANDS");
  }
  const nativeValue = version === 4 && key.currency0 === zeroAddress ? bands.reduce((n, b) => n + b.amount0Max, 0n) : 0n;
  if (version === 4) return tx(encodeFunctionData({ abi: deltaLiquidityAbi, functionName: "openV4", args: [key, bands.map(b => ({ tickLower: b.tickLower, tickUpper: b.tickUpper, liquidity: b.liquidity, amount0Max: b.amount0Max, amount1Max: b.amount1Max })), deadline] }), "open", nativeValue);
  return tx(encodeFunctionData({ abi: deltaLiquidityAbi, functionName: "openV3", args: [input.pool, bands.map(b => ({ tickLower: b.tickLower, tickUpper: b.tickUpper, amount0Desired: b.amount0, amount1Desired: b.amount1, amount0Min: b.amount0 * BigInt(10000 - input.slippageBps) / 10000n, amount1Min: b.amount1 * BigInt(10000 - input.slippageBps) / 10000n })), input.minimumTick, input.maximumTick, deadline] }), "open");
}
export function assertLiquidityOwnership(expectedOwner: string, version: 3 | 4, legs: LiquidityLeg[], observations: { tokenId: string; beneficialOwner: string; nftOwner: string }[]) {
  ids(legs);
  for (const leg of legs) {
    const item = observations.find(x => x.tokenId === leg.tokenId);
    if (!item || item.beneficialOwner.toLowerCase() !== expectedOwner.toLowerCase() || item.nftOwner.toLowerCase() !== DELTA_LIQUIDITY.manager) throw new Error(`LIQUIDITY_OWNER_MISMATCH_V${version}`);
  }
}
