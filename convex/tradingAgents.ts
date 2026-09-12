import { v } from "convex/values";
import { hashMessage } from "viem";
import { advanceYardSchedule, botThoughtSchema, BOT_TRADE_INTERVAL_MS, dueYardCycle, initialYardSchedule, parseCreateBotPost } from "../lib/trading-agents/bot-yard";
import { createBotSprite } from "../lib/trading-agents/sprite";
import { botNameKey, formatBotStatus, parseCheckBotPost, type BotStatusAsset } from "../lib/trading-agents/status";
import { parseBotFundingPost } from "../lib/trading-agents/funding";
import { botCreatedReply } from "../lib/trading-agents/messages";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { Doc } from "./_generated/dataModel";
import type { BotYardBot, BotYardLog } from "../lib/trading-agents/yard-view";
import { tradingAgentPolicyValidator } from "./lib/tradingAgentSchema";
import { tradingAgentCapabilities } from "../lib/trading-agents/config";
import { AgentPolicyError, agentDecisionSchema, agentPolicySchema, isAgentPlatformToken, paperPortfolioSchema, settlePaperDecision, units } from "../lib/trading-agents/policy";
import { countAgentTrade, isSecondaryAgentToken, secondaryAgentTokens, secondaryTradeAvailable } from "../lib/trading-agents/universe";

// Deliberately internal only. No cron, public action, browser/X/TG entry point, CDP account, or signer.
// Future web adapters must derive ownerXUserId from a verified session, never request/model text.
const MAX_BOTS_PER_USER = 3;
function requirePaper() {
  const caps = tradingAgentCapabilities();
  if (!caps.paperTrading && !caps.liveTrading) throw new Error("TRADING_AGENTS_DISABLED");
}
function bounded(value: string, limit: number) {
  if (!value.trim() || value.length > limit) throw new Error("INVALID_AGENT_INPUT");
  return value.trim();
}
async function owned(ctx: QueryCtx | MutationCtx, id: Id<"tradingAgents">, owner: string) {
  const agent = await ctx.db.get(id);
  if (!agent || agent.ownerXUserId !== owner) throw new Error("AGENT_NOT_FOUND");
  return agent;
}
async function abandon(ctx: MutationCtx, cycleId: Id<"tradingAgentCycles"> | undefined, code: string) {
  if (!cycleId) return;
  const cycle = await ctx.db.get(cycleId);
  if (cycle?.status === "leased") await ctx.db.patch(cycleId, { status: "abandoned", diagnosticCode: code, completedAt: Date.now() });
}

export const createPaperAgent = internalMutation({
  args: { ownerXUserId: v.string(), creationKey: v.string(), name: v.string(), strategy: v.string(),
    policy: tradingAgentPolicyValidator, initialPaperCashWei: v.string() },
  handler: async (ctx, args) => {
    if (!tradingAgentCapabilities().paperTrading) throw new Error("PAPER_DISABLED");
    if (!/^\d{1,30}$/.test(args.ownerXUserId)) throw new Error("INVALID_OWNER_ID");
    const creationKey = bounded(args.creationKey, 100), name = bounded(args.name, 80), strategy = bounded(args.strategy, 2000);
    const policy = agentPolicySchema.parse(args.policy), cashWei = units.parse(args.initialPaperCashWei);
    const existing = await ctx.db.query("tradingAgents").withIndex("by_owner_creation", q => q.eq("ownerXUserId", args.ownerXUserId).eq("creationKey", creationKey)).unique();
    if (existing) {
      if (existing.name !== name || existing.strategy !== strategy || existing.initialPaperCashWei !== cashWei
        || JSON.stringify(agentPolicySchema.parse(existing.policy)) !== JSON.stringify(policy)) throw new Error("AGENT_CREATION_KEY_CONFLICT");
      return existing._id;
    }
    // Bound per-owner resource consumption even for future internal callers.
    const nameKey = botNameKey(name);
    if (await ctx.db.query("tradingAgents").withIndex("by_name", q => q.eq("nameKey", nameKey)).first()) throw new Error("BOT_NAME_TAKEN");
    const ownedAgents = await ctx.db.query("tradingAgents").withIndex("by_owner", q => q.eq("ownerXUserId", args.ownerXUserId)).take(MAX_BOTS_PER_USER);
    if (ownedAgents.length >= MAX_BOTS_PER_USER) throw new Error("AGENT_COUNT_LIMIT");
    const now = Date.now();
    return ctx.db.insert("tradingAgents", {
      ownerXUserId: args.ownerXUserId, creationKey, name, nameKey, strategy, mode: "paper", status: "draft", policy, policyVersion: 1,
      initialPaperCashWei: cashWei,
      portfolio: { cashWei, holdings: [], day: new Date(now).toISOString().slice(0, 10), turnoverWei: "0", gasWei: "0", trades: 0 },
      sequence: 0, nextRunAt: now, createdAt: now, updatedAt: now,
    });
  },
});

