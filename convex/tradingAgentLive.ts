import { v } from "convex/values";
import { isSecondaryAgentToken, secondaryTradeAvailable } from "../lib/trading-agents/universe";
import { makeFunctionReference } from "convex/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { openRouter } from "./llm";
import { tradingAgentCapabilities } from "../lib/trading-agents/config";
import { advanceYardSchedule, botThoughtSchema, dueYardCycle, initialYardSchedule } from "../lib/trading-agents/bot-yard";
import { agentDecisionSchema, isAgentPlatformToken, units } from "../lib/trading-agents/policy";
import { reserveLiveDecision, type LiveSnapshot } from "../lib/trading-agents/live-policy";
import { runAgentModel } from "../lib/trading-agents/model";
import { agentMarketsSchema } from "../lib/trading-agents/market";
import type { AgentMarketContext } from "../lib/trading-agents/eliza-bridge";
import { z } from "zod";
import { loadPnlState } from "../lib/trading-agents/pnl";

const snapshotSchema = z.object({ cashWei: units, tokens: z.array(z.object({ token: z.string().regex(/^0x[0-9a-f]{40}$/), amount: units })).max(100), observedAt: z.number().int().positive(), complete: z.boolean() }).strict();
type Lease = { agent: Doc<"tradingAgents">; cycleId: Id<"tradingAgentCycles">; kind: "thought" | "trade" };
export const lease = internalMutation({
  args: { leaseToken: v.string() }, handler: async (ctx, { leaseToken }): Promise<Lease | null> => {
    if (!tradingAgentCapabilities().liveTrading || !tradingAgentCapabilities().scheduler) return null;
    if (!/^[a-zA-Z0-9_-]{20,100}$/.test(leaseToken)) throw new Error("INVALID_LEASE");
    const now = Date.now(), agent = await ctx.db.query("tradingAgents").withIndex("by_mode_status_due", q => q.eq("mode", "live").eq("status", "running").lte("nextRunAt", now)).first();
    if (!agent) return null;
    if (!agent.walletAddress || agent.walletProvisionStatus !== "ready") { await ctx.db.patch(agent._id, { nextRunAt: now + 60000 }); return null; }
    let schedule = agent.schedule ?? initialYardSchedule(now);
    if (agent.activeCycleId) {
      const old = await ctx.db.get(agent.activeCycleId);
      if (old?.status === "leased" && old.leaseUntil > now) return null;
      if (old?.status === "leased") { await ctx.db.patch(old._id, { status: "abandoned", completedAt: now, diagnosticCode: "WORKER_LEASE_EXPIRED" }); schedule = advanceYardSchedule(schedule, old.kind ?? "trade", now); }
    }
    const kind = dueYardCycle(schedule, now);
    if (!kind) { await ctx.db.patch(agent._id, { activeCycleId: undefined, schedule, nextRunAt: Math.min(schedule.nextThoughtAt, schedule.nextTradeAt) }); return null; }
    if (kind === "trade" && await ctx.db.query("tradingAgentExecutions").withIndex("by_agent_state", q => q.eq("agentId", agent._id).eq("state", "active")).first()) {
      schedule = advanceYardSchedule(schedule, "trade", now);
      await ctx.db.patch(agent._id, { activeCycleId: undefined, schedule, nextRunAt: Math.min(schedule.nextThoughtAt, schedule.nextTradeAt) }); return null;
    }
    const sequence = agent.sequence + 1;
    const cycleId = await ctx.db.insert("tradingAgentCycles", { agentId: agent._id, cycleKey: `${agent._id}:live:${agent.policyVersion}:${sequence}`, policyVersion: agent.policyVersion,
      leaseToken, leaseUntil: now + 180000, createdAt: now, status: "leased", kind });
    await ctx.db.patch(agent._id, { sequence, activeCycleId: cycleId, schedule, nextRunAt: now + 180000 });
    return { agent, cycleId, kind };
  },
});
export const complete = internalMutation({
  args: { cycleId: v.id("tradingAgentCycles"), leaseToken: v.string(), resultJson: v.string(), snapshotJson: v.optional(v.string()), failed: v.optional(v.boolean()), ethUsd: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!tradingAgentCapabilities().liveTrading) throw new Error("LIVE_DISABLED");
    if (args.resultJson.length > 3000 || (args.snapshotJson?.length ?? 0) > 20000) throw new Error("PAYLOAD_TOO_LARGE");
    const cycle = await ctx.db.get(args.cycleId);
    if (!cycle || cycle.leaseToken !== args.leaseToken) throw new Error("STALE_CYCLE");
    if (cycle.status !== "leased") return cycle.executionId ?? null;
    const agent = await ctx.db.get(cycle.agentId), now = Date.now();
    if (!agent || agent.mode !== "live" || agent.status !== "running" || agent.activeCycleId !== cycle._id || agent.policyVersion !== cycle.policyVersion || cycle.leaseUntil <= now) throw new Error("STALE_CYCLE");
    let status: "held" | "executing" | "rejected" = "held", executionId: Id<"tradingAgentExecutions"> | undefined, thought: string | undefined, decisionJson: string | undefined;
    try {
      if (args.failed) throw new Error("LIVE_CHECK_FAILED");
      if (cycle.kind === "thought") {
        thought = botThoughtSchema.parse(JSON.parse(args.resultJson)).thought;
        if (args.snapshotJson) {
          const snapshot = snapshotSchema.parse(JSON.parse(args.snapshotJson));
          if (snapshot.complete && snapshot.observedAt <= now && now - snapshot.observedAt <= 60000) await ctx.db.patch(agent._id, { liveHoldings: snapshot });
        }
      }
      else {
        const snapshot = snapshotSchema.parse(JSON.parse(args.snapshotJson ?? ""));
        const decision = agentDecisionSchema.parse(JSON.parse(args.resultJson));
        const reservation = reserveLiveDecision(decision, agent.policy, snapshot, agent.liveBudget, now);
        decisionJson = JSON.stringify(decision);
        if (decision.action === "buy" && args.ethUsd && Number.isFinite(args.ethUsd) && args.ethUsd > 0) {
          const buyUsd = Number(decision.amount) / 1e18 * args.ethUsd;
          if (Number.isFinite(buyUsd)) await ctx.db.patch(cycle._id, { buyUsd });
        }
        await ctx.db.patch(agent._id, { liveHoldings: snapshot });
        if (decision.action !== "hold") {
          const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", decision.token)).unique();
          const tradeBucket = isSecondaryAgentToken(decision.token) ? "secondary" : "platform";
          if (tradeBucket === "platform" && !isAgentPlatformToken(decision.token, launch)) throw new Error("NOT_PLATFORM_TOKEN");
          if (tradeBucket === "secondary" && !secondaryTradeAvailable(agent.liveTradeMix)) throw new Error("SECONDARY_TRADE_QUOTA");
          if (await ctx.db.query("tradingAgentExecutions").withIndex("by_agent_state", q => q.eq("agentId", agent._id).eq("state", "active")).first()) throw new Error("WALLET_BUSY");
          if (!agent.walletAddress || agent.walletProvisionStatus !== "ready") throw new Error("WALLET_NOT_READY");
          executionId = await ctx.db.insert("tradingAgentExecutions", { agentId: agent._id, ownerXUserId: agent.ownerXUserId, requestKey: `live:${cycle._id}`, cycleId: cycle._id,
            tradeBucket, policyJson: JSON.stringify(agent.policy), policyVersion: agent.policyVersion, from: agent.walletAddress, destination: agent.walletAddress,
            intentJson: JSON.stringify({ kind: decision.action, token: decision.token, amount: decision.amount }), state: "active", step: 0, hashes: [], gasSpentWei: "0", createdAt: now, updatedAt: now });
          await ctx.db.patch(agent._id, { liveBudget: reservation.budget });
          await ctx.scheduler.runAfter(0, makeFunctionReference<"action", { jobId: Id<"tradingAgentExecutions"> }>("tradingAgentExecution:run"), { jobId: executionId });
          status = "executing";
        }
      }
    } catch (error) { if (executionId) throw error; status = "rejected"; }
    const schedule = advanceYardSchedule(agent.schedule ?? initialYardSchedule(now), cycle.kind ?? "trade", now);
    await ctx.db.patch(cycle._id, { status, thought, decisionJson, ...(executionId ? { executionId } : {}), completedAt: now, ...(status === "rejected" ? { diagnosticCode: "LIVE_CHECK_OR_POLICY_FAILED" } : {}) });
    await ctx.db.patch(agent._id, { activeCycleId: undefined, schedule, nextRunAt: Math.min(schedule.nextThoughtAt, schedule.nextTradeAt), updatedAt: now });
    return executionId ?? null;
  },
});

