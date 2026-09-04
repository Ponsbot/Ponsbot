import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { guidedHelpOperationFromCommandKind, isGuidedHelpCompletion, GUIDED_HELP_TTL_MS } from "../../lib/guided-help-workflow";
import { isGasResumePrompt } from "../../lib/x-temporary-reply-policy";

export const UNVERIFIED_REPLY_LIMIT = 10;
export const UNVERIFIED_REPLY_WARNING =
  "⚠️ You've used 7 of your 10 daily replies for unverified accounts. You can finish your current workflow. The limit resets at 00:00 UTC.";

export async function unverifiedReplyDay(ctx: MutationCtx, xUserId: string) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await ctx.db.query("xUnverifiedReplyDays")
    .withIndex("by_user_day", q => q.eq("xUserId", xUserId).eq("day", day)).unique();
  return { day, row, count: row?.count || 0 };
}

// Reserve when a unique response becomes ready, not on every publication retry.
// Queued responses count toward capacity so concurrent workers cannot overshoot.
export async function admitUnverifiedContinuation(ctx: MutationCtx, interaction: Doc<"xReplyInteractions">) {
  const { row } = await unverifiedReplyDay(ctx, interaction.authorXUserId);
  if (!row) return false;
  // Same accepted request may produce a submission notice and a final result.
  if (row.continuationConsumer === interaction.postId) return true;
  if (!row.continuationPostId || !interaction.parentPostId || (row.continuationUntil || 0) <= Date.now()) return false;
  const parent = await ctx.db.query("xReplyInteractions")
    .withIndex("by_response_post_id", q => q.eq("responsePostId", interaction.parentPostId!)).unique();
  if (!parent || parent.authorXUserId !== interaction.authorXUserId || parent.postId !== row.continuationPostId) return false;
  // Consume the prompt atomically: sibling answers cannot open parallel chains.
  await ctx.db.patch(row._id, { continuationPostId: undefined, continuationConsumer: interaction.postId });
  return true;
}

async function continuationExpiry(ctx: MutationCtx, interaction: Doc<"xReplyInteractions">, text: string, kind: string) {
  if (isGuidedHelpCompletion(text) || /^✅/.test(text.trim())) return undefined;
  if (kind === "liquidity") {
    const turn = await ctx.db.query("liquidityTurns").withIndex("by_request", q => q.eq("requestKey", `x:${interaction.postId}`)).unique();
    const conversation = turn ? await ctx.db.get(turn.conversationId) : null;
    return conversation?.active && conversation.ownerXUserId === interaction.authorXUserId
      ? conversation.expiresAt : undefined;
  }
  if (isGasResumePrompt(text) || guidedHelpOperationFromCommandKind(interaction.commandKind))
    return Date.now() + GUIDED_HELP_TTL_MS;
  return undefined;
}

export async function reserveUnverifiedReply(ctx: MutationCtx, xUserId: string, interaction: Doc<"xReplyInteractions">, text: string, kind: string) {
  const { day, row, count } = await unverifiedReplyDay(ctx, xUserId);
  if (count >= UNVERIFIED_REPLY_LIMIT && !await admitUnverifiedContinuation(ctx, interaction))
    return { allowed: false, warning: false };
  const until = await continuationExpiry(ctx, interaction, text, kind);
  const continuation = until ? {
    continuationPostId: interaction.postId, continuationUntil: until,
    continuationConsumer: undefined,
  } : {
    continuationPostId: undefined, continuationUntil: undefined,
    // Preserve authority for asynchronous final delivery from this request.
    continuationConsumer: interaction.postId,
  };
  if (row) await ctx.db.patch(row._id, { count: count + 1, ...continuation });
  else await ctx.db.insert("xUnverifiedReplyDays", { xUserId, day, count: 1, ...continuation });
  return { allowed: true, warning: count + 1 === 7 };
}
