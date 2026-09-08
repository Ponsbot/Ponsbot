import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { validateStructuredWalletCommand, isTerminalCommand } from "./walletCommands";
import { walletContinuation } from "../lib/wallet-continuation";
import { buyTargetContractReply } from "../lib/buy-target-policy";
import { isResumeReply } from "../lib/x-direct-post-policy";
import { WORKFLOW_EXPIRED_MESSAGE } from "../lib/workflow-expiration";
import type { Doc } from "./_generated/dataModel";

const identity = { owner: v.string(), source: v.union(v.literal("terminal"), v.literal("telegram")), scope: v.string() };
export const current = internalQuery({ args: identity, handler: (ctx, a) => ctx.db.query("walletContinuations")
  .withIndex("by_scope", q => q.eq("owner", a.owner).eq("source", a.source).eq("scope", a.scope)).unique() });
export const save = internalMutation({ args: { ...identity, requestId: v.string(), commandJson: v.string(), sourceText: v.string(), message: v.string(), onlyIfIdle: v.optional(v.boolean()) }, handler: async (ctx, a) => {
  const command = validateStructuredWalletCommand(JSON.parse(a.commandJson));
  if (!command || !isTerminalCommand(command)) return false;
  const state = walletContinuation(a.message, command);
  if (!state) return false;
  const prior = await ctx.db.query("walletContinuations").withIndex("by_scope", q => q.eq("owner", a.owner).eq("source", a.source).eq("scope", a.scope)).unique();
  if (prior?.requestId === a.requestId) return true;
  if (a.onlyIfIdle && prior && !prior.consumedBy && prior.expiresAt > Date.now()) return false;
  const value = { owner: a.owner, source: a.source, scope: a.scope, requestId: a.requestId, ...state,
    commandJson: a.commandJson, sourceText: a.sourceText, consumedBy: undefined,
    expiresAt: Date.now() + 600_000, updatedAt: Date.now(), field: "field" in state ? state.field : undefined, ticker: "ticker" in state ? state.ticker : undefined };
  if (prior) await ctx.db.patch(prior._id, value); else await ctx.db.insert("walletContinuations", value);
  return true;
} });
export const clear = internalMutation({ args: identity, handler: async (ctx, a) => {
  const row = await ctx.db.query("walletContinuations").withIndex("by_scope", q => q.eq("owner", a.owner).eq("source", a.source).eq("scope", a.scope)).unique();
  if (row) await ctx.db.delete(row._id);
} });
export const claim = internalMutation({ args: { ...identity, id: v.id("walletContinuations"), version: v.string(), consumer: v.string() }, handler: async (ctx, a) => {
  const row = await ctx.db.get(a.id);
  if (!row || row.owner !== a.owner || row.source !== a.source || row.scope !== a.scope || row.requestId !== a.version
    || row.expiresAt <= Date.now() || (row.consumedBy && row.consumedBy !== a.consumer)) return false;
  await ctx.db.patch(row._id, { consumedBy: a.consumer }); return true;
} });
export const release = internalMutation({ args: { id: v.id("walletContinuations"), consumer: v.string() }, handler: async (ctx, a) => {
  const row = await ctx.db.get(a.id);
  if (row?.consumedBy === a.consumer) await ctx.db.patch(row._id, { consumedBy: undefined });
} });
export const resolve = internalAction({ args: { ...identity, text: v.string(), requestId: v.string() }, handler: async (ctx, a): Promise<{ commandJson?: string; sourceText?: string; message?: string } | null> => {
  const ca = buyTargetContractReply(a.text), resume = isResumeReply(a.text);
  if (!ca && !resume) return null;
  const row: Doc<"walletContinuations"> | null = await ctx.runQuery(internal.walletContinuations.current, { owner: a.owner, source: a.source, scope: a.scope });
  if (!row || (row.kind === "gas" ? !resume : !ca)) return null;
  if (row.expiresAt <= Date.now()) return { message: WORKFLOW_EXPIRED_MESSAGE };
  if (!await ctx.runMutation(internal.walletContinuations.claim, { owner: a.owner, source: a.source, scope: a.scope, id: row._id, version: row.requestId, consumer: a.requestId }))
    return { message: "This request was already continued. Use the latest response." };
  const command = validateStructuredWalletCommand(JSON.parse(row.commandJson));
  if (!command || !isTerminalCommand(command)) return { message: WORKFLOW_EXPIRED_MESSAGE };
  if (row.kind === "gas") return { commandJson: row.commandJson, sourceText: row.sourceText };
  let result: { matches: boolean };
  try { result = await ctx.runAction(internal.wallets.verifyTokenTickerContract, { ticker: row.ticker!, tokenAddress: ca! }); }
  catch {
    await ctx.runMutation(internal.walletContinuations.release, { id: row._id, consumer: a.requestId });
    return { message: "⚠️ I couldn't verify that contract just now. Your request is saved. Reply with the contract address again shortly." };
  }
  if (!result.matches) {
    const message = `⚠️ That contract address's onchain ticker does not match $${row.ticker}. Double-check that you've got the right contract address, then reply with it.`;
    await ctx.runMutation(internal.walletContinuations.save, { owner: a.owner, source: a.source, scope: a.scope, requestId: a.requestId, commandJson: row.commandJson, sourceText: row.sourceText, message });
    return { message };
  }
  const updated = validateStructuredWalletCommand({ ...command, [row.field!]: ca });
  if (!updated) return { message: WORKFLOW_EXPIRED_MESSAGE };
  return { commandJson: JSON.stringify(updated), sourceText: row.sourceText };
} });
