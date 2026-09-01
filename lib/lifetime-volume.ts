import { encodeAbiParameters, keccak256, type Address } from "viem";

export const HOUR_MS = 60 * 60_000;
// Lifetime volume is a cumulative statistic, not a live trading surface. A
// six-hour cadence and small recent pages keep it accurate without making a
// full OHLCV request for every source every hour.
export const LIFETIME_VOLUME_REFRESH_MS = 6 * HOUR_MS;
export const LIFETIME_VOLUME_DISCOVERY_MS = 6 * HOUR_MS;
export const LIFETIME_VOLUME_BACKFILL_MS = 30 * 60_000;
export const LIFETIME_VOLUME_RECENT_CANDLE_LIMIT = 8;
export const LIFETIME_VOLUME_HISTORICAL_CANDLE_LIMIT = 1_000;
export const LIFETIME_VOLUME_BATCH_LIMIT = 12;
export const LIFETIME_VOLUME_LEASE_MS = 5 * 60_000;

// Routine updates need only the hours since the last successful checkpoint.
// Expand after an outage so a sparse schedule never creates a permanent gap.
export function lifetimeVolumeRecentCandleLimit(lastSuccessAt: number | undefined, now = Date.now()) {
  if (!lastSuccessAt || !Number.isFinite(lastSuccessAt)) return LIFETIME_VOLUME_RECENT_CANDLE_LIMIT;
  const elapsedHours = Math.ceil(Math.max(0, now - lastSuccessAt) / HOUR_MS);
  return Math.min(LIFETIME_VOLUME_HISTORICAL_CANDLE_LIMIT, Math.max(LIFETIME_VOLUME_RECENT_CANDLE_LIMIT, elapsedHours + 2));
}

// A shared upstream cooldown, not an independent retry timer per token/worker.
export function volumeRetryDelay(failures: number, retryAfterMs = 0) {
  return Math.max(Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0,
    Math.min(30 * 60_000, 90_000 * 2 ** Math.min(Math.max(failures - 1, 0), 5)));
}

export function volumeRetryAfterMs(header: string | null, now: number) {
  if (!header) return 90_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : 90_000;
}
export const LIFETIME_VOLUME_RECENT_HOURS = 72;

export type VolumeCandle = { hourStartedAt: number; volumeUsd: number };

export function ponsV4PoolId(
  tokenAddress: Address,
  pairAddress: Address,
  poolFee: number,
  tickSpacing: number,
  hook: Address,
) {
  const token = tokenAddress.toLowerCase() as Address;
  const pair = pairAddress.toLowerCase() as Address;
  const [currency0, currency1] = pair < token ? [pair, token] : [token, pair];
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [currency0, currency1, poolFee, tickSpacing, hook],
  ));
}

export function lifetimeVolumeSummary(rows: Array<{
  normalizedTokenAddress: string;
  confirmedVolumeUsd: number;
  provisionalVolumeUsd: number;
  lastSuccessAt?: number;
}>) {
  const covered = rows.filter((row) => row.lastSuccessAt !== undefined);
  return {
    totalUsd: covered.reduce((total, row) =>
      total + (Number.isFinite(row.confirmedVolumeUsd) ? row.confirmedVolumeUsd : 0)
        + (Number.isFinite(row.provisionalVolumeUsd) ? row.provisionalVolumeUsd : 0), 0),
    tokenCoverage: new Set(covered.map((row) => row.normalizedTokenAddress)).size,
  };
}

export function parseOhlcvCandles(value: unknown): VolumeCandle[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<number, number>();
  for (const row of value) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const timestampSeconds = Number(row[0]);
    const volumeUsd = Number(row[5]);
    if (!Number.isFinite(timestampSeconds) || !Number.isFinite(volumeUsd) || timestampSeconds <= 0 || volumeUsd < 0) continue;
    const hourStartedAt = Math.floor(timestampSeconds * 1_000 / HOUR_MS) * HOUR_MS;
    unique.set(hourStartedAt, volumeUsd);
  }
  return [...unique.entries()]
    .map(([hourStartedAt, volumeUsd]) => ({ hourStartedAt, volumeUsd }))
    .sort((a, b) => b.hourStartedAt - a.hourStartedAt);
}

export function parseRecentHours(value?: string) {
  if (!value) return new Map<number, number>();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return new Map<number, number>();
    return new Map(parsed.flatMap((row): Array<[number, number]> => {
      if (!Array.isArray(row) || row.length !== 2) return [];
      const hour = Number(row[0]);
      const volume = Number(row[1]);
      return Number.isFinite(hour) && Number.isFinite(volume) && volume >= 0 ? [[hour, volume]] : [];
    }));
  } catch { return new Map<number, number>(); }
}

export function serializeRecentHours(hours: Map<number, number>) {
  return JSON.stringify([...hours.entries()].sort((a, b) => b[0] - a[0]).slice(0, LIFETIME_VOLUME_RECENT_HOURS));
}
