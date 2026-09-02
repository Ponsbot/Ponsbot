// One shared on-chain/Gecko indexing pass per minute is sufficient for the
// public browsing surfaces. Individual trade feeds can still refresh from
// their CDN-backed source without acquiring this global RPC lease.
export const MARKET_INDEX_MIN_REFRESH_MS = 60_000;
export const CURRENT_MARKET_CAP_TTL_MS = 60_000;
export const CATALOG_GECKO_REFRESH_MS = 15 * 60_000;

export function geckoMarketCap(marketCap: unknown, fdv: unknown) {
  const verified = Number(marketCap);
  if (Number.isFinite(verified) && verified > 0) return verified;
  const fallback = Number(fdv);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : undefined;
}

// Liquidity bounds are converted to fixed ticks using total token supply.
// Gecko's market_cap_usd can use circulating supply, so its FDV field is the
// matching live valuation for this particular interface.
export function geckoLiquidityMarketCap(marketCap: unknown, fdv: unknown) {
  const totalSupplyValue = Number(fdv);
  if (Number.isFinite(totalSupplyValue) && totalSupplyValue > 0) return totalSupplyValue;
  const fallback = Number(marketCap);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : undefined;
}

export function freshMarketCap(value: number | undefined, updatedAt: number | undefined, now: number) {
  return value !== undefined && Number.isFinite(value) && value >= 0
    && updatedAt !== undefined && now - updatedAt < CURRENT_MARKET_CAP_TTL_MS;
}

export function marketRefreshAllowed(lastRecordedAt: number | undefined, now: number) {
  return lastRecordedAt === undefined || now - lastRecordedAt >= MARKET_INDEX_MIN_REFRESH_MS;
}

export function catalogMarketRefreshDue(lastRefreshedAt: number | undefined, now: number) {
  return lastRefreshedAt === undefined || now - lastRefreshedAt >= CATALOG_GECKO_REFRESH_MS;
}

export function marketEventKey(transactionHash: string, logIndex: number) {
  return `${transactionHash.toLowerCase()}:${logIndex}`;
}

// Uniswap V4's Swap event reports BalanceDelta from the caller's perspective:
// a positive token delta is received by the swapper (buy), while a negative
// delta is paid into the pool (sell). V3 uses the opposite event convention.
export function v4TokenTradeKind(tokenDelta: bigint) {
  if (tokenDelta === 0n) return undefined;
  return tokenDelta > 0n ? "buy" as const : "sell" as const;
}

export function marketFieldsChanged(
  current: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
) {
  if (!current) return true;
  return Object.entries(next).some(([key, value]) => {
    const prior = current[key];
    if (Array.isArray(value) && Array.isArray(prior)) {
      return value.length !== prior.length || value.some((item, index) => item !== prior[index]);
    }
    return prior !== value;
  });
}
