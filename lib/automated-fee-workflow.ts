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
