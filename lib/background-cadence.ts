// Fractions of the previous routine check rates. Never use these for transaction
// receipt polling, execution leases, user requests, or safety/recovery deadlines.
export const backgroundInterval = (previousMs: number, rate = 0.3) => Math.ceil(previousMs / rate);
export const CREATOR_BURN_CHECK_MS = backgroundInterval(15 * 60_000, 0.05);
export const CREATOR_BURN_HISTORY_MS = backgroundInterval(60_000, 0.05);
