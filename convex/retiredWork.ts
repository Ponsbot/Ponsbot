import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { canArchiveFinishedUncertain, canRetireBlockedReply } from "../lib/retired-work-policy";

// Operator-only housekeeping. Never submits, schedules, retries, or declares a transaction successful.
export const retire = internalMutation({
  args: { queueIds: v.array(v.id("xReplyQueue")), quoteIds: v.array(v.id("xHoudiniQuotes")), execute: v.boolean() },
  handler: async (ctx, args) => {
    if (args.queueIds.length > 100 || args.quoteIds.length > 20) throw new Error("BOUNDED_REVIEW_REQUIRED");
    const now = Date.now();
    const queues = await Promise.all(args.queueIds.map(id => ctx.db.get(id)));
    const quotes = await Promise.all(args.quoteIds.map(id => ctx.db.get(id)));
    for (const row of queues) if (!row || !canRetireBlockedReply(row, now)) throw new Error("REPLY_STATE_CHANGED");
    for (const row of quotes) if (!row || !canArchiveFinishedUncertain(row, now)) throw new Error("QUOTE_STATE_CHANGED");
    if (args.execute) {
      for (const row of queues) {
        if (!row) continue;
        await ctx.db.patch(row._id, { status: "cancelled", updatedAt: now });
        if (row.postId) {
          const interaction = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", row.postId!)).unique();
          if (interaction && !interaction.responsePostId && interaction.publicationStatus === "blocked") {
            await ctx.db.patch(interaction._id, { status: "rejected", commandKind: "operator_cancelled", publicationQueued: false,
              nextRetryAt: undefined, guidedHelpStateJson: undefined, safeError: "Historical blocked reply retired without retry.", updatedAt: now });
          }
        }
      }
      for (const row of quotes) if (row) await ctx.db.patch(row._id, { operationalArchivedAt: now });
    }
    return { replies: queues.length, archivedUncertainQuotes: quotes.length, executed: args.execute };
  },
});
