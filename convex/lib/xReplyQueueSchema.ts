import { defineTable } from "convex/server";
import { v } from "convex/values";
export const queuePriority = v.union(v.literal("A"), v.literal("B"), v.literal("C"));
export const queueKind = v.union(
  v.literal("reply"),
  v.literal("guided_reply"),
  v.literal("guided_execution"),
  v.literal("thread_continuation"),
  v.literal("liquidity"),
  v.literal("houdini_progress"),
  v.literal("houdini_final"),
  v.literal("graduation"),
);
export const xReplyQueueTables = {
  xReplyQueue: defineTable({
    key: v.string(), postId: v.optional(v.string()), text: v.string(), priority: queuePriority, kind: queueKind,
    ok: v.boolean(), standalone: v.boolean(), allowLong: v.boolean(), username: v.optional(v.string()),
    houdiniQuoteId: v.optional(v.id("xHoudiniQuotes")), launchId: v.optional(v.id("tokenLaunches")),
    status: v.union(v.literal("queued"), v.literal("paused"), v.literal("sending"), v.literal("published"), v.literal("expired"), v.literal("cancelled"), v.literal("blocked"), v.literal("uncertain")),
    readyAt: v.number(), expiresAt: v.optional(v.number()), nextAttemptAt: v.number(), attempts: v.number(),
    leaseToken: v.optional(v.string()), eventId: v.optional(v.id("xPublicationEvents")),
    responsePostId: v.optional(v.string()), lastError: v.optional(v.string()), updatedAt: v.number(),
  }).index("by_key", ["key"]).index("by_status_priority_ready", ["status", "priority", "readyAt"])
    .index("by_status_kind_ready", ["status", "kind", "readyAt"])
    .index("by_status_expiry", ["status", "expiresAt"]),
  xReplyQueueState: defineTable({
    key: v.string(), wakeToken: v.optional(v.string()), wakeAt: v.optional(v.number()),
    activeId: v.optional(v.id("xReplyQueue")), leaseToken: v.optional(v.string()), leaseUntil: v.optional(v.number()),
    attempts: v.array(v.object({ at: v.number(), priority: v.optional(queuePriority), kind: v.optional(queueKind) })),
    remaining: v.optional(v.number()), reset: v.optional(v.number()), blockedUntil: v.optional(v.number()), updatedAt: v.number(),
  }).index("by_key", ["key"]),
};
