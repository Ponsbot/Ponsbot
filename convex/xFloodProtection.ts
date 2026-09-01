import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { readOnlyReplyCategory, reserveLookupSlot, reserveWalletRequestSlot, walletLookupLimit, type BudgetedReplyCategory } from "../lib/x-wallet-flood-policy";
import { liquidityAdmissionExempt } from "./liquidity";

async function admitWalletRequest(ctx: MutationCtx, args: { postId: string; authorXUserId: string }) {
  const key = `wallet:user:${args.authorXUserId}:admission`;
  const budget = await ctx.db.query("xWalletLookupBudgets").withIndex("by_key", q => q.eq("key", key)).unique();
  // Carry forward any retained pre-rollout admission for this owner, without
  // reviving rejected work or letting the old global cap block other users.
  const legacy = budget ? null : await ctx.db.query("xWalletLookupBudgets").withIndex("by_key", q => q.eq("key", "admission")).unique();
  const now = Date.now();
  const decision = reserveWalletRequestSlot(budget?.slots ?? legacy?.slots ?? [], args.postId, args.authorXUserId, now);
  if (decision.allowed) {
    if (budget) await ctx.db.patch(budget._id, { slots: decision.slots, updatedAt: now });
    else await ctx.db.insert("xWalletLookupBudgets", { key, slots: decision.slots, updatedAt: now });
  }
  return decision.allowed;
}

// Live request admission: one wallet-address request per owner per 10 minutes.
// Balance/help have no category admission caps. Outgoing pacing is the queue's
// job. The publication branch is retained solely for legacy operator tooling;
// no live publication path calls it.
export async function suppressReadOnlyReply(ctx: MutationCtx, interaction: Doc<"xReplyInteractions">, publication = false) {
  if (interaction.walletLookupSuppressed || interaction.replySuppressedReason) return true;
  if (!publication) {
    if (await liquidityAdmissionExempt(ctx, { ownerXUserId: interaction.authorXUserId, text: interaction.text, parentPostId: interaction.parentPostId, postId: interaction.postId })) return false;
    if (readOnlyReplyCategory(interaction) !== "wallet") return false;
    if (interaction.walletLookupAdmittedAt !== undefined || interaction.responsePostId || interaction.publicationAttempted || interaction.status === "publishing") return false;
    if (!await admitWalletRequest(ctx, interaction)) {
      await rejectReadOnlyReply(ctx, interaction, "wallet"); return true;
    }
    await ctx.db.patch(interaction._id, { walletLookupAdmittedAt: Date.now() });
    return false;
  }
  const category = readOnlyReplyCategory(interaction);
  if (!category) return false;
  if (interaction.responsePostId || interaction.publicationAttempted || interaction.status === "publishing") return false;
  // Legacy operator-only publication reservation. The live durable queue does
  // not call this branch or use these category records.
  const key = category === "wallet" ? "publication" : `${category}:publication`;
  const budget = await ctx.db.query("xWalletLookupBudgets").withIndex("by_key", q => q.eq("key", key)).unique();
  const now = Date.now();
  const decision = reserveLookupSlot(budget?.slots ?? [], interaction.postId, interaction.authorXUserId, now, walletLookupLimit(), publication);
  if (!decision.allowed) {
    await rejectReadOnlyReply(ctx, interaction, category);
    return true;
  }
  if (budget) await ctx.db.patch(budget._id, { slots: decision.slots, updatedAt: now });
  else await ctx.db.insert("xWalletLookupBudgets", { key, slots: decision.slots, updatedAt: now });
  return false;
}

export async function rejectReadOnlyReply(ctx: MutationCtx, interaction: Doc<"xReplyInteractions">, category: BudgetedReplyCategory) {
  await ctx.db.patch(interaction._id, {
    ...(category === "wallet" ? { walletLookupSuppressed: true } : {}),
    replySuppressedReason: `${category}_reply_budget`,
    status: "rejected", nextRetryAt: undefined,
    safeError: `${category} reply budget exhausted; silently ignored`, updatedAt: Date.now(),
  });
}

// Failure notices are limited only at publication, after execution has already
// failed. This must never gate a launch/trade or take wallet/balance/help slots.
export async function suppressInsufficientEthReply(ctx: MutationCtx, interaction: Doc<"xReplyInteractions">, publicationKey?: string) {
  const key = "insufficient_eth:publication";
  const budget = await ctx.db.query("xWalletLookupBudgets").withIndex("by_key", q => q.eq("key", key)).unique();
  const now = Date.now();
  const decision = reserveLookupSlot(budget?.slots ?? [], publicationKey || interaction.postId, interaction.authorXUserId, now, 10, true, false);
  if (!decision.allowed) {
    await rejectReadOnlyReply(ctx, interaction, "insufficient_eth");
    return true;
  }
  if (budget) await ctx.db.patch(budget._id, { slots: decision.slots, updatedAt: now });
  else await ctx.db.insert("xWalletLookupBudgets", { key, slots: decision.slots, updatedAt: now });
  return false;
}

export const guardQueued = internalMutation({
  args: { postId: v.string() },
  handler: async (ctx, { postId }) => {
    const interaction = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", postId)).unique();
    return { suppressed: interaction ? await suppressReadOnlyReply(ctx, interaction) : false };
  },
});

// Admit obvious read-only requests BEFORE their author profiles are fetched.
// Reserve the same admission slot guardQueued will reuse, but do not create an
// executable interaction until profile lookup succeeds. A failed X lookup can
// safely replay this post without either a stranded request or another slot.
export const admitBeforeProfile = internalMutation({
  args: { postId: v.string(), authorXUserId: v.string(), text: v.string(), parentPostId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", args.postId)).unique();
    if (existing) return false;
    if (await liquidityAdmissionExempt(ctx, { ...args, ownerXUserId: args.authorXUserId })) return true;
    const category = readOnlyReplyCategory(args);
    if (category !== "wallet") return true;
    const now = Date.now();
    if (!await admitWalletRequest(ctx, args)) {
      await ctx.db.insert("xReplyInteractions", {
        ...args, status: "rejected", createdAt: now, updatedAt: now,
        ...(category === "wallet" ? { walletLookupSuppressed: true } : {}),
        replySuppressedReason: `${category}_reply_budget`,
        safeError: `${category} reply budget exhausted; silently ignored`,
      });
      return false;
    }
    return true;
  },
});
