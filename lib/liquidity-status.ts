import { formatUnits } from "viem";
import { formatLiquidityMarketCap } from "./liquidity-market-cap";

const Q128 = 1n << 128n;
/** Fee-growth counters deliberately wrap at uint256, as in Uniswap. */
export function liquidityAccruedFees(liquidity: bigint, growth: bigint, last: bigint, owed = 0n) {
  return owed + liquidity * BigInt.asUintN(256, growth - last) / Q128;
}
export function liquidityInsideGrowth(global: bigint, lowerOutside: bigint, upperOutside: bigint, tick: number, lower: number, upper: number) {
  const below = tick >= lower ? lowerOutside : BigInt.asUintN(256, global - lowerOutside);
  const above = tick < upper ? upperOutside : BigInt.asUintN(256, global - upperOutside);
  return BigInt.asUintN(256, global - below - above);
}
export type LiquidityPositionStatus = {
  block: string;
  assets: Array<{ symbol: string; amount: string; usd: number | null; unclaimed: string | null; unclaimedUsd: number | null }>;
  range: { lower: number; upper: number; unit: string; inRange: boolean };
  marketCapRangeUsd?: { lower: number; upper: number } | null;
};
export function liquidityAssetValue(amount: bigint, decimals: number, price: number | null) {
  const value = Number(formatUnits(amount, decimals)) * (price ?? NaN);
  return Number.isFinite(value) && value >= 0 && price !== null ? value : null;
}
const usd = (n: number | null) => n === null || !Number.isFinite(n) ? "value unavailable" : n > 0 && n < .01 ? "<$0.01" : `~$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const number = (n: number) => n.toLocaleString("en-US", { maximumSignificantDigits: 5 });
export function liquidityStatusMessage(id: string, symbol: string, status?: LiquidityPositionStatus) {
  const title = `💧 ${id} • $${symbol}`;
  if (!status) return `${title}\n\nAsset values: unavailable\nUnclaimed fees: unavailable\nRange: live status unavailable; reply with this LP ID again.`;
  const fees = status.assets.map(a => a.unclaimed === null ? `${a.symbol}: unavailable` : `${number(Number(a.unclaimed))} ${a.symbol} (${usd(a.unclaimedUsd)})`).join(" + ");
  return [title, "", ...status.assets.map(a => `${a.symbol}: ${number(Number(a.amount))} ${a.symbol} (${usd(a.usd)})`), `Unclaimed fees: ${fees}`,
    status.marketCapRangeUsd ? `Range (MCap): ${formatLiquidityMarketCap(status.marketCapRangeUsd.lower)} to ${formatLiquidityMarketCap(status.marketCapRangeUsd.upper)}` : "Range (MCap): dollar valuation unavailable.",
    ...(status.range.inRange ? [] : ["⚠️ Outside the funded range; not earning trading fees at the current price."]),
  ].join("\n");
}
