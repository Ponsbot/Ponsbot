import type { FundedLiquidityBand } from "./liquidity-contracts";
import { LIQUIDITY_MAX_BANDS } from "./liquidity-limits";
export const LIQUIDITY_Q96 = 1n << 96n;
// Uniswap TickMath constants, identical for V3 and V4 ticks.
const ratios = ["fffcb933bd6fad37aa2d162d1a594001", "fff97272373d413259a46990580e213a", "fff2e50f5f656932ef12357cf3c7fdcc", "ffe5caca7e10e4e61c3624eaa0941cd0", "ffcb9843d60f6159c9db58835c926644", "ff973b41fa98c081472e6896dfb254c0", "ff2ea16466c96a3843ec78b326b52861", "fe5dee046a99a2a811c461f1969c3053", "fcbe86c7900a88aedcffc83b479aa3a4", "f987a7253ac413176f2b074cf7815e54", "f3392b0822b70005940c7a398e4b70f3", "e7159475a2c29b7443b29c7fa6e889d9", "d097f3bdfd2022b8845ad8f792aa5825", "a9f746462d870fdf8a65dc1f90e061e5", "70d869a156d2a1b890bb3df62baf32f7", "31be135f97d08fd981231505542fcfa6", "9aa508b5b7a84e1c677de54f3e99bc9", "5d6af8dedb81196699c329225ee604", "2216e584f5fa1ea926041bedfe98", "48a170391f7dc42444e8fa2"].map(x => BigInt(`0x${x}`));
export function liquiditySqrtTick(tick: number) {
  if (!Number.isInteger(tick) || Math.abs(tick) > 887272) throw new Error("INVALID_TICK");
  let ratio = 1n << 128n;
  for (let i = 0; i < ratios.length; i++) if (Math.abs(tick) & (1 << i)) ratio = ratio * ratios[i] >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) ? 1n : 0n);
}
export function liquidityAmounts(liquidity: bigint, lower: number, upper: number, price: bigint, roundUp = true): [bigint, bigint] {
  if (liquidity < 0n || price <= 0n || lower >= upper) throw new Error("INVALID_LIQUIDITY_AMOUNTS");
  const a = liquiditySqrtTick(lower), b = liquiditySqrtTick(upper), q = LIQUIDITY_Q96;
  const div = (n: bigint, d: bigint) => roundUp ? (n + d - 1n) / d : n / d;
  return price <= a ? [div(liquidity * q * (b - a), b * a), 0n]
    : price >= b ? [0n, div(liquidity * (b - a), q)]
      : [div(liquidity * q * (b - price), b * price), div(liquidity * (price - a), q)];
}
export function liquidityTickAtSqrt(price: bigint) {
  if (price < liquiditySqrtTick(-887272) || price >= liquiditySqrtTick(887272)) throw new Error("INVALID_POOL_PRICE");
  let low = -887272, high = 887272;
  while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (liquiditySqrtTick(mid) <= price) low = mid; else high = mid; }
  return low;
}
export function liquidityBands(input: { tick: number; spacing: number; down: number; up: number; tokenIs0: boolean; count: number; shape: "flat" | "bell" | "bid_ask" }) {
  const { tick, spacing, count, shape } = input;
  if (input.down <= 0 || input.down >= 100 || input.up <= 0 || count < 1 || count > LIQUIDITY_MAX_BANDS || !Number.isInteger(count) || !Number.isInteger(spacing) || spacing <= 0) throw new Error("INVALID_BANDS");
  if (shape !== "flat" && count < 3) throw new Error("INVALID_BANDS");
  // Displayed price is quote/token; invert the percentage boundaries when
  // the requested token is currency1. Do not invert twice for six decimals.
  const lowerRatio = input.tokenIs0 ? 1 - input.down / 100 : 1 / (1 + input.up / 100);
  const upperRatio = input.tokenIs0 ? 1 + input.up / 100 : 1 / (1 - input.down / 100);
  const lower = Math.floor((tick + Math.log(lowerRatio) / Math.log(1.0001)) / spacing) * spacing;
  const upper = Math.ceil((tick + Math.log(upperRatio) / Math.log(1.0001)) / spacing) * spacing;
  return liquidityBandsBetweenTicks(lower, upper, spacing, count, shape);
}
function liquidityBandsBetweenTicks(lower: number, upper: number, spacing: number, count: number, shape: "flat" | "bell" | "bid_ask") {
  if (![lower, upper, spacing, count].every(Number.isInteger) || spacing <= 0 || count < 1 || count > LIQUIDITY_MAX_BANDS || lower >= upper) throw new Error("INVALID_BANDS");
  if (shape !== "flat" && count < 3) throw new Error("INVALID_BANDS");
  if (lower < -887272 || upper > 887272 || (upper - lower) / spacing < count) throw new Error("INVALID_BANDS");
  const boundaries = Array.from({ length: count + 1 }, (_, i) => lower + Math.floor((upper - lower) / spacing * i / count) * spacing);
  // Even counts have two symmetric center bands; odd counts have one.
  return Array.from({ length: count }, (_, i) => ({ tickLower: boundaries[i], tickUpper: boundaries[i + 1], weight: shape === "flat" ? 1 : shape === "bell" ? 1 + Math.min(i, count - 1 - i) : 1 + Math.floor(Math.abs(i - (count - 1) / 2)) }));
}
/** Absolute USD market-cap bounds. Never recenter a user's targets on refresh. */
export function liquidityMarketCapBands(input: {
  lowerUsd: number; upperUsd: number; supply: number; pairedAssetUsd: number;
  tokenDecimals: number; pairDecimals: number; tokenIs0: boolean; sqrt: bigint;
  spacing: number; count: number; shape: "flat" | "bell" | "bid_ask";
}) {
  const { lowerUsd, upperUsd, supply, pairedAssetUsd, tokenDecimals, pairDecimals, tokenIs0, sqrt, spacing, count, shape } = input;
  if (![lowerUsd, upperUsd, supply, pairedAssetUsd].every(n => Number.isFinite(n) && n > 0) || lowerUsd >= upperUsd
    || !Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 255 || !Number.isInteger(pairDecimals) || pairDecimals < 0 || pairDecimals > 255) throw new Error("LP_INVALID_MCAP_RANGE");
  const decimalScale = 10 ** (pairDecimals - tokenDecimals);
  const rawRatio = (cap: number) => { const quotePerToken = cap / supply / pairedAssetUsd * decimalScale; return tokenIs0 ? quotePerToken : 1 / quotePerToken; };
  const capAtRatio = (ratio: number) => (tokenIs0 ? ratio : 1 / ratio) / decimalScale * pairedAssetUsd * supply;
  const referenceUsd = capAtRatio((Number(sqrt) / 2 ** 96) ** 2);
  if (!Number.isFinite(referenceUsd) || referenceUsd <= 0) throw new Error("LP_INVALID_MCAP_RANGE");
  const lowerRatio = rawRatio(tokenIs0 ? lowerUsd : upperUsd), upperRatio = rawRatio(tokenIs0 ? upperUsd : lowerUsd);
  if (![lowerRatio, upperRatio].every(n => Number.isFinite(n) && n > 0)) throw new Error("LP_INVALID_MCAP_RANGE");
  const tickLower = Math.floor(Math.log(lowerRatio) / Math.log(1.0001) / spacing) * spacing;
  const tickUpper = Math.ceil(Math.log(upperRatio) / Math.log(1.0001) / spacing) * spacing;
  const bands = liquidityBandsBetweenTicks(tickLower, tickUpper, spacing, count, shape);
  const roundedLowerUsd = capAtRatio(1.0001 ** (tokenIs0 ? tickLower : tickUpper));
  const roundedUpperUsd = capAtRatio(1.0001 ** (tokenIs0 ? tickUpper : tickLower));
  if (![roundedLowerUsd, roundedUpperUsd].every(n => Number.isFinite(n) && n > 0)) throw new Error("LP_INVALID_MCAP_RANGE");
  return { bands, range: { lowerUsd, upperUsd, referenceUsd, roundedLowerUsd, roundedUpperUsd, tickLower, tickUpper } };
}
/** Fit exact base-unit asset budgets, never floating-point uint128 amounts. */
export function fundLiquidityBands(bands: ReturnType<typeof liquidityBands>, price: bigint, max0: bigint, max1: bigint, marginBps = 0): FundedLiquidityBand[] {
  if (max0 < 0n || max1 < 0n || marginBps < 0 || marginBps > 1000) throw new Error("INVALID_LIQUIDITY_BUDGET");
  const make = (base: bigint) => bands.map(b => {
    const liquidity = base * BigInt(b.weight), [amount0, amount1] = liquidityAmounts(liquidity, b.tickLower, b.tickUpper, price);
    const maximum = (a: bigint) => (a * BigInt(10000 + marginBps) + 9999n) / 10000n;
    return { ...b, liquidity, amount0, amount1, amount0Max: maximum(amount0), amount1Max: maximum(amount1) };
  });
  let low = 0n, high = (1n << 128n) / BigInt(Math.max(...bands.map(b => b.weight)));
  while (high - low > 1n) {
    const mid = (high + low) / 2n, rungs = make(mid);
    if (rungs.reduce((n, r) => n + r.amount0Max, 0n) <= max0 && rungs.reduce((n, r) => n + r.amount1Max, 0n) <= max1) low = mid; else high = mid;
  }
  if (low === 0n) throw new Error("LIQUIDITY_AMOUNT_TOO_SMALL");
  return make(low);
}
