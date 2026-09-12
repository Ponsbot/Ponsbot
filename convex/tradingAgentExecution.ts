import { v } from "convex/values";
import { countAgentTrade, isSecondaryAgentToken, secondaryTradeAvailable } from "../lib/trading-agents/universe";
import { makeFunctionReference } from "convex/server";
import { action, internalAction, internalMutation, mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { botEnvelopeSchema, anyBotExecutionEnabled, autonomousBotIntent, ownerBotExecutionEnabled, ownerBotIntent } from "../lib/trading-agents/execution";
import { isAgentPlatformToken } from "../lib/trading-agents/policy";
import { tradingAgentCapabilities } from "../lib/trading-agents/config";

function signerSecret(secret: string) {
  if (!process.env.WALLET_SIGNER_TOKEN || secret !== process.env.WALLET_SIGNER_TOKEN) throw new Error("UNAUTHORIZED");
}
export const create = internalMutation({
  args: { agentId: v.id("tradingAgents"), ownerXUserId: v.string(), requestKey: v.string(), intentJson: v.string() },
  handler: async (ctx, args) => {
    if (!ownerBotExecutionEnabled()) throw new Error("AGENT_EXECUTION_DISABLED");
    const intentJson = JSON.stringify(ownerBotIntent.parse(JSON.parse(args.intentJson)));
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(args.requestKey)) throw new Error("INVALID_REQUEST_KEY");
    const agent = await ctx.db.get(args.agentId);
    if (!agent || agent.ownerXUserId !== args.ownerXUserId) throw new Error("AGENT_NOT_FOUND");
    const previous = await ctx.db.query("tradingAgentExecutions").withIndex("by_owner_key", q => q.eq("ownerXUserId", args.ownerXUserId).eq("requestKey", args.requestKey)).unique();
    if (previous) {
      if (previous.agentId !== args.agentId || previous.intentJson !== intentJson) throw new Error("REQUEST_CONFLICT");
      return previous._id;
    }
    if (!agent.walletAddress || agent.walletProvisionStatus !== "ready") throw new Error("BOT_WALLET_NOT_READY");
    const wallet = await ctx.db.query("cryptoWallets").withIndex("by_owner_x_user_id", q => q.eq("ownerXUserId", args.ownerXUserId)).unique();
    if (!wallet || wallet.status !== "active" || wallet.chainId !== 4663 || wallet.address.toLowerCase() === agent.walletAddress.toLowerCase()) throw new Error("OWNER_WALLET_NOT_READY");
    if (await ctx.db.query("tradingAgentExecutions").withIndex("by_agent_state", q => q.eq("agentId", args.agentId).eq("state", "active")).first()) throw new Error("BOT_TRANSACTION_PENDING");
    const id = await ctx.db.insert("tradingAgentExecutions", { agentId: args.agentId, ownerXUserId: args.ownerXUserId, requestKey: args.requestKey,
      from: agent.walletAddress, destination: wallet.address, intentJson, state: "active", step: 0, hashes: [], createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, makeFunctionReference<"action", { jobId: Id<"tradingAgentExecutions"> }>("tradingAgentExecution:run"), { jobId: id });
    return id;
  },
});
export const submit = action({
  args: { secret: v.string(), sessionId: v.string(), ownerXUserId: v.string(), agentId: v.id("tradingAgents"), requestKey: v.string(), intentJson: v.string() },
  handler: async (ctx, { secret, sessionId, ...args }): Promise<string> => {
    if (!await ctx.runAction(api.wallets.verifyWebSession, { secret, sessionId, ownerXUserId: args.ownerXUserId })) throw new Error("UNAUTHORIZED");
    return ctx.runMutation(makeFunctionReference<"mutation", typeof args, string>("tradingAgentExecution:create"), args);
  },
});
// Private job payloads (including signed bytes) require signer credentials. No public history query exposes them.
export const read = query({
  args: { secret: v.string(), jobId: v.id("tradingAgentExecutions") },
  handler: async (ctx, { secret, jobId }) => {
    signerSecret(secret);
    const job = await ctx.db.get(jobId);
    if (!job?.cycleId) return job;
    const agent = await ctx.db.get(job.agentId), intent = autonomousBotIntent.parse(JSON.parse(job.intentJson));
    const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", intent.token)).unique();
    return { ...job, executionAllowed: Boolean(tradingAgentCapabilities().liveTrading && agent?.mode === "live" && agent.status === "running"
      && agent.policyVersion === job.policyVersion && agent.walletAddress?.toLowerCase() === job.from.toLowerCase()
      && (isSecondaryAgentToken(intent.token)
        ? job.tradeBucket === "secondary" && (job.tradeCounted || secondaryTradeAvailable(agent.liveTradeMix))
        : job.tradeBucket !== "secondary" && isAgentPlatformToken(intent.token, launch))) };
  },
});
export const save = mutation({
  args: { secret: v.string(), jobId: v.id("tradingAgentExecutions"), step: v.number(), kind: v.union(v.literal("envelope"), v.literal("signed"), v.literal("receipt"), v.literal("failure")), value: v.string() },
  handler: async (ctx, args) => {
    signerSecret(args.secret);
    if (args.value.length > 100000) throw new Error("PAYLOAD_TOO_LARGE");
    const job = await ctx.db.get(args.jobId);
    if (!job || job.state !== "active" || job.step !== args.step) return false;
    if (args.kind === "envelope") {
      if (job.envelopeJson) return false; // first persisted preparation wins, even across overlapping workers
      const envelope = botEnvelopeSchema.parse(JSON.parse(args.value));
      if (job.cycleId && !envelope.route) throw new Error("LIVE_ROUTE_REQUIRED");
      if (envelope.nonce < (job.minimumNonce ?? 0)) throw new Error("NONCE_REUSE");
      await ctx.db.patch(job._id, { envelopeJson: JSON.stringify(envelope), updatedAt: Date.now() });
    } else if (args.kind === "signed") {
      if (!job.envelopeJson || job.signedJson) return false;
      const signed = JSON.parse(args.value) as { transactionHash: string; signedTransaction: string };
      if (!/^0x[0-9a-fA-F]{64}$/.test(signed.transactionHash) || !/^0x[0-9a-fA-F]+$/.test(signed.signedTransaction)) throw new Error("INVALID_SIGNATURE");
      await ctx.db.patch(job._id, { signedJson: args.value, hashes: [...job.hashes, signed.transactionHash], updatedAt: Date.now() });
    } else if (args.kind === "receipt") {
      if (!job.signedJson || !job.envelopeJson) throw new Error("NO_SIGNED_TRANSACTION");
      const receipt = JSON.parse(args.value) as { success: boolean; block: string; outputAmount?: string; gasWei?: string };
      if (typeof receipt.success !== "boolean" || !/^\d+$/.test(receipt.block)) throw new Error("INVALID_RECEIPT");
      const envelope = botEnvelopeSchema.parse(JSON.parse(job.envelopeJson));
      if (job.cycleId) {
        if (!envelope.route || !receipt.gasWei || !/^\d+$/.test(receipt.gasWei) || (receipt.outputAmount !== undefined && !/^\d+$/.test(receipt.outputAmount))) throw new Error("INVALID_LIVE_RECEIPT");
        const intent = autonomousBotIntent.parse(JSON.parse(job.intentJson));
        const gasSpentWei = (BigInt(job.gasSpentWei ?? "0") + BigInt(receipt.gasWei)).toString();
        let phase = envelope.route.phase, pairAmount = job.pairAmount;
        let more = envelope.approval;
        let failure = !receipt.success ? "Transaction reverted. Any completed earlier steps remain on-chain." : undefined;
        if (receipt.success && !envelope.approval) {
          const expectsToken = envelope.route.outputToken !== "0x0000000000000000000000000000000000000000";
          if (expectsToken && BigInt(receipt.outputAmount ?? "0") <= 0n) failure = "Transaction confirmed, but its token proceeds could not be reconciled. No replacement trade was started.";
          else if (phase === "funding") { phase = "trade"; pairAmount = receipt.outputAmount; more = true; }
          else if (phase === "trade" && intent.kind === "sell" && expectsToken) { phase = "convert"; pairAmount = receipt.outputAmount; more = true; }
        }
        if (more && job.step >= 12) failure = "Execution step limit reached. Assets from completed steps remain in the bot wallet.";
        // Count the target fill once, even if a subsequent conversion fails. Funding hops and approvals do not count.
        if (!job.tradeCounted && receipt.success && !envelope.approval && envelope.route.phase === "trade"
          && (envelope.route.outputToken === "0x0000000000000000000000000000000000000000" || BigInt(receipt.outputAmount ?? "0") > 0n)) {
          const agent = await ctx.db.get(job.agentId);
          if (!agent) throw new Error("AGENT_NOT_FOUND");
          await ctx.db.patch(agent._id, { liveTradeMix: countAgentTrade(agent.liveTradeMix, isSecondaryAgentToken(intent.token) ? "secondary" : "platform") });
          await ctx.db.patch(job._id, { tradeCounted: true });
        }
        if (failure || !more) {
          await ctx.db.patch(job._id, { state: failure ? "failed" : "confirmed", error: failure, gasSpentWei,
            outputAmount: receipt.outputAmount, confirmedBlock: receipt.block, updatedAt: Date.now() });
          await ctx.db.patch(job.cycleId, { status: failure ? "rejected" : "live_filled", transactionHashes: job.hashes,
            quoteJson: receipt.outputAmount ? JSON.stringify({ amountOut: receipt.outputAmount }) : undefined,
            diagnosticCode: failure ? "LIVE_EXECUTION_INCOMPLETE" : undefined, completedAt: Date.now() });
          await ctx.scheduler.runAfter(3000, makeFunctionReference<"action", { jobId: Id<"tradingAgentExecutions"> }>("tradingAgentLive:refreshAfterExecution"), { jobId: job._id });
        } else {
          await ctx.db.patch(job._id, { step: job.step + 1, phase, pairToken: envelope.route.pairToken, pairAmount, gasSpentWei,
            envelopeJson: undefined, signedJson: undefined, minimumNonce: envelope.nonce + 1, confirmedBlock: receipt.block, updatedAt: Date.now() });
          await ctx.scheduler.runAfter(1000, makeFunctionReference<"action", { jobId: Id<"tradingAgentExecutions"> }>("tradingAgentExecution:run"), { jobId: job._id });
        }
        return true;
      }
      if (!receipt.success) await ctx.db.patch(job._id, { state: "failed", error: "Transaction reverted. Any earlier approvals remain confirmed.", updatedAt: Date.now() });
      else if (envelope.approval && job.step < 4) {
        await ctx.db.patch(job._id, { step: job.step + 1, envelopeJson: undefined, signedJson: undefined,
          minimumNonce: envelope.nonce + 1, confirmedBlock: receipt.block, updatedAt: Date.now() });
        await ctx.scheduler.runAfter(1000, makeFunctionReference<"action", { jobId: Id<"tradingAgentExecutions"> }>("tradingAgentExecution:run"), { jobId: job._id });
      }
      else await ctx.db.patch(job._id, { state: envelope.approval ? "failed" : "confirmed", ...(envelope.approval ? { error: "Approval limit reached; no sale was completed." } : {}), updatedAt: Date.now() });
    } else {
      // Once an envelope exists signing may have succeeded: NEVER release the wallet lock on a timeout.
      if (job.envelopeJson || job.signedJson) return false;
      await ctx.db.patch(job._id, { state: "failed", error: "The transaction could not be prepared. Check the bot's funds and available trading route.", updatedAt: Date.now() });
      if (job.cycleId) await ctx.db.patch(job.cycleId, { status: "rejected", transactionHashes: job.hashes,
        diagnosticCode: job.pairAmount ? "LIVE_PARTIAL_FUNDING" : "LIVE_PREPARATION_FAILED", completedAt: Date.now() });
      if (job.cycleId && job.hashes.length) await ctx.scheduler.runAfter(3000,
        makeFunctionReference<"action", { jobId: Id<"tradingAgentExecutions"> }>("tradingAgentLive:refreshAfterExecution"), { jobId: job._id });
    }
    return true;
  },
});
export const run = internalAction({
  args: { jobId: v.id("tradingAgentExecutions") },
  handler: async (_ctx, args) => {
    if (!anyBotExecutionEnabled()) return;
    const base = process.env.WALLET_SIGNER_URL || `${process.env.NEXT_PUBLIC_SITE_URL}/api/wallet-signer`;
    if (!base.startsWith("https://") || !process.env.WALLET_SIGNER_TOKEN) return;
    try { await fetch(`${base.replace(/\/$/, "")}/v1/agents/execute`, { method: "POST", headers: { authorization: `Bearer ${process.env.WALLET_SIGNER_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(args), signal: AbortSignal.timeout(90000) }); }
    catch { /* Durable job is resumed by tick, never replaced or silently unlocked. */ }
  },
});
export const tick = internalMutation({
  args: {}, handler: async ctx => {
    if (!anyBotExecutionEnabled()) return;
    const jobs = await ctx.db.query("tradingAgentExecutions").withIndex("by_state_updated", q => q.eq("state", "active")).take(20);
    for (const job of jobs) {
      await ctx.db.patch(job._id, { updatedAt: Date.now() });
      await ctx.scheduler.runAfter(0, makeFunctionReference<"action", { jobId: Id<"tradingAgentExecutions"> }>("tradingAgentExecution:run"), { jobId: job._id });
    }
  },
});
