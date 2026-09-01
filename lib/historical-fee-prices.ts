// Historical reporting only, never a price source for execution or quotes.
export const FEE_PRICE_BUCKET_MS = 5 * 60_000;
export const FEE_PRICE_DAY_MS = 24 * 60 * 60_000;
export const feePriceBucket = (time: number) => Math.floor(time / FEE_PRICE_BUCKET_MS) * FEE_PRICE_BUCKET_MS;

export function parseClaimedAsset(display?: string) {
  const match = display?.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s+([A-Za-z0-9._-]+)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? { amount, symbol: match[2].toUpperCase() } : null;
}

/** Coinbase candles: time, low, high, open, close, volume. Use the opening
 * price of the claim's five-minute bucket, not a later daily/current price. */
export function historicalEthCandles(data: unknown, start: number, end: number, now: number) {
  if (!Array.isArray(data)) throw new Error("invalid historical candle response");
  const prices = new Map<number, number>();
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const time = Number(row[0]) * 1_000, low = Number(row[1]), high = Number(row[2]), open = Number(row[3]);
    if (!Number.isSafeInteger(time) || time % FEE_PRICE_BUCKET_MS !== 0 || time < start || time >= end
      || time + FEE_PRICE_BUCKET_MS > now || !Number.isFinite(open) || open <= 0
      || !Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || low > open || open > high) continue;
    prices.set(time, open);
  }
  return [...prices].map(([bucketAt, priceUsd]) => ({ bucketAt, priceUsd }));
}
