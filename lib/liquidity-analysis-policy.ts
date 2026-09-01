import type { LiquidityCandidate } from "./liquidity-workflow";

export const LIQUIDITY_VOLUME_FILTERS = {
  high: { hour: 1_000, day: 10_000 },
  low: { hour: 100, day: 1_000 },
} as const;
export type LiquidityVolumeTier = "high" | "low" | "limited";
export function liquidityMetric(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string" || typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
export function liquidityVolumeTier(hour: number | null, day: number | null): LiquidityVolumeTier {
  for (const tier of ["high", "low"] as const) {
    const filter = LIQUIDITY_VOLUME_FILTERS[tier];
    if (hour !== null && hour >= filter.hour || day !== null && day >= filter.day) return tier;
  }
  return "limited";
}

/** Conservative activity proxy, not an APR or a promise of future volume.
 * Temper a one-hour spike with longer windows when available. */
export function liquidityHourlyActivity(p: LiquidityCandidate): number | null {
  const windows = [p.volumeHourUsd, p.volumeSixHourUsd == null ? null : p.volumeSixHourUsd / 6, p.volumeDayUsd == null ? null : p.volumeDayUsd / 24]
    .filter((v): v is number => v != null && Number.isFinite(v) && v >= 0);
  return windows.length ? Math.min(...windows) : null;
}
export function liquidityFeeOpportunity(p: LiquidityCandidate): number | null {
  const activity = liquidityHourlyActivity(p), share = p.estimatedBudgetSharePercent;
  if (activity === null || share == null || !Number.isFinite(share) || !Number.isFinite(p.netLpFeePercent)) return null;
  return activity * p.netLpFeePercent / 100 * share / 100;
}
/** Separate measured current trading from historical-only and unknown activity.
 * A quiet last hour cannot be rescued by yesterday's volume. */
export function liquidityActivityConfidence(p: LiquidityCandidate) {
  if (p.volumeHourUsd === 0) return 0;
  if ((p.volumeHourUsd ?? 0) > 0) return 3;
  return (liquidityHourlyActivity(p) ?? 0) > 0 ? 2 : 1;
}
export function liquidityHigherRisk(p: LiquidityCandidate) {
  const depth = p.activeDepthUsd;
  // Reserve the headline label for genuinely extreme conditions. Ordinary
  // small-token pools can still show specific thin-depth, fee, or activity
  // notes without branding every imperfect option as "higher risk".
  return p.traderFeePercent >= 8
    || depth != null && depth < 5 && p.traderFeePercent >= 5
    || depth != null && depth < 1 && p.swapsHour === 0;
}
/** Sustained volume first; depth, cost and modeled share are tie-breakers.
 * Absolute raw liquidity integers are not comparable across token decimals. */
export function compareLiquidityCandidates(a: LiquidityCandidate, b: LiquidityCandidate) {
  const scoreA = liquidityFeeOpportunity(a), scoreB = liquidityFeeOpportunity(b);
  return liquidityActivityConfidence(b) - liquidityActivityConfidence(a)
    || (liquidityHourlyActivity(b) ?? -1) - (liquidityHourlyActivity(a) ?? -1)
    || Number(liquidityHigherRisk(a)) - Number(liquidityHigherRisk(b))
    || (b.activeDepthUsd ?? -1) - (a.activeDepthUsd ?? -1)
    || a.traderFeePercent - b.traderFeePercent
    || (scoreB ?? -1) - (scoreA ?? -1)
    || a.id.localeCompare(b.id);
}

/** AI may compare depth/fees within a similar-volume group, never move a pool
 * ahead of one with >=2x sustained activity. Anchored groups stay transitive. */
export function liquidityRankingGroups(candidates: LiquidityCandidate[]) {
  const groups = new Map<string, number>(); let group = -1, anchor: LiquidityCandidate | undefined;
  for (const p of [...candidates].sort(compareLiquidityCandidates)) {
    const activity = liquidityHourlyActivity(p) ?? 0, leading = anchor ? liquidityHourlyActivity(anchor) ?? 0 : 0;
    if (!anchor || liquidityActivityConfidence(anchor) !== liquidityActivityConfidence(p) || leading > 0 && activity <= leading / 2) {
      anchor = p; group++;
    }
    groups.set(p.id, group);
  }
  return groups;
}
