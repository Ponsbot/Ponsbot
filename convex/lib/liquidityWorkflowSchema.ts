import { defineTable } from "convex/server";
import { v } from "convex/values";
export const liquidityWorkflowTables = {
  liquidityThreadPosts: defineTable({ postId: v.string(), conversationId: v.id("liquidityConversations") })
    .index("by_post", ["postId"]),
  liquidityConversations: defineTable({
    publicId: v.string(), ownerXUserId: v.string(), walletId: v.id("cryptoWallets"), source: v.union(v.literal("x"), v.literal("terminal")),
    scope: v.string(), stateJson: v.string(), revision: v.number(), active: v.boolean(), expiresAt: v.number(),
    currentTurnId: v.optional(v.id("liquidityTurns")), lastPromptPostId: v.optional(v.string()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_scope_active", ["scope", "active"]).index("by_active_expiry", ["active", "expiresAt"])
    .index("by_public_id", ["publicId"]).index("by_prompt", ["lastPromptPostId"]),
  liquidityTurns: defineTable({
    requestKey: v.string(), ownerXUserId: v.string(), conversationId: v.id("liquidityConversations"), input: v.string(),
    revision: v.number(), status: v.union(v.literal("processing"), v.literal("ready"), v.literal("cancelled")),
    response: v.optional(v.string()), responsePostId: v.optional(v.string()), createdAt: v.number(),
  }).index("by_request", ["requestKey"]).index("by_response", ["responsePostId"])
    .index("by_conversation", ["conversationId"]).index("by_status", ["status"]),
  liquidityManagedPositions: defineTable({
    publicId: v.string(), ownerXUserId: v.string(), walletId: v.id("cryptoWallets"),
    version: v.union(v.literal(3), v.literal(4)), token: v.string(), symbol: v.string(), poolId: v.string(),
    fieldsJson: v.string(), legsJson: v.string(), autoCompoundRequested: v.boolean(),
    feesClaimedJson: v.optional(v.string()), lastClaimedJson: v.optional(v.string()), lastClaimedAt: v.optional(v.number()),
    status: v.union(v.literal("active"), v.literal("closed")), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_owner", ["ownerXUserId"]).index("by_public_id", ["publicId"])
    .index("by_status", ["status"])
    .index("by_owner_wallet_status", ["ownerXUserId", "walletId", "status"]),
  liquidityExecutions: defineTable({
    conversationId: v.id("liquidityConversations"),
    // Bind an execution to the exact confirmation turn that authorized it.
    // Optional only for rows created before this field existed.
    turnId: v.optional(v.id("liquidityTurns")),
    ownerXUserId: v.string(), walletId: v.id("cryptoWallets"),
    planJson: v.string(), status: v.union(v.literal("queued"), v.literal("running"), v.literal("reconciling"), v.literal("manual_review"), v.literal("confirmed"), v.literal("failed")),
    stepsJson: v.string(), response: v.optional(v.string()), diagnostic: v.optional(v.string()),
    // Public LP identifiers created or managed by this execution. Keeping
    // these on the execution makes terminal history independent of response
    // copy and supports multi-position fee collections.
    positionIds: v.optional(v.array(v.string())),
    // A final Delta open can revert if its pool price moves after funding.
    // Preserve the rejected envelope for audit while allowing one funding-free
    // reprice retry of the same pool, range, shape and bands.
    openRecoveryCount: v.optional(v.number()), revertedOpenStepsJson: v.optional(v.string()),
    retryCount: v.optional(v.number()), stage: v.optional(v.string()), nextAttemptAt: v.optional(v.number()), leaseUntil: v.optional(v.number()),
    // Opt-in outbox for newly completed operations; old results are not replayed.
    deliveryStatus: v.optional(v.union(v.literal("pending"), v.literal("handed_off"), v.literal("manual_review"))),
    deliveryAttempts: v.optional(v.number()), deliveryNextAttemptAt: v.optional(v.number()), deliveryDiagnostic: v.optional(v.string()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_conversation", ["conversationId"]).index("by_wallet_status", ["walletId", "status"])
    .index("by_owner_updated", ["ownerXUserId", "updatedAt"]).index("by_status_updated", ["status", "updatedAt"])
    .index("by_status_next_attempt", ["status", "nextAttemptAt"])
    .index("by_delivery_due", ["deliveryStatus", "deliveryNextAttemptAt"]),
};
