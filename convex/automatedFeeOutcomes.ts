import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { feeUpgradeSuccessMessage } from "../lib/fee-upgrade-command";

export type FeeOutcome = "upgrade" | "reassign" | "holders";

export function automatedFeeOutcomeMessage(outcome: FeeOutcome, symbol: string, token: string, hash: string) {
  if (outcome === "upgrade") {
    const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "") || "https://www.ponsbot.family";
    return feeUpgradeSuccessMessage(symbol, `${site}/launch/${token}`);
  }
  const label = /^[a-zA-Z0-9]{1,32}$/.test(symbol.replace(/^\$/, "")) ? `$${symbol.replace(/^\$/, "")}` : "this token";
  return `✅ Success! Reassigned future creator fees for ${label}${outcome === "holders" ? " to holders" : ""}!\nYour TXN: https://robinhoodchain.blockscout.com/tx/${hash}`;
}

// Shared by foreground commands and background recovery. The program's state
// must already have been updated from a verified receipt; this never grants rights.
export async function recordVerifiedFeeOutcome(ctx: MutationCtx, program: Doc<"automatedFeePrograms">,
  launch: Doc<"tokenLaunches">, outcome: FeeOutcome, transactionHash: string) {
  const hash = transactionHash.toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(hash) || program.launchId !== launch._id) throw new Error("verified automated fee outcome is missing");
  if (outcome === "upgrade") {
    if (program.status !== "enrolled" || program.enrollmentSource !== "upgrade" || program.enrollmentTransactionHash?.toLowerCase() !== hash)
      throw new Error("verified automated fee upgrade outcome was not found");
  } else if (program.lastControllerChangeTransactionHash?.toLowerCase() !== hash
    || (outcome === "reassign" ? program.status !== "enrolled" : program.status !== "exited" || program.distributionMode !== "holders")) {
    throw new Error("verified automated fee controller outcome was not found");
  }
  let recipient = program.beneficiaryAddress;
  if (outcome === "holders") {
    const changes = await ctx.db.query("automatedFeeControllerChanges")
      .withIndex("by_program_status", q => q.eq("programId", program._id).eq("status", "confirmed")).collect();
    const root = changes.find(row => row.workflowRoot && row.operation === "holders" && row.transactionHash?.toLowerCase() === hash);
    if (!root?.exitRecipientAddress) throw new Error("verified holder recipient is missing");
    recipient = root.exitRecipientAddress;
  }
  await ctx.db.patch(launch._id, {
    creatorFeeRecipient: recipient, normalizedCreatorFeeRecipient: recipient.toLowerCase(),
    ...(outcome !== "upgrade" ? {
      holderFeeSharing: outcome === "holders", holderFeeDistributor: outcome === "holders" ? recipient : undefined,
      holderFeeSharingStatus: outcome === "holders" ? "enabled" as const : undefined,
      holderFeeSharingAttempts: undefined, holderFeeSharingLastError: undefined, holderFeeSharingNextAttemptAt: undefined,
    } : {}),
    feesReassignedAt: launch.feeReassignmentTransactionHash?.toLowerCase() === hash ? launch.feesReassignedAt : Date.now(),
    feeReassignmentTransactionHash: hash, updatedAt: Date.now(),
  });
}

export async function finalizeFeeWalletOutcome(ctx: MutationCtx, program: Doc<"automatedFeePrograms">,
  requestId: string, outcome: FeeOutcome, transactionHash: string) {
  const launch = program.launchId ? await ctx.db.get(program.launchId) : null;
  if (!launch) {
    if (!program.privateTest) throw new Error("automated fee launch record is missing");
    return;
  }
  await recordVerifiedFeeOutcome(ctx, program, launch, outcome, transactionHash);
  const request = requestId ? await ctx.db.query("walletRequests").withIndex("by_request_id", q => q.eq("requestId", requestId)).unique() : null;
  if (!request) return; // Operator-only enrollments have no public wallet request.
  if (request.diagnosticCode === "UPGRADE_CANCELLED_BY_OPERATOR") return;
  await ctx.db.patch(request._id, {
    status: "confirmed", transactionHash: transactionHash.toLowerCase(),
    workflowStage: outcome === "upgrade" ? "automated_fee_upgrade_confirmed"
      : outcome === "holders" ? "automated_holder_fee_sharing_enabled" : "automated_fee_control_reassigned",
    safeError: undefined,
    finalMessage: automatedFeeOutcomeMessage(outcome, launch.symbol, program.tokenAddress, transactionHash),
    updatedAt: Date.now(),
  });
}
