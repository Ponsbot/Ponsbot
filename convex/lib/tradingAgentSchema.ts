import { defineTable } from "convex/server";
import { v } from "convex/values";

export const tradingAgentPolicyValidator = v.object({
  intervalMs: v.number(), maxTradeWei: v.string(), maxDailyTurnoverWei: v.string(),
  maxGasPerTradeWei: v.string(), maxDailyGasWei: v.string(), reserveWei: v.string(),
  maxPositions: v.number(), maxSlippageBps: v.number(), maxTradesPerDay: v.number(),
});
export const tradingAgentPortfolioValidator = v.object({
  cashWei: v.string(), holdings: v.array(v.object({ token: v.string(), amount: v.string() })),
  day: v.string(), turnoverWei: v.string(), gasWei: v.string(), trades: v.number(),
});
export const tradingAgentTables = {
  tradingAgentExecutions: defineTable({
    agentId: v.id("tradingAgents"), ownerXUserId: v.string(), requestKey: v.string(), from: v.string(), destination: v.string(), intentJson: v.string(),
    state: v.union(v.literal("active"), v.literal("confirmed"), v.literal("failed")), step: v.number(),
    envelopeJson: v.optional(v.string()), signedJson: v.optional(v.string()), hashes: v.array(v.string()),
    minimumNonce: v.optional(v.number()), confirmedBlock: v.optional(v.string()), error: v.optional(v.string()),
    createdAt: v.number(), updatedAt: v.number(),
    cycleId: v.optional(v.id("tradingAgentCycles")), policyJson: v.optional(v.string()), policyVersion: v.optional(v.number()),
    phase: v.optional(v.union(v.literal("funding"), v.literal("trade"), v.literal("convert"))), pairToken: v.optional(v.string()), pairAmount: v.optional(v.string()),
    gasSpentWei: v.optional(v.string()), outputAmount: v.optional(v.string()),
    tradeBucket: v.optional(v.union(v.literal("platform"), v.literal("secondary"))), tradeCounted: v.optional(v.boolean()),
  }).index("by_owner_key", ["ownerXUserId", "requestKey"]).index("by_agent_state", ["agentId", "state"]).index("by_agent_created", ["agentId", "createdAt"]).index("by_state_updated", ["state", "updatedAt"]),
  tradingAgents: defineTable({
    ownerXUserId: v.string(), creationKey: v.string(), name: v.string(), strategy: v.string(),
    nameKey: v.string(),
    mode: v.union(v.literal("paper"), v.literal("live")), status: v.union(v.literal("draft"), v.literal("running"), v.literal("paused")),
    policy: tradingAgentPolicyValidator, policyVersion: v.number(),
    initialPaperCashWei: v.string(), portfolio: tradingAgentPortfolioValidator,
    sequence: v.number(), nextRunAt: v.number(), createdAt: v.number(), updatedAt: v.number(),
    activeCycleId: v.optional(v.id("tradingAgentCycles")),
    description: v.optional(v.string()), sourcePostId: v.optional(v.string()),
    // Reserved for a future verified dedicated-wallet provisioning step. No setter is exposed yet.
    walletAddress: v.optional(v.string()),
    walletProvisionStatus: v.optional(v.union(v.literal("pending"), v.literal("leased"), v.literal("ready"))),
    walletProvisionNextAt: v.optional(v.number()), walletProvisionLeaseToken: v.optional(v.string()),
    modelDay: v.optional(v.string()), modelCalls: v.optional(v.number()),
    liveBudget: v.optional(v.object({ day: v.string(), buyWei: v.string(), gasReservedWei: v.string(), trades: v.number() })),
    liveTradeMix: v.optional(v.object({ platform: v.number(), secondary: v.number() })),
    paperTradeMix: v.optional(v.object({ platform: v.number(), secondary: v.number() })),
    liveHoldings: v.optional(v.object({ cashWei: v.string(), tokens: v.array(v.object({ token: v.string(), amount: v.string() })), observedAt: v.number(), complete: v.boolean() })),
    schedule: v.optional(v.object({ anchorAt: v.number(), nextThoughtAt: v.number(), nextTradeAt: v.number() })),
    sprite: v.optional(v.object({ version: v.union(v.literal(1), v.literal(2)), seed: v.number(), palette: v.number(),
      archetype: v.union(v.literal("robot"), v.literal("wizard"), v.literal("cat"), v.literal("plant"), v.literal("pirate"), v.literal("rover"), v.literal("jelly"), v.literal("bird"), v.literal("golem"), v.literal("astronaut")) })),
  }).index("by_provision_due", ["walletProvisionStatus", "walletProvisionNextAt"])
    .index("by_wallet", ["walletAddress"]).index("by_name", ["nameKey"]).index("by_owner_creation", ["ownerXUserId", "creationKey"])
    .index("by_owner", ["ownerXUserId"]).index("by_status_due", ["status", "nextRunAt"]).index("by_mode_status_due", ["mode", "status", "nextRunAt"]).index("by_created", ["createdAt"]),
  tradingAgentCycles: defineTable({
    agentId: v.id("tradingAgents"), cycleKey: v.string(), policyVersion: v.number(), leaseToken: v.string(),
    leaseUntil: v.number(), createdAt: v.number(), completedAt: v.optional(v.number()),
    status: v.union(v.literal("leased"), v.literal("held"), v.literal("paper_filled"), v.literal("rejected"), v.literal("abandoned"), v.literal("executing"), v.literal("live_filled")),
    executionId: v.optional(v.id("tradingAgentExecutions")), transactionHashes: v.optional(v.array(v.string())),
    // Validated canonical JSON only, never raw model output or provider errors/secrets.
    decisionJson: v.optional(v.string()), quoteJson: v.optional(v.string()), diagnosticCode: v.optional(v.string()),
    completionDigest: v.optional(v.string()),
    kind: v.optional(v.union(v.literal("thought"), v.literal("trade"))), thought: v.optional(v.string()),
  }).index("by_cycle", ["cycleKey"]).index("by_agent_created", ["agentId", "createdAt"])
    .index("by_agent_kind_status", ["agentId", "kind", "status", "createdAt"])
    .index("by_agent_status", ["agentId", "status", "createdAt"]),
  tradingAgentBudgets: defineTable({ day: v.string(), calls: v.number() }).index("by_day", ["day"]),
};
