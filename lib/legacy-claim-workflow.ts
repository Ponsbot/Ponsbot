import { keccak256, toHex } from "viem";

export const LEGACY_CLAIM_VERSION = 2;
export const LEGACY_CLAIM_SUPERSEDED = "LEGACY_CLAIM_SUPERSEDED";

type ClaimState = {
  requestId: string;
  kind: string;
  status: string;
  transactionHash?: string;
  diagnosticCode?: string;
  claimWorkflowVersion?: number;
  claimWorkflowJson?: string;
  claimWorkflowCursor?: number;
};

export function storedClaimWorkflow(request: ClaimState) {
  const tokens: unknown = JSON.parse(request.claimWorkflowJson || "null");
  const cursor = request.claimWorkflowCursor ?? 0;
  if (!Array.isArray(tokens) || !tokens.every(t => typeof t === "string" && /^0x[\da-f]{40}$/i.test(t))
    || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > tokens.length) {
    throw new Error("claim workflow state is invalid");
  }
  return { tokenAddresses: tokens as string[], cursor };
}

export function resumableLegacyClaim(request: ClaimState) {
  if (request.kind !== "claim_fees" || !request.requestId.endsWith(":claim_fees")
    || request.status !== "simulating" || request.transactionHash
    || request.diagnosticCode === LEGACY_CLAIM_SUPERSEDED
    || request.claimWorkflowVersion !== LEGACY_CLAIM_VERSION) return false;
  storedClaimWorkflow(request);
  return true;
}

// Keep existing short keys stable. Only the CDP key changes, never the persisted
// parent/child identity or a previously signed transaction envelope.
export function legacyClaimSigningKey(requestId: string, operationType: unknown) {
  if (requestId.length <= 128 || !["pons_v2_claim_fees", "pons_v2_sweep_fees"].includes(String(operationType))) return requestId;
  return `legacy-claim:${keccak256(toHex(requestId))}`;
}

export function canSkipUnsubmittedSweep(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // A failed simulation or changed recipient cannot move funds. In those cases
  // old fees in escrow can still be claimed. Transport/CDP failures are NOT a
  // reason to mark the sweep complete, and a signed/broadcast step must be
  // checked separately by the caller before using this predicate.
  return /wallet is not the launch creator fee beneficiary|no completed Pons launch was found|no (?:claimable creator )?fees|nothing to sweep|execution reverted|contract function .* reverted/i.test(message);
}

export function legacyClaimTerminalSession(requestId: string, sourcePostId: string) {
  const match = /^terminal:(web_[a-zA-Z0-9_-]{16,80}):([^:]+):claim_fees$/.exec(requestId);
  if (!match || match[2] !== sourcePostId) throw new Error("claim terminal identity mismatch");
  return match[1];
}
