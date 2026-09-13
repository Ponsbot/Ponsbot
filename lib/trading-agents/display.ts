import { formatUnits } from "viem";
export function botAmount(raw: string, decimals = 18) {
  const value = Number(formatUnits(BigInt(raw), decimals));
  return new Intl.NumberFormat("en", { maximumSignificantDigits: 5 }).format(value);
}
export function botDollars(usd?:number) { return usd!==undefined&&Number.isFinite(usd)&&usd>=0?` (${new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(usd)})`:''; }
export function botAsset(asset: { token: string; amount: string; symbol?: string; decimals?: number; usdValue?:number }) {
  const symbol = asset.symbol ?? `${asset.token.slice(0, 6)}...${asset.token.slice(-4)}`;
  return (asset.decimals === undefined ? `${asset.amount} base units ${symbol}` : `${botAmount(asset.amount, asset.decimals)} ${symbol}`)+botDollars(asset.usdValue);
}
export function botBuyLabel(log: { side?: string; outcome: string; buyUsd?: number; tradeUsd?: number; amountIn?: string; amountOut?: string; tokenSymbol?: string; tokenDecimals?: number; token?: string }) {
  if (!log.side || !["buy","sell"].includes(log.side) || log.outcome !== "live_filled") return null;
  const symbol = log.tokenSymbol ?? `${log.token?.slice(0, 6)}...${log.token?.slice(-4)}`;
  const rawAmount=log.side==="buy"?log.amountOut:log.amountIn;
  const quantity=rawAmount && log.tokenDecimals!==undefined?`${botAmount(rawAmount,log.tokenDecimals)} `:"";
  const usd=log.tradeUsd??(log.side==="buy"?log.buyUsd:undefined);
  const dollars=usd!==undefined && Number.isFinite(usd) && usd>=0?` (${new Intl.NumberFormat("en", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(usd)})`:"";
  return `${log.side==="buy"?"Bought":"Sold"} ${quantity}${symbol}${dollars}`;
}
