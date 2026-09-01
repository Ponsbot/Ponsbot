export const GECKO_REQUEST_GAP_MS = 2_500;
export const GECKO_REQUESTS_PER_MINUTE = 24;
// Preserve three slots for interactive liquidity comparisons. This is part of
// the same provider quota, never an additional allowance above the global cap.
export const GECKO_BACKGROUND_REQUESTS_PER_MINUTE = 21;
export const COINGECKO_PAID_REQUEST_GAP_MS = 250;
export const COINGECKO_PAID_REQUESTS_PER_MINUTE = 240;
export const COINGECKO_PAID_BACKGROUND_REQUESTS_PER_MINUTE = 220;
export type GeckoPriority = "background" | "interactive";

/** Use the upstream cooldown globally, not just in the caller that got the 429. */
export function geckoRetryAt(retryAfter: string | null | undefined, now: number) {
  const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
  const parsed = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1_000 : Date.parse(retryAfter ?? "");
  return Math.max(now + 60_000, Number.isFinite(parsed) ? parsed : 0);
}

export function geckoBudgetRetryAt(attempts: number[], blockedUntil: number | undefined, now: number, priority: GeckoPriority = "background", paid = false) {
  const recent = attempts.filter(at => at > now - 60_000).sort((a, b) => a - b);
  const limit = paid
    ? priority === "interactive" ? COINGECKO_PAID_REQUESTS_PER_MINUTE : COINGECKO_PAID_BACKGROUND_REQUESTS_PER_MINUTE
    : priority === "interactive" ? GECKO_REQUESTS_PER_MINUTE : GECKO_BACKGROUND_REQUESTS_PER_MINUTE;
  const gap = paid ? COINGECKO_PAID_REQUEST_GAP_MS : GECKO_REQUEST_GAP_MS;
  return Math.max(blockedUntil ?? 0,
    recent.length ? recent[recent.length - 1] + gap : 0,
    recent.length >= limit ? recent[recent.length - limit] + 60_000 : 0);
}
