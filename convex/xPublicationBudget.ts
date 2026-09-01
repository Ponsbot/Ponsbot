import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { readOnlyReplyCategory, type BudgetedReplyCategory } from "../lib/x-wallet-flood-policy";
import { isInsufficientEthReply } from "../lib/x-temporary-reply-policy";
import { xReplyBudgetScale } from "../lib/x-budget-scale";

export const X_PUBLICATION_WINDOW_MS = 15 * 60_000;
export const X_PUBLICATION_WINDOW_LIMIT = 25;
export const X_LOW_PRIORITY_WINDOW_LIMIT = 20;
export type PublicationCategory = BudgetedReplyCategory | "other";

// Used inside the same mutation as the reservation insert, so concurrent replies
// and graduation announcements cannot each spend the same remaining capacity.
export async function publicationCapacity(ctx: Pick<QueryCtx, "db">, now = Date.now()) {
  const totalLimit = Math.max(1, Math.floor(X_PUBLICATION_WINDOW_LIMIT * xReplyBudgetScale()));
  const lowPriorityLimit = Math.max(1, Math.floor(X_LOW_PRIORITY_WINDOW_LIMIT * xReplyBudgetScale()));
  const since = now - 3 * 60 * 60_000;
  const cutoff = now - X_PUBLICATION_WINDOW_MS;
  const events = await ctx.db.query("xPublicationEvents")
    .withIndex("by_created_at", q => q.gte("createdAt", since)).collect();
  const [completed, rejected] = await Promise.all(["completed", "rejected"].map(status =>
    ctx.db.query("xReplyInteractions").withIndex("by_status_updated_at", q =>
      q.eq("status", status as "completed" | "rejected").gte("updatedAt", since)).collect()));
  const interactions = new Map([...completed, ...rejected].map(row => [row.postId, row]));
  const eventPostIds = new Set(events.map(event => event.postId));
  const historical = [...completed, ...rejected]
    .filter(row => row.responsePostId && !eventPostIds.has(row.postId));
  const attempts = [...events, ...historical.map(row => ({ createdAt: row.updatedAt }))]
    .sort((a, b) => a.createdAt - b.createdAt);
  // Half-open rolling window: an attempt releases capacity exactly at +15 min.
  const recent = attempts.filter(attempt => attempt.createdAt > cutoff);

  async function legacyCategory(postId: string): Promise<PublicationCategory> {
    const sourcePostId = postId.split(":")[0];
    const row: Doc<"xReplyInteractions"> | null | undefined = interactions.get(sourcePostId)
      ?? await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", sourcePostId)).unique();
    if (!row) return "other";
    const category = readOnlyReplyCategory(row);
    if (category) return category;
    if (isInsufficientEthReply(row.safeError ?? "")) return "insufficient_eth";
    // Pre-rollout events lack a category. Read the persisted response rather than
    // resetting the shared budget or guessing from the user's transaction text.
    const requests = await ctx.db.query("walletRequests")
      .withIndex("by_source_post_id", q => q.eq("sourcePostId", sourcePostId)).collect();
    return requests.some(request => isInsufficientEthReply(request.finalMessage ?? "")) ? "insufficient_eth" : "other";
  }
  let lowPriorityAttempts = 0;
  for (const event of events.filter(event => event.createdAt > cutoff)) {
    if ((event.replyCategory ?? await legacyCategory(event.postId)) !== "other") lowPriorityAttempts++;
  }
  for (const row of historical.filter(row => row.updatedAt > cutoff)) {
    if (await legacyCategory(row.postId) !== "other") lowPriorityAttempts++;
  }

  const lastRestriction = [...events].reverse().find(event => event.status === "rejected" && event.httpStatus === 403
    && /not permitted to access this feature|posting limitation|post limit|status update limit/i.test(event.error ?? ""));
  const recoverySuccesses = lastRestriction ? events.filter(event => event.createdAt > lastRestriction.createdAt && event.status === "published").length : 0;
  const recovering = lastRestriction && now - lastRestriction.createdAt < 30 * 60_000 && recoverySuccesses < 3;
  const headerWaitMs = Math.max(0, ...events.flatMap(observation => {
    if (observation.rateLimitRemaining === undefined || observation.rateLimitReset === undefined || observation.rateLimitReset * 1_000 <= now) return [];
    const subsequent = events.filter(event => event._id !== observation._id && event.createdAt >= observation.createdAt).length;
    // No extra margin: honor all remaining capacity, but never reuse a header's
    // last slot across concurrent reservations.
    return observation.rateLimitRemaining - subsequent <= 0 ? [observation.rateLimitReset * 1_000 - now] : [];
  }));
  const waitMs = Math.max(0, headerWaitMs,
    recent.length >= totalLimit ? recent[recent.length - totalLimit].createdAt + X_PUBLICATION_WINDOW_MS - now : 0,
    recovering ? Math.max(attempts.at(-1)?.createdAt ?? 0, lastRestriction.createdAt) + 60_000 - now : 0);
  return { waitMs, attempts: recent.length, lowPriorityAttempts, lowPriorityFull: lowPriorityAttempts >= lowPriorityLimit, totalLimit, lowPriorityLimit };
}
