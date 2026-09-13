import { formatUnits } from "viem";
export function botAmount(raw: string, decimals = 18) {
  const value = Number(formatUnits(BigInt(raw), decimals));
  return new Intl.NumberFormat("en", { maximumSignificantDigits: 5 }).format(value);
}
export function botAsset(asset: { token: string; amount: string; symbol?: string; decimals?: number }) {
  const symbol = asset.symbol ?? `${asset.token.slice(0, 6)}...${asset.token.slice(-4)}`;
  return asset.decimals === undefined ? `${asset.amount} base units ${symbol}` : `${botAmount(asset.amount, asset.decimals)} ${symbol}`;
}
export function botBuyLabel(log: { side?: string; outcome: string; buyUsd?: number; amountIn?: string; tokenSymbol?: string; token?: string }) {
  if (log.side !== "buy" || log.outcome !== "live_filled") return null;
  const symbol = log.tokenSymbol ?? `${log.token?.slice(0, 6)}...${log.token?.slice(-4)}`;
  return log.buyUsd !== undefined ? `Bought ${new Intl.NumberFormat("en", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(log.buyUsd)} of ${symbol}`
    : log.amountIn ? `Bought ${botAmount(log.amountIn)} ETH of ${symbol}` : `Bought ${symbol}`;
}
