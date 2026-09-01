/** Shared input/display helpers, with no server or chain dependencies. */
export const LIQUIDITY_USD_AMOUNT = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:thousand|million|billion|[kmb])?`;
export function parseLiquidityMarketCap(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?$/i.exec(value.trim().replace(/^\$/, "").replaceAll(",", ""));
  if (!match) return;
  const scale: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
  const amount = Number(match[1]) * (scale[match[2]?.toLowerCase()] ?? 1);
  return Number.isFinite(amount) && amount > 0 && amount <= 1e15 ? amount : undefined;
}
export function liquidityMarketCapInput(text: string, rangeStep: boolean) {
  if (!rangeStep && !/\b(?:range|mcap|market cap)\b/i.test(text)) return null;
  const match = new RegExp(`^(?:(?:i want|use|set|change)(?: the)?\\s+)?(?:range(?:\\s+to)?\\s*:?\\s*)?(?:from\\s+)?\\$?(${LIQUIDITY_USD_AMOUNT})\\s*(?:to|through|[-–])\\s*\\$?(${LIQUIDITY_USD_AMOUNT})(?:\\s*(?:usd|dollars?))?(?:\\s*(?:mcap|market cap))?$`, "i").exec(text);
  if (!match) return null;
  const lowerMarketCapUsd = parseLiquidityMarketCap(match[1]), upperMarketCapUsd = parseLiquidityMarketCap(match[2]);
  if (lowerMarketCapUsd === undefined || upperMarketCapUsd === undefined) return null;
  return { lowerMarketCapUsd, upperMarketCapUsd };
}
export function formatLiquidityMarketCap(value: number) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