/** Trusted X interaction lookup only; NOT registered in polling, AI parsing, or reply handlers. */
export const createYardBotFromPost = internalMutation({
  args: { postId: v.string() },
  handler: async (ctx, { postId }) => {
    requirePaper();
    const post = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", postId)).unique();
    if (!post || !/^\d{1,30}$/.test(post.authorXUserId)) throw new Error("BOT_CREATION_POST_NOT_FOUND");
    const parsed = parseCreateBotPost(post.text);
    if (!parsed?.ok) throw new Error(parsed && !parsed.ok ? parsed.message : "NOT_A_BOT_CREATION_REQUEST");
    const creationKey = `x:${postId}`, ownerXUserId = post.authorXUserId;
    const existing = await ctx.db.query("tradingAgents").withIndex("by_owner_creation", q => q.eq("ownerXUserId", ownerXUserId).eq("creationKey", creationKey)).unique();
    if (existing) {
      if (existing.name !== parsed.name || existing.description !== parsed.description) throw new Error("AGENT_CREATION_KEY_CONFLICT");
      return existing._id;
    }
    if ((await ctx.db.query("tradingAgents").withIndex("by_owner", q => q.eq("ownerXUserId", ownerXUserId)).take(MAX_BOTS_PER_USER)).length >= MAX_BOTS_PER_USER) throw new Error("AGENT_COUNT_LIMIT");
    const nameKey = botNameKey(parsed.name);
    if (await ctx.db.query("tradingAgents").withIndex("by_name", q => q.eq("nameKey", nameKey)).first()) throw new Error("BOT_NAME_TAKEN");
    const now = Date.now(), schedule = initialYardSchedule(now), maximum = (2n ** 256n - 1n).toString();
    // Cash starts at zero. This creates neither a real wallet nor a funded paper balance.
    return ctx.db.insert("tradingAgents", {
      ownerXUserId, creationKey, name: parsed.name, nameKey, description: parsed.description, strategy: parsed.description, sourcePostId: postId,
      mode: tradingAgentCapabilities().liveTrading ? "live" : "paper", status: "draft", policyVersion: 1, schedule, sprite: createBotSprite(parsed.name, parsed.description),
      ...(tradingAgentCapabilities().walletProvisioning ? { walletProvisionStatus: "pending" as const, walletProvisionNextAt: now } : {}),
      policy: agentPolicySchema.parse({ intervalMs: BOT_TRADE_INTERVAL_MS, maxTradeWei: maximum, maxDailyTurnoverWei: maximum,
        maxGasPerTradeWei: "2000000000000000", maxDailyGasWei: "64000000000000000", reserveWei: "1000000000000000",
        maxPositions: 20, maxSlippageBps: 300, maxTradesPerDay: 32 }),
      initialPaperCashWei: "0", portfolio: { cashWei: "0", holdings: [], day: new Date(now).toISOString().slice(0, 10), turnoverWei: "0", gasWei: "0", trades: 0 },
      sequence: 0, nextRunAt: schedule.nextThoughtAt, createdAt: now, updatedAt: now,
    });
  },
});

/** Only prepare a creation reply after the matching bot record exists. No X publishing. */
export const creationReplyForPost = internalQuery({
  args: { postId: v.string() },
  handler: async (ctx, { postId }) => {
    requirePaper();
    const post = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", postId)).unique();
    if (!post) return null;
    const bot = await ctx.db.query("tradingAgents").withIndex("by_owner_creation", q => q.eq("ownerXUserId", post.authorXUserId).eq("creationKey", `x:${postId}`)).unique();
    if (!bot || bot.sourcePostId !== postId || !bot.description) return null;
    return { reply: botCreatedReply(bot.name, bot.description), allowLongPost: true };
  },
});

