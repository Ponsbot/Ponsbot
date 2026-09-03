import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { validateStructuredWalletCommand } from "./walletCommands";
import { legacyClaimTerminalSession, LEGACY_CLAIM_SUPERSEDED, LEGACY_CLAIM_VERSION, storedClaimWorkflow } from "../lib/legacy-claim-workflow";

// This worker accepts only a persisted request ID, never a new user instruction,
// owner, token or destination. Authorization was established before that request
// was admitted. Session expiry prevents NEW requests, not completion of this one.
export const resumeTerminalClaim = internalAction({
  args: { requestId: v.string(), pendingPolls: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const request: Doc<"walletRequests"> | null = await ctx.runQuery(internal.wallets.getWalletRequest, { requestId: args.requestId });
    if (!request || (request.source !== "terminal" && request.source !== "telegram") || request.kind !== "claim_fees"
      || request.claimWorkflowVersion !== LEGACY_CLAIM_VERSION || request.diagnosticCode === LEGACY_CLAIM_SUPERSEDED) return;
    const sessionId = legacyClaimTerminalSession(request.requestId, request.sourcePostId);
    const command = validateStructuredWalletCommand(JSON.parse(request.normalizedJson));
    if (command?.kind !== "claim_fees") throw new Error("stored claim command is invalid");
    const finished = ["confirmed", "failed", "rejected", "skipped"].includes(request.status);
    if (finished && request.status !== "confirmed" && !request.finalMessage) return;
    if (request.transactionHash && !finished) {
      await ctx.runAction(internal.wallets.reconcileTransaction, { requestId: request.requestId });
    }
    const result = finished && request.finalMessage
      ? { message: request.finalMessage!, pending: false, deferred: false }
      : await ctx.runAction(internal.wallets.executeCommand, {
        requestId: request.requestId, sourcePostId: request.sourcePostId,
        xUserId: request.ownerXUserId, source: request.source,
        channel: request.source === "telegram" ? "telegram_chat" : request.channel === "terminal_form" ? "terminal_form" : "terminal_chat",
        text: "claim fees", parsedCommandJson: request.normalizedJson,
      });
    if (result.pending || result.deferred) {
      const latest: Doc<"walletRequests"> | null = await ctx.runQuery(internal.wallets.getWalletRequest, { requestId: request.requestId });
      // Sweep continuations schedule themselves. Final claim receipts instead
      // need this bounded reconciliation poll; do not grow duplicate job chains.
      if (latest?.transactionHash && (args.pendingPolls ?? 0) < 30) {
        await ctx.scheduler.runAfter(20_000, internal.legacyClaims.resumeTerminalClaim, {
          requestId: request.requestId, pendingPolls: (args.pendingPolls ?? 0) + 1,
        });
      }
      return;
    }
    if (request.source === "terminal" && result.message) await ctx.runMutation(internal.wallets.recordTerminalMessage, {
      sessionId, ownerXUserId: request.ownerXUserId, role: "assistant", messageType: "result",
      text: result.message, requestId: request.sourcePostId,
    });
  },
});

