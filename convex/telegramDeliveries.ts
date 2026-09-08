import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { isGasResumePrompt } from "../lib/x-temporary-reply-policy";
import { CLAIM_LP_FEE_OFFER } from "../lib/guided-help-workflow";

export const enqueue = internalMutation({ args: { requestId: v.string(), ownerXUserId: v.string(), telegramUserId: v.string(), telegramChatId: v.string(), telegramUpdateId: v.string() }, handler: async (ctx, a) => {
  const existing = await ctx.db.query("telegramWalletDeliveries").withIndex("by_request", q => q.eq("requestId", a.requestId)).unique();
  if (existing) {
    if (existing.ownerXUserId !== a.ownerXUserId || existing.telegramUserId !== a.telegramUserId || existing.telegramChatId !== a.telegramChatId) throw new Error("Delivery identity mismatch");
    return;
  }
  await ctx.db.insert("telegramWalletDeliveries", { ...a, status: "pending", attempts: 0, nextAttemptAt: Date.now() + 5_000, createdAt: Date.now(), updatedAt: Date.now() });
  await ctx.scheduler.runAfter(5_000, internal.telegramDeliveries.deliver, { requestId: a.requestId });
} });
export const setText = internalMutation({ args: { requestId: v.string(), text: v.string() }, handler: async (ctx, a) => {
  const row = await ctx.db.query("telegramWalletDeliveries").withIndex("by_request", q => q.eq("requestId", a.requestId)).unique();
  if (row?.status === "pending" && !row.text) await ctx.db.patch(row._id, { text: a.text, nextAttemptAt: Date.now(), updatedAt: Date.now() });
} });
export const reserve = internalMutation({ args: { requestId: v.string(), leaseToken: v.string() }, handler: async (ctx, a) => {
  const row = await ctx.db.query("telegramWalletDeliveries").withIndex("by_request", q => q.eq("requestId", a.requestId)).unique();
  if (!row || row.status !== "pending" || row.nextAttemptAt > Date.now() || (row.leaseUntil ?? 0) > Date.now()) return null;
  await ctx.db.patch(row._id, { leaseToken: a.leaseToken, leaseUntil: Date.now() + 120_000, attempts: row.attempts + 1 });
  return row;
} });
export const finish = internalMutation({ args: { requestId: v.string(), leaseToken: v.string(), status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("cancelled")), text: v.optional(v.string()) }, handler: async (ctx, a) => {
  const row = await ctx.db.query("telegramWalletDeliveries").withIndex("by_request", q => q.eq("requestId", a.requestId)).unique();
  if (!row || row.status !== "pending" || row.leaseToken !== a.leaseToken) return;
  const delay = row.attempts < 60 ? 5_000 : 60_000;
  await ctx.db.patch(row._id, { status: a.status, ...(a.text ? { text: a.text } : {}), leaseToken: undefined, leaseUntil: undefined,
    nextAttemptAt: Date.now() + delay, updatedAt: Date.now() });
  if (a.status === "pending") await ctx.scheduler.runAfter(delay, internal.telegramDeliveries.deliver, { requestId: a.requestId });
} });
export const due = internalQuery({ args: {}, handler: ctx => ctx.db.query("telegramWalletDeliveries")
  .withIndex("by_due", q => q.eq("status", "pending").lte("nextAttemptAt", Date.now())).take(50) });
export const recover = internalAction({ args: {}, handler: async ctx => {
  const rows: Doc<"telegramWalletDeliveries">[] = await ctx.runQuery(internal.telegramDeliveries.due, {});
  for (const row of rows) await ctx.scheduler.runAfter(0, internal.telegramDeliveries.deliver, { requestId: row.requestId });
} });
export const deliver = internalAction({ args: { requestId: v.string() }, handler: async (ctx, a) => {
  const leaseToken = crypto.randomUUID();
  const row: Doc<"telegramWalletDeliveries"> | null = await ctx.runMutation(internal.telegramDeliveries.reserve, { ...a, leaseToken });
  if (!row) return;
  let status: "pending" | "delivered" | "cancelled" = "pending", text = row.text;
  try {
    const binding = await ctx.runQuery(internal.telegram.boundUpdateLink, { updateId: row.telegramUpdateId, telegramUserId: row.telegramUserId, telegramChatId: row.telegramChatId });
    if (!binding.valid || binding.link?.ownerXUserId !== row.ownerXUserId) { status = "cancelled"; return; }
    if (!text) {
      const result = await ctx.runQuery(internal.telegram.walletRequestResult, { requestId: row.requestId, ownerXUserId: row.ownerXUserId });
      if (!result || !["confirmed", "rejected", "failed", "skipped"].includes(result.status)) return;
      text = result.finalMessage || result.safeError || "The request finished. Check your wallet activity for the result.";
      // Deferred results must not replace newer user conversations.
      if (isGasResumePrompt(text)) text = text.replace(/reply\s+[“"]resume[”"]/i, "send the full request again");
      if (text.trim().endsWith(CLAIM_LP_FEE_OFFER)) {
        const registered = await ctx.runMutation(internal.telegram.setConversation, { telegramUserId: row.telegramUserId, telegramChatId: row.telegramChatId, operation: "claim_lp_offer", onlyIfIdle: true });
        if (!registered) text = text.replace(CLAIM_LP_FEE_OFFER, 'For LP fees, send "claim LP fees".');
      }
    }
    const delivered: boolean = await ctx.runAction(internal.telegram.deliverHoudiniMessage, { telegramUserId: row.telegramUserId, telegramChatId: row.telegramChatId,
      ownerXUserId: row.ownerXUserId, text, requestId: `telegram-result:${row.requestId}` });
    status = delivered ? "delivered" : "cancelled";
  } catch { /* Retry delivery only. Never execute the wallet request again. */ }
  finally { await ctx.runMutation(internal.telegramDeliveries.finish, { ...a, leaseToken, status, ...(text ? { text } : {}) }); }
} });
