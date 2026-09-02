// Per-step retries. Progress resets the counter; uncertain transactions never
// lose their saved envelope/nonce when background reconciliation stops.
export const LIQUIDITY_WRITE_ATTEMPTS = 6;
export const LIQUIDITY_TOTAL_ATTEMPTS = 18;
import { LIQUIDITY_EXECUTION_RESERVE_MS } from "./liquidity-timing";
export { LIQUIDITY_EXECUTION_RESERVE_MS } from "./liquidity-timing";

/** CDP requires a new key when a repriced retry changes transaction bytes. */
export function liquidityStepIdempotencyKey(requestId: string, stepIndex: number, recoveryCount = 0) {
  return `${requestId}:${stepIndex}:r${recoveryCount}`;
}

/** Applies to every write, including approvals/claims without a contract deadline.
 * Receipt reconciliation remains allowed after this window has closed.
 */
export function liquidityExecutionWindowOpen(plan: { executionDeadline: number }, now: number) {
  return Number.isFinite(plan.executionDeadline) && now < plan.executionDeadline - LIQUIDITY_EXECUTION_RESERVE_MS;
}

/** Save diagnostic codes only, never arbitrary RPC/CDP payloads or AI output. */
export function liquidityDiagnostic(error: unknown, fallback: "LP_WORKFLOW_FAILED" | "LP_EXECUTION_FAILED") {
  const message = error instanceof Error ? error.message : "";
  if (/^[A-Z][A-Z0-9_]{2,99}$/.test(message)) return message;
  if (message === "Wallet is not active") return "LP_WALLET_INACTIVE";
  if (/insufficient funds|exceeds the balance/i.test(message)) return "LP_INSUFFICIENT_FUNDS";
  return fallback;
}
type RecoveryState = { status: string; retryCount?: number; nextAttemptAt?: number };
export function liquidityRecoveryStopped(state: RecoveryState) {
  return state.status === "manual_review" && (state.retryCount ?? 0) >= LIQUIDITY_TOTAL_ATTEMPTS;
}
export function liquidityRecoveryDue(state: RecoveryState, now: number) {
  return !liquidityRecoveryStopped(state) && (state.nextAttemptAt ?? 0) <= now;
}

type RetryCall = { purpose: string };
type RetryStep = { confirmed?: boolean; reverted?: boolean; transactionHash?: string };

/** Return the immutable confirmed prefix that may be reused for an explicit
 * post-funding retry. Every purchase in the signed plan must already be
 * receipt-confirmed, and the next step may never be another purchase. */
export function liquidityFundedRetryPrefix(plan: { operation: string; calls: RetryCall[] }, steps: RetryStep[]) {
  if (plan.operation !== "open" || !plan.calls.length || steps.length > plan.calls.length) return null;
  const fundingPurposes = new Set(["funding_buy", "funding_usdg_to_eth"]);
  const fundingIndexes = plan.calls.map((call, index) => fundingPurposes.has(call.purpose) ? index : -1).filter(index => index >= 0);
  if (!fundingIndexes.length || fundingIndexes.some(index => !steps[index]?.confirmed || !steps[index]?.transactionHash || steps[index]?.reverted)) return null;
  const firstIncomplete = steps.findIndex(step => !step.confirmed || step.reverted);
  const prefixLength = firstIncomplete < 0 ? steps.length : firstIncomplete;
  const prefix = steps.slice(0, prefixLength);
  if (prefix.some(step => !step.confirmed || !step.transactionHash || step.reverted)) return null;
  if (steps.slice(prefixLength).some(step => step.confirmed)) return null;
  if (prefixLength >= plan.calls.length || fundingPurposes.has(plan.calls[prefixLength]!.purpose)) return null;
  return prefix;
}

/** HTTP diagnostics only: never retain an HTML gateway body or signer secrets. */
export async function liquiditySignerResponse<T>(response: Response): Promise<T> {
  let result: unknown;
  try { result = await response.json(); }
  catch { throw new Error(`LP_SIGNER_HTTP_${response.status}_INVALID_JSON`); }
  if (!response.ok) {
    const code = result && typeof result === "object" && "diagnosticCode" in result ? result.diagnosticCode : undefined;
    throw new Error(typeof code === "string" && /^[A-Z][A-Z0-9_]{2,99}$/.test(code) ? code : `LP_SIGNER_HTTP_${response.status}`);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("LP_SIGNER_INVALID_RESPONSE");
  return result as T;
}