export const setPaperState = internalMutation({
  args: { agentId: v.id("tradingAgents"), ownerXUserId: v.string(), running: v.boolean() },
  handler: async (ctx, args) => {
    const agent = await owned(ctx, args.agentId, args.ownerXUserId);
    // Pausing always remains possible, including after the master flag is disabled.
    if (args.running) requirePaper();
    if (args.running && agent.status === "running") return;
    await abandon(ctx, agent.activeCycleId, "AGENT_STATE_CHANGED");
    const now = Date.now();
    // Resume on the next fixed slot rather than replaying missed hours of thoughts/trades.
    const schedule = agent.schedule && args.running
      ? advanceYardSchedule(advanceYardSchedule(agent.schedule, "thought", now), "trade", now) : agent.schedule;
    await ctx.db.patch(agent._id, { status: args.running ? "running" : "paused", activeCycleId: undefined, schedule,
      policyVersion: agent.policyVersion + 1, nextRunAt: schedule ? Math.min(schedule.nextThoughtAt, schedule.nextTradeAt) : Math.max(now, agent.nextRunAt), updatedAt: now });
  },
});

export const updatePaperPolicy = internalMutation({
  args: { agentId: v.id("tradingAgents"), ownerXUserId: v.string(), policy: tradingAgentPolicyValidator, strategy: v.string() },
  handler: async (ctx, args) => {
    requirePaper();
    const agent = await owned(ctx, args.agentId, args.ownerXUserId), policy = agentPolicySchema.parse(args.policy);
    if (agent.portfolio.holdings.length > policy.maxPositions) throw new Error("EXISTING_HOLDINGS_EXCEED_LIMIT");
    if (agent.schedule && policy.intervalMs !== BOT_TRADE_INTERVAL_MS) throw new Error("BOT_YARD_TRADE_INTERVAL_FIXED");
    await abandon(ctx, agent.activeCycleId, "POLICY_CHANGED");
    await ctx.db.patch(agent._id, { policy, strategy: bounded(args.strategy, 2000), status: "paused",
      policyVersion: agent.policyVersion + 1, activeCycleId: undefined, updatedAt: Date.now() });
  },
});

export const inspect = internalQuery({
  args: { agentId: v.id("tradingAgents"), ownerXUserId: v.string() },
  handler: async (ctx, args) => {
    const agent = await owned(ctx, args.agentId, args.ownerXUserId);
    const cycles = await ctx.db.query("tradingAgentCycles").withIndex("by_agent_created", q => q.eq("agentId", agent._id)).order("desc").take(30);
    // Lease tokens are worker credentials, not part of owner-facing status.
    return { agent, cycles: cycles.map(c => ({ cycleKey: c.cycleKey, status: c.status, createdAt: c.createdAt,
      completedAt: c.completedAt, decisionJson: c.decisionJson, diagnosticCode: c.diagnosticCode, kind: c.kind ?? "trade", thought: c.thought })) };
  },
});

