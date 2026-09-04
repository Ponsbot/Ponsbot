import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { queueKind } from "./lib/xReplyQueueSchema";
import { replyQueueExpiresAt, replyQueuePriority, replyQueueWaitMs } from "../lib/x-reply-queue-policy";
import { temporaryXReplySuppressionReason } from "../lib/x-temporary-reply-policy";
import { xCashtagSafeText } from "../lib/x-cashtag-policy";
import { reserveUnverifiedReply, UNVERIFIED_REPLY_WARNING } from "./lib/xUnverifiedReplyLimit";
import {
  guidedHelpCommandKind,
  guidedHelpOperationFromCommandKind,
  isGuidedHelpCompletion,
} from "../lib/guided-help-workflow";

type QueueRow = Doc<"xReplyQueue">;
type QueueState = Doc<"xReplyQueueState">;
const enabled = () => process.env.X_REPLIES_ENABLED === "true";
const stateQuery = (ctx: MutationCtx) => ctx.db.query("xReplyQueueState").withIndex("by_key", q => q.eq("key", "main")).unique();

async function stateForEnqueue(ctx: MutationCtx): Promise<QueueState> {
  const prior = await stateQuery(ctx);
  if (prior) return prior;
  // Bootstrap only once, so rollout does not forget already-used X capacity.
  const events = await ctx.db.query("xPublicationEvents").withIndex("by_created_at", q => q.gte("createdAt", Date.now() - 3 * 60 * 60_000)).order("desc").take(501);
  const header = events.find(e => e.rateLimitRemaining !== undefined && e.rateLimitReset !== undefined);
  const id = await ctx.db.insert("xReplyQueueState", { key: "main", attempts: events.map(e => ({ at: e.createdAt,
    ...(e.replyCategory && e.replyCategory !== "other" ? { priority: "C" as const } : {}) })),
    ...(header ? { remaining: Math.max(0, header.rateLimitRemaining! - events.filter(e => e.createdAt > header.createdAt).length), reset: header.rateLimitReset } : {}), updatedAt: Date.now() });
  return (await ctx.db.get(id))!;
}

async function wake(ctx: MutationCtx, state: QueueState, at = Date.now()) {
  if (!enabled() || (state.leaseUntil ?? 0) > Date.now()) return;
  if (state.wakeToken && state.wakeAt !== undefined && state.wakeAt <= at) return;
  const token = crypto.randomUUID();
  await ctx.db.patch(state._id, { wakeToken: token, wakeAt: at, updatedAt: Date.now() });
  await ctx.scheduler.runAfter(Math.max(0, at - Date.now()), internal.xReplies.drainReplyQueue, { wakeToken: token });
}

