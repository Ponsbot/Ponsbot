import { describe, expect, it } from "vitest";
import {
  AUTOMATED_FEE_WORKFLOW_CONTINUATION,
  automatedFeeFailureRequiresManualReview,
  isUnsignedProcessingSimulationFailure,
  automatedFeeRejectedPreBroadcastStage,
  automatedFeeControllerTransactionMayExist,
  isAutomatedFeeControllerWorkflowRoot,
  isAutomatedFeeWorkflowContinuation,
  isTerminalAutomatedFeeControllerReview,
} from "../lib/automated-fee-workflow";

describe("unsigned processing simulation retries", () => {
  const detail = "automated fee signer request failed [/v1/automated-fees/prepare]: SIMULATION_OR_REVERT: Execution reverted for an unknown reason.";
  it("recognizes a definitive pre-signing simulation failure", () => {
    expect(isUnsignedProcessingSimulationFailure(detail, {})).toBe(true);
  });
  it.each(["processingTransactionHash", "processingSignedTransaction", "processingPreparedAt", "processingBroadcastAt", "deliveryTransactionHash", "deliverySignedTransaction"])("never requotes with %s recorded", field => {
    expect(isUnsignedProcessingSimulationFailure(detail, { [field]: 1 } as any)).toBe(false);
  });
  it.each(["request timed out", "AUTOMATED_FEE_PROCESSING_REVERTED", "automated fee signer request failed [/v1/automated-fees/broadcast]: SIMULATION_OR_REVERT: Execution reverted for an unknown reason."])("excludes %s", error => {
    expect(isUnsignedProcessingSimulationFailure(error, {})).toBe(false);
  });
});

describe("automated fee workflow continuation", () => {
  it("retries base-fee broadcast rejection instead of freezing the vault", () => {
    expect(automatedFeeFailureRequiresManualReview("SIGNER_INTERNAL_FAILURE: Missing or invalid parameters. max fee per gas less than block base fee")).toBe(false);
    expect(automatedFeeFailureRequiresManualReview("automated fee signer request failed [/v1/automated-fees/broadcast]: Missing or invalid parameters. max fee per gas less than block base fee")).toBe(false);
    expect(automatedFeeFailureRequiresManualReview("AUTOMATED_FEE_PROCESSING_REVERTED")).toBe(true);
    expect(automatedFeeFailureRequiresManualReview("automated fee processing receipt mismatch")).toBe(true);
  });

  it("identifies deterministic pre-broadcast fee-envelope rejections", () => {
    expect(automatedFeeRejectedPreBroadcastStage("automated fee signer request failed [/v1/automated-fees/broadcast]: Missing or invalid parameters: max fee per gas less than block base fee")).toBe("processing");
    expect(automatedFeeRejectedPreBroadcastStage("automated fee signer request failed [/v1/automated-fees/broadcast-sweep]: fee cap less than block base fee")).toBe("sweep");
    expect(automatedFeeRejectedPreBroadcastStage("automated fee signer request failed [/v1/automated-fees/broadcast-delivery]: max fee per gas less than block base fee")).toBe("delivery");
    expect(automatedFeeRejectedPreBroadcastStage("request timed out")).toBeNull();
  });
  it("recognizes only the private persisted-workflow continuation signal", () => {
    expect(isAutomatedFeeWorkflowContinuation(new Error(AUTOMATED_FEE_WORKFLOW_CONTINUATION))).toBe(true);
    expect(isAutomatedFeeWorkflowContinuation(new Error(`Uncaught Error: ${AUTOMATED_FEE_WORKFLOW_CONTINUATION}\n    at handler (../convex/wallets.ts:3740:26)`))).toBe(true);
    expect(isAutomatedFeeWorkflowContinuation(new Error(`different error: ${AUTOMATED_FEE_WORKFLOW_CONTINUATION}`))).toBe(false);
    expect(isAutomatedFeeWorkflowContinuation(new Error("confirmation timed out"))).toBe(false);
    expect(isAutomatedFeeWorkflowContinuation(AUTOMATED_FEE_WORKFLOW_CONTINUATION)).toBe(false);
  });

  it("distinguishes root controller workflows from colon-delimited child records", () => {
    const root = { status: "broadcast" as const, ownerXUserId: "123", walletRef: "0x1", vaultAddress: "0x2" };
    expect(isAutomatedFeeControllerWorkflowRoot(root)).toBe(true);
    expect(isAutomatedFeeControllerWorkflowRoot({ status: "broadcast", transactionHash: "0xabc" })).toBe(false);
  });

  it("prevents quota refunds whenever a controller transaction may exist", () => {
    expect(automatedFeeControllerTransactionMayExist({ status: "prepared", signedTransaction: "0xabc" })).toBe(true);
    expect(automatedFeeControllerTransactionMayExist({ status: "failed", transactionHash: "0xabc" })).toBe(true);
    expect(automatedFeeControllerTransactionMayExist({ status: "reserved" })).toBe(false);
  });

  it("keeps terminal manual-review outcomes out of automatic replay", () => {
    expect(isTerminalAutomatedFeeControllerReview({
      status: "manual_review", diagnosticCode: "CONTROLLER_TRANSACTION_DROPPED",
    })).toBe(true);
    expect(isTerminalAutomatedFeeControllerReview({
      status: "manual_review", diagnosticCode: "CONTROLLER_CHANGE_RECONCILIATION_REQUIRED",
    })).toBe(false);
  });
});