async function yardSummary(ctx: QueryCtx, agent: Doc<"tradingAgents">): Promise<BotYardBot | null> {
  if (!agent.sprite || !agent.description) return null;
  const creator = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", q => q.eq("xUserId", agent.ownerXUserId)).unique();
  const creatorUsername = creator && /^[A-Za-z0-9_]{1,15}$/.test(creator.username) ? creator.username : undefined;
  return { id: agent._id, name: agent.name, description: agent.description, sprite: agent.sprite, status: agent.status,
    creatorUsername,
    mode: agent.mode, nextThoughtAt: agent.schedule?.nextThoughtAt, nextTradeAt: agent.schedule?.nextTradeAt,
    walletAddress: agent.walletAddress, logs: [] };
}
function yardLog(cycle: Doc<"tradingAgentCycles">): BotYardLog | null {
  if (cycle.status === "leased") return null;
  const base = { id: cycle._id, at: cycle.completedAt ?? cycle.createdAt, kind: cycle.kind ?? "trade" } as const;
  if (cycle.thought) return { ...base, outcome: "thought", summary: cycle.thought };
  if (cycle.status === "rejected" || cycle.status === "abandoned") return { ...base, outcome: "failed", transactionHashes: cycle.transactionHashes,
    summary: cycle.diagnosticCode === "LIVE_PARTIAL_FUNDING" || cycle.diagnosticCode === "LIVE_EXECUTION_INCOMPLETE"
      ? "The trade did not fully complete. Confirmed steps are linked below; any remaining assets stay in the bot wallet."
      : cycle.kind === "thought" ? "This observation could not be completed." : "The trade was skipped because its checks did not complete or a trading limit was reached." };
  try {
    const decision = agentDecisionSchema.parse(JSON.parse(cycle.decisionJson ?? ""));
    const quote = cycle.quoteJson ? JSON.parse(cycle.quoteJson) as { amountOut?: string } : undefined;
    return { ...base, outcome: cycle.status === "paper_filled" || cycle.status === "live_filled" || cycle.status === "executing" ? cycle.status : "held", summary: decision.reason, transactionHashes: cycle.transactionHashes,
      ...(decision.action === "hold" ? {} : { side: decision.action, token: decision.token, amountIn: decision.amount, amountOut: quote?.amountOut }) };
  } catch { return null; }
}
/** Safe presentation DTOs only; no owner IDs, creation keys, lease credentials or raw diagnostics. */
export const yardList = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requirePaper();
    const page = await ctx.db.query("tradingAgents").withIndex("by_created").order("desc").paginate({ cursor: args.cursor ?? null, numItems: 24 });
    return { bots: (await Promise.all(page.page.map(agent => yardSummary(ctx, agent)))).filter((bot): bot is BotYardBot => bot !== null), nextCursor: page.isDone ? null : page.continueCursor };
  },
});
export const yardDetail = internalQuery({
  args: { agentId: v.id("tradingAgents"), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requirePaper();
    const agent = await ctx.db.get(args.agentId), bot = agent ? await yardSummary(ctx, agent) : null;
    if (!bot) return null;
    const page = await ctx.db.query("tradingAgentCycles").withIndex("by_agent_created", q => q.eq("agentId", args.agentId))
      .order("desc").paginate({ cursor: args.cursor ?? null, numItems: 30 });
    return { bot: { ...bot, logs: page.page.map(yardLog).filter((log): log is BotYardLog => log !== null) }, nextCursor: page.isDone ? null : page.continueCursor };
  },
});

/** Staged read-only command adapter. Does not enqueue replies or alter an agent. */
export const checkBotPost = internalQuery({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    requirePaper();
    const nameKey = parseCheckBotPost(text);
    if (!nameKey) return null;
    const agent = await ctx.db.query("tradingAgents").withIndex("by_name", q => q.eq("nameKey", nameKey)).unique();
    if (!agent) return { reply: "⚠️ I couldn't find a bot with that name. Check the name and try again.", allowLongPost: true };
    const [thought, trade] = await Promise.all([
      ctx.db.query("tradingAgentCycles").withIndex("by_agent_kind_status", q => q.eq("agentId", agent._id).eq("kind", "thought").eq("status", "held")).order("desc").first(),
      ctx.db.query("tradingAgentCycles").withIndex("by_agent_status", q => q.eq("agentId", agent._id).eq("status", agent.mode === "live" ? "live_filled" : "paper_filled")).order("desc").first(),
    ]);
    const asset = async (token: string, amount: string): Promise<BotStatusAsset> => {
      // Registry is display metadata only, never authorization to trade a token.
      const metadata = await ctx.db.query("tokenRegistry").withIndex("by_normalized_address", q => q.eq("normalizedAddress", token.toLowerCase())).first();
      return { token, amount, symbol: metadata?.symbol, decimals: metadata?.decimals };
    };
    let lastTrade: Parameters<typeof formatBotStatus>[0]["trade"];
    if (trade) {
      const decision = agentDecisionSchema.parse(JSON.parse(trade.decisionJson!));
      const quote = JSON.parse(trade.quoteJson ?? "{}") as { amountOut?: string };
      if (decision.action !== "hold") lastTrade = {
        side: decision.action, asset: await asset(decision.token, decision.action === "buy" ? quote.amountOut ?? "0" : decision.amount),
        at: trade.completedAt ?? trade.createdAt, reason: decision.reason,
      };
    }
    return { allowLongPost: true, reply: formatBotStatus({ name: agent.name, mode: agent.mode,
      cashWei: agent.mode === "live" ? agent.liveHoldings?.cashWei ?? "0" : agent.portfolio.cashWei,
      holdingsAvailable: agent.mode === "paper" || Boolean(agent.liveHoldings?.complete),
      holdings: await Promise.all((agent.mode === "live" ? agent.liveHoldings?.tokens ?? [] : agent.portfolio.holdings).map(h => asset(h.token, h.amount))), updatedAt: agent.mode === "live" ? agent.liveHoldings?.observedAt ?? agent.updatedAt : agent.updatedAt,
      thought: thought?.thought ? { text: thought.thought, at: thought.completedAt ?? thought.createdAt } : undefined,
      trade: lastTrade,
    }) };
  },
});

