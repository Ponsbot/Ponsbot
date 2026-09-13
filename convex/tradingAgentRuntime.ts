import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { openRouter } from "./llm";
import { runAgentModel } from "../lib/trading-agents/model";
import { runPaperAgentCycle } from "../lib/trading-agents/paper-worker";
import { tradingAgentCapabilities } from "../lib/trading-agents/config";
import { agentMarketsSchema, paperMarketQuote, type AgentMarkets } from "../lib/trading-agents/market";
import { parseCreateBotPost } from "../lib/trading-agents/bot-yard";
import { parseCheckBotPost } from "../lib/trading-agents/status";
import { parseBotFundingPost } from "../lib/trading-agents/funding";
import { botCreatedReply } from "../lib/trading-agents/messages";
import type { AgentMarketContext } from "../lib/trading-agents/eliza-bridge";

type Lease = { agent: Doc<"tradingAgents">; cycleId: Id<"tradingAgentCycles">; cycleKey: string; leaseUntil: number; kind: "thought" | "trade" };
type Context = { agent: Doc<"tradingAgents">; cycle: Doc<"tradingAgentCycles">; tokens: Array<{ address: string; symbol: string }>; recentLog: Array<{ at: number; summary: string }>; yard: AgentMarketContext["yard"] };
const ref = {
  lease: makeFunctionReference<"mutation", { leaseToken: string }, Lease | null>("tradingAgents:leaseNextPaperCycle"),
  context: makeFunctionReference<"query", { cycleId: Id<"tradingAgentCycles">; leaseToken: string }, Context>("tradingAgents:workerContext"),
  reserve: makeFunctionReference<"mutation", { cycleId: Id<"tradingAgentCycles">; leaseToken: string }, boolean>("tradingAgents:reserveModelCall"),
  finish: makeFunctionReference<"mutation", { cycleId: Id<"tradingAgentCycles">; leaseToken: string; decisionJson: string; quoteJson?: string }, { status: string; cycleId: string }>("tradingAgents:finishPaperCycle"),
  create: makeFunctionReference<"mutation", { postId: string }, Id<"tradingAgents">>("tradingAgents:createYardBotFromPost"),
  bind: makeFunctionReference<"mutation", { agentId: Id<"tradingAgents">; address: string; leaseToken?: string }, null>("tradingAgents:bindAgentWallet"),
  provisionLease: makeFunctionReference<"mutation", { leaseToken: string }, { agentId: Id<"tradingAgents"> } | null>("tradingAgents:leaseAgentProvision"),
  start: makeFunctionReference<"mutation", { agentId: Id<"tradingAgents"> }, null>("tradingAgents:startYardDraft"),
  check: makeFunctionReference<"query", { text: string }, { reply: string; allowLongPost: boolean } | null>("tradingAgents:checkBotPost"),
  funding: makeFunctionReference<"query", { postId: string }, { ok: false; message: string } | { ok: true; recipientAddress: string; senderXUserId: string; amount: string; unit: string; asset: string } | null>("tradingAgents:prepareBotFundingPost"),
};

/** Uses existing server credentials; never sends arbitrary URLs or logs secrets. */
async function signer(path: "markets" | "provision" | "live-balances", body: unknown, signal?: AbortSignal): Promise<unknown> {
  const base = (process.env.WALLET_SIGNER_URL || `${process.env.NEXT_PUBLIC_SITE_URL || ""}/api/wallet-signer`).replace(/\/$/, "");
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || !process.env.WALLET_SIGNER_TOKEN) throw new Error("AGENT_SIGNER_NOT_CONFIGURED");
  const response = await fetch(`${base}/v1/agents/${path}`, { method: "POST", headers: {
    authorization: `Bearer ${process.env.WALLET_SIGNER_TOKEN}`, "content-type": "application/json",
  }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000) });
  if (!response.ok) throw new Error("AGENT_SIGNER_UNAVAILABLE");
  return response.json();
}