async function settleBindings(ctx: MutationCtx, row: QueueRow, status: "published" | "expired" | "cancelled" | "blocked" | "uncertain", responsePostId?: string) {
  const now = Date.now();
  if (row.postId) {
    const interaction = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", row.postId!)).unique();
    if (interaction && interaction.commandKind !== "operator_cancelled") {
      if (row.kind === "houdini_progress" && status === "published") {
        await ctx.db.patch(interaction._id, {
          publicationQueued: false,
          publicationAttempted: true,
          publicationStatus: "published",
          updatedAt: now,
        });
      } else await ctx.db.patch(interaction._id, {
        status: status === "published" ? (row.ok ? "completed" : "rejected") : status === "expired" || status === "cancelled" ? "rejected" : "failed",
        // Blocked/uncertain publications retain ownership of this outcome;
        // generic recovery must never run the user's command again.
        publicationQueued: status === "blocked" || status === "uncertain", publicationAttempted: status === "published" || status === "uncertain",
        publicationStatus: status === "published" ? "published" : status === "blocked" ? "blocked" : status === "uncertain" ? "uncertain" : "failed",
        nextRetryAt: undefined, ...(responsePostId ? { responsePostId } : {}),
        ...(status === "published" && row.ok && isGuidedHelpCompletion(row.text)
          ? { commandKind: guidedHelpCommandKind("root") }
          : {}),
        // If a B-tier guided prompt expires, close its workflow silently. A
        // later reply must never revive a step the user never received.
        ...(status === "expired" && row.kind === "guided_reply"
          ? { commandKind: "guided_help:cancelled", guidedHelpStateJson: undefined }
          : {}),
        ...(status === "published" ? { safeError: row.ok ? undefined : row.text } : { safeError: `X reply queue: ${status}` }), updatedAt: now,
      });
    }
  }
  if (row.houdiniQuoteId) {
    const quote = await ctx.db.get(row.houdiniQuoteId);
    if (quote) await ctx.db.patch(quote._id, row.kind === "houdini_progress" ? {
      submissionPublicationStatus: status === "published" ? "published" : status === "uncertain" ? "uncertain" : "failed",
      ...(responsePostId ? { submissionResponsePostId: responsePostId } : {}), updatedAt: now,
    } : {
      finalPublicationStatus: status === "published" ? "published" : status === "uncertain" ? "uncertain" : "failed",
      finalPublicationLeaseId: undefined, finalPublicationLeaseUntil: undefined, nextPublicationAttemptAt: undefined,
      ...(responsePostId ? { finalResponsePostId: responsePostId } : {}), updatedAt: now,
    });
  }
  if (row.launchId) {
    const launch = await ctx.db.get(row.launchId);
    if (launch) await ctx.db.patch(launch._id, { graduationAnnouncementStatus: status === "published" ? "posted" : "uncertain",
      ...(responsePostId ? { graduationAnnouncementPostId: responsePostId, graduationAnnouncementPostedAt: now } : { graduationAnnouncementError: `X queue ${status}; retained for review` }),
      graduationMonitorNextCheckAt: undefined, updatedAt: now });
  }
  if (row.kind === "liquidity" && row.postId && responsePostId) {
    const turn = await ctx.db.query("liquidityTurns").withIndex("by_request", q => q.eq("requestKey", `x:${row.postId}`)).unique();
    if (turn) {
      await ctx.db.patch(turn._id, { responsePostId });
      const conversation = await ctx.db.get(turn.conversationId);
      if (conversation?.currentTurnId === turn._id) await ctx.db.patch(conversation._id, { lastPromptPostId: responsePostId });
    } else {
      // Redirects have no LP turn of their own, but replies to the redirect
      // still belong to the protected original thread.
      const link = await ctx.db.query("liquidityThreadPosts").withIndex("by_post", q => q.eq("postId", row.postId!)).first();
      if (link && !await ctx.db.query("liquidityThreadPosts").withIndex("by_post", q => q.eq("postId", responsePostId)).first())
        await ctx.db.insert("liquidityThreadPosts", { postId: responsePostId, conversationId: link.conversationId });
    }
  }
}