/** Resolve a funding intent from a stored X post. Never sign, enqueue or move money. */
export const prepareBotFundingPost = internalQuery({
  args: { postId: v.string() },
  handler: async (ctx, { postId }) => {
    requirePaper();
    const post = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", postId)).unique();
    if (!post || !/^\d{1,30}$/.test(post.authorXUserId)) throw new Error("BOT_FUNDING_POST_NOT_FOUND");
    const request = parseBotFundingPost(post.text);
    if (!request || !request.ok) return request;
    const bot = await ctx.db.query("tradingAgents").withIndex("by_name", q => q.eq("nameKey", request.botNameKey)).unique();
    if (!bot) return { ok: false, message: "⚠️ I couldn't find a bot with that name. Check the name and try again." };
    if (!bot.walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(bot.walletAddress) || /^0x0{40}$/i.test(bot.walletAddress)) {
      return { ok: false, message: "⚠️ That bot's wallet isn't ready to receive funds yet. Nothing was sent." };
    }
    return { ok: true, status: "requires_transfer_validation", executionEnabled: false,
      sourcePostId: postId, senderXUserId: post.authorXUserId, botId: bot._id, botName: bot.name,
      recipientAddress: bot.walletAddress.toLowerCase(), chainId: 4663,
      amount: request.amount, unit: request.unit, asset: request.asset,
    };
  },
});

export const platformTokens = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requirePaper();
    const page = await ctx.db.query("tokenLaunches").withIndex("by_public_created_at", q =>
      q.eq("publicPublished", true)).order("desc").paginate({ cursor: args.cursor ?? null, numItems: 100 });
    return { tokens: page.page.filter(row => isAgentPlatformToken(row.tokenAddress ?? "", row)).map(row => ({
      address: row.tokenAddress!.toLowerCase(), symbol: row.symbol,
      // Display/discovery hints only, never execution prices.
      marketCapUsd: row.publicMarketCapUsd, marketCapUpdatedAt: row.publicMarketCapUpdatedAt,
    })), nextCursor: page.isDone ? null : page.continueCursor };
  },
});

export const leaseNextPaperCycle = internalMutation({
  args: { leaseToken: v.string() },
  handler: async (ctx, { leaseToken }) => {
    requirePaper();
    if (!/^[a-zA-Z0-9_-]{20,100}$/.test(leaseToken)) throw new Error("INVALID_LEASE_TOKEN");
    const now = Date.now();
    if (!tradingAgentCapabilities().paperTrading) return null;
    const agent = await ctx.db.query("tradingAgents").withIndex("by_mode_status_due", q => q.eq("mode", "paper").eq("status", "running").lte("nextRunAt", now)).first();
    if (!agent) return null;
    let schedule = agent.schedule;
    if (agent.activeCycleId) {
      const prior = await ctx.db.get(agent.activeCycleId);
      if (prior?.status === "leased" && prior.leaseUntil > now) return null;
      await abandon(ctx, agent.activeCycleId, "WORKER_LEASE_EXPIRED");
      // A failed trade slot does not silently become another trade two minutes later.
      if (schedule && prior) schedule = advanceYardSchedule(schedule, prior.kind ?? "trade", now);
    }
    const kind = schedule ? dueYardCycle(schedule, now) : "trade";
    if (!kind) {
      await ctx.db.patch(agent._id, { schedule, activeCycleId: undefined, nextRunAt: Math.min(schedule!.nextThoughtAt, schedule!.nextTradeAt) });
      return null;
    }
    const sequence = agent.sequence + 1, cycleKey = `${agent._id}:${agent.policyVersion}:${sequence}`, leaseUntil = now + 120_000;
    const cycleId = await ctx.db.insert("tradingAgentCycles", {
      agentId: agent._id, cycleKey, policyVersion: agent.policyVersion, leaseToken, leaseUntil, createdAt: now, status: "leased", kind,
    });
    await ctx.db.patch(agent._id, { activeCycleId: cycleId, nextRunAt: leaseUntil, sequence, updatedAt: now, schedule });
    return { agent: { ...agent, schedule }, cycleId, cycleKey, leaseUntil, kind };
  },
});

