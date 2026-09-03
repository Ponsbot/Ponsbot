export const FEE_ACCUMULATION_THRESHOLD_WEI = 7_000_000_000_000_000n;
export const FEE_CHECK_INTERVAL_MS = 60 * 60_000;
export const FEE_WORKERS = 4;
export const FEE_WORK_LEASE_MS = 5 * 60_000;

/** Fixed enrollment-relative cadence; coalesce missed slots, never replay them. */
export function nextFeeCheck(program: { scheduleAnchorAt?: number; enrolledAt?: number; createdAt?: number }, now: number) {
  const anchor = program.scheduleAnchorAt ?? program.enrolledAt ?? program.createdAt ?? now;
  return anchor + Math.max(1, Math.floor((now - anchor) / FEE_CHECK_INTERVAL_MS) + 1) * FEE_CHECK_INTERVAL_MS;
}

export function feeRetryDelay(attempt: number, retryAfterMs = 0) {
  return Math.max(Math.min(Math.max(0, retryAfterMs), 60 * 60_000), Math.min(5 * 60_000, 30_000 * 2 ** Math.min(4, Math.max(0, attempt))));
}

/** Mirrors the frozen Pons fee policy, including accrued (not current) buyback earmarks. */
export function netCreatorFees(fees: bigint, tax: bigint, buyback: bigint, protocolBps: bigint) {
  if ([fees, tax, buyback, protocolBps].some(n => n < 0n) || protocolBps > 10_000n) throw new Error("invalid fee accounting");
  const bucket = fees - fees * protocolBps / 10_000n;
  return bucket - (buyback > bucket ? bucket : buyback) + tax;
}

export function feeThresholdReached(value: string | undefined) {
  return value !== undefined && /^\d+$/.test(value) && BigInt(value) >= FEE_ACCUMULATION_THRESHOLD_WEI;
}
