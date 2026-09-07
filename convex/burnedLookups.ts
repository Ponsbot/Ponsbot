import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { buyTargetContractReply } from "../lib/buy-target-policy";
export const save = internalMutation({ args: { owner: v.string(), source: v.string(), scope: v.optional(v.string()), ticker: v.optional(v.string()) }, handler: async (ctx, args) => {
  const row = await ctx.db.query("burnedLookupContinuations").withIndex("by_owner_source", q => q.eq("owner", args.owner).eq("source", args.source)).unique();
  if (row) await ctx.db.delete(row._id);
  if (args.ticker) await ctx.db.insert("burnedLookupContinuations", { ...args, expiresAt: Date.now() + 600_000 });
} });
export const resume = internalMutation({ args: { owner: v.string(), source: v.string(), scope: v.optional(v.string()), superseded: v.optional(v.boolean()), text: v.string() }, handler: async (ctx, args) => {
  const ca = buyTargetContractReply(args.text);
  const row = await ctx.db.query("burnedLookupContinuations").withIndex("by_owner_source", q => q.eq("owner", args.owner).eq("source", args.source)).unique();
  if (!row) return null;
  if (!ca || args.superseded || row.scope !== args.scope) { await ctx.db.delete(row._id); return null; }
  if (row.expiresAt < Date.now()) { await ctx.db.delete(row._id); return "expired"; }
  // Read-only retries retain the pending lookup until success. An unrelated
  // request or a different session clears it before starting another workflow.
  return `How much $${row.ticker} ${ca} has been burned?`;
} });