export const work = internalAction({
  args: {},
  handler: async ctx => {
    if (!tradingAgentCapabilities().scheduler || !tradingAgentCapabilities().paperTrading) return { status: "disabled" };
    let current: Lease | null = null;
    let markets: AgentMarkets | undefined;
    const leaseToken = crypto.randomUUID();
    return runPaperAgentCycle({
      lease: async () => {
        current = await ctx.runMutation(ref.lease, { leaseToken });
        return current ? { agentId: current.agent._id, cycleId: current.cycleKey, policyVersion: current.agent.policyVersion, leaseUntil: current.leaseUntil, kind: current.kind } : null;
      },
      loadContext: async (_lease, signal) => {
        if (!current) throw new Error("AGENT_LEASE_MISSING");
        const data = await ctx.runQuery(ref.context, { cycleId: current.cycleId, leaseToken });
        markets = agentMarketsSchema.parse(await signer("markets", { tokens: data.tokens.map(t => t.address) }, signal));
        const allowed = new Set(data.tokens.map(t => t.address));
        return { agentId: data.agent._id, cycleId: data.cycle.cycleKey, policyVersion: data.agent.policyVersion,
          observedAt: Date.now(), ethUsd: markets.ethUsd, strategy: data.agent.strategy, policy: data.agent.policy,
          character: { name: data.agent.name, description: data.agent.description ?? data.agent.strategy }, recentLog: data.recentLog, yard: data.yard,
          tokens: markets.tokens.filter(t => allowed.has(t.address)).map(t => ({ address: t.address, symbol: t.symbol, decimals: t.decimals,
            ...(t.priceUsd ? { priceUsd: t.priceUsd, priceObservedAt: t.priceObservedAt } : {}), ...(t.volume24hUsd !== undefined ? { volume24hUsd: t.volume24hUsd } : {}) })),
          cashWei: data.agent.portfolio.cashWei, holdings: data.agent.portfolio.holdings,
        };
      },
      think: async (context, signal) => {
        if (!current || !await ctx.runMutation(ref.reserve, { cycleId: current.cycleId, leaseToken })) throw new Error("AGENT_MODEL_BUDGET_EXHAUSTED");
        return runAgentModel("thought", context, signal, openRouter);
      },
      decide: async (context, signal) => {
        if (!current || !await ctx.runMutation(ref.reserve, { cycleId: current.cycleId, leaseToken })) throw new Error("AGENT_MODEL_BUDGET_EXHAUSTED");
        return runAgentModel("trade", context, signal, openRouter);
      },
      quote: async (lease, decision, signal) => {
        if (!markets || !current) throw new Error("AGENT_MARKETS_MISSING");
        // Refresh the chosen token after model latency instead of executing against stale prices.
        const fresh = agentMarketsSchema.parse(await signer("markets", { tokens: [decision.token] }, signal));
        return paperMarketQuote(fresh, decision, lease, Date.now());
      },
      finish: async (_lease, decisionJson, quoteJson) => {
        if (!current) throw new Error("AGENT_LEASE_MISSING");
        return ctx.runMutation(ref.finish, { cycleId: current.cycleId, leaseToken, decisionJson, ...(quoteJson ? { quoteJson } : {}) });
      },
    });
  },
});

export const provision = internalAction({
  args: {},
  handler: async ctx => {
    if (!tradingAgentCapabilities().walletProvisioning || !tradingAgentCapabilities().scheduler) return { status: "disabled" };
    const leaseToken = crypto.randomUUID(), lease = await ctx.runMutation(ref.provisionLease, { leaseToken });
    if (!lease) return { status: "idle" };
    try {
      const wallet = await signer("provision", { agentId: lease.agentId }) as { address?: string };
      if (!wallet.address || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) throw new Error("AGENT_WALLET_INVALID");
      await ctx.runMutation(ref.bind, { agentId: lease.agentId, address: wallet.address, leaseToken });
      return { status: "ready" };
    } catch { return { status: "retry_after_lease" }; }
  },
});