// Explicit, preview-first operator recovery. A deploy alone cannot resume old
// claims, and no broad scan can accidentally revive cancelled wallet actions.
export const continueStuckClaims = internalMutation({
  args: {
    requestIds: v.array(v.string()),
    supersededRequestIds: v.optional(v.array(v.string())),
    execute: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const ids = args.requestIds;
    const supersededIds = args.supersededRequestIds ?? [];
    if (!ids.length || ids.length > 20 || supersededIds.length > 100
      || new Set([...ids, ...supersededIds]).size !== ids.length + supersededIds.length) throw new Error("invalid claim recovery selection");
    const selected: Doc<"walletRequests">[] = [];
    const superseded: Doc<"walletRequests">[] = [];
    for (const id of [...ids, ...supersededIds]) {
      const request = await ctx.db.query("walletRequests").withIndex("by_request_id", q => q.eq("requestId", id)).unique();
      if (!request || request.kind !== "claim_fees" || !id.endsWith(":claim_fees")
        || request.status !== "simulating" || request.transactionHash || request.claimWorkflowVersion === LEGACY_CLAIM_VERSION
        || request.diagnosticCode === LEGACY_CLAIM_SUPERSEDED) throw new Error(`claim is not an unsubmitted legacy continuation: ${id}`);
      storedClaimWorkflow(request);
      const command = validateStructuredWalletCommand(JSON.parse(request.normalizedJson));
      if (command?.kind !== "claim_fees") throw new Error("invalid persisted claim command");
      const wallet = await ctx.db.get(request.walletId);
      if (!wallet || wallet.ownerXUserId !== request.ownerXUserId || wallet.chainId !== 4663) throw new Error("claim wallet binding mismatch");
      const lock = await ctx.db.query("walletExecutionLocks").withIndex("by_wallet_id", q => q.eq("walletId", request.walletId)).unique();
      if (lock && lock.leaseUntil > Date.now()) throw new Error("claim wallet is currently executing a transaction");
      const related = await ctx.db.query("walletRequests").withIndex("by_source_post_id", q => q.eq("sourcePostId", request.sourcePostId)).collect();
      for (const child of related.filter(r => r.requestId.startsWith(`${id}:`))) {
        if (["simulating", "accepted", "prepared", "broadcast"].includes(child.status)) throw new Error("claim has an unresolved child; reconcile it before recovery");
        const transaction = await ctx.db.query("walletTransactions").withIndex("by_request_id", q => q.eq("requestId", child.requestId)).unique();
        if (transaction && ["prepared", "broadcast"].includes(transaction.status)) throw new Error("claim has an unresolved signed child");
      }
      if (request.source === "terminal") {
        legacyClaimTerminalSession(id, request.sourcePostId);
      } else {
        const interaction = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", request.sourcePostId)).unique();
        if (!interaction || interaction.responsePostId || ["completed", "rejected", "publishing"].includes(interaction.status)
          || interaction.authorXUserId !== request.ownerXUserId) throw new Error("X claim is not eligible for continuation");
        const intent = JSON.parse(interaction.parsedIntentJson || "null");
        if (intent?.kind !== "command" || JSON.stringify(intent.command) !== request.normalizedJson) throw new Error("X claim intent does not match its request");
      }
      (ids.includes(id) ? selected : superseded).push(request);
    }
    if (new Set(selected.map(r => r.walletId)).size !== selected.length) throw new Error("select only one continuation per wallet");
    for (const duplicate of superseded) {
      if (!selected.some(r => r.walletId === duplicate.walletId && r.ownerXUserId === duplicate.ownerXUserId
        && r.normalizedJson === duplicate.normalizedJson && r.createdAt >= duplicate.createdAt)) {
        throw new Error("superseded claim must match a newer selected claim");
      }
    }
    if (args.execute) {
      for (const duplicate of superseded) {
        await ctx.db.patch(duplicate._id, { status: "rejected", diagnosticCode: LEGACY_CLAIM_SUPERSEDED,
          workflowStage: "claim_superseded", safeError: "continued by a newer equivalent claim", updatedAt: Date.now() });
        if (duplicate.source !== "terminal") {
          const interaction = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", duplicate.sourcePostId)).unique();
          if (interaction) await ctx.db.patch(interaction._id, { status: "rejected", safeError: LEGACY_CLAIM_SUPERSEDED, nextRetryAt: undefined, updatedAt: Date.now() });
        }
      }
      for (const [index, request] of selected.entries()) {
        // Retry old skipped steps with the bounded CDP key. Confirmed steps are
        // read from their existing receipts and NEVER submitted again.
        await ctx.db.patch(request._id, { claimWorkflowVersion: LEGACY_CLAIM_VERSION, claimWorkflowCursor: 0,
          workflowStage: "claim_continuation", safeError: undefined, finalMessage: undefined,
          diagnosticCode: undefined, diagnosticDetail: undefined, updatedAt: Date.now() });
        if (request.source === "terminal") {
          await ctx.scheduler.runAfter(index * 5_000, internal.legacyClaims.resumeTerminalClaim, { requestId: request.requestId });
        } else {
          await ctx.scheduler.runAfter(index * 5_000, internal.xReplies.retryInteraction, { postId: request.sourcePostId });
        }
      }
    }
    return { mutationSent: Boolean(args.execute), resumed: selected.map(r => ({ requestId: r.requestId, ownerXUserId: r.ownerXUserId,
      tokenCount: storedClaimWorkflow(r).tokenAddresses.length })), superseded: superseded.map(r => r.requestId) };
  },
});