export const finishPaperCycle = internalMutation({
  args: { cycleId: v.id("tradingAgentCycles"), leaseToken: v.string(), decisionJson: v.string(), quoteJson: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requirePaper();
    if (args.decisionJson.length > 2000 || (args.quoteJson?.length ?? 0) > 4000) throw new Error("AGENT_PAYLOAD_TOO_LARGE");
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle || cycle.leaseToken !== args.leaseToken) throw new Error("CYCLE_NOT_FOUND");
    const completionDigest = hashMessage(JSON.stringify([args.decisionJson, args.quoteJson ?? ""]));
    // Terminal states are immutable: retries cannot apply paper balances twice.
    if (cycle.status !== "leased") {
      if (cycle.completionDigest && cycle.completionDigest !== completionDigest) throw new Error("CYCLE_COMPLETION_CONFLICT");
      return { status: cycle.status, cycleId: cycle.cycleKey };
    }
    const agent = await ctx.db.get(cycle.agentId), now = Date.now();
    if (!agent || agent.mode !== "paper" || agent.status !== "running" || agent.activeCycleId !== cycle._id
      || agent.policyVersion !== cycle.policyVersion || cycle.leaseUntil <= now) throw new Error("STALE_AGENT_CYCLE");
    let status: "paper_filled" | "held" | "rejected" = "rejected";
    let diagnosticCode: string | undefined, decisionJson: string | undefined, quoteJson: string | undefined, thought: string | undefined;
    let portfolio = paperPortfolioSchema.parse(agent.portfolio);
    try {
      if (cycle.kind === "thought") {
        if (args.quoteJson !== undefined) throw new Error("THOUGHT_CANNOT_TRADE");
        thought = botThoughtSchema.parse(JSON.parse(args.decisionJson)).thought;
        status = "held";
      } else {
        const decision = agentDecisionSchema.parse(JSON.parse(args.decisionJson));
        decisionJson = JSON.stringify(decision);
        const launch = decision.action === "hold" ? null : await ctx.db.query("tokenLaunches")
          .withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", decision.token)).unique();
        const result = settlePaperDecision({ agentId: agent._id, cycleId: cycle.cycleKey, policyVersion: agent.policyVersion,
          now, policy: agent.policy, portfolio, decision, launch, tradeMix: agent.paperTradeMix, quote: args.quoteJson ? JSON.parse(args.quoteJson) : undefined });
        portfolio = result.portfolio;
        quoteJson = result.quote ? JSON.stringify(result.quote) : undefined;
        status = decision.action === "hold" ? "held" : "paper_filled";
        if (decision.action !== "hold") await ctx.db.patch(agent._id, { paperTradeMix: countAgentTrade(agent.paperTradeMix, isSecondaryAgentToken(decision.token) ? "secondary" : "platform") });
      }
    } catch (error) {
      // Do not persist provider payloads, arbitrary exception messages, credentials, or model dumps.
      diagnosticCode = error instanceof AgentPolicyError ? error.code : "INVALID_PAPER_INPUT";
    }
    const schedule = agent.schedule ? advanceYardSchedule(agent.schedule, cycle.kind ?? "trade", now) : undefined;
    const nextRunAt = schedule ? Math.min(schedule.nextThoughtAt, schedule.nextTradeAt)
      : agent.createdAt + (Math.floor((now - agent.createdAt) / agent.policy.intervalMs) + 1) * agent.policy.intervalMs;
    await ctx.db.patch(cycle._id, { status, completedAt: now, diagnosticCode, decisionJson, quoteJson, completionDigest, thought });
    await ctx.db.patch(agent._id, { portfolio, activeCycleId: undefined, nextRunAt, updatedAt: now, schedule });
    return { status, cycleId: cycle.cycleKey };
  },
});

