import { defineTable } from 'convex/server';
import { v } from 'convex/values';
export const pollSpecValidator = v.object({ token: v.string(), question: v.string(), options: v.array(v.string()), durationMinutes: v.number(), minimumHoldingPercent: v.number() });
export const pollSnapshotValidator = v.object({ block: v.string(), blockHash: v.string(), timestamp: v.number(), symbol: v.string(), decimals: v.number(), supply: v.string(), activeSupply: v.string(),
  exclusions: v.array(v.object({ address: v.string(), balance: v.string(), label: v.string() })), policy: v.string() });
export const pollTables = {
  pollDraftTurns: defineTable({ postId: v.string(), owner: v.string(), expiresAt: v.number(), consumedBy: v.optional(v.string()), creationPostId: v.optional(v.string()),
    draft: v.object({ token: v.optional(v.string()), question: v.optional(v.string()), options: v.optional(v.array(v.string())), durationMinutes: v.optional(v.number()), minimumHoldingPercent: v.optional(v.number()) }),
    step: v.union(v.literal('token'), v.literal('question'), v.literal('options'), v.literal('duration'), v.literal('minimum'), v.literal('confirm')),
    state: v.union(v.literal('active'), v.literal('cancelled'), v.literal('ready')), message: v.string()
  }).index('by_post', ['postId']),
  pollWalletChallenges: defineTable({ nonce: v.string(), binding: v.string(), address: v.string(), message: v.string(), expiresAt: v.number(), used: v.boolean() }).index('by_nonce', ['nonce']).index('by_expiry', ['expiresAt']),
  pollWalletSessions: defineTable({ hash: v.string(), binding: v.string(), address: v.string(), expiresAt: v.number(), contractProof: v.optional(v.object({ message: v.string(), signature: v.string() })) }).index('by_hash', ['hash']).index('by_expiry', ['expiresAt']),
  polls: defineTable({ code: v.string(), requestKey: v.string(), ownerXUserId: v.string(), creatorWallet: v.string(), creatorXUsername: v.optional(v.string()), source: v.union(v.literal('x'), v.literal('web')), sourcePostId: v.optional(v.string()),
    spec: pollSpecValidator, tokenAddress: v.optional(v.string()), status: v.union(v.literal('preparing'), v.literal('needs_token'), v.literal('open'), v.literal('closed'), v.literal('failed'), v.literal('cancelled')),
    createdAt: v.number(), endsAt: v.optional(v.number()), anchor: v.object({ block: v.string(), blockHash: v.string(), timestamp: v.number() }), snapshot: v.optional(pollSnapshotValidator), official: v.boolean(), officialBy: v.optional(v.string()), officialAt: v.optional(v.number()),
    totals: v.array(v.string()), votedWeight: v.string(), voterCount: v.number(), xPostId: v.optional(v.string()), resultPostId: v.optional(v.string()), resultPublication: v.optional(v.string()),
    diagnostic: v.optional(v.string()), nextAttemptAt: v.number(), attempts: v.number(), lease: v.optional(v.string()), leaseUntil: v.optional(v.number())
  }).index('by_code', ['code']).index('by_request', ['requestKey']).index('by_source_post', ['sourcePostId']).index('by_x_post', ['xPostId'])
    .index('by_status_created', ['status', 'createdAt']).index('by_status_due', ['status', 'nextAttemptAt']).index('by_owner_created', ['ownerXUserId', 'createdAt']).index('by_wallet_created', ['creatorWallet', 'createdAt']),
  pollVotes: defineTable({ pollId: v.id('polls'), wallet: v.string(), option: v.number(), weight: v.string(), updatedAt: v.number(), source: v.union(v.literal('x'), v.literal('web')), eventOrder: v.string() })
    .index('by_poll_wallet', ['pollId', 'wallet']),
  pollVoteEvents: defineTable({ key: v.string(), pollId: v.id('polls'), wallet: v.string(), option: v.number(), weight: v.string(), createdAt: v.number(), duplicate: v.optional(v.boolean()), duplicateNotice: v.optional(v.boolean()) }).index('by_key', ['key']),
  pollDuplicateNotices: defineTable({ pollId: v.id('polls'), owner: v.string() }).index('by_poll_owner', ['pollId', 'owner']),
  pollRequestLimits: defineTable({ key: v.string(), times: v.array(v.number()) }).index('by_key', ['key']),
};
