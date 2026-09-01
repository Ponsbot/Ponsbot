import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// Operator-only maintenance: retain audit records and never sign, send, or
// reconcile transactions. Do not touch fee cycles or terminal/Houdini workers.
export const cancelWaitingBefore = internalMutation({
  args: { before: v.number(), execute: v.boolean(), cursor: v.optional(v.string()) },
  handler: async (ctx, { before, execute, cursor }) => {
    if (process.env.X_REPLIES_ENABLED !== "false") throw new Error("Pause X before cleanup");
    if (before > Date.now()) throw new Error("Cutoff must be in the past");
    const groups = await Promise.all((["received", "processing", "publishing", "failed"] as const).map(status =>
      ctx.db.query("xReplyInteractions").withIndex("by_status", q => q.eq("status", status)).take(500)));
    const targets = groups.flat().filter(r => r.createdAt <= before && r.commandKind !== "operator_cancelled");
    const ids = new Set(targets.map(r => r.postId));
    // Include sealed records to catch late callbacks scheduled during cleanup.
    const sealed = await ctx.db.query("xReplyInteractions").withIndex("by_status", q => q.eq("status", "rejected")).order("desc").take(500);
    for (const r of sealed) if (r.createdAt <= before && r.commandKind === "operator_cancelled") ids.add(r.postId);
    const page = await ctx.db.system.query("_scheduled_functions").order("desc").paginate({numItems:500,cursor:cursor ?? null});
    const jobs = page.page
      .filter(r => r.state.kind === "pending" && /^xReplies(?:\.js)?:/.test(r.name)
        && ids.has((r.args[0] as { postId?: string } | undefined)?.postId ?? ""));
    if (execute) {
      for (const r of targets) await ctx.db.patch(r._id, {
        status: "rejected", commandKind: "operator_cancelled", nextRetryAt: undefined,
        safeError: "Operator cancelled waiting X response; no reply requested", updatedAt: Date.now(),
      });
      for (const job of jobs) await ctx.scheduler.cancel(job._id);
    }
    return { execute, cutoff: before, interactions: targets.map(r => ({ postId: r.postId, status: r.status, responsePostId: r.responsePostId })), cancelledJobs: jobs.length, cursor: page.continueCursor, done: page.isDone };
  },
});