export const workerContext = internalQuery({
  args: { cycleId: v.id("tradingAgentCycles"), leaseToken: v.string() },
  handler: async (ctx, args) => {
    requirePaper();
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle || cycle.leaseToken !== args.leaseToken || cycle.status !== "leased" || cycle.leaseUntil <= Date.now()) throw new Error("STALE_AGENT_CYCLE");
    const agent = await ctx.db.get(cycle.agentId);
    if (!agent || agent.activeCycleId !== cycle._id || agent.policyVersion !== cycle.policyVersion || agent.status !== "running") throw new Error("STALE_AGENT_CYCLE");
    const launches = await ctx.db.query("tokenLaunches").withIndex("by_public_created_at", q => q.eq("publicPublished", true)).order("desc").take(100);
    const established = agent.mode === "live" ? await ctx.db.query("tokenLaunches").withIndex("by_public_market_cap", q => q.eq("publicPublished", true)).order("desc").take(40) : [];
    const held = await Promise.all((agent.mode === "live" ? agent.liveHoldings?.tokens ?? [] : agent.portfolio.holdings).map(h => ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", h.token)).unique()));
    const primary = [...new Map([...held, ...established, ...launches].filter(l => l && isAgentPlatformToken(l.tokenAddress ?? "", l)).map(l => [l!.tokenAddress!.toLowerCase(), { address: l!.tokenAddress!.toLowerCase(), symbol: l!.symbol }])).values()];
    const mix = agent.mode === "live" ? agent.liveTradeMix : agent.paperTradeMix;
    const holdings = agent.mode === "live" ? agent.liveHoldings?.tokens ?? [] : agent.portfolio.holdings;
    const owned = new Set(holdings.map(h => h.token.toLowerCase()));
    // Keep held secondary assets and PONS visible; rotate the remainder without displacing primary markets.
    const rotation = agent.sequence % Math.max(1, secondaryAgentTokens.length);
    const alternatives = secondaryTradeAvailable(mix) ? [...new Map([
      ...secondaryAgentTokens.filter(t => owned.has(t.address) || t.symbol === "PONS"),
      ...secondaryAgentTokens.slice(rotation), ...secondaryAgentTokens.slice(0, rotation),
    ].map(t => [t.address, t])).values()].slice(0, 40) : [];
    const tokens = [...primary.slice(0, 100 - alternatives.length), ...alternatives];
    const history = await ctx.db.query("tradingAgentCycles").withIndex("by_agent_created", q => q.eq("agentId", agent._id)).order("desc").take(16);
    return { agent, cycle, tokens, recentLog: history.map(yardLog).filter((l): l is BotYardLog => Boolean(l)).slice(0, 15).map(l => ({ at: l.at, summary: l.summary })) };
  },
});

export const reserveModelCall = internalMutation({
  args: { cycleId: v.id("tradingAgentCycles"), leaseToken: v.string() },
  handler: async (ctx, args) => {
    requirePaper();
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle || cycle.leaseToken !== args.leaseToken || cycle.status !== "leased" || cycle.leaseUntil <= Date.now()) return false;
    const agent = await ctx.db.get(cycle.agentId);
    if (!agent || agent.status !== "running" || agent.activeCycleId !== cycle._id || agent.policyVersion !== cycle.policyVersion) return false;
    const day = new Date().toISOString().slice(0, 10), calls = agent.modelDay === day ? agent.modelCalls ?? 0 : 0;
    const global = await ctx.db.query("tradingAgentBudgets").withIndex("by_day", q => q.eq("day", day)).unique();
    if (calls >= 160 || (global?.calls ?? 0) >= 12_800) return false;
    await ctx.db.patch(agent._id, { modelDay: day, modelCalls: calls + 1 });
    if (global) await ctx.db.patch(global._id, { calls: global.calls + 1 });
    else await ctx.db.insert("tradingAgentBudgets", { day, calls: 1 });
    return true;
  },
});

export const startYardDraft = internalMutation({
  args: { agentId: v.id("tradingAgents") },
  handler: async (ctx, { agentId }) => {
    requirePaper();
    const agent = await ctx.db.get(agentId);
    if (!agent || !agent.schedule || agent.status !== "draft") return;
    // Keep the creation-time anchor rather than restarting the initial wait.
    const schedule = agent.schedule;
    await ctx.db.patch(agent._id, { status: "running", schedule, nextRunAt: schedule.nextThoughtAt, updatedAt: Date.now() });
  },
});

/** Operator-only paper capital, not a deposit and never added to a real wallet. */
export const seedPaperCapital = internalMutation({
  args: { agentId: v.id("tradingAgents"), cashWei: v.string() },
  handler: async (ctx, args) => {
    requirePaper();
    const agent = await ctx.db.get(args.agentId), cashWei = units.parse(args.cashWei);
    if (!agent || agent.mode !== "paper" || agent.status === "running" || agent.activeCycleId || agent.sequence !== 0) throw new Error("PAPER_SEED_REQUIRES_UNUSED_PAUSED_AGENT");
    if (BigInt(cashWei) > 100n * 10n ** 18n) throw new Error("PAPER_SEED_LIMIT");
    await ctx.db.patch(agent._id, { initialPaperCashWei: cashWei, portfolio: { ...agent.portfolio, cashWei }, updatedAt: Date.now() });
  },
});