export const enqueue = internalMutation({
  args: { key: v.string(), postId: v.optional(v.string()), text: v.string(), ok: v.optional(v.boolean()), kind: queueKind,
    allowLong: v.optional(v.boolean()), houdiniQuoteId: v.optional(v.id("xHoudiniQuotes")), launchId: v.optional(v.id("tokenLaunches")) },
  handler: async (ctx, args): Promise<{ status: string; responsePostId?: string }> => {
    const existing = await ctx.db.query("xReplyQueue").withIndex("by_key", q => q.eq("key", args.key)).unique();
    if (existing) return { status: existing.status, ...(existing.responsePostId ? { responsePostId: existing.responsePostId } : {}) };
    const interaction = args.postId ? await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", args.postId!)).unique() : null;
    if (args.postId && (!interaction || interaction.commandKind === "operator_cancelled" || interaction.replySuppressedReason || interaction.walletLookupSuppressed)) return { status: "cancelled" };
    const prior = await ctx.db.query("xPublicationEvents").withIndex("by_post_id", q => q.eq("postId", args.key)).order("desc").first();
    if (prior?.status === "published") return { status: "published", responsePostId: prior.responsePostId };
    if (interaction?.responsePostId && args.key === args.postId) return { status: "published", responsePostId: interaction.responsePostId };
    // Never replay a pre-rollout ambiguous publication or cancelled backlog.
    if (prior && prior.status !== "rejected") return { status: "uncertain" };
    if (!prior && interaction?.publicationAttempted && args.key === args.postId) return { status: "uncertain" };
    if (interaction && args.key === args.postId && ["completed", "rejected"].includes(interaction.status)) return { status: "cancelled" };
    let safeText = xCashtagSafeText(args.text);
    const suppressedReason = temporaryXReplySuppressionReason(safeText);
    if (suppressedReason) {
      if (interaction) await ctx.db.patch(interaction._id, { status: "rejected", publicationStatus: "suppressed", replySuppressedReason: suppressedReason,
        nextRetryAt: undefined, safeError: `X response silently suppressed: ${suppressedReason}`, updatedAt: Date.now() });
      return { status: "cancelled" };
    }
    if (args.launchId) {
      const launch = await ctx.db.get(args.launchId);
      if (!launch?.publicPublished || launch.graduationAnnouncementStatus !== "posting") return { status: "cancelled" };
    }
    if (args.houdiniQuoteId) {
      const quote = await ctx.db.get(args.houdiniQuoteId);
      if (!quote || quote.requestPostId !== args.postId) throw new Error("Queue order/source mismatch");
    }
    let commandKind = interaction?.commandKind;
    if (!guidedHelpOperationFromCommandKind(commandKind) && commandKind !== "guided_help:cancelled") {
      try { const intent = JSON.parse(interaction?.parsedIntentJson || "null"); commandKind = intent?.kind === "help" ? "help" : intent?.command?.kind || commandKind; } catch { /* No model output is interpreted as queue authority. */ }
    }
    let effectiveKind = args.kind;
    if (args.kind === "reply" && interaction?.parentPostId) {
      if (commandKind?.startsWith("guided_help")) {
        effectiveKind = "guided_reply";
      } else {
        const parent = await ctx.db.query("xReplyInteractions")
          .withIndex("by_response_post_id", q => q.eq("responsePostId", interaction.parentPostId!)).unique();
        if (parent?.authorXUserId === interaction.authorXUserId) effectiveKind = "thread_continuation";
      }
    }
    const priorityAuthority = ["reply", "thread_continuation"].includes(effectiveKind) ? commandKind : effectiveKind;
    const priority = replyQueuePriority(safeText, priorityAuthority, args.ok);
    const now = Date.now();
    const user = interaction ? await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", q => q.eq("xUserId", interaction.authorXUserId)).unique() : null;
    let dailyWarning = false;
    if (interaction && (interaction.authorVerified ?? user?.verified) !== true) {
      const budget = await reserveUnverifiedReply(ctx, interaction.authorXUserId, interaction, safeText, effectiveKind);
      if (!budget.allowed) {
        await ctx.db.patch(interaction._id, { publicationQueued: false, publicationStatus: "suppressed",
          replySuppressedReason: "unverified_daily_reply_limit", nextRetryAt: undefined, updatedAt: now });
        return { status: "cancelled" };
      }
      dailyWarning = budget.warning;
      if (dailyWarning) safeText += `\n\n${UNVERIFIED_REPLY_WARNING}`;
    }
    const standalone = args.kind === "graduation" || process.env.X_STANDALONE_MENTIONS_ENABLED === "true";
    await ctx.db.insert("xReplyQueue", {
      ...args, text: safeText, kind: effectiveKind, ok: args.ok ?? (priority === "C" ? commandKind === "help" || commandKind === "show_wallet" || commandKind === "show_balance" || commandKind === "create_wallet" : /^✅/.test(safeText.trim())),
      priority, standalone, allowLong: args.allowLong === true || dailyWarning, ...(user?.username ? { username: user.username } : {}),
      status: "queued", readyAt: now, expiresAt: replyQueueExpiresAt(priority, now), nextAttemptAt: now, attempts: 0, updatedAt: now,
    });
    if (interaction) await ctx.db.patch(interaction._id, {
      publicationQueued: true,
      publicationStatus: "queued",
      status: "publishing",
      nextRetryAt: undefined,
      updatedAt: now,
    });
    if (args.houdiniQuoteId) await ctx.db.patch(args.houdiniQuoteId, args.kind === "houdini_progress" ? { submissionPublicationStatus: "queued", updatedAt: now } : {
      finalPublicationStatus: "queued", finalPublicationLeaseId: undefined, finalPublicationLeaseUntil: undefined, nextPublicationAttemptAt: undefined, updatedAt: now,
    });
    await wake(ctx, await stateForEnqueue(ctx));
    return { status: "queued" };
  },
});

