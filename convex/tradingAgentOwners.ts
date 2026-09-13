import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { action, internalQuery } from "./_generated/server";
import { api } from "./_generated/api";
import { tradingAgentCapabilities } from "../lib/trading-agents/config";
import type { OwnedBot } from "../lib/trading-agents/owner-view";
import { pnlDisplay } from "../lib/trading-agents/pnl";

export const listOwned = internalQuery({
  args: { ownerXUserId: v.string() },
  handler: async (ctx, { ownerXUserId }): Promise<OwnedBot[]> => {
    const bots = await ctx.db.query("tradingAgents").withIndex("by_owner", q => q.eq("ownerXUserId", ownerXUserId)).take(3);
    return Promise.all(bots.map(async bot => ({ id: bot._id, name: bot.name, mode: bot.mode,
      ...(bot.mode === "live" ? { pnl: pnlDisplay(bot.pnlStateJson,bot.pnlAt,Date.now(),bot.pnlPending) } : {}),
      ...(bot.walletAddress ? { walletAddress: bot.walletAddress } : {}),
      cashWei: bot.mode === "live" ? bot.liveHoldings?.cashWei ?? "0" : bot.portfolio.cashWei,
      holdings: bot.mode === "live" ? bot.liveHoldings?.tokens ?? [] : bot.portfolio.holdings,
      transactions: (await ctx.db.query("tradingAgentExecutions").withIndex("by_agent_created", q => q.eq("agentId", bot._id)).order("desc").take(10))
        .map(job => ({ id: job._id, requestKey: job.requestKey, state: job.state, kind: JSON.parse(job.intentJson).kind as string, hashes: job.hashes, ...(job.error ? { error: job.error } : {}) })),
    })));
  },
});

// Called only by the website server. Knowing an X ID or bot ID is not authorization.
export const webList = action({
  args: { secret: v.string(), sessionId: v.string(), ownerXUserId: v.string() },
  handler: async (ctx, args): Promise<OwnedBot[]> => {
    if (!tradingAgentCapabilities().website) throw new Error("AGENTS_DISABLED");
    const active = await ctx.runAction(api.wallets.verifyWebSession, args);
    if (!active) throw new Error("UNAUTHORIZED");
    return ctx.runQuery(makeFunctionReference<"query", { ownerXUserId: string }, OwnedBot[]>("tradingAgentOwners:listOwned"), { ownerXUserId: args.ownerXUserId });
  },
});