export const tick = internalAction({
  args: {},
  handler: async ctx => {
    const caps = tradingAgentCapabilities();
    if (!caps.scheduler || (!caps.paperTrading && !caps.liveTrading)) return;
    if (tradingAgentCapabilities().walletProvisioning) await ctx.scheduler.runAfter(0, makeFunctionReference<"action">("tradingAgentRuntime:provision"), {});
    // Stagger bounded worker starts; durable leases prevent overlap between ticks.
    for (let n = 0; n < 20; n++) {
      if (caps.paperTrading) await ctx.scheduler.runAfter(n * 1500, makeFunctionReference<"action">("tradingAgentRuntime:work"), {});
      if (caps.liveTrading) await ctx.scheduler.runAfter(n * 1500, makeFunctionReference<"action">("tradingAgentLive:work"), {});
    }
  },
});

export const handleX = internalAction({
  args: { postId: v.string() },
  handler: async (ctx, { postId }): Promise<{ handled: boolean }> => {
    const caps = tradingAgentCapabilities();
    if (!caps.publicCommands || (!caps.paperTrading && !caps.liveTrading)) return { handled: false };
    const current = await ctx.runQuery(internal.xReplies.getRetryContext, { postId });
    if (!current?.user || current.interaction.authorXUserId !== current.user.xUserId || current.interaction.responsePostId
      || current.interaction.replySuppressedReason || current.interaction.commandKind === "operator_cancelled") return { handled: false };
    const text = current.interaction.text;
    const create = parseCreateBotPost(text), check = parseCheckBotPost(text), funding = parseBotFundingPost(text);
    if (!create && !check && !funding) return { handled: false };
    await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "processing", commandKind: create ? "bot_create" : funding ? "send" : "bot_check" });
    let message: string, ok = false;
    try {
      if (create) {
        if (!create.ok) message = create.message;
        else {
          const id = await ctx.runMutation(ref.create, { postId });
          await ctx.runMutation(ref.start, { agentId: id });
          message = botCreatedReply(create.name, create.description); ok = true;
        }
      } else if (check) {
        const wallet = await ctx.runQuery(makeFunctionReference<"query", { text: string }, { agentId: Id<"tradingAgents">; walletAddress: string; tokens: string[] } | null>("tradingAgents:checkBotWallet"), { text });
        if (wallet) {
          try {
            const snapshot = await signer("live-balances", { ...wallet, discover: true }, AbortSignal.timeout(25000));
            await ctx.runMutation(makeFunctionReference<"mutation", { agentId: Id<"tradingAgents">; snapshotJson: string }>("tradingAgentLive:saveHoldings"), { agentId: wallet.agentId, snapshotJson: JSON.stringify(snapshot) });
          } catch { /* Preserve the last verified holdings; a status request never triggers a trade. */ }
        }
        message = (await ctx.runQuery(ref.check, { text }))?.reply ?? "I couldn't find that bot."; ok = true;
      } else if (funding && !funding.ok) message = funding.message;
      else {
        const prepared = await ctx.runQuery(ref.funding, { postId });
        if (!prepared || !prepared.ok) message = prepared?.message ?? "I couldn't find that bot.";
        else if (!caps.liveTrading) message = "Bot funding is not open yet. Nothing was sent.";
        else {
          // Existing wallet workflow supplies sender authorization, balances, gas and durable send recovery.
          const result = await ctx.runAction(internal.wallets.executeCommand, { sourcePostId: postId, xUserId: prepared.senderXUserId,
            source: "x", text, parsedCommandJson: JSON.stringify({ kind: "send", amount: prepared.amount, unit: prepared.unit, token: prepared.asset, recipient: prepared.recipientAddress }) });
          message = result.message; ok = result.ok;
        }
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      message = code.includes("BOT_NAME_TAKEN") ? "That bot name is already taken. Choose a different name."
        : code.includes("AGENT_COUNT_LIMIT") ? "You already have three bots. Each user can create a maximum of three."
          : "I couldn't finish setting up this bot request. No agent trade was started.";
    }
    await ctx.runMutation(internal.xReplyQueue.enqueue, { key: postId, postId, text: message, kind: "reply", ok, allowLong: true });
    return { handled: true };
  },
});