export const bindAgentWallet = internalMutation({
  args: { agentId: v.id("tradingAgents"), address: v.string(), leaseToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!tradingAgentCapabilities().walletProvisioning) throw new Error("AGENT_WALLET_PROVISIONING_DISABLED");
    const agent = await ctx.db.get(args.agentId), address = args.address.toLowerCase();
    if (!agent || !/^0x[0-9a-f]{40}$/.test(address) || /^0x0{40}$/.test(address)) throw new Error("INVALID_AGENT_WALLET");
    if (agent.walletProvisionStatus === "leased" && agent.walletProvisionLeaseToken !== args.leaseToken) throw new Error("STALE_AGENT_WALLET_LEASE");
    if (agent.walletAddress && agent.walletAddress.toLowerCase() !== address) throw new Error("AGENT_WALLET_IMMUTABLE");
    const existing = await ctx.db.query("tradingAgents").withIndex("by_wallet", q => q.eq("walletAddress", address)).unique();
    if (existing && existing._id !== agent._id) throw new Error("AGENT_WALLET_COLLISION");
    await ctx.db.patch(agent._id, { walletAddress: address, walletProvisionStatus: "ready", walletProvisionLeaseToken: undefined, walletProvisionNextAt: undefined, updatedAt: Date.now() });
  },
});

export const leaseAgentProvision = internalMutation({
  args: { leaseToken: v.string() },
  handler: async (ctx, { leaseToken }) => {
    if (!tradingAgentCapabilities().walletProvisioning) return null;
    if (leaseToken.length < 20 || leaseToken.length > 100) throw new Error("INVALID_LEASE_TOKEN");
    const now = Date.now();
    const expired = await ctx.db.query("tradingAgents").withIndex("by_provision_due", q => q.eq("walletProvisionStatus", "leased").lte("walletProvisionNextAt", now)).first();
    const agent = expired ?? await ctx.db.query("tradingAgents").withIndex("by_provision_due", q => q.eq("walletProvisionStatus", "pending").lte("walletProvisionNextAt", now)).first();
    if (!agent) return null;
    await ctx.db.patch(agent._id, { walletProvisionStatus: "leased", walletProvisionLeaseToken: leaseToken, walletProvisionNextAt: now + 300_000 });
    return { agentId: agent._id };
  },
});

/** Public DTO only. Disabled by default; no private ids, policies or signing state. */
export const publicYard = query({
  args: { selected: v.optional(v.id("tradingAgents")), walletAddress: v.optional(v.string()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!tradingAgentCapabilities().website) return { bots: [], nextCursor: null };
    const selected = args.selected ? await ctx.db.get(args.selected) : args.walletAddress && /^0x[0-9a-fA-F]{40}$/.test(args.walletAddress)
      ? await ctx.db.query("tradingAgents").withIndex("by_wallet", q => q.eq("walletAddress", args.walletAddress!.toLowerCase())).unique() : null;
    if (args.selected || args.walletAddress) {
      const bot = selected ? await yardSummary(ctx, selected) : null;
      if (!bot || !selected) return { bots: [], nextCursor: null };
      const logs = await ctx.db.query("tradingAgentCycles").withIndex("by_agent_created", q => q.eq("agentId", selected._id)).order("desc").take(30);
      return { bots: [{ ...bot, ...(selected.mode === "live" ? { liveHoldings: selected.liveHoldings } : { paperHoldings: { cashWei: selected.portfolio.cashWei, tokens: selected.portfolio.holdings, updatedAt: selected.updatedAt } }),
        logs: logs.map(yardLog).filter((l): l is BotYardLog => Boolean(l)) }], nextCursor: null };
    }
    const page = await ctx.db.query("tradingAgents").withIndex("by_created").order("desc").paginate({ cursor: args.cursor ?? null, numItems: 24 });
    return { bots: (await Promise.all(page.page.map(a => yardSummary(ctx, a)))).filter((b): b is BotYardBot => Boolean(b)), nextCursor: page.isDone ? null : page.continueCursor };
  },
});
