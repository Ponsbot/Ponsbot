export const PAGE_REFRESH_SESSION_MS = 5 * 60_000;
export const WEBSITE_MARKET_TTL_MS = 60_000;
export const WEBSITE_REFRESH_LEASE_MS = 45_000;
export const WEBSITE_REFRESH_RETRY_MS = 30_000;
export const WEBSITE_METADATA_TTL_MS = 60 * 60_000;

export function pageRefreshActive(startedAt: number, now: number) {
  return now >= startedAt && now - startedAt < PAGE_REFRESH_SESSION_MS;
}

export function snapshotFresh(value: unknown, observedAt: number | undefined, now: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    && observedAt !== undefined && observedAt <= now && now - observedAt < WEBSITE_MARKET_TTL_MS;
}

export function newerSnapshot(existingAt: number | undefined, incomingAt: number | undefined) {
  return incomingAt !== undefined && Number.isFinite(incomingAt) && (existingAt === undefined || incomingAt >= existingAt);
}

/** Strict rolling minute, shared across instances, including failed upstream attempts. */
export function reserveProviderAttempt(prior: number[], now: number, limit: number) {
  const recent = prior.filter((time) => time > now - 60_000);
  return { allowed: recent.length < limit, attempts: recent.length < limit ? [...recent, now] : recent };
}