async function recoverLostWorker(ctx: MutationCtx, state: QueueState) {
  if (!state.activeId || (state.leaseUntil ?? 0) > Date.now()) return state;
  const row = await ctx.db.get(state.activeId);
  if (row?.status === "sending") {
    await ctx.db.patch(row._id, { status: "uncertain", lastError: "Publication worker interrupted; reconcile before retry", updatedAt: Date.now() });
    if (row.eventId) await ctx.db.patch(row.eventId, { status: "uncertain", error: "Publication worker interrupted", updatedAt: Date.now() });
    await settleBindings(ctx, row, "uncertain");
  }
  await ctx.db.patch(state._id, { activeId: undefined, leaseToken: undefined, leaseUntil: undefined });
  return { ...state, activeId: undefined, leaseToken: undefined, leaseUntil: undefined };
}

export const kick = internalMutation({
  args: {}, handler: async ctx => {
    let state = await stateQuery(ctx);
    if (!state || !enabled()) return;
    state = await recoverLostWorker(ctx, state);
    let resumed = false;
    // The graduation-only switch must not hold up transaction replies. Preserve
    // paused announcements and their original FIFO age for later resumption.
    if (process.env.X_GRADUATION_POSTS_ENABLED !== "false") {
      const paused = await ctx.db.query("xReplyQueue").withIndex("by_status_priority_ready", q => q.eq("status", "paused")).take(100);
      resumed = paused.length > 0;
      for (const row of paused) await ctx.db.patch(row._id, { status: "queued", updatedAt: Date.now() });
    }
    if (state.wakeAt !== undefined && state.wakeAt < Date.now() - 60_000) {
      await ctx.db.patch(state._id, { wakeAt: undefined, wakeToken: undefined });
      state = { ...state, wakeAt: undefined, wakeToken: undefined };
    }
    const queued = await ctx.db.query("xReplyQueue").withIndex("by_status_priority_ready", q => q.eq("status", "queued")).first();
    if (queued) await wake(ctx, state, resumed ? Date.now() : state.wakeAt ?? Date.now());
  },
});

export const takeNext = internalMutation({
  args: { wakeToken: v.string() }, handler: async (ctx, args): Promise<{ row: QueueRow; leaseToken: string } | null> => {
    let state = await stateQuery(ctx);
    if (!state || state.wakeToken !== args.wakeToken) return null;
    await ctx.db.patch(state._id, { wakeToken: undefined, wakeAt: undefined });
    state = { ...state, wakeToken: undefined, wakeAt: undefined };
    if (!enabled() || (state.leaseUntil ?? 0) > Date.now()) return null;
    state = await recoverLostWorker(ctx, state);
    const now = Date.now();
    const expired = await ctx.db.query("xReplyQueue").withIndex("by_status_expiry", q => q.eq("status", "queued").gt("expiresAt", 0).lte("expiresAt", now)).take(100);
    for (const row of expired) { await ctx.db.patch(row._id, { status: "expired", updatedAt: now }); await settleBindings(ctx, row, "expired"); }
    let row = await ctx.db.query("xReplyQueue").withIndex("by_status_priority_ready", q => q.eq("status", "queued")).first();
    if (!row) return null;
    if (row.expiresAt !== undefined && row.expiresAt <= now) { await wake(ctx, state); return null; }
    const attempts = state.attempts.filter(a => a.at > now - 3 * 60 * 60_000);
    const waitFor = (candidate: QueueRow) => Math.max(candidate.nextAttemptAt - now, replyQueueWaitMs(attempts, candidate.priority, now, state, candidate.kind));
    let wait = waitFor(row);
    if (wait > 0 && !["liquidity", "guided_reply", "guided_execution", "thread_continuation"].includes(row.kind)) {
      // An older ordinary reply waiting on its short window must not block
      // an exempt LP step. Keep normal A/B/C ordering whenever the head is due,
      // and FIFO among LP replies. Shared quotas/provider blocks still apply.
      const exemptCandidates = await Promise.all(
        (["liquidity", "guided_reply", "guided_execution", "thread_continuation"] as const).map(kind =>
          ctx.db.query("xReplyQueue").withIndex("by_status_kind_ready", q => q.eq("status", "queued").eq("kind", kind)).first()),
      );
      const exempt = exemptCandidates.filter((candidate): candidate is QueueRow => Boolean(candidate))
        .sort((a, b) => a.readyAt - b.readyAt)[0];
      if (exempt && waitFor(exempt) < wait) { row = exempt; wait = waitFor(exempt); }
    }
    const interaction = row.postId ? await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", row.postId!)).unique() : null;
    if (row.postId && (!interaction || interaction.commandKind === "operator_cancelled" || interaction.replySuppressedReason || interaction.walletLookupSuppressed)) {
      await ctx.db.patch(row._id, { status: "cancelled", updatedAt: now }); await settleBindings(ctx, row, "cancelled"); await wake(ctx, state); return null;
    }
    if (row.launchId) {
      const launch = await ctx.db.get(row.launchId);
      if (!launch?.publicPublished || launch.graduationAnnouncementStatus !== "posting") {
        await ctx.db.patch(row._id, { status: "cancelled", lastError: "Graduation announcement no longer authorized", updatedAt: now });
        await wake(ctx, state); return null;
      }
    }
    if (row.kind === "graduation" && process.env.X_GRADUATION_POSTS_ENABLED === "false") {
      await ctx.db.patch(row._id, { status: "paused", updatedAt: now }); await wake(ctx, state); return null;
    }
    if (wait > 0) { await wake(ctx, state, now + wait); return null; }
    const leaseToken = crypto.randomUUID();
    const eventId = await ctx.db.insert("xPublicationEvents", { postId: row.key, replyCategory: row.priority === "C" ? "information" : "other", status: "reserved", createdAt: now, updatedAt: now });
    await ctx.db.patch(row._id, { status: "sending", leaseToken, eventId, attempts: row.attempts + 1, updatedAt: now });
    await ctx.db.patch(state._id, { activeId: row._id, leaseToken, leaseUntil: now + 90_000,
      attempts: [...attempts, { at: now, priority: row.priority, kind: row.kind }],
      remaining: state.reset && state.reset * 1_000 > now && state.remaining !== undefined ? Math.max(0, state.remaining - 1) : undefined,
      reset: state.reset && state.reset * 1_000 > now ? state.reset : undefined, updatedAt: now });
    return { row: { ...row, status: "sending", leaseToken, eventId, attempts: row.attempts + 1 }, leaseToken };
  },
});

