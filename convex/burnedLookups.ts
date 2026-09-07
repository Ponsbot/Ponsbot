import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { buyTargetContractReply } from "../lib/buy-target-policy";
export const save = internalMutation({ args: { owner: v.string(), source: v.string(), ticker: v.optional(v.string()) }, handler: async (ctx, args) => {
  const row = await ctx.db.query("burnedLookupContinuations").withIndex("by_owner_source", q => q.eq("owner", args.owner).eq("source", args.source)).unique();
  if (row) await ctx.db.delete(row._id);
  if (args.ticker) await ctx.db.insert("burnedLookupContinuations", { ...args, expiresAt: Date.now() + 600_000 });
} });
export const resume = internalMutation({ args: { owner: v.string(), source: v.string(), text: v.string() }, handler: async (ctx, args) => {
  const ca = buyTargetContractReply(args.text);
  if (!ca) return null;
  const row = await ctx.db.query("burnedLookupContinuations").withIndex("by_owner_source", q => q.eq("owner", args.owner).eq("source", args.source)).unique();
  if (!row) return null;
  await ctx.db.delete(row._id);
  if (row.expiresAt < Date.now()) return "expired";
  return `How much $${row.ticker} ${ca} has been burned?`;
} });
