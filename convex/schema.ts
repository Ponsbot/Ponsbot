import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  xReplyUsers: defineTable({
    xUserId: v.string(), username: v.string(), verified: v.boolean(),
    verifiedType: v.optional(v.string()), subscriptionType: v.optional(v.string()),
    walletId: v.optional(v.id("cryptoWallets")),
    walletStatus: v.union(v.literal("none"), v.literal("provisioning"), v.literal("active"), v.literal("frozen")),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_x_user_id", ["xUserId"]),

  xReplyInteractions: defineTable({
    postId: v.string(), authorXUserId: v.string(), text: v.string(), mediaUrl: v.optional(v.string()),
    recipientXUserId: v.optional(v.string()), recipientAddress: v.optional(v.string()),
    status: v.union(v.literal("received"), v.literal("processing"), v.literal("publishing"), v.literal("completed"), v.literal("rejected"), v.literal("failed")),
    commandKind: v.optional(v.string()), responsePostId: v.optional(v.string()), safeError: v.optional(v.string()), publicationAttempted: v.optional(v.boolean()),
    retryCount: v.optional(v.number()), nextRetryAt: v.optional(v.number()), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_post_id", ["postId"]).index("by_status", ["status"]),

  xReplyState: defineTable({
    key: v.string(), newestSeenPostId: v.optional(v.string()), lastPolledAt: v.optional(v.number()),
    leaseUntil: v.optional(v.number()), updatedAt: v.number(),
  }).index("by_key", ["key"]),

  xReplyRateLimits: defineTable({
    key: v.string(), utcDay: v.string(), dailyCount: v.number(), windowStartedAt: v.number(),
    windowCount: v.number(), lastAcceptedAt: v.number(), updatedAt: v.number(),
  }).index("by_key", ["key"]),

  cryptoWallets: defineTable({
    ownerXUserId: v.string(), address: v.string(), normalizedAddress: v.optional(v.string()), signerWalletRef: v.string(), chainId: v.number(),
    status: v.union(v.literal("active"), v.literal("frozen")), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_owner_x_user_id", ["ownerXUserId"]).index("by_address", ["address"]).index("by_normalized_address", ["normalizedAddress"]),

  walletHoldingSnapshots: defineTable({
    walletAddress: v.string(), tokenAddress: v.optional(v.string()), name: v.string(), symbol: v.string(),
    displayBalance: v.string(), iconUrl: v.optional(v.string()), updatedAt: v.number(),
  }).index("by_wallet_address", ["walletAddress"]),

  walletRequests: defineTable({
    requestId: v.string(), sourcePostId: v.string(), ownerXUserId: v.string(), walletId: v.id("cryptoWallets"), kind: v.string(),
    status: v.union(v.literal("accepted"), v.literal("simulating"), v.literal("prepared"), v.literal("broadcast"), v.literal("confirmed"), v.literal("rejected"), v.literal("failed")),
    normalizedJson: v.string(), safeError: v.optional(v.string()), transactionHash: v.optional(v.string()),
    reconciliationAttempts: v.optional(v.number()), nextReconcileAt: v.optional(v.number()), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_request_id", ["requestId"]).index("by_source_post_id", ["sourcePostId"]).index("by_owner_created_at", ["ownerXUserId", "createdAt"]),

  walletTransactions: defineTable({
    requestId: v.string(), walletId: v.id("cryptoWallets"), chainId: v.number(), to: v.string(), valueWei: v.string(),
    callKind: v.string(), transactionHash: v.string(), signedTransaction: v.optional(v.string()),
    status: v.union(v.literal("prepared"), v.literal("broadcast"), v.literal("confirmed"), v.literal("reverted"), v.literal("invalid")),
    blockNumber: v.optional(v.string()), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_request_id", ["requestId"]).index("by_transaction_hash", ["transactionHash"]),

  tokenLaunches: defineTable({
    requestId: v.string(), ownerXUserId: v.string(), walletId: v.id("cryptoWallets"), launchMode: v.literal("pons"),
    name: v.string(), symbol: v.string(), imageUri: v.string(), description: v.optional(v.string()), website: v.optional(v.string()),
    twitter: v.optional(v.string()), telegram: v.optional(v.string()), pairToken: v.optional(v.string()), devBuyWei: v.string(), transactionHash: v.string(), tokenAddress: v.optional(v.string()), normalizedTokenAddress: v.optional(v.string()),
    poolAddress: v.optional(v.string()), positionId: v.optional(v.string()), devBuySucceeded: v.optional(v.boolean()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_request_id", ["requestId"]).index("by_owner_created_at", ["ownerXUserId", "createdAt"])
    .index("by_token_address", ["tokenAddress"]).index("by_normalized_token_address", ["normalizedTokenAddress"]).index("by_symbol", ["symbol"]),

  walletRateLimits: defineTable({ ownerXUserId: v.string(), day: v.string(), count: v.number(), updatedAt: v.number() })
    .index("by_owner_x_user_id", ["ownerXUserId"]),
});
