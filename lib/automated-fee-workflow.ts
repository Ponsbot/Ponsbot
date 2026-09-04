export const AUTOMATED_FEE_WORKFLOW_CONTINUATION = "automated fee workflow continuation required";

export function isAutomatedFeeWorkflowContinuation(error: unknown) {
  if (!(error instanceof Error)) return false;
  // Convex wraps errors crossing runAction with a prefix and a stack trace.
  const firstLine = error.message.trim().split(/\r?\n/, 1)[0].replace(/^Uncaught Error: /, "");
  return firstLine === AUTOMATED_FEE_WORKFLOW_CONTINUATION;
}

export type AutomatedFeeControllerRecoveryRecord = {
  status: "reserved" | "prepared" | "broadcast" | "confirmed" | "failed" | "manual_review";
  transactionHash?: string;
  signedTransaction?: string;
  ownerXUserId?: string;
  walletRef?: string;
  vaultAddress?: string;
  workflowRoot?: boolean;
  diagnosticCode?: string;
};

export function automatedFeeControllerTransactionMayExist(record: AutomatedFeeControllerRecoveryRecord | null | undefined) {
  return Boolean(record && (
    record.transactionHash
    || record.signedTransaction
    || ["prepared", "broadcast", "confirmed", "manual_review"].includes(record.status)
  ));
}

export function isAutomatedFeeControllerWorkflowRoot(record: AutomatedFeeControllerRecoveryRecord) {
  return record.workflowRoot === true || Boolean(record.ownerXUserId && record.walletRef && record.vaultAddress);
}

export function isTerminalAutomatedFeeControllerReview(record: AutomatedFeeControllerRecoveryRecord) {
  return record.status === "manual_review" && [
    "CONTROLLER_TRANSACTION_DROPPED",
    "CONTROLLER_TRANSACTION_REVERTED",
    "CONTROLLER_TRANSACTION_PENDING_TOO_LONG",
  ].includes(record.diagnosticCode ?? "");
}

export function automatedFeeFailureRequiresManualReview(detail: string) {
  if (automatedFeeRejectedPreBroadcastStage(detail)) return false;
  // The transport wrapper starts with "automated fee". Do not let its generic
  // "Missing or invalid parameters" RPC error masquerade as a protocol invariant
  // failure. Read-only inspections can be retried with a fresh pinned block;
  // saved signed envelopes/receipts remain authoritative on the next pass.
  const reason = detail.replace(/^automated fee signer request failed \[[^\]]+\]:\s*/i, "");
  return /\bAUTOMATED_FEE_[A-Z_]*(?:MISMATCH|REVERTED|DROPPED|INVALID)\b/i.test(detail)
    || /automated fee[^\n]*(?:mismatch|reverted|dropped|invalid|out of order)/i.test(reason);
}

/** Only an explicit simulation rejection before signing can get a new quote.
 * Timeouts and submitted/reverted transactions are deliberately excluded. */
export function isUnsignedProcessingSimulationFailure(detail: string, run: {
  processingTransactionHash?: string; processingSignedTransaction?: string;
  processingPreparedAt?: number; processingBroadcastAt?: number;
  deliveryTransactionHash?: string; deliverySignedTransaction?: string;
}) {
  return !run.processingTransactionHash && !run.processingSignedTransaction
    && !run.processingPreparedAt && !run.processingBroadcastAt
    && !run.deliveryTransactionHash && !run.deliverySignedTransaction
    && detail.includes("[/v1/automated-fees/prepare]")
    && /SIMULATION_OR_REVERT: Execution reverted for an unknown reason\./.test(detail);
}

export type AutomatedFeeTransactionStage = "sweep" | "processing" | "delivery";

export function automatedFeeRejectedPreBroadcastStage(detail: string): AutomatedFeeTransactionStage | null {
  if (!/max fee per gas less than block base fee|fee cap less than block base fee/i.test(detail)) return null;
  if (/\[\/v1\/automated-fees\/broadcast-sweep\]/i.test(detail)) return "sweep";
  if (/\[\/v1\/automated-fees\/broadcast-delivery\]/i.test(detail)) return "delivery";
  if (/\[\/v1\/automated-fees\/broadcast\]/i.test(detail)) return "processing";
  return null;
}