export const work = internalAction({
  args: {}, handler: async ctx => {
    if (!tradingAgentCapabilities().liveTrading || !tradingAgentCapabilities().scheduler) return;
    const leaseToken = crypto.randomUUID();
    const current = await ctx.runMutation(makeFunctionReference<"mutation", { leaseToken: string }, Lease | null>("tradingAgentLive:lease"), { leaseToken });
    if (!current) return;
    let ethUsd: number | undefined;
    const finish = (resultJson: string, snapshot?: LiveSnapshot, failed = false) => ctx.runMutation(makeFunctionReference<"mutation", { cycleId: Id<"tradingAgentCycles">; leaseToken: string; resultJson: string; snapshotJson?: string; failed: boolean; ethUsd?: number }>("tradingAgentLive:complete"), {
      cycleId: current.cycleId, leaseToken, resultJson, ...(snapshot ? { snapshotJson: JSON.stringify(snapshot) } : {}), ...(ethUsd ? { ethUsd } : {}), failed,
    });
    try {
      const context = await ctx.runQuery(makeFunctionReference<"query", { cycleId: Id<"tradingAgentCycles">; leaseToken: string }, { tokens: Array<{ address: string; symbol: string }>; recentLog: AgentMarketContext["recentLog"]; yard: AgentMarketContext["yard"] }>("tradingAgents:workerContext"), { cycleId: current.cycleId, leaseToken });
      if (current.kind === "thought") {
        // Thoughts are not transactions. They must not depend on inventory, pricing, or signer availability.
        if (!await ctx.runMutation(makeFunctionReference<"mutation", { cycleId: Id<"tradingAgentCycles">; leaseToken: string }, boolean>("tradingAgents:reserveModelCall"), { cycleId: current.cycleId, leaseToken })) throw new Error("MODEL_LIMIT");
        const result = await runAgentModel("thought", { agentId: current.agent._id, cycleId: current.cycleId, policyVersion: current.agent.policyVersion,
          observedAt: Date.now(), strategy: current.agent.strategy, character: { name: current.agent.name, description: current.agent.description ?? current.agent.strategy }, policy: current.agent.policy,
          tokens: context.tokens, cashWei: "0", holdings: [], holdingsAvailable: false, recentLog: context.recentLog, yard: context.yard }, AbortSignal.timeout(50000), openRouter);
        await finish(JSON.stringify(result));
        return;
      }
      const base = new URL((process.env.WALLET_SIGNER_URL || `${process.env.NEXT_PUBLIC_SITE_URL}/api/wallet-signer`).replace(/\/$/, "") + "/v1/agents/live-context");
      if (base.protocol !== "https:" || base.username || base.password || !process.env.WALLET_SIGNER_TOKEN) throw new Error("SIGNER_NOT_CONFIGURED");
      const response = await fetch(base, { method: "POST", headers: { authorization: `Bearer ${process.env.WALLET_SIGNER_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ agentId: current.agent._id, walletAddress: current.agent.walletAddress, tokens: context.tokens.map(t => t.address) }), signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error("LIVE_MARKETS_UNAVAILABLE");
      const data = await response.json() as { markets: unknown; snapshot: unknown };
      const markets = agentMarketsSchema.parse(data.markets), snapshot = snapshotSchema.parse(data.snapshot);
      ethUsd = markets.ethUsd;
      const heldAllowed = await ctx.runQuery(makeFunctionReference<"query", { tokens: string[] }, string[]>("tradingAgentLive:allowedHoldings"), { tokens: snapshot.tokens.map(t => t.token) });
      const allowed = new Set([...context.tokens.map(t => t.address), ...heldAllowed].filter(t => !isSecondaryAgentToken(t) || secondaryTradeAvailable(current.agent.liveTradeMix)));
      // Non-platform holdings remain visible to wallet management but never become model trade candidates.
      if (!snapshot.complete) throw new Error("LIVE_HOLDINGS_INCOMPLETE");
      // A verified balance read is useful even if the later model or trade step fails.
      await ctx.runMutation(makeFunctionReference<"mutation", { agentId: Id<"tradingAgents">; snapshotJson: string }>("tradingAgentLive:saveHoldings"), {
        agentId: current.agent._id, snapshotJson: JSON.stringify(snapshot),
      });
      if (!await ctx.runMutation(makeFunctionReference<"mutation", { cycleId: Id<"tradingAgentCycles">; leaseToken: string }, boolean>("tradingAgents:reserveModelCall"), { cycleId: current.cycleId, leaseToken })) throw new Error("MODEL_LIMIT");
      const result = await runAgentModel(current.kind, { agentId: current.agent._id, cycleId: current.cycleId, policyVersion: current.agent.policyVersion,
        observedAt: markets.observedAt, strategy: current.agent.strategy, character: { name: current.agent.name, description: current.agent.description ?? current.agent.strategy }, policy: current.agent.policy,
        ethUsd: markets.ethUsd,
        tokens: markets.tokens.filter(t => allowed.has(t.address)).map(({ address, symbol, decimals, priceUsd, priceObservedAt, volume24hUsd }) => ({ address, symbol, decimals, priceUsd, priceObservedAt, volume24hUsd })),
        cashWei: snapshot.cashWei, holdings: snapshot.tokens.filter(t => allowed.has(t.token)).slice(0, 20), recentLog: context.recentLog, yard: context.yard }, AbortSignal.timeout(50000), openRouter);
      let finalSnapshot = snapshot;
      if (current.kind === "trade") {
        const refreshed = await fetch(new URL(base.toString().replace(/live-context$/, "live-balances")), { method: "POST",
          headers: { authorization: `Bearer ${process.env.WALLET_SIGNER_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ agentId: current.agent._id, walletAddress: current.agent.walletAddress, tokens: [...new Set([...snapshot.tokens.map(t=>t.token),...markets.tokens.map(t=>t.address)])].slice(0,100) }), signal: AbortSignal.timeout(25000) });
        if (!refreshed.ok) throw new Error("LIVE_BALANCE_REFRESH_FAILED");
        finalSnapshot = snapshotSchema.parse(await refreshed.json());
      }
      await finish(JSON.stringify(result), finalSnapshot);
    } catch { await finish("{}", undefined, true); }
  },
});