export const finish = internalMutation({
  args: { queueId: v.id("xReplyQueue"), leaseToken: v.string(), outcome: v.union(v.literal("published"), v.literal("retry"), v.literal("blocked"), v.literal("uncertain")),
    responsePostId: v.optional(v.string()), error: v.optional(v.string()), httpStatus: v.optional(v.number()),
    remaining: v.optional(v.number()), reset: v.optional(v.number()), limit: v.optional(v.number()), retryAfterMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.queueId), state = await stateQuery(ctx);
    if (!row || !state || row.leaseToken !== args.leaseToken || state.leaseToken !== args.leaseToken || row.status !== "sending") return;
    const now = Date.now();
    const status = args.outcome === "retry" ? "queued" : args.outcome;
    const nextAttemptAt = args.outcome === "retry" ? now + Math.max(60_000, args.retryAfterMs ?? Math.min(15 * 60_000, 60_000 * 2 ** Math.min(row.attempts - 1, 4))) : row.nextAttemptAt;
    await ctx.db.patch(row._id, { status, leaseToken: undefined, responsePostId: args.responsePostId, lastError: args.error,
      nextAttemptAt, updatedAt: now });
    if (row.eventId) await ctx.db.patch(row.eventId, { status: args.outcome === "published" ? "published" : args.outcome === "uncertain" ? "uncertain" : "rejected",
      responsePostId: args.responsePostId, error: args.error, httpStatus: args.httpStatus,
      rateLimit: args.limit, rateLimitRemaining: args.remaining, rateLimitReset: args.reset, updatedAt: now });
    if (args.outcome !== "retry") await settleBindings(ctx, row, args.outcome, args.responsePostId);
    const patch = { activeId: undefined, leaseToken: undefined, leaseUntil: undefined, updatedAt: now,
      ...(args.outcome === "retry" && (args.httpStatus === 429 || args.httpStatus === 403) ? { blockedUntil: Math.max(state.blockedUntil ?? 0, nextAttemptAt) } : {}),
      ...(args.remaining !== undefined ? { remaining: args.remaining } : {}), ...(args.reset !== undefined ? { reset: args.reset } : {}) };
    await ctx.db.patch(state._id, patch);
    await wake(ctx, { ...state, ...patch });
  },
});
