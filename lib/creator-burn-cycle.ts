/** Second-layer timing is independent of the upstream accrual/sweep schedule.
 * Input snapshots and transaction states must be verified by the signer/receipt
 * adapter. This planner never considers an unsigned request a confirmed payment.
 */
export type CreatorBurnStage = "collect" | "payout" | "burn";
export type CreatorBurnPending = { stage: CreatorBurnStage; hash: string; checkAt: number };
export type CreatorBurnCycleSnapshot = {
  enabled: boolean; active: boolean; now: number;
  upstreamClaimable: bigint; cash: bigint; reserve: bigint;
  // Burn valuation uses integer microdollars, never floating token amounts.
  reserveUsdMicros?: bigint; burnGasUsdMicros?: bigint;
  nextBurnAt: number; burnFailures: number; pending?: CreatorBurnPending;
  payoutRetryAt?: number; collectRetryAt?: number;
};
export type CreatorBurnNext =
  | { kind: "disabled" }
  | { kind: "reconcile"; hash: string; dueAt: number }
  | { kind: "execute"; stage: CreatorBurnStage; dueAt: number }
  | { kind: "wait"; dueAt: number; reason: "empty" | "burn_accumulating" | "burn_backoff" | "retry" };

export const CREATOR_BURN_RECOVERY_INTERVAL_MS = 60_000;
export const CREATOR_BURN_MINIMUM_USD_MICROS = 1_000_000n;

export function creatorBurnRetryAt(now: number, failures: number) {
  return now + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(4, Math.max(0, failures)));
}

export function nextCreatorBurnStep(s: CreatorBurnCycleSnapshot): CreatorBurnNext {
  // Receipt reconciliation remains read-only and required even after disable.
  if (s.pending) return { kind: "reconcile", hash: s.pending.hash, dueAt: s.pending.checkAt };
  if (!s.enabled) return { kind: "disabled" };
  if ([s.cash, s.reserve, s.upstreamClaimable].some(v => v < 0n)) throw new Error("Invalid layer balance");
  // Pay already allocated cash first. A failing collection or burn must not
  // keep existing cash waiting behind it, including after a layer is exited.
  if (s.cash > 0n && (s.payoutRetryAt ?? 0) <= s.now) return { kind: "execute", stage: "payout", dueAt: s.now };
  if (s.upstreamClaimable > 0n && (s.collectRetryAt ?? 0) <= s.now) return { kind: "execute", stage: "collect", dueAt: s.now };
  // Do not spend more gas on a burn while a creator payout is unresolved.
  if (s.cash > 0n || s.upstreamClaimable > 0n) return { kind: "wait", reason: "retry", dueAt: Math.min(
    s.cash > 0n ? Math.max(s.now, s.payoutRetryAt ?? s.now) : Infinity,
    s.upstreamClaimable > 0n ? Math.max(s.now, s.collectRetryAt ?? s.now) : Infinity) };
  if (!s.active || s.reserve === 0n) return { kind: "wait", reason: "empty", dueAt: s.now + CREATOR_BURN_RECOVERY_INTERVAL_MS };
  if (s.nextBurnAt > s.now) return { kind: "wait", reason: "burn_backoff", dueAt: s.nextBurnAt };
  const economical = s.reserveUsdMicros !== undefined && s.burnGasUsdMicros !== undefined
    && s.burnGasUsdMicros > 0n
    && s.reserveUsdMicros >= CREATOR_BURN_MINIMUM_USD_MICROS && s.reserveUsdMicros >= s.burnGasUsdMicros * 5n;
  if (!economical) return { kind: "wait", reason: "burn_accumulating", dueAt: s.now + 15 * 60_000 };
  return { kind: "execute", stage: "burn", dueAt: s.now };
}

/** Poll a submitted transaction on its own timer; after a confirmed receipt,
 * immediately advance to the next stage, not the next hourly upstream slot. */
export function creatorBurnReceiptDueAt(now: number, status: "pending" | "confirmed" | "reverted") {
  return status === "pending" ? now + CREATOR_BURN_RECOVERY_INTERVAL_MS : now;
}

export function assertCreatorBurnEnrollmentOwner(s: {
  wallet: string; primaryController: string; primaryBeneficiary: string;
  layerOwner: string; layerActive: boolean; layerExited: boolean;
}) {
  const wallet = s.wallet.toLowerCase();
  if (s.layerActive || s.layerExited || !/^0x[0-9a-f]{40}$/.test(wallet)
    || /^0x0{40}$/.test(wallet) || [s.primaryController, s.primaryBeneficiary, s.layerOwner]
      .some(a => a.toLowerCase() !== wallet)) throw new Error("CREATOR_BURN_ENROLLMENT_OWNER_CHANGED");
}
