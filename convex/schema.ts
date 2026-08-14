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
    status: v.union(v.literal("active"), v.literal("frozen")), launchEnabled: v.optional(v.boolean()), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_owner_x_user_id", ["ownerXUserId"]).index("by_address", ["address"]).index("by_normalized_address", ["normalizedAddress"]),

  walletHoldingSnapshots: defineTable({
    walletAddress: v.string(), tokenAddress: v.optional(v.string()), name: v.string(), symbol: v.string(),
    displayBalance: v.string(), iconUrl: v.optional(v.string()), updatedAt: v.number(),
  }).index("by_wallet_address", ["walletAddress"]),

  walletRequests: defineTable({
    requestId: v.string(), sourcePostId: v.string(), ownerXUserId: v.string(), walletId: v.id("cryptoWallets"), kind: v.string(),
    source: v.optional(v.union(v.literal("x"), v.literal("terminal"))),
    channel: v.optional(v.union(v.literal("x_reply"), v.literal("terminal_chat"), v.literal("terminal_form"))),
    status: v.union(v.literal("accepted"), v.literal("simulating"), v.literal("prepared"), v.literal("broadcast"), v.literal("confirmed"), v.literal("rejected"), v.literal("failed")),
    normalizedJson: v.string(), safeError: v.optional(v.string()), transactionHash: v.optional(v.string()),
    preparedLaunchSalt: v.optional(v.string()), predictedTokenAddress: v.optional(v.string()), predictedCurveAddress: v.optional(v.string()),
    reconciliationAttempts: v.optional(v.number()), nextReconcileAt: v.optional(v.number()), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_request_id", ["requestId"]).index("by_source_post_id", ["sourcePostId"]).index("by_owner_created_at", ["ownerXUserId", "createdAt"]),

  terminalMessages: defineTable({
    sessionId: v.string(), ownerXUserId: v.string(), role: v.union(v.literal("user"), v.literal("assistant")),
    messageType: v.union(v.literal("chat"), v.literal("action"), v.literal("result")), text: v.string(),
    requestId: v.optional(v.string()), createdAt: v.number(),
  }).index("by_owner_created_at", ["ownerXUserId", "createdAt"]).index("by_session_created_at", ["sessionId", "createdAt"]),

  webWalletSessions: defineTable({
    sessionIdHash: v.string(), ownerXUserId: v.string(), expiresAt: v.number(), revokedAt: v.optional(v.number()), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_session_hash", ["sessionIdHash"]).index("by_owner", ["ownerXUserId"]),

  terminalRateLimits: defineTable({
    key: v.string(), utcDay: v.string(), dailyCount: v.number(), windowStartedAt: v.number(), windowCount: v.number(), updatedAt: v.number(),
  }).index("by_key", ["key"]),

  walletTransactions: defineTable({
    requestId: v.string(), walletId: v.id("cryptoWallets"), chainId: v.number(), to: v.string(), valueWei: v.string(),
    callKind: v.string(), transactionHash: v.string(), signedTransaction: v.optional(v.string()),
    status: v.union(v.literal("prepared"), v.literal("broadcast"), v.literal("confirmed"), v.literal("reverted"), v.literal("invalid")),
    blockNumber: v.optional(v.string()), claimedDisplay: v.optional(v.string()), tradeOutputDisplay: v.optional(v.string()),
    tradeOutputTokenAddress: v.optional(v.string()), tradeOutputBalanceBefore: v.optional(v.string()), involvedPairTokenAddress: v.optional(v.string()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_request_id", ["requestId"]).index("by_transaction_hash", ["transactionHash"]),

  tokenLaunches: defineTable({
    requestId: v.string(), ownerXUserId: v.string(), launcherUsername: v.optional(v.string()), walletId: v.id("cryptoWallets"), launchMode: v.literal("pons"),
    name: v.string(), symbol: v.string(), imageUri: v.string(), description: v.optional(v.string()), website: v.optional(v.string()),
    twitter: v.optional(v.string()), telegram: v.optional(v.string()), pairToken: v.optional(v.string()), devBuyWei: v.string(), transactionHash: v.string(), tokenAddress: v.optional(v.string()), normalizedTokenAddress: v.optional(v.string()),
    poolAddress: v.optional(v.string()), positionId: v.optional(v.string()), devBuySucceeded: v.optional(v.boolean()),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_request_id", ["requestId"]).index("by_owner_created_at", ["ownerXUserId", "createdAt"])
    .index("by_token_address", ["tokenAddress"]).index("by_normalized_token_address", ["normalizedTokenAddress"]).index("by_symbol", ["symbol"]),

  tokenActivity: defineTable({
    tokenAddress: v.string(), normalizedTokenAddress: v.string(), transactionHash: v.string(), logIndex: v.number(),
    kind: v.union(v.literal("buy"), v.literal("sell"), v.literal("burn")), walletAddress: v.string(),
    tokenAmount: v.string(), marketCapUsd: v.optional(v.number()), usdAmount: v.optional(v.number()), blockNumber: v.string(), timestamp: v.number(), createdAt: v.number(),
  }).index("by_token_time", ["normalizedTokenAddress", "timestamp"])
    .index("by_transaction_log", ["transactionHash", "logIndex"]),

  tokenMarketState: defineTable({
    tokenAddress: v.string(), normalizedTokenAddress: v.string(), lastBuyAt: v.optional(v.number()),
    marketCapUsd: v.optional(v.number()), volume24hUsd: v.optional(v.number()), graduated: v.optional(v.boolean()),
    poolFee: v.optional(v.number()), tickSpacing: v.optional(v.number()), graduationCheckedAt: v.optional(v.number()), activityBackfilledAt: v.optional(v.number()),
    indexedThroughBlock: v.optional(v.string()), updatedAt: v.number(),
  }).index("by_normalized_token", ["normalizedTokenAddress"])
    .index("by_last_buy", ["lastBuyAt"]),

  marketIndexState: defineTable({
    key: v.string(), indexedThroughBlock: v.optional(v.string()), leaseUntil: v.number(), lastViewerAt: v.number(), updatedAt: v.number(),
  }).index("by_key", ["key"]),

  marketPriceCache: defineTable({
    key: v.string(), value: v.number(), sourceTimestamp: v.number(), expiresAt: v.number(), updatedAt: v.number(),
  }).index("by_key", ["key"]),

  walletRateLimits: defineTable({ ownerXUserId: v.string(), day: v.string(), count: v.number(), updatedAt: v.number() })
    .index("by_owner_x_user_id", ["ownerXUserId"]),

  walletExecutionLocks: defineTable({
    walletId: v.id("cryptoWallets"), requestId: v.string(), leaseUntil: v.number(), updatedAt: v.number(),
  }).index("by_wallet_id", ["walletId"]),

  protocolContracts: defineTable({
    key: v.string(), address: v.string(), normalizedAddress: v.string(), active: v.boolean(), updatedAt: v.number(),
  }).index("by_key", ["key"]),

  tokenRegistry: defineTable({
    address: v.string(), normalizedAddress: v.string(), symbol: v.string(), name: v.string(), decimals: v.number(),
    pairCandidate: v.boolean(), pairApproved: v.boolean(), active: v.boolean(), verifiedAt: v.optional(v.number()), updatedAt: v.number(),
  }).index("by_normalized_address", ["normalizedAddress"]).index("by_symbol", ["symbol"]).index("by_pair_candidate", ["pairCandidate"]),

  walletTokenIndex: defineTable({
    walletId: v.id("cryptoWallets"), tokenAddress: v.string(), normalizedTokenAddress: v.string(), symbol: v.string(),
    involvedByLaunch: v.boolean(), involvedByTransaction: v.boolean(), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_wallet", ["walletId"]).index("by_wallet_token", ["walletId", "normalizedTokenAddress"]),
});