export const allowedHoldings = internalQuery({
  args: { tokens: v.array(v.string()) }, handler: async (ctx, { tokens }) => {
    if (tokens.length > 100) throw new Error("TOO_MANY_TOKENS");
    const records = await Promise.all(tokens.map(async token => {
      const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", token)).unique();
      return isAgentPlatformToken(token, launch) || isSecondaryAgentToken(token) ? token : null;
    }));
    return records.filter((token): token is string => token !== null);
  },
});

export const saveHoldings = internalMutation({
  args: { agentId: v.id("tradingAgents"), snapshotJson: v.string() }, handler: async (ctx, args) => {
    if (args.snapshotJson.length > 20000) throw new Error("PAYLOAD_TOO_LARGE");
    const snapshot = snapshotSchema.parse(JSON.parse(args.snapshotJson)), agent = await ctx.db.get(args.agentId);
    if (!agent || agent.mode !== "live" || !snapshot.complete || snapshot.observedAt > Date.now() || snapshot.observedAt < (agent.liveHoldings?.observedAt ?? 0)) return;
    await ctx.db.patch(agent._id, { liveHoldings: snapshot, pnlNextAt: Date.now(), updatedAt: Date.now() });
  },
});
export const inventoryTokens = internalQuery({
  args:{agentId:v.id("tradingAgents")},handler:async(ctx,{agentId})=>{
    const agent=await ctx.db.get(agentId);
    if(!agent)return [];
    const state=loadPnlState(agent.pnlStateJson);
    const tokens=[...new Set([...(agent.liveHoldings?.tokens.map(t=>t.token)??[]),...Object.entries(state.lots).filter(([,lot])=>BigInt(lot.amount)>0n).map(([token])=>token)])];
    if(tokens.length>100)throw new Error("AGENT_INVENTORY_LIMIT");
    return tokens;
  },
});
export const refreshAfterExecution = internalAction({
  args: { jobId: v.id("tradingAgentExecutions") }, handler: async (ctx, { jobId }) => {
    if (!tradingAgentCapabilities().liveTrading || !process.env.WALLET_SIGNER_TOKEN) return;
    const job = await ctx.runQuery(makeFunctionReference<"query", { secret: string; jobId: Id<"tradingAgentExecutions"> }, Doc<"tradingAgentExecutions"> | null>("tradingAgentExecution:read"), { secret: process.env.WALLET_SIGNER_TOKEN, jobId });
    if (!job || job.state === "active") return;
    const base = new URL((process.env.WALLET_SIGNER_URL || `${process.env.NEXT_PUBLIC_SITE_URL}/api/wallet-signer`).replace(/\/$/, "") + "/v1/agents/live-context");
    if (base.protocol !== "https:" || base.username || base.password) return;
    try {
      const intent = JSON.parse(job.intentJson) as { token?: string };
      const tracked=await ctx.runQuery(makeFunctionReference<"query",{agentId:Id<"tradingAgents">},string[]>("tradingAgentLive:inventoryTokens"),{agentId:job.agentId});
      const tokens=[...new Set([...tracked,...(intent.token?[intent.token]:[])])];
      if(tokens.length>100)return;
      const response = await fetch(base, { method: "POST", headers: { authorization: `Bearer ${process.env.WALLET_SIGNER_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ agentId: job.agentId, walletAddress: job.from, tokens, minimumBlock: job.confirmedBlock }), signal: AbortSignal.timeout(60000) });
      if (!response.ok) return;
      const data = await response.json() as { snapshot: unknown };
      await ctx.runMutation(makeFunctionReference<"mutation", { agentId: Id<"tradingAgents">; snapshotJson: string }>("tradingAgentLive:saveHoldings"), { agentId: job.agentId, snapshotJson: JSON.stringify(data.snapshot) });
    } catch { /* A failed display refresh never rolls back or repeats a completed transaction. */ }
  },
});

/** Explicit operator migration, never converts simulated balances into real funds. */
export const activateExisting = internalMutation({
  args: { agentId: v.id("tradingAgents") }, handler: async (ctx, { agentId }) => {
    if (!tradingAgentCapabilities().liveTrading) throw new Error("LIVE_DISABLED");
    const agent = await ctx.db.get(agentId);
    if (!agent || !agent.walletAddress || agent.walletProvisionStatus !== "ready" || agent.activeCycleId) throw new Error("AGENT_NOT_READY");
    if (await ctx.db.query("tradingAgentExecutions").withIndex("by_agent_state", q => q.eq("agentId", agentId).eq("state", "active")).first()) throw new Error("WALLET_BUSY");
    if (agent.mode === "live") return;
    const now = Date.now(), schedule = initialYardSchedule(now);
    await ctx.db.patch(agentId, { mode: "live", status: "running", policyVersion: agent.policyVersion + 1, schedule, nextRunAt: schedule.nextThoughtAt, updatedAt: now });
  },
});
