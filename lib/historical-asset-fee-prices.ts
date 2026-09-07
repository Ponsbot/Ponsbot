import { geckoSharedFetch } from "./gecko-shared";
import { FEE_PRICE_BUCKET_MS } from "./historical-fee-prices";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function historicalAssetCandle(body: unknown, address: string, bucketAt: number): number | undefined {
  const meta = record(record(body).meta);
  const matches = [record(meta.base).address, record(meta.quote).address]
    .some(value => typeof value === "string" && value.toLowerCase() === address.toLowerCase());
  if (!matches || !Number.isSafeInteger(bucketAt) || bucketAt <= 0 || bucketAt % FEE_PRICE_BUCKET_MS
    || bucketAt + FEE_PRICE_BUCKET_MS > Date.now()) return undefined;
  const rows = record(record(record(body).data).attributes).ohlcv_list;
  const candle = Array.isArray(rows) ? rows.find((row: unknown): row is number[] =>
    Array.isArray(row) && row.every(value => typeof value === "number" && Number.isFinite(value)) && row[0] * 1000 === bucketAt) : undefined;
  if (!candle || candle.length < 6 || !candle.slice(1, 5).every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0)
    || candle[2] < Math.max(candle[1], candle[3], candle[4]) || candle[3] > Math.min(candle[1], candle[4])) return undefined;
  return candle[1] as number;
}

/** Historical opening price only. Missing candles never become current prices or a presumed peg. */
export async function historicalAssetFeePrice(address: string, bucketAt: number) {
  if (!/^0x[0-9a-f]{40}$/i.test(address)) return undefined;
  const base = "https://api.geckoterminal.com/api/v2/networks/robinhood";
  const response = await geckoSharedFetch(base + "/tokens/" + address + "/pools?page=1");
  if (!response.ok) return undefined;
  const body: unknown = await response.json();
  const data = record(body).data;
  const pools = (Array.isArray(data) ? data : []).map(record).filter(pool => {
    const relationships = record(pool.relationships);
    return [record(record(relationships.base_token).data).id, record(record(relationships.quote_token).data).id]
      .some(id => typeof id === "string" && id.toLowerCase() === "robinhood_" + address.toLowerCase());
  }).sort((a, b) => Number(record(b.attributes).reserve_in_usd || 0) - Number(record(a.attributes).reserve_in_usd || 0)).slice(0, 2);
  for (const pool of pools) {
    const poolAddress = record(pool.attributes).address;
    if (typeof poolAddress !== "string" || !/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(poolAddress)) continue;
    const query = new URLSearchParams({ aggregate: "5", before_timestamp: String((bucketAt + FEE_PRICE_BUCKET_MS) / 1000),
      limit: "2", currency: "usd", token: address, include_empty_intervals: "false" });
    const candles = await geckoSharedFetch(base + "/pools/" + poolAddress + "/ohlcv/minute?" + query, 86_400_000);
    if (!candles.ok) continue;
    const priceUsd = historicalAssetCandle(await candles.json(), address, bucketAt);
    if (priceUsd !== undefined) return { priceUsd, source: "gecko:robinhood:" + poolAddress + ":300:open" };
  }
  return undefined;
}
