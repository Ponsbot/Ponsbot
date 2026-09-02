import { v } from "convex/values";
import { mapLiquidityBounded } from "../lib/liquidity-concurrency";
import { inheritLiquidityPositionFields, isIndependentLiquidityRead, isOrdinaryWalletCommand, liquidityThreadRedirect, liquidityWalletAllowed, liquidityNftSelection, liquidityStatusSelection, liquidityClaimSelection, liquidityWithdrawalSelection, normalizeLiquidityTokenAliases } from "../lib/liquidity-workflow";
import { action, internalAction, internalMutation, internalQuery, mutation, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { applyLiquidityBandDefault, applyLiquiditySpacingDefault, backLiquidityDraft, isLiquidityMessage, liquidityControl, liquidityDraftSchema, liquidityFieldsSchema, liquidityNextPhase, liquidityOwnerAllowed, liquidityReviewHash, newLiquidityDraft, selectLiquidityPool, updateLiquidityFields, validateLiquidityReview, LIQUIDITY_CONVERSATION_MS, type LiquidityDraft } from "../lib/liquidity-workflow";
import { liquidityFundingMessage, liquidityResponseLines, liquidityStepExample, liquidityCompletionGuidance, liquidityOpenedDetails, paginateLiquidityResponse, LIQUIDITY_RESPONSES as R } from "../lib/liquidity-responses";
import { discoverLiquidityPools } from "../lib/liquidity-markets";
import { extractLiquidityFields, rankLiquidityPoolsWithDiagnostics } from "./liquidityAi";
import { liquidityExplanation } from "../lib/liquidity-help";
import { liquidityClaimPositionSchema, type LiquidityQuotePlan } from "../lib/liquidity-quote";
import { deltaLiquidityAbi, liquidityPoolId, type LiquidityLeg } from "../lib/liquidity-contracts";
import { liquidityStatusMessage, type LiquidityPositionStatus } from "../lib/liquidity-status";
import { liquidityNftLines } from "../lib/liquidity-nfts";
import { formatLiquidityMarketCap } from "../lib/liquidity-market-cap";
import { decodeFunctionData, keccak256, stringToHex, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";
import { liquidityDiagnostic, liquidityExecutionWindowOpen, liquidityFundedRetryPrefix, liquidityRecoveryDue, liquidityRecoveryStopped, liquiditySignerResponse, liquidityStepIdempotencyKey, LIQUIDITY_WRITE_ATTEMPTS, LIQUIDITY_TOTAL_ATTEMPTS } from "../lib/liquidity-recovery";
import { validateLiquidityQuote, validateLiquidityEnvelope, validateLiquiditySignature, validateLiquidityFinalReceipt, validateLiquidityOpenRefresh } from "../lib/liquidity-wire";
import { withGuidedHelpCompletion } from "../lib/guided-help-workflow";
import { mergeLiquidityClaimedFees, parseLiquidityClaimedFee, type LiquidityClaimedFee } from "../lib/liquidity-claimed-fees";

const source = v.union(v.literal("x"), v.literal("terminal"));
const requestArgs = { ownerXUserId: v.string(), source, scope: v.string(), requestKey: v.string(), text: v.string(), parentPostId: v.optional(v.string()) };

export const cacheTerminalPositionStatus = internalMutation({
  args: { ownerXUserId: v.string(), positionId: v.string(), liveStatusJson: v.string(), observedAt: v.number() },
  handler: async (ctx, args) => {
    const position = await ctx.db.query("liquidityManagedPositions")
      .withIndex("by_public_id", q => q.eq("publicId", args.positionId)).unique();
    if (!position || position.ownerXUserId !== args.ownerXUserId || position.status !== "active") return false;
    await ctx.db.patch(position._id, { liveStatusJson: args.liveStatusJson, liveStatusAt: args.observedAt });
    return true;
  },
});
async function latestForScope(ctx: QueryCtx | MutationCtx, scope: string) {
  return ctx.db.query("liquidityConversations").withIndex("by_scope_active", q => q.eq("scope", scope).eq("active", true)).order("desc").first();
}
async function fromParent(ctx: QueryCtx | MutationCtx, parentPostId: string) {
  // Only an actual published bot prompt can authorize a continuation. Thread
  // membership (original requests, outsiders and redirects) is not authority.
  let turn = await ctx.db.query("liquidityTurns").withIndex("by_response", q => q.eq("responsePostId", parentPostId)).first();
  if (!turn) {
    // Recover after publication succeeded but the LP prompt attachment failed.
    const interaction = await ctx.db.query("xReplyInteractions").withIndex("by_response_post_id", q => q.eq("responsePostId", parentPostId)).first();
    if (interaction) turn = await ctx.db.query("liquidityTurns").withIndex("by_request", q => q.eq("requestKey", `x:${interaction.postId}`)).first();
    if (turn?.responsePostId && turn.responsePostId !== parentPostId) return null;
  }
  if (!turn) return null;
  const conversation = await ctx.db.get(turn.conversationId);
  return conversation ? { turn, conversation } : null;
}
async function threadConversation(ctx: QueryCtx | MutationCtx, parentPostId: string) {
  const prompt = await fromParent(ctx, parentPostId);
  if (prompt) return prompt.conversation;
  const request = await ctx.db.query("liquidityTurns").withIndex("by_request", q => q.eq("requestKey", `x:${parentPostId}`)).first();
  if (request) return ctx.db.get(request.conversationId);
  const link = await ctx.db.query("liquidityThreadPosts").withIndex("by_post", q => q.eq("postId", parentPostId)).first();
  return link ? ctx.db.get(link.conversationId) : null;
}
async function foreignThread(ctx: MutationCtx, args: { ownerXUserId: string; parentPostId?: string; postId: string; text: string }) {
  const conversation = args.parentPostId ? await threadConversation(ctx, args.parentPostId) : null;
  if (!conversation || conversation.ownerXUserId === args.ownerXUserId) return null;
  // Remember even silent interjections so their descendants cannot enter the
  // normal command path by replying to the outsider rather than the LP prompt.
  if (!await ctx.db.query("liquidityThreadPosts").withIndex("by_post", q => q.eq("postId", args.postId)).first())
    await ctx.db.insert("liquidityThreadPosts", { postId: args.postId, conversationId: conversation._id });
  return liquidityThreadRedirect(args.text) ? "redirect" as const : "silent" as const;
}
export const guardThread = internalMutation({
  args: { ownerXUserId: v.string(), parentPostId: v.optional(v.string()), postId: v.string(), text: v.string() },
  handler: foreignThread,
});
// Admission bypass is derived from the authenticated author and persisted
// prompt, not from a caller-supplied priority or a mention of "liquidity".
export async function liquidityAdmissionExempt(ctx: QueryCtx | MutationCtx, args: { ownerXUserId: string; text: string; parentPostId?: string; postId?: string }) {
  if (isOrdinaryWalletCommand(args.text)) return false;
  if (liquidityOwnerAllowed(args.ownerXUserId)) {
    if (isLiquidityMessage(args.text)) return true;
    const found = args.parentPostId ? await fromParent(ctx, args.parentPostId) : null;
    return Boolean(found && found.conversation.ownerXUserId === args.ownerXUserId && found.conversation.active &&
      found.conversation.expiresAt > Date.now() && found.conversation.currentTurnId === found.turn._id);
  }
  // Only the existing, non-executable "make a new post" redirect is exempt
  // for outsiders. guardThread has already bound this post to the LP thread.
  return Boolean(args.postId && liquidityThreadRedirect(args.text) &&
    await ctx.db.query("liquidityThreadPosts").withIndex("by_post", q => q.eq("postId", args.postId!)).first());
}
export const isContinuation = internalQuery({
  args: { ownerXUserId: v.string(), parentPostId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!liquidityOwnerAllowed(args.ownerXUserId) || !args.parentPostId) return false;
    const found = await fromParent(ctx, args.parentPostId);
    return Boolean(found && found.conversation.ownerXUserId === args.ownerXUserId && found.conversation.active && found.conversation.expiresAt > Date.now() && found.conversation.currentTurnId === found.turn._id);
  },
});
export const reserveTurn = internalMutation({
  args: requestArgs,
  handler: async (ctx, args) => {
    if (args.source === "x") {
      const guard = await foreignThread(ctx, { ...args, postId: args.requestKey.replace(/^x:/, "") });
      if (guard) return { handled: true, silent: guard === "silent", ...(guard === "redirect" ? { message: R.foreignThread } : {}) };
    }
    if (isOrdinaryWalletCommand(args.text)) return { handled: false };
    if (!liquidityOwnerAllowed(args.ownerXUserId, args.source)) return { handled: isLiquidityMessage(args.text), silent: true };
    // Terminal reads intentionally preserve and resume the session's current
    // setup. This concurrency exception is only for independent top-level X
    // posts, where two mention jobs may execute at the same time.
    const independentRead = args.source === "x" && isIndependentLiquidityRead(args.text);
    const previous = await ctx.db.query("liquidityTurns").withIndex("by_request", q => q.eq("requestKey", args.requestKey)).unique();
    if (previous) {
      if (previous.ownerXUserId !== args.ownerXUserId || previous.input !== args.text) throw new Error("LP_REQUEST_ID_REUSED");
      const conversation = await ctx.db.get(previous.conversationId);
      const execution = await ctx.db.query("liquidityExecutions").withIndex("by_conversation", q => q.eq("conversationId", previous.conversationId)).first();
      if (execution) return { handled: true, deferred: !["confirmed", "failed"].includes(execution.status), message: execution.response, conversationId: previous.conversationId };
      if (previous.response !== undefined) return { handled: true, message: previous.response, conversationId: previous.conversationId };
      if (Date.now() - previous.createdAt < 180_000) return independentRead ? { handled: true, deferred: true } : { handled: true, message: R.busy };
      if (conversation?.currentTurnId !== previous._id) return { handled: true, message: R.stale };
      const revision = conversation.revision + 1;
      await ctx.db.patch(previous._id, { createdAt: Date.now(), revision });
      await ctx.db.patch(conversation._id, { revision });
      return { handled: true, turnId: previous._id, conversationId: previous.conversationId, publicId: conversation.publicId, revision, state: conversation.stateJson, walletId: conversation.walletId };
    }
    const parent = args.source === "x" && args.parentPostId ? await fromParent(ctx, args.parentPostId) : null;
    const retryRequested = liquidityControl(args.text)?.kind === "retry";
    let retryConversation = retryRequested ? parent?.conversation ?? null : null;
    let retryExecution = retryConversation
      ? await ctx.db.query("liquidityExecutions").withIndex("by_conversation", q => q.eq("conversationId", retryConversation!._id)).first()
      : null;
    if (retryRequested && args.source === "terminal" && !retryExecution) {
      const recent = await ctx.db.query("liquidityExecutions").withIndex("by_owner_updated", q => q.eq("ownerXUserId", args.ownerXUserId)).order("desc").take(20);
      for (const candidate of recent) {
        if (candidate.status !== "failed") continue;
        const candidateConversation = await ctx.db.get(candidate.conversationId);
        if (candidateConversation?.source === "terminal" && candidateConversation.scope === args.scope) {
          retryConversation = candidateConversation; retryExecution = candidate; break;
        }
      }
    }
    if (retryRequested && retryConversation && retryExecution && retryConversation.ownerXUserId === args.ownerXUserId
      && retryExecution.ownerXUserId === args.ownerXUserId && retryExecution.status === "failed") {
      const retryPlan = JSON.parse(retryExecution.planJson) as LiquidityQuotePlan;
      const retrySteps = JSON.parse(retryExecution.stepsJson) as SignedStep[];
      const confirmedPrefix = liquidityFundedRetryPrefix(retryPlan, retrySteps);
      if (!confirmedPrefix) return { handled: true, message: "⚠️ This request can’t be safely retried from its saved funding steps. Request a new liquidity quote." };
      if (!liquidityExecutionWindowOpen(retryPlan, Date.now())) return { handled: true, message: "⌛ The position settings are too old to retry safely. Request a new liquidity quote. The assets already purchased remain in your wallet." };
      const revision = retryConversation.revision + 1;
      const turnId = await ctx.db.insert("liquidityTurns", { requestKey: args.requestKey, ownerXUserId: args.ownerXUserId,
        conversationId: retryConversation._id, input: args.text, revision, status: "processing", createdAt: Date.now() });
      await ctx.db.patch(retryConversation._id, { active: true, revision, currentTurnId: turnId, updatedAt: Date.now(), expiresAt: Date.now() + LIQUIDITY_CONVERSATION_MS });
      await ctx.db.patch(retryExecution._id, { turnId, status: "running", stage: "user_retry_after_funding", stepsJson: JSON.stringify(confirmedPrefix),
        response: undefined, diagnostic: "LP_USER_RETRY_AFTER_FUNDING", retryCount: 0, openRecoveryCount: (retryExecution.openRecoveryCount ?? 0) + 1,
        leaseUntil: 0, nextAttemptAt: undefined, deliveryStatus: undefined, deliveryAttempts: undefined, deliveryNextAttemptAt: undefined,
        deliveryDiagnostic: undefined, updatedAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.liquidity.execute, { executionId: retryExecution._id });
      return { handled: true, deferred: true, conversationId: retryConversation._id };
    }
    if (!independentRead && args.source === "x" && args.parentPostId && !parent && await threadConversation(ctx, args.parentPostId))
      return { handled: true, message: R.stale };
    // Give simultaneous top-level status/NFT lookups separate short-lived
    // conversations so neither can return the setup workflow's busy message.
    let conversation = independentRead ? null : args.source === "terminal" ? await latestForScope(ctx, args.scope) : parent?.conversation ?? null;
    if (conversation && (conversation.ownerXUserId !== args.ownerXUserId || conversation.source !== args.source)) throw new Error("LP access denied");
    if (parent && (parent.conversation.ownerXUserId !== args.ownerXUserId || !independentRead && parent.conversation.currentTurnId !== parent.turn._id)) return { handled: true, message: R.stale };
    if (!conversation && liquidityControl(args.text)?.kind === "cancel") return { handled: true, message: R.cancelled };
    if (!conversation && !isLiquidityMessage(args.text)) return { handled: false };
    if (conversation) {
      const execution = await ctx.db.query("liquidityExecutions").withIndex("by_conversation", q => q.eq("conversationId", conversation!._id)).first();
      if (execution && liquidityNftSelection(args.text) && ["confirmed", "failed"].includes(execution.status)) {
        // Asking for NFTs under a finished X result is a fresh read-only
        // request, not a retry or edit of the completed execution.
        conversation = null;
      } else if (execution) return { handled: true, message: execution.response || "⏳ This liquidity request is already executing or being reconciled. Cancelling a draft cannot undo a submitted transaction." };
    }
    if (conversation && (!conversation.active || conversation.expiresAt < Date.now())) {
      await ctx.db.patch(conversation._id, { active: false });
      return { handled: true, message: R.expired };
    }
    if (conversation?.currentTurnId) {
      const current = await ctx.db.get(conversation.currentTurnId);
      if (current?.status === "processing" && liquidityControl(args.text)?.kind !== "cancel" && Date.now() - current.createdAt < 300_000) return { handled: true, message: R.busy };
    }
    if (!conversation) {
      const active = independentRead ? null : await latestForScope(ctx, args.scope);
      if (active && active.expiresAt > Date.now()) {
        const current = active.currentTurnId ? await ctx.db.get(active.currentTurnId) : null;
        if (current?.status === "processing" && Date.now() - current.createdAt < 300_000) return { handled: true, message: R.busy };
        const revision = active.revision + 1;
        const turnId = await ctx.db.insert("liquidityTurns", { requestKey: args.requestKey, ownerXUserId: args.ownerXUserId, conversationId: active._id, input: args.text, revision, status: "ready", response: R.waiting, createdAt: Date.now() });
        await ctx.db.patch(active._id, { revision, currentTurnId: turnId, updatedAt: Date.now(), expiresAt: Date.now() + LIQUIDITY_CONVERSATION_MS });
        return { handled: true, message: R.waiting, conversationId: active._id };
      }
      if (active) await ctx.db.patch(active._id, { active: false });
      const user = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", q => q.eq("xUserId", args.ownerXUserId)).unique();
      const wallet = user?.walletId ? await ctx.db.get(user.walletId) : null;
      if (!wallet || wallet.status !== "active" || wallet.ownerXUserId !== args.ownerXUserId || !liquidityWalletAllowed(args.ownerXUserId, wallet.address)) return { handled: true, message: "👛 Ask for your wallet first, then start your liquidity request." };
      let publicId = "";
      for (let attempt = 0; ; attempt++) {
        publicId = `LQ-${keccak256(stringToHex(`${args.ownerXUserId}:${args.requestKey}:${attempt}`)).slice(2, 10).toUpperCase()}`;
        if (!await ctx.db.query("liquidityConversations").withIndex("by_public_id", q => q.eq("publicId", publicId)).first()) break;
      }
      const id = await ctx.db.insert("liquidityConversations", { publicId, ownerXUserId: args.ownerXUserId, walletId: wallet._id, source: args.source, scope: args.scope, stateJson: JSON.stringify(newLiquidityDraft()), revision: 0, active: true, expiresAt: Date.now() + LIQUIDITY_CONVERSATION_MS, createdAt: Date.now(), updatedAt: Date.now() });
      conversation = (await ctx.db.get(id))!;
    }
    const revision = conversation.revision + 1;
    const turnId = await ctx.db.insert("liquidityTurns", { requestKey: args.requestKey, ownerXUserId: args.ownerXUserId, conversationId: conversation._id, input: args.text, revision, status: "processing", createdAt: Date.now() });
    await ctx.db.patch(conversation._id, { revision, currentTurnId: turnId, updatedAt: Date.now(), expiresAt: Date.now() + LIQUIDITY_CONVERSATION_MS });
    return { handled: true, turnId, conversationId: conversation._id, publicId: conversation.publicId, revision, state: conversation.stateJson, walletId: conversation.walletId };
  },
});
export const saveTurn = internalMutation({
  args: { turnId: v.id("liquidityTurns"), state: v.string(), message: v.string(), active: v.boolean(), revision: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const turn = await ctx.db.get(args.turnId); if (!turn) throw new Error("Missing LP turn");
    const conversation = await ctx.db.get(turn.conversationId);
    if (conversation?.currentTurnId !== turn._id || conversation.revision !== turn.revision || args.revision !== undefined && args.revision !== turn.revision) throw new Error("LP_STALE_TURN");
    const state = liquidityDraftSchema.parse(JSON.parse(args.state));
    await ctx.db.patch(conversation._id, { stateJson: JSON.stringify(state), active: args.active, updatedAt: Date.now() });
    await ctx.db.patch(turn._id, { status: "ready", response: args.message });
    if (state.phase === "cancelled") {
      const turns = await ctx.db.query("liquidityTurns").withIndex("by_conversation", q => q.eq("conversationId", conversation._id)).take(100);
      for (const stale of turns) if (stale._id !== turn._id && stale.status === "processing") {
        await ctx.db.patch(stale._id, { status: "cancelled", response: R.cancelled });
      }
    }
  },
});
export const attachPrompt = internalMutation({
  args: { requestKey: v.string(), responsePostId: v.string() },
  handler: async (ctx, args) => {
    const turn = await ctx.db.query("liquidityTurns").withIndex("by_request", q => q.eq("requestKey", args.requestKey)).unique();
    if (!turn) return;
    await ctx.db.patch(turn._id, { responsePostId: args.responsePostId });
    const conversation = await ctx.db.get(turn.conversationId);
    if (conversation?.currentTurnId === turn._id) await ctx.db.patch(conversation._id, { lastPromptPostId: args.responsePostId });
  },
});
export const resolveContext = internalQuery({
  args: { ownerXUserId: v.string(), source: v.optional(source), token: v.optional(v.string()), position: v.optional(v.string()), listPositions: v.optional(v.boolean()), includeClosedPosition: v.optional(v.boolean()), selectPosition: v.optional(v.boolean()), claimPositions: v.optional(v.boolean()), allPositions: v.optional(v.boolean()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!liquidityOwnerAllowed(args.ownerXUserId, args.source)) throw new Error("LP access denied");
    const user = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", q => q.eq("xUserId", args.ownerXUserId)).unique();
    const wallet = user?.walletId ? await ctx.db.get(user.walletId) : null;
    if (wallet && (wallet.ownerXUserId !== args.ownerXUserId || !liquidityWalletAllowed(args.ownerXUserId, wallet.address))) throw new Error("LP access denied");
    const found = args.position ? await ctx.db.query("liquidityManagedPositions").withIndex("by_public_id", q => q.eq("publicId", args.position!)).unique() : null;
    let position = found?.ownerXUserId === args.ownerXUserId && found.walletId === wallet?._id && (found.status === "active" || args.listPositions && args.includeClosedPosition && found.status === "closed") ? found : undefined;
    const selectionMatches = [];
    if (wallet && args.selectPosition && !args.position) {
      for await (const p of ctx.db.query("liquidityManagedPositions").withIndex("by_owner_wallet_status", q =>
        q.eq("ownerXUserId", args.ownerXUserId).eq("walletId", wallet._id).eq("status", "active"))) {
        if (args.token && p.token.toLowerCase() !== args.token.toLowerCase() && p.symbol.toUpperCase() !== args.token.replace(/^\$/, "").toUpperCase()) continue;
        selectionMatches.push(p);
        if (selectionMatches.length > 20) break;
      }
      // Only assume a position after exhausting the matching set, never from
      // a truncated page and never in place of an explicit invalid LP ID.
      if (selectionMatches.length === 1) position = selectionMatches[0];
    }
    const tokenPositions = [];
    if (wallet && args.listPositions && !args.position && args.token) {
      for await (const p of ctx.db.query("liquidityManagedPositions").withIndex("by_owner_wallet_status", q =>
        q.eq("ownerXUserId", args.ownerXUserId).eq("walletId", wallet._id).eq("status", "active"))) {
        if (p.token.toLowerCase() !== args.token.toLowerCase() && p.symbol.toUpperCase() !== args.token.replace(/^\$/, "").toUpperCase()) continue;
        tokenPositions.push(p);
        if (tokenPositions.length >= 20) break;
      }
    }
    const page = args.listPositions && !args.position && !args.token ? await ctx.db.query("liquidityManagedPositions").withIndex("by_owner", q => q.eq("ownerXUserId", args.ownerXUserId)).order("desc").paginate({ numItems: 20, cursor: args.cursor ?? null }) : null;
    const positions = args.token && args.listPositions ? tokenPositions : page?.page ?? (position ? [position] : []);
    const claimMatches = [];
    if (wallet && args.claimPositions && !args.position && (args.allPositions || args.token)) {
      const claimAll = args.allPositions && !args.token;
      // Native paginate may only be called once per Convex query. Iterate the
      // indexed active positions instead; closed history and other wallets are
      // never scanned, and finding a 21st match stops the lookup immediately.
      const active = ctx.db.query("liquidityManagedPositions").withIndex("by_owner_wallet_status", q =>
        q.eq("ownerXUserId", args.ownerXUserId).eq("walletId", wallet._id).eq("status", "active"));
      for await (const p of active) {
        if (!(claimAll || p.token.toLowerCase() === args.token?.toLowerCase() || p.symbol.toUpperCase() === args.token?.replace(/^\$/, "").toUpperCase())) continue;
        claimMatches.push(p);
        if (claimMatches.length > 20) throw new Error("LP_CLAIM_TOO_MANY");
      }
      if (!claimAll && new Set(claimMatches.map(p => p.token.toLowerCase())).size > 1) throw new Error("LP_CLAIM_AMBIGUOUS");
    }
    let tokenAddress: string | undefined;
    if (args.token && /^0x[a-f0-9]{40}$/i.test(args.token)) tokenAddress = args.token.toLowerCase();
    else if (args.token) {
      const symbols = [...new Set([args.token, args.token.toUpperCase(), args.token.toLowerCase()])];
      const found = (await Promise.all(symbols.map(symbol => ctx.db.query("tokenRegistry").withIndex("by_symbol", q => q.eq("symbol", symbol)).take(30)))).flat().filter(r => r.active).map(r => r.normalizedAddress);
      const launches = (await Promise.all(symbols.map(symbol => ctx.db.query("tokenLaunches").withIndex("by_symbol", q => q.eq("symbol", symbol)).take(30)))).flat().flatMap(r => r.tokenAddress ? [r.tokenAddress.toLowerCase()] : []);
      const addresses = [...new Set([...found, ...launches])]; if (addresses.length === 1) tokenAddress = addresses[0];
    }
    return { wallet, tokenAddress, position, positions,
      positionChoices: selectionMatches.slice(0, 20).map(p => ({ positionId: p.publicId, symbol: p.symbol, pair: liquidityFieldsSchema.parse(JSON.parse(p.fieldsJson)).pair! })),
      morePositionChoices: selectionMatches.length > 20,
      claimPositions: claimMatches.map(p => liquidityClaimPositionSchema.parse({ positionId: p.publicId, token: p.token, symbol: p.symbol, version: p.version, poolId: p.poolId, fields: JSON.parse(p.fieldsJson), legs: JSON.parse(p.legsJson) })), nextCursor: page && !page.isDone ? page.continueCursor : undefined };
  },
});

export const terminalPositionRecords = internalQuery({
  args: { ownerXUserId: v.string(), sessionIdHash: v.string() },
  handler: async (ctx, args): Promise<{ wallet: Doc<"cryptoWallets">; positions: Doc<"liquidityManagedPositions">[]; executions: Doc<"liquidityExecutions">[] }> => {
    const session = await ctx.runQuery(internal.wallets.webSessionRecord, { sessionIdHash: args.sessionIdHash });
    if (!session || session.ownerXUserId !== args.ownerXUserId || session.revokedAt || session.expiresAt <= Math.floor(Date.now() / 1_000))
      throw new Error("LP terminal session is not active");
    const user = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", q => q.eq("xUserId", args.ownerXUserId)).unique();
    const wallet = user?.walletId ? await ctx.db.get(user.walletId) : null;
    if (!wallet || wallet.status !== "active" || wallet.ownerXUserId !== args.ownerXUserId || !liquidityWalletAllowed(args.ownerXUserId, wallet.address))
      throw new Error("LP wallet is not active");
    const positions = await ctx.db.query("liquidityManagedPositions").withIndex("by_owner", q => q.eq("ownerXUserId", args.ownerXUserId)).order("desc").take(200);
    const executions = await ctx.db.query("liquidityExecutions").withIndex("by_owner_updated", q => q.eq("ownerXUserId", args.ownerXUserId)).order("desc").take(500);
    return { wallet, positions: positions.filter(position => position.walletId === wallet._id), executions };
  },
});

export const terminalWorkflowRecord = internalQuery({
  args: { ownerXUserId: v.string(), sessionIdHash: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.wallets.webSessionRecord, { sessionIdHash: args.sessionIdHash });
    if (!session || session.ownerXUserId !== args.ownerXUserId || session.revokedAt || session.expiresAt <= Math.floor(Date.now() / 1_000))
      throw new Error("LP terminal session is not active");
    const conversation = await ctx.db.query("liquidityConversations")
      .withIndex("by_scope_active", q => q.eq("scope", `terminal:${args.sessionId}`).eq("active", true))
      .order("desc").first();
    if (!conversation || conversation.ownerXUserId !== args.ownerXUserId || conversation.source !== "terminal" || conversation.expiresAt <= Date.now()) return null;
    return { stateJson: conversation.stateJson, revision: conversation.revision };
  },
});

async function signer<T>(path: string, body: unknown, timeout = 120_000): Promise<T> {
  const base = process.env.WALLET_SIGNER_URL?.trim() || `${process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "")}/api/wallet-signer`;
  if (!base.startsWith("https://") || !process.env.WALLET_SIGNER_TOKEN) throw new Error("Signer not configured");
  const response = await fetch(`${base.replace(/\/$/, "")}${path}`, { method: "POST", headers: { authorization: `Bearer ${process.env.WALLET_SIGNER_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  return liquiditySignerResponse<T>(response);
}
async function positionStatusPages(ctx: ActionCtx, ownerXUserId: string, source: "x" | "terminal", position?: string, cursor?: string, view?: "nfts", token?: string) {
  if (view === "nfts" && !position) return { pages: ["Tell me one position's LP ID to see its NFTs. Example: Show me the NFTs for position LP-1234ABCD"], cursor: undefined };
  const context = await ctx.runQuery(internal.liquidity.resolveContext, { ownerXUserId, source, position, token, listPositions: true, cursor, ...(view === "nfts" ? { includeClosedPosition: true } : {}) });
  const wallet = context.wallet;
  if (!wallet || wallet.status !== "active") throw new Error("LP_WALLET_INACTIVE");
  if (view === "nfts") return { pages: paginateLiquidityResponse(context.position ? liquidityNftLines(context.position) : [R.notOwner], source, true), cursor: undefined };
  const positions = context.positions.filter(p => p.status === "active" && p.walletId === wallet._id && (!position || p.publicId === position)
    && (!token || p.token.toLowerCase() === token.toLowerCase() || p.symbol.toUpperCase() === token.replace(/^\$/, "").toUpperCase()));
  const statusDeadline = Date.now() + 30_000;
  const entries = await mapLiquidityBounded(positions.slice(0, 20), async p => {
    try {
      if (Date.now() >= statusDeadline) return liquidityStatusMessage(p.publicId, p.symbol);
      const fields = liquidityFieldsSchema.parse(JSON.parse(p.fieldsJson));
      const draft = newLiquidityDraft("status", fields);
      draft.tokenAddress = p.token; draft.symbol = p.symbol;
      const live = await signer<LiquidityPositionStatus>("/v1/liquidity/status", { ownerXUserId, source, walletRef: wallet.signerWalletRef, expectedFrom: wallet.address, draft, legs: JSON.parse(p.legsJson) }, Math.max(1, Math.min(15_000, statusDeadline - Date.now())));
      return liquidityStatusMessage(p.publicId, p.symbol, live);
    } catch { return liquidityStatusMessage(p.publicId, p.symbol); }
  });
  const lines = entries.flatMap((entry, index) => [...(index ? [""] : []), entry]);
  if (positions.length) lines.unshift("💧 Here are your recorded Delta Liquidity positions with current asset-value and fee estimates. Use an LP ID to collect its fees or fully withdraw it.", "");
  if (!positions.length && (position || !context.nextCursor)) lines.push(position ? R.notOwner : R.noPositions);
  if (context.nextCursor) lines.push("", "Reply next for more positions, or request any specific LP ID.");
  return { pages: paginateLiquidityResponse(lines, source, true), cursor: context.nextCursor };
}
export const handle = internalAction({
  args: requestArgs,
  handler: async (ctx, args): Promise<{ handled: boolean; message?: string; silent?: boolean; deferred?: boolean }> => {
    // Position-card actions in the terminal are independent of an unfinished
    // builder draft. Give an explicit LP claim/withdraw its own scope so it can
    // execute without replacing or conflicting with the user's saved setup.
    // Requiring a concrete position ID keeps ambiguous conversational requests
    // in the ordinary guided flow, where clarification remains available.
    const terminalManagement = args.source === "terminal"
      ? liquidityClaimSelection(args.text) ?? liquidityWithdrawalSelection(args.text)
      : null;
    const detachedTerminalManagement = terminalManagement?.position
      && (liquidityClaimSelection(args.text) !== null || terminalManagement.withdrawPercent === 100);
    const reservationArgs = detachedTerminalManagement
      ? { ...args, scope: `${args.scope}:manage:${args.requestKey}` }
      : args;
    const reservation = await ctx.runMutation(internal.liquidity.reserveTurn, reservationArgs);
    if (!reservation.handled || !reservation.turnId || !reservation.state || !reservation.publicId || !reservation.revision) return reservation;
    let d = liquidityDraftSchema.parse(JSON.parse(reservation.state));
    let preservedSetup: LiquidityDraft | undefined;
    let message: string | undefined, active = true, analyzedThisTurn = false, walletAddress: string | undefined;
    let terminalSearchWarning: string | undefined;
    try {
      const inputText = normalizeLiquidityTokenAliases(args.text);
      const control = liquidityControl(inputText, d.phase);
      const explicitStatusSelection = liquidityStatusSelection(inputText);
      // Questions are routed before the review-page gate so help is available
      // even halfway through a paginated quote. Parse only once per turn.
      const parsed = !control ? await extractLiquidityFields(inputText, reservation.revision > 1 ? d : undefined) : undefined;
      // Repeating an explicit create/open request after discovery returned no
      // candidates is a natural retry. Do not instantly replay the stale empty
      // analysis merely because the persistent draft already has token fields.
      const retryEmptyPoolAnalysis = d.operation === "open" && d.phase === "pool" && d.analyzed && d.candidates.length === 0
        && parsed?.operation === "open" && /\b(?:create|open)\b[\s\S]*\b(?:liquidity|pool|position)\b/i.test(inputText);
      if (control?.id && control.id !== reservation.publicId) message = R.stale;
      else if (control?.kind === "cancel") { d.phase = "cancelled"; d.explanationPages = []; d.review = undefined; d.executionPlanJson = undefined; d.remainingPages = []; active = false; message = R.cancelled; }
      else if (control?.kind === "back") { d = backLiquidityDraft(d); message = liquidityResponseLines(d, reservation.publicId).join("\n"); }
      else if (control?.kind === "continue") {
        message = d.explanationPages.shift() ?? d.remainingPages.shift() ?? liquidityResponseLines(d, reservation.publicId).join("\n");
      }
      else if (parsed?.inquiryTopics?.length) {
        if (reservation.revision === 1) { d = newLiquidityDraft("help"); active = false; }
        // Explanations re-prompt the setup step, so "next" must not resume an
        // older position list instead of the explanation just displayed.
        d.positionInquiry = undefined;
        const explained = liquidityExplanation(d, reservation.publicId, parsed.inquiryTopics, args.source);
        d = explained.draft; message = explained.message;
      }
      else if ((parsed?.operation === "status" && d.operation !== "status" && reservation.revision > 1)
        || (control?.kind === "next" && d.positionInquiry)) {
        preservedSetup = structuredClone(d);
        d.explanationPages = [];
        const inquiry = control?.kind === "next" ? d.positionInquiry! : { pages: [], position: parsed?.fields.position, token: explicitStatusSelection?.token, cursor: undefined, view: parsed?.statusView };
        if (!inquiry.pages.length) {
          const result = await positionStatusPages(ctx, args.ownerXUserId, args.source, inquiry.position, inquiry.cursor, inquiry.view, inquiry.token);
          inquiry.pages = result.pages; inquiry.cursor = result.cursor;
        }
        message = inquiry.pages.shift();
        d.positionInquiry = inquiry.pages.length || inquiry.cursor ? inquiry : undefined;
        if (!d.positionInquiry) message += "\nYour setup is unchanged. Continue with your previous choice or quote.";
      }
      else if (control?.kind === "next" && d.explanationPages.length) { message = d.explanationPages.shift(); }
      else if (control?.kind === "next" && d.remainingPages.length) { message = d.remainingPages.shift(); if (d.phase === "done" && !d.remainingPages.length) active = Boolean(d.positionCursor); }
      // Editing replaces the quote, including its unread pages. Confirmation
      // still cannot bypass the page gate; only explicit edits/refresh can.
      else if (d.remainingPages.length && !(
        parsed?.operation === d.operation && Object.keys(parsed.fields).length > 0
        || control?.kind === "refresh" || control?.kind === "custom"
      )) message = R.next;
      else if (control?.kind === "confirm" && !d.alternative) {
        if (!d.review?.executionReady || !d.executionPlanJson || d.review.expiresAt < Date.now()) message = "⌛ Reply refresh for a current liquidity quote before confirming.";
        else {
          validateLiquidityReview(d);
          await ctx.runMutation(internal.liquidity.queueExecution, { turnId: reservation.turnId, revision: reservation.revision, planJson: d.executionPlanJson });
          return { handled: true, deferred: true };
        }
      } else if (parsed && !parsed.statusView && reservation.revision > 1 && parsed.operation === d.operation && !Object.keys(parsed.fields).length && !retryEmptyPoolAnalysis) {
        // An unrelated/empty extraction is not an edit, refresh or renewed
        // authorization. In particular it must not create another quote.
        message = liquidityResponseLines(d, reservation.publicId).join("\n");
      } else {
        d.explanationPages = [];
        d.positionInquiry = undefined;
        const alternative = control?.kind === "confirm" ? d.alternative : undefined;
        if (alternative === "withdraw_all") {
          d.alternative = undefined; d = updateLiquidityFields(d, { withdrawPercent: 100 });
        } else if (alternative === "copy") {
          d.alternative = undefined;
          const copy = await ctx.runQuery(internal.liquidity.resolveContext, { ownerXUserId: args.ownerXUserId, source: args.source, position: d.fields.position });
          if (!copy.position) { message = R.notOwner; d.phase = "position"; }
          else {
            const settings = inheritLiquidityPositionFields(liquidityFieldsSchema.parse(JSON.parse(copy.position.fieldsJson)), {});
            d = newLiquidityDraft("open", { ...settings, token: copy.position.token }); d.copyFromPosition = copy.position.publicId;
            d.custom = true; d.analyzed = true; d.tokenAddress = copy.position.token; d.symbol = copy.position.symbol;
          }
        } else if (d.alternative) message = d.alternative === "copy" ? R.addUnavailable : R.partialUnavailable;
        else if (control?.kind === "custom") { d.custom = true; d.selected = undefined; d.analyzed = true; d.review = undefined; d.executionPlanJson = undefined; }
        else if (control?.kind === "choose") d = selectLiquidityPool(d, control.option!);
        else if (parsed) {
          if (reservation.revision > 1 && parsed.operation !== d.operation && parsed.operation !== "help" && parsed.operation !== "status") { message = R.waiting; }
          else {
            if (parsed.fields.position && d.fields.position && parsed.fields.position !== d.fields.position) d = newLiquidityDraft(parsed.operation);
            d.operation = parsed.operation; d = updateLiquidityFields(d, parsed.fields);
            if (parsed.operation === "status") {
              d.statusView = parsed.statusView;
              // An explicit NFT lookup without one valid ID must not reuse an
              // earlier target or silently expand to every recorded position.
              if (parsed.statusView === "nfts") d.fields.position = parsed.fields.position;
            }
          }
        }
        if (!message && d.operation === "status") {
          const result = await positionStatusPages(ctx, args.ownerXUserId, args.source, d.fields.position, control?.kind === "next" ? d.positionCursor : undefined, d.statusView, d.fields.token);
          d.positionCursor = result.cursor;
          message = result.pages.shift(); d.remainingPages = result.pages; d.phase = "done"; active = result.pages.length > 0 || Boolean(d.positionCursor);
        }
        if (!message) {
          if (d.operation === "withdraw" && d.fields.withdrawPercent === undefined) d.fields.withdrawPercent = 100;
          const selectPosition = d.operation === "withdraw" || d.operation === "claim" && !d.fields.token && !d.fields.allPositions;
          const context = await ctx.runQuery(internal.liquidity.resolveContext, { ownerXUserId: args.ownerXUserId, source: args.source, token: d.fields.token, position: d.fields.position, selectPosition, claimPositions: d.operation === "claim", allPositions: d.fields.allPositions, listPositions: d.operation === "status", cursor: control?.kind === "next" ? d.positionCursor : undefined });
          if (!context.wallet || context.wallet.status !== "active") throw new Error("Missing wallet");
          walletAddress = context.wallet.address;
          if (d.operation === "help") { message = R.help; active = false; }
          else if (d.operation === "add") {
            d.review = undefined; d.executionPlanJson = undefined;
            if (!context.position) { d.phase = "position"; message = `${d.fields.position ? R.notOwner : "Adding to a position isn’t available yet. I can offer a separate matching position."}\n${R.position}`; }
            else { d.alternative = "copy"; d.phase = "blocked"; message = R.addUnavailable; }
          } else if (d.operation === "withdraw" && d.fields.withdrawPercent !== undefined && d.fields.withdrawPercent !== 100) {
            d.review = undefined; d.executionPlanJson = undefined; d.alternative = "withdraw_all";
            d.phase = "blocked"; message = R.partialUnavailable;
          } else if (d.operation === "compound" || d.fields.autoCompound) {
            d.phase = "blocked"; message = R.blocked; active = false;
          } else {
            if (selectPosition && !d.fields.position) {
              if (context.position) {
                d.fields.position = context.position.publicId;
                // The authenticated indexed selection determines this token.
                delete d.fields.token;
                d.positionChoices = []; d.morePositionChoices = false;
              } else {
                d.positionChoices = context.positionChoices; d.morePositionChoices = context.morePositionChoices;
                d.phase = "position";
                message = d.positionChoices.length ? liquidityResponseLines(d, reservation.publicId).join("\n") : R.noPositions;
                if (!d.positionChoices.length) active = false;
              }
            }
            if (d.operation === "claim" && !d.fields.position && (d.fields.token || d.fields.allPositions)) {
              if (!context.claimPositions.length) { message = R.noPositions; d.phase = "position"; }
              else {
                const first = context.claimPositions[0];
                // Top-level fields describe the first position only. The exact
                // complete set is frozen into the signed quote, not inferred later.
                d.fields = { ...inheritLiquidityPositionFields(first.fields, {}), position: undefined, allPositions: d.fields.allPositions, token: d.fields.token };
                d.tokenAddress = first.token; d.symbol = first.symbol; d.analyzed = true;
              }
            }
            if (d.fields.position) {
              if (!context.position) { message = R.notOwner; d.phase = "position"; }
              else {
                const saved = liquidityFieldsSchema.parse(JSON.parse(context.position.fieldsJson));
                d.fields = inheritLiquidityPositionFields(saved, d.fields); d.tokenAddress = context.position.token; d.symbol = context.position.symbol; d.analyzed = true;
              }
            }
            if (!message && d.operation === "open" && d.fields.token && d.fields.amount && d.fields.unit && (!d.tokenAddress || !d.analyzed || (control?.kind === "refresh" || retryEmptyPoolAnalysis) && d.phase === "pool")) {
              if (!context.tokenAddress) { message = R.unresolved; d.phase = "token"; }
              else {
                d.tokenAddress = context.tokenAddress;
                const fingerprint = `${d.tokenAddress.toLowerCase()}:${d.fields.amount}:${d.fields.unit}`;
                if (!d.fundingCheck || d.fundingCheck.fingerprint !== fingerprint || !d.fundingCheck.sufficient || control?.kind === "refresh") {
                  try {
                    const funding = await signer<{ sufficient: boolean; missing?: "ETH" | "USDG" | "POSITION_ASSET" | "FUNDING" }>("/v1/liquidity/funding-check", {
                      ownerXUserId: args.ownerXUserId, source: args.source, expectedFrom: context.wallet.address,
                      walletRef: context.wallet.signerWalletRef, draft: d, legs: [],
                    }, 30_000);
                    d.fundingCheck = { fingerprint, checkedAt: Date.now(), sufficient: funding.sufficient, ...(funding.missing ? { missing: funding.missing } : {}) };
                    if (!funding.sufficient) {
                      d.diagnosticCode = "LP_PRECHECK_INSUFFICIENT_FUNDS";
                      d.phase = "analysis";
                      message = liquidityFundingMessage(d, walletAddress);
                    }
                  } catch {
                    // Advisory check availability must never block pool
                    // discovery. The exact signed quote remains authoritative.
                    d.fundingCheck = undefined;
                  }
                }
                if (message) {
                  // Preserve the draft and skip expensive market discovery
                  // until the user funds the wallet and explicitly resumes.
                } else {
                if (args.source === "terminal") {
                  const sessionId = args.scope.startsWith("terminal:") ? args.scope.slice("terminal:".length) : "";
                  const searchLimit = await ctx.runMutation(internal.wallets.consumeTerminalLiquiditySearch, {
                    ownerXUserId: args.ownerXUserId, sessionId,
                  });
                  if (!searchLimit.allowed) throw new Error("LP_TERMINAL_SEARCH_LIMIT");
                  if (searchLimit.warn) terminalSearchWarning = `⚠️ You’ve used 25 of today’s 30 terminal liquidity pool searches. You have ${searchLimit.remaining} remaining.`;
                }
                const discovered = await discoverLiquidityPools(context.tokenAddress as `0x${string}`, d.fields.unit === "usd" ? Number(d.fields.amount) : undefined, undefined, { fresh: true, fields: d.fields });
                d.symbol = discovered.symbol;
                d.currentMarketCapUsd = discovered.currentMarketCapUsd;
                const ranked = await rankLiquidityPoolsWithDiagnostics(discovered.candidates, `${d.fields.amount ?? "unknown"} ${d.fields.unit ?? ""}`);
                d.candidates = ranked.candidates;
                d.analysis = { ...discovered.analysis, rankingMode: ranked.mode, rankingDiagnostics: ranked.diagnostics }; analyzedThisTurn = true;
                d.analyzed = true;
                }
              }
            }
            if (!message) {
              applyLiquidityBandDefault(d);
              applyLiquiditySpacingDefault(d);
              d.phase = liquidityNextPhase(d);
              if (d.phase === "review") {
                validateLiquidityReview(d);
                d.executionPlanJson = undefined; d.review = undefined; d.quoteSummary = [];
                if (d.operation === "open" && !analyzedThisTurn) {
                  const comparison = await discoverLiquidityPools(d.tokenAddress as `0x${string}`, d.fields.unit === "usd" ? Number(d.fields.amount) : undefined, undefined, { fresh: true, fields: d.fields, selected: d.selected });
                  // Refresh execution inputs without another AI call: the user
                  // already chose a pool and review must not choose a new one.
                  d.analysis = comparison.analysis; d.candidates = comparison.candidates; d.currentMarketCapUsd = comparison.currentMarketCapUsd ?? d.currentMarketCapUsd;
                  if (d.selected && !comparison.selected) throw new Error(
                    comparison.analysis.diagnostics.includes("SELECTED_POOL_RANGE_BANDS_INCOMPATIBLE") ? "LP_SELECTED_POOL_RANGE_BANDS_INCOMPATIBLE"
                        : comparison.analysis.diagnostics.includes("SELECTED_POOL_SETTINGS_INCOMPATIBLE") ? "LP_POOL_SETTINGS_INCOMPATIBLE"
                          : "LP_SELECTED_POOL_UNAVAILABLE",
                  );
                  if (comparison.selected) d.selected = comparison.selected;
                }
                const legs: LiquidityLeg[] = context.position ? JSON.parse(context.position.legsJson) : [];
                const claimPositions = context.claimPositions.length ? context.claimPositions : undefined;
                const response = await signer<unknown>("/v1/liquidity/quote", { ownerXUserId: args.ownerXUserId, source: args.source, expectedFrom: context.wallet.address, walletRef: context.wallet.signerWalletRef, draft: d, legs, ...(claimPositions ? { claimPositions } : {}) });
                const plan = validateLiquidityQuote(response, { owner: context.wallet.address, draft: d, legs, poolId: context.position?.poolId, claimPositions });
                d.executionPlanJson = JSON.stringify(plan); d.quoteSummary = plan.summary;
                d.review = { hash: liquidityReviewHash(reservation.publicId, args.ownerXUserId, reservation.revision, d), expiresAt: plan.expiresAt, executionReady: true };
                if (d.operation === "claim" || d.operation === "withdraw") {
                  d.remainingPages = [];
                  await ctx.runMutation(internal.liquidity.queueExecution, { turnId: reservation.turnId, revision: reservation.revision, planJson: d.executionPlanJson, preparedState: JSON.stringify(d) });
                  return { handled: true, deferred: true };
                }
              }
              // Keep each explained setup step together instead of making the
              // user request multiple short fragments of the same question.
              const pages = paginateLiquidityResponse(liquidityResponseLines(d, reservation.publicId), args.source, true); message = pages.shift(); d.remainingPages = pages;
            }
          }
        }
      }
    } catch (error) {
      const code = liquidityDiagnostic(error, "LP_WORKFLOW_FAILED");
      if (preservedSetup) d = preservedSetup;
      d.diagnosticCode = code;
      if (!preservedSetup) { d.review = undefined; d.executionPlanJson = undefined; d.remainingPages = []; d.quoteSummary = []; }
      if (!preservedSetup && code.includes("INVALID_BANDS")) {
        d.phase = "bands"; d.remainingPages = []; d.quoteSummary = [];
      }
      if (!preservedSetup && /LP_INVALID_MCAP_RANGE/.test(code)) d.phase = "range";
      // A failed standalone lookup can create a brand-new draft before its
      // token/status lookup throws. Do not leave that empty draft looking like
      // an active setup. Preserve every draft that contains actual user input.
      if (!preservedSetup && code === "LP_WORKFLOW_FAILED" && d.operation === "open" && d.phase === "token"
        && Object.keys(d.fields).length === 0) active = false;
      message = preservedSetup ? "⚠️ I couldn’t load your positions just now. Your liquidity setup is unchanged; retry the lookup or continue your setup."
        : code.includes("INVALID_BANDS") ? liquidityResponseLines(d, reservation.publicId).join("\n")
        : code === "LP_NEW_POOL_PRICE_UNVERIFIED" ? "⚠️ I couldn’t independently verify a reliable current price to initialize this new pool. No funds were moved. Reply refresh shortly, or choose an existing pool."
        : code === "LP_REFERENCE_PRICE_DISAGREEMENT" ? "⚠️ Independent price sources disagree too much to safely initialize this pool. No funds were moved. Reply refresh later, or choose an existing pool."
        : code === "LP_NO_CLAIMABLE_FEES" ? "ℹ️ That position does not currently have LP fees worth collecting, so no gas was spent."
        : code === "LP_TERMINAL_SEARCH_LIMIT" ? "⏳ You’ve reached today’s limit of 30 terminal liquidity pool searches. You can search again tomorrow."
        : code.includes("LP_INVALID_MCAP_RANGE") ? "⚠️ Enter a positive lower and upper dollar MCap, with the lower value first. No funds were moved. Example: $50k to $150k"
        : code.includes("LP_INSUFFICIENT_GAS") ? liquidityFundingMessage(d, walletAddress, true)
        : /LP_(?:PRECHECK_)?INSUFFICIENT_(?:FUNDS|FUNDING)/.test(code) || code === "INSUFFICIENT_FUNDS" ? liquidityFundingMessage(d, walletAddress)
        : code.includes("LP_CLAIM_TOO_MANY") ? R.claimTooMany : code.includes("LP_CLAIM_AMBIGUOUS") ? R.ambiguousClaim
        : code.includes("DELTA_NATIVE_ADD_UNVERIFIED") ? R.addUnavailable
        : code.includes("LP_POSITION_SETTINGS_CONFLICT") ? R.settingsConflict : code.includes("LP_POSITION_CAPACITY") ? R.capacity
        : code.includes("LP_SELECTED_POOL_RANGE_BANDS_INCOMPATIBLE") ? `⚠️ Your selected pool cannot fit ${d.fields.bands ?? "the requested number of"} bands inside that MCap range because of the pool's price spacing. Use fewer bands or a wider range, then review a new quote. No funds were moved.`
        : code.includes("LP_POOL_SETTINGS_INCOMPATIBLE") ? "⚠️ Your selected pool cannot represent that MCap range and band layout. Use fewer bands, widen the range, or choose another pool, then review a new quote. No funds were moved."
        : code.includes("LP_SELECTED_POOL_UNAVAILABLE") ? "⚠️ I couldn’t verify your selected pool just now. No different pool was substituted and no funds were moved. Reply refresh to retry, or choose custom pool."
        : code.includes("LP_REFERENCE_PRICE") ? "⚠️ I couldn’t verify a reliable price for this pool. Choose another established pool or retry later; no funds were moved."
        : /DELTA_.*UNVERIFIED/.test(code) ? R.blocked : R.failed;
    }
    if (terminalSearchWarning && message) message += `\n\n${terminalSearchWarning}`;
    if (active && message && !message.includes("Example:") && !["token", "budget", "pair", "review"].includes(d.phase)) {
      const hint = d.remainingPages.length || d.explanationPages.length || d.positionInquiry ? "" : liquidityStepExample(d, reservation.publicId);
      if (hint) message += `\n${hint}`;
    }
    await ctx.runMutation(internal.liquidity.saveTurn, { turnId: reservation.turnId, revision: reservation.revision, state: JSON.stringify(d), message: message || R.invalid, active });
    return { handled: true, message: message || R.invalid };
  },
});

export const queueExecution = internalMutation({
  args: { turnId: v.id("liquidityTurns"), planJson: v.string(), revision: v.optional(v.number()), preparedState: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (process.env.X_CRYPTO_EXECUTION_ENABLED !== "true") throw new Error("Wallet execution is disabled");
    const turn = await ctx.db.get(args.turnId), conversation = turn ? await ctx.db.get(turn.conversationId) : null;
    if (!turn || !conversation || !conversation.active || !liquidityOwnerAllowed(conversation.ownerXUserId, conversation.source) || turn.ownerXUserId !== conversation.ownerXUserId || conversation.currentTurnId !== turn._id || conversation.revision !== turn.revision || args.revision !== undefined && args.revision !== turn.revision) throw new Error("Invalid liquidity confirmation");
    const d = liquidityDraftSchema.parse(JSON.parse(args.preparedState ?? conversation.stateJson));
    if (args.preparedState !== undefined) {
      if (args.revision === undefined || !(d.operation === "claim" || d.operation === "withdraw" && d.fields.withdrawPercent === 100)) throw new Error("LP_DIRECT_OPERATION_INVALID");
      validateLiquidityReview(d);
    }
    if (d.operation === "add") throw new Error("DELTA_NATIVE_ADD_UNVERIFIED");
    if (!d.review?.executionReady || d.review.expiresAt < Date.now() || d.executionPlanJson !== args.planJson || d.remainingPages.length) throw new Error("Stale liquidity confirmation");
    const existing = await ctx.db.query("liquidityExecutions").withIndex("by_conversation", q => q.eq("conversationId", conversation._id)).unique(); if (existing) return existing._id;
    if (args.preparedState !== undefined) await ctx.db.patch(conversation._id, { stateJson: JSON.stringify(d), updatedAt: Date.now() });
    const id = await ctx.db.insert("liquidityExecutions", { conversationId: conversation._id, turnId: turn._id, walletId: conversation.walletId, ownerXUserId: conversation.ownerXUserId, planJson: args.planJson, status: "queued", stepsJson: "[]", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.liquidity.execute, { executionId: id }); return id;
  },
});
export const executionContext = internalQuery({ args: { executionId: v.id("liquidityExecutions") }, handler: async (ctx, args) => {
  const execution = await ctx.db.get(args.executionId); if (!execution) return null;
  const conversation = await ctx.db.get(execution.conversationId), wallet = await ctx.db.get(execution.walletId);
  const boundTurnId = execution.turnId ?? conversation?.currentTurnId;
  const candidate = boundTurnId ? await ctx.db.get(boundTurnId) : null;
  const turn = candidate?.conversationId === execution.conversationId ? candidate : null;
  return { execution, conversation, wallet, turn };
} });
// A fresh query observes operator disablement between network awaits. Receipt
// reconciliation and delivery remain available while new writes are disabled.
export const executionWritesEnabled = internalQuery({ args: {}, handler: () => process.env.X_CRYPTO_EXECUTION_ENABLED === "true" });

/** Bounded operator health snapshot. Read-only and internal: no wallet action,
 * retry, delivery, or conversation is changed by this query. */
export const health = internalQuery({ args: {}, handler: async ctx => {
  const now = Date.now();
  const [queued, running, reconciling, manualReview, pendingDelivery, activePositions, expiredConversations, processingTurns] = await Promise.all([
    ctx.db.query("liquidityExecutions").withIndex("by_status_updated", q => q.eq("status", "queued")).take(200),
    ctx.db.query("liquidityExecutions").withIndex("by_status_updated", q => q.eq("status", "running")).take(200),
    ctx.db.query("liquidityExecutions").withIndex("by_status_updated", q => q.eq("status", "reconciling")).take(200),
    ctx.db.query("liquidityExecutions").withIndex("by_status_updated", q => q.eq("status", "manual_review")).take(200),
    ctx.db.query("liquidityExecutions").withIndex("by_delivery_due", q => q.eq("deliveryStatus", "pending")).take(200),
    ctx.db.query("liquidityManagedPositions").withIndex("by_status", q => q.eq("status", "active")).take(500),
    ctx.db.query("liquidityConversations").withIndex("by_active_expiry", q => q.eq("active", true).lte("expiresAt", now)).take(200),
    ctx.db.query("liquidityTurns").withIndex("by_status", q => q.eq("status", "processing")).take(200),
  ]);
  const staleCutoff = now - 10 * 60_000;
  return {
    checkedAt: now, executions: { queued: queued.length, running: running.length, reconciling: reconciling.length, manualReview: manualReview.length },
    pendingDelivery: pendingDelivery.length, activePositions: activePositions.length, expiredActiveConversations: expiredConversations.length,
    staleProcessingTurns: processingTurns.filter(turn => turn.createdAt < staleCutoff).length,
    diagnostics: [...new Set(manualReview.map(row => row.diagnostic).filter((code): code is string => Boolean(code)))].slice(0, 20),
    bounded: queued.length === 200 || running.length === 200 || reconciling.length === 200 || manualReview.length === 200 || pendingDelivery.length === 200 || activePositions.length === 500,
  };
} });
export const monitorHealth = internalAction({ args: {}, handler: async (ctx): Promise<{ checkedAt: number; unhealthy: boolean }> => {
  const snapshot: { checkedAt: number; executions: { manualReview: number }; expiredActiveConversations: number; staleProcessingTurns: number; bounded: boolean }
    = await ctx.runQuery(internal.liquidity.health, {});
  const unhealthy = snapshot.executions.manualReview > 0 || snapshot.expiredActiveConversations > 0
    || snapshot.staleProcessingTurns > 0 || snapshot.bounded;
  if (unhealthy) console.error("liquidity_health_attention", JSON.stringify(snapshot));
  return { checkedAt: snapshot.checkedAt, unhealthy };
} });
async function requireExecutionWrites(ctx: ActionCtx) {
  if (await ctx.runQuery(internal.liquidity.executionWritesEnabled, {}) !== true) throw new Error("LP_EXECUTION_DISABLED");
}
export const persistSteps = internalMutation({ args: { executionId: v.id("liquidityExecutions"), stepsJson: v.string() }, handler: async (ctx, args) => {
  const e = await ctx.db.get(args.executionId); if (!e || ["confirmed", "failed"].includes(e.status)) return;
  // Discovering a late receipt may resolve a nonce; it must not reauthorize
  // later spending steps after this execution entered read-only manual review.
  const manual = e.status === "manual_review";
  await ctx.db.patch(args.executionId, { stepsJson: args.stepsJson, status: manual ? "manual_review" : "running", retryCount: manual ? e.retryCount : 0, nextAttemptAt: undefined, leaseUntil: Date.now() + 180_000, updatedAt: Date.now() });
} });
export const replaceOpenPlan = internalMutation({
  args: { executionId: v.id("liquidityExecutions"), expectedProof: v.string(), stepIndex: v.number(), planJson: v.string() },
  handler: async (ctx, args) => {
    const execution = await ctx.db.get(args.executionId); if (!execution || ["confirmed", "failed"].includes(execution.status)) throw new Error("LP_REFRESH_EXECUTION_INVALID");
    const current = JSON.parse(execution.planJson) as LiquidityQuotePlan, steps = JSON.parse(execution.stepsJson) as SignedStep[];
    if (current.proof !== args.expectedProof || args.stepIndex !== current.calls.length - 1 || steps.length !== args.stepIndex
      || steps.some(step => !step.confirmed || !step.transactionHash || step.reverted || !step.blockNumber)) throw new Error("LP_REFRESH_EXECUTION_INVALID");
    const refreshed = validateLiquidityOpenRefresh(current, JSON.parse(args.planJson));
    await ctx.db.patch(execution._id, { planJson: JSON.stringify(refreshed), stage: "reprice_open", updatedAt: Date.now() });
    return refreshed;
  },
});
type SignedStep = { transactionHash?: string; signedTransaction?: string; toAddress: string; valueWei: string; nonce: number; confirmed?: boolean; reverted?: boolean; blockNumber?: string; received?: string[]; envelope?: { unsignedTransaction: string; toAddress: string; valueWei: string; nonce: number; envelopeProof: string } };

function liquidityFundingStepLabel(plan: LiquidityQuotePlan, callIndex: number) {
  const assetFunding = new Set(["funding_buy", "funding_usdg_to_eth", "funding_wrap"]);
  const fundingIndexes = plan.calls.map((call, index) => assetFunding.has(call.purpose) ? index : -1).filter(index => index >= 0);
  const ordinal = fundingIndexes.indexOf(callIndex);
  const descriptions = plan.summary.filter(line => /^(?:Buy missing|Wrap)\b/i.test(line));
  const description = descriptions[ordinal];
  if (description) return description.replace(/^Buy missing\s+/i, "Buy ").replace(/:\s*/i, " using up to ");
  const purpose = plan.calls[callIndex]?.purpose;
  return purpose === "funding_wrap" ? "Wrap ETH into WETH" : purpose === "funding_usdg_to_eth" ? "Convert USDG into ETH" : "Funding purchase";
}

function liquidityExecutionStepLabel(plan: LiquidityQuotePlan, callIndex: number) {
  const purpose = plan.calls[callIndex]?.purpose;
  if (["funding_buy", "funding_usdg_to_eth", "funding_wrap"].includes(purpose)) return liquidityFundingStepLabel(plan, callIndex);
  if (purpose === "approval" || purpose === "funding_approval") return "Token approval";
  if (purpose === "approval_reset" || purpose === "funding_approval_reset") return "Token approval reset";
  if (purpose === "funding_permit2") return "Trading permission";
  if (purpose === "initialize") return "Pool initialization";
  if (purpose === "open") return "Delta Liquidity position creation";
  return "Liquidity transaction step";
}

function liquidityFundingFailureMessage(plan: LiquidityQuotePlan, steps: SignedStep[]) {
  const assetFunding = new Set(["funding_buy", "funding_usdg_to_eth", "funding_wrap"]);
  const fundingIndexes = plan.calls.map((call, index) => assetFunding.has(call.purpose) ? index : -1).filter(index => index >= 0);
  const completed = plan.calls.map((_, index) => steps[index]?.confirmed && steps[index]?.transactionHash ? index : -1).filter(index => index >= 0);
  const pending = fundingIndexes.filter(index => !steps[index]?.confirmed);
  const completedLines = completed.flatMap(index => [
    `• ${liquidityExecutionStepLabel(plan, index)}: confirmed`,
    `  TXN: https://robinhoodchain.blockscout.com/tx/${steps[index]!.transactionHash}`,
  ]);
  const pendingLines = plan.calls.map((_, index) => !steps[index]?.confirmed ? `• ${liquidityExecutionStepLabel(plan, index)}: not completed` : null).filter((line): line is string => Boolean(line));
  const allFundingComplete = pending.length === 0;
  const safelyRetryable = Boolean(liquidityFundedRetryPrefix(plan, steps));
  return [
    allFundingComplete
      ? "⚠️ Funding swaps completed, but the liquidity position did not finish."
      : "⚠️ Part of the liquidity funding completed, but the liquidity position did not finish.",
    "", "Completed:", ...completedLines,
    "", "Not completed:", ...pendingLines,
    "", "Confirmed purchases remain in your wallet.",
    safelyRetryable
      ? "Reply retry to form the position from those saved assets without repeating the buys."
      : "Request a refreshed quote to continue from your current wallet balances without repeating completed purchases.",
  ].join("\n");
}
export const retryRevertedOpen = internalMutation({
  args: { executionId: v.id("liquidityExecutions") },
  handler: async (ctx, args) => {
    const execution = await ctx.db.get(args.executionId);
    if (!execution || ["confirmed", "failed", "manual_review"].includes(execution.status) || (execution.openRecoveryCount ?? 0) >= 1) return false;
    const plan = JSON.parse(execution.planJson) as LiquidityQuotePlan, steps = JSON.parse(execution.stepsJson) as SignedStep[];
    const finalIndex = plan.calls.length - 1, failed = steps[finalIndex], prefix = steps.slice(0, finalIndex);
    if (plan.operation !== "open" || plan.calls[finalIndex]?.purpose !== "open" || steps.length !== plan.calls.length
      || !failed?.reverted || failed.confirmed || !failed.transactionHash || !failed.signedTransaction
      || prefix.some(step => !step.confirmed || step.reverted || !step.transactionHash || !step.blockNumber)) return false;
    const history = execution.revertedOpenStepsJson ? JSON.parse(execution.revertedOpenStepsJson) as SignedStep[] : [];
    history.push(failed);
    await ctx.db.patch(execution._id, {
      stepsJson: JSON.stringify(prefix), revertedOpenStepsJson: JSON.stringify(history), openRecoveryCount: 1,
      status: "running", stage: "retry_reverted_open", diagnostic: "LP_OPEN_PRICE_RETRY", retryCount: 0,
      leaseUntil: 0, nextAttemptAt: undefined, updatedAt: Date.now(),
    });
    return true;
  },
});
export const executionHeartbeat = internalMutation({ args: { executionId: v.id("liquidityExecutions"), stage: v.string() }, handler: async (ctx, args) => {
  await ctx.db.patch(args.executionId, { stage: args.stage, leaseUntil: Date.now() + 180_000, updatedAt: Date.now() });
} });
export const deferExecution = internalMutation({ args: { executionId: v.id("liquidityExecutions"), stage: v.string(), diagnostic: v.string(), readOnly: v.boolean() }, handler: async (ctx, args) => {
  const e = await ctx.db.get(args.executionId); if (!e || ["confirmed", "failed"].includes(e.status)) return;
  // A duplicate job must not spend another attempt or create a parallel retry.
  if (!liquidityRecoveryDue(e, Date.now())) return;
  const walletBusy = args.diagnostic === "LP_WALLET_BUSY";
  const attempts = walletBusy ? (e.retryCount ?? 0) : e.status === "manual_review" && args.diagnostic === "LP_MANUAL_REVIEW_REQUIRED"
    ? LIQUIDITY_TOTAL_ATTEMPTS : (e.retryCount ?? 0) + 1;
  const manual = e.status === "manual_review" || args.diagnostic === "LP_EXECUTION_DISABLED" || args.diagnostic === "LP_EXPIRED_ENVELOPE_REQUIRES_REVIEW" || attempts >= LIQUIDITY_WRITE_ATTEMPTS;
  const delay = walletBusy ? 10_000 : manual ? 5 * 60_000 : Math.min(60_000, attempts * 10_000);
  const stopped = attempts >= LIQUIDITY_TOTAL_ATTEMPTS;
  await ctx.db.patch(e._id, { status: manual ? "manual_review" : args.readOnly ? "reconciling" : "running", retryCount: attempts, stage: args.stage, diagnostic: args.diagnostic, leaseUntil: 0, nextAttemptAt: stopped ? undefined : Date.now() + delay, updatedAt: Date.now() });
  if (!stopped) await ctx.scheduler.runAfter(delay, internal.liquidity.execute, { executionId: e._id });
} });
// Recovers hard action termination, not just errors caught by the action.
export const recoverExecutions = internalMutation({ args: {}, handler: async ctx => {
  for (const status of ["queued", "running", "reconciling", "manual_review"] as const) {
    // Stopped manual-review rows have no nextAttemptAt and must not occupy
    // every slot in the bounded recovery scan ahead of work that is still due.
    const rows = status === "manual_review"
      ? await ctx.db.query("liquidityExecutions").withIndex("by_status_next_attempt", q => q.eq("status", status).gt("nextAttemptAt", 0).lte("nextAttemptAt", Date.now())).take(10)
      : await ctx.db.query("liquidityExecutions").withIndex("by_status_updated", q => q.eq("status", status)).order("asc").take(10);
    for (const e of rows) if (!liquidityRecoveryStopped(e) && (e.leaseUntil ?? e.updatedAt + 180_000) < Date.now() && (e.nextAttemptAt ?? 0) <= Date.now()) {
      await ctx.db.patch(e._id, { leaseUntil: Date.now() + 180_000, updatedAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.liquidity.execute, { executionId: e._id });
    }
  }
  // A cancellation can supersede an action while that action is outside the
  // mutation. Retire its old turn so health checks do not report inactive or
  // superseded conversations as live processing work.
  const processingTurns = await ctx.db.query("liquidityTurns").withIndex("by_status", q => q.eq("status", "processing")).take(50);
  for (const turn of processingTurns) {
    const conversation = await ctx.db.get(turn.conversationId);
    if (!conversation || !conversation.active || conversation.currentTurnId !== turn._id || conversation.expiresAt <= Date.now()) {
      await ctx.db.patch(turn._id, { status: "cancelled", response: conversation?.active ? R.expired : R.cancelled });
    }
  }
  // Expired drafts otherwise remain active forever unless their exact scope is
  // opened again. Retire a bounded indexed batch so health checks and admission
  // logic reflect executable work only.
  const expired = await ctx.db.query("liquidityConversations")
    .withIndex("by_active_expiry", q => q.eq("active", true).lte("expiresAt", Date.now())).take(50);
  for (const conversation of expired) {
    await ctx.db.patch(conversation._id, { active: false, updatedAt: Date.now() });
    if (conversation.currentTurnId) {
      const turn = await ctx.db.get(conversation.currentTurnId);
      if (turn?.status === "processing") await ctx.db.patch(turn._id, { status: "cancelled", response: R.expired });
    }
  }
  // Recover only final-result delivery. Never re-enter wallet execution for a
  // completed action, and never backfill pre-outbox historical results.
  const deliveries = await ctx.db.query("liquidityExecutions")
    .withIndex("by_delivery_due", q => q.eq("deliveryStatus", "pending").lte("deliveryNextAttemptAt", Date.now())).take(10);
  for (const e of deliveries) await ctx.scheduler.runAfter(0, internal.liquidity.deliverExecution, { executionId: e._id });
} });
export const execute = internalAction({
  args: { executionId: v.id("liquidityExecutions") },
  handler: async (ctx, args) => {
    let context = await ctx.runQuery(internal.liquidity.executionContext, args);
    if (!context?.wallet || !context.conversation || !context.turn || !liquidityOwnerAllowed(context.execution.ownerXUserId, context.conversation.source) || ["confirmed", "failed"].includes(context.execution.status) || !liquidityRecoveryDue(context.execution, Date.now())) return;
    const requestId = `liquidity:${args.executionId}`, leaseToken = crypto.randomUUID(), walletId = context.wallet._id;
    if (!await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, { walletId, requestId, leaseToken })) {
      await ctx.runMutation(internal.liquidity.deferExecution, { ...args, stage: "wallet_lock", diagnostic: "LP_WALLET_BUSY", readOnly: context.execution.status === "manual_review" }); return;
    }
    // A duplicate scheduled invocation may have read state before acquiring
    // the lock. Re-read under the shared wallet lock before preparing anything.
    context = await ctx.runQuery(internal.liquidity.executionContext, args);
    if (!context?.wallet || !context.conversation || !context.turn || !liquidityOwnerAllowed(context.execution.ownerXUserId, context.conversation.source)
      || context.wallet.ownerXUserId !== context.execution.ownerXUserId || context.conversation.ownerXUserId !== context.execution.ownerXUserId || context.turn.ownerXUserId !== context.execution.ownerXUserId
      || !liquidityWalletAllowed(context.execution.ownerXUserId, context.wallet.address)
      || ["confirmed", "failed"].includes(context.execution.status) || !liquidityRecoveryDue(context.execution, Date.now())) {
      await ctx.runMutation(internal.wallets.releaseWalletExecutionLock, { walletId, requestId, leaseToken }); return;
    }
    let plan = JSON.parse(context.execution.planJson) as LiquidityQuotePlan;
    const steps = JSON.parse(context.execution.stepsJson) as SignedStep[];
    const readOnly = context.execution.status === "manual_review";
    let stage = "prepare";
    try {
      await ctx.runMutation(internal.liquidity.executionHeartbeat, { ...args, stage });
      // Reconcile each collection independently. A restart must never collect
      // again just because its payout lookup failed after the receipt arrived.
      for (let i = 0; i < steps.length; i++) if (steps[i].confirmed && plan.calls[i]?.purpose === "claim" && !steps[i].received) {
        stage = "reconcile_position";
        const payout = validateLiquidityFinalReceipt(await signer("/v1/liquidity/receipt", { transactionHash: steps[i].transactionHash, plan, step: i }), "claim");
        if (payout.status !== "confirmed") throw new Error("LIQUIDITY_RECEIPT_FAILED");
        steps[i].received = payout.received ?? [];
        await ctx.runMutation(internal.liquidity.persistSteps, { ...args, stepsJson: JSON.stringify(steps) });
      }
      stage = "prepare";
      const index = steps.findIndex(s => !s.confirmed), stepIndex = index < 0 ? steps.length : index;
      if (stepIndex < plan.calls.length) {
        if (!steps[stepIndex]) {
          if (readOnly) throw new Error("LP_MANUAL_REVIEW_REQUIRED");
          if (!liquidityExecutionWindowOpen(plan, Date.now()) || stepIndex === 0 && Date.now() >= plan.expiresAt) throw new Error("LIQUIDITY_QUOTE_EXPIRED");
          if (context.wallet.status !== "active") throw new Error("Wallet is not active");
          // Funding and approvals may move or outlive the selected pool price.
          // Rebuild only the unsent final open, preserving all user-selected
          // settings and all already-confirmed transactions.
          if (plan.operation === "open" && stepIndex === plan.calls.length - 1 && plan.requestedBudgetUsd && plan.bandWeights?.length) {
            stage = "reprice_open";
            const refreshed = validateLiquidityOpenRefresh(plan, await signer("/v1/liquidity/refresh-open", {
              ownerXUserId: context.execution.ownerXUserId, source: context.conversation.source,
              walletRef: context.wallet.signerWalletRef, expectedFrom: context.wallet.address, plan, step: stepIndex,
              confirmedTransactions: steps.map(step => step.transactionHash),
            }, 45_000));
            plan = await ctx.runMutation(internal.liquidity.replaceOpenPlan, { ...args, expectedProof: plan.proof, stepIndex, planJson: JSON.stringify(refreshed) });
          }
          const minimumNonce = steps.length > 0 ? steps.at(-1)!.nonce + 1 : 0;
          await requireExecutionWrites(ctx);
          const idempotencyKey = liquidityStepIdempotencyKey(requestId, stepIndex, context.execution.openRecoveryCount);
          const envelope = validateLiquidityEnvelope(await signer("/v1/liquidity/prepare-envelope", { ownerXUserId: context.execution.ownerXUserId, source: context.conversation.source, walletRef: context.wallet.signerWalletRef, plan, step: stepIndex, idempotencyKey, ...(steps.length > 0 ? { minimumNonce, minimumBlock: steps.at(-1)!.blockNumber } : {}) }), plan, stepIndex, minimumNonce);
          steps[stepIndex] = { toAddress: envelope.toAddress, valueWei: envelope.valueWei, nonce: envelope.nonce, envelope };
          await ctx.runMutation(internal.liquidity.persistSteps, { ...args, stepsJson: JSON.stringify(steps) });
        }
        const step = steps[stepIndex];
        if (!step.signedTransaction) {
          if (readOnly) throw new Error("LP_MANUAL_REVIEW_REQUIRED");
          if (!liquidityExecutionWindowOpen(plan, Date.now())) throw new Error("LP_EXPIRED_ENVELOPE_REQUIRES_REVIEW");
          stage = "sign";
          const envelope = validateLiquidityEnvelope(step.envelope, plan, stepIndex, stepIndex > 0 ? steps[stepIndex - 1].nonce + 1 : 0);
          await requireExecutionWrites(ctx);
          const idempotencyKey = liquidityStepIdempotencyKey(requestId, stepIndex, context.execution.openRecoveryCount);
          const signed = await validateLiquiditySignature(await signer("/v1/liquidity/sign-envelope", { ownerXUserId: context.execution.ownerXUserId, source: context.conversation.source, walletRef: context.wallet.signerWalletRef, plan, step: stepIndex, idempotencyKey, envelope }), envelope, context.wallet.address);
          Object.assign(step, signed);
          await ctx.runMutation(internal.liquidity.persistSteps, { ...args, stepsJson: JSON.stringify(steps) });
        }
        stage = "receipt";
        // Reconcile the exact saved envelope before any rebroadcast or next step.
        const c = (await import("../lib/liquidity-markets")).liquidityRpc();
        let receipt;
        try { receipt = await c.getTransactionReceipt({ hash: step.transactionHash as `0x${string}` }); }
        catch (error) {
          // A timeout/429/bad response is NOT evidence that a transaction is
          // absent. Keep the signed bytes and retry reads before any broadcast.
          if (!(error instanceof TransactionReceiptNotFoundError)) throw new Error("LP_RECEIPT_RPC_UNAVAILABLE");
        }
        if (receipt && (!["success", "reverted"].includes(receipt.status) || typeof receipt.blockNumber !== "bigint"
          || receipt.transactionHash?.toLowerCase() !== step.transactionHash?.toLowerCase()
          || receipt.from?.toLowerCase() !== context.wallet.address.toLowerCase()
          || receipt.to?.toLowerCase() !== step.toAddress.toLowerCase())) throw new Error("LP_RECEIPT_RPC_INVALID");
        if (!receipt) {
          let transaction;
          try { transaction = await c.getTransaction({ hash: step.transactionHash as `0x${string}` }); }
          catch (error) { if (!(error instanceof TransactionNotFoundError)) throw new Error("LP_TRANSACTION_RPC_UNAVAILABLE"); }
          if (transaction) {
            await ctx.runMutation(internal.liquidity.deferExecution, { ...args, stage: "receipt", diagnostic: transaction.blockNumber == null ? "LP_TRANSACTION_PENDING" : "LP_RECEIPT_INDEXING", readOnly: false }); return;
          }
          if (readOnly) throw new Error("LP_PENDING_TRANSACTION_REQUIRES_REVIEW");
          // Approvals and Delta collect/close calls have no on-chain deadline.
          // A saved signature is not permission to broadcast stale instructions.
          if (!liquidityExecutionWindowOpen(plan, Date.now())) throw new Error("LP_EXPIRED_ENVELOPE_REQUIRES_REVIEW");
          stage = "broadcast";
          await requireExecutionWrites(ctx);
          await signer("/v1/transactions/broadcast", { chainId: 4663, ownerReference: `x:${context.execution.ownerXUserId}`, walletRef: context.wallet.signerWalletRef, operationType: `liquidity_${plan.operation}`, signedTransaction: step.signedTransaction, transactionHash: step.transactionHash, expectedFrom: context.wallet.address, expectedTo: step.toAddress, expectedValueWei: step.valueWei });
          await ctx.runMutation(internal.liquidity.deferExecution, { ...args, stage: "receipt", diagnostic: "LP_AWAITING_RECEIPT", readOnly: false }); return;
        }
        if (receipt.status !== "success") {
          step.reverted = true;
          await ctx.runMutation(internal.liquidity.persistSteps, { ...args, stepsJson: JSON.stringify(steps) });
          // Funding remains in the user's wallet after a reverted final open.
          // Reprice and retry that final call once, using a fresh nonce and no
          // additional purchase, wrap or approval. A second revert remains a
          // terminal failure instead of becoming an unbounded spend loop.
          if (plan.operation === "open" && stepIndex === plan.calls.length - 1 && liquidityExecutionWindowOpen(plan, Date.now())
            && await ctx.runMutation(internal.liquidity.retryRevertedOpen, args)) {
            await ctx.scheduler.runAfter(0, internal.liquidity.execute, args);
            return;
          }
          throw new Error("LIQUIDITY_TRANSACTION_REVERTED");
        }
        step.confirmed = true; step.blockNumber = receipt.blockNumber.toString();
        await ctx.runMutation(internal.liquidity.persistSteps, { ...args, stepsJson: JSON.stringify(steps) });
        if (plan.calls[stepIndex].purpose === "claim") {
          stage = "reconcile_position";
          const payout = validateLiquidityFinalReceipt(await signer("/v1/liquidity/receipt", { transactionHash: step.transactionHash, plan, step: stepIndex }), "claim");
          if (payout.status !== "confirmed") throw new Error("LIQUIDITY_RECEIPT_FAILED");
          step.received = payout.received ?? [];
          await ctx.runMutation(internal.liquidity.persistSteps, { ...args, stepsJson: JSON.stringify(steps) });
        }
        if (steps.length < plan.calls.length) {
          if (readOnly) await ctx.runMutation(internal.liquidity.deferExecution, { ...args, stage: "next_step_requires_review", diagnostic: "LP_MANUAL_REVIEW_REQUIRED", readOnly: true });
          else await ctx.scheduler.runAfter(0, internal.liquidity.execute, args);
          return;
        }
      }
      stage = "reconcile_position";
      const final = steps.at(-1)!.received ? { status: "confirmed" as const, legs: [], received: [], deposited: undefined, depositedUsd: undefined }
        : validateLiquidityFinalReceipt(await signer("/v1/liquidity/receipt", { transactionHash: steps.at(-1)!.transactionHash, plan }), plan.operation);
      if (final.status !== "confirmed") throw new Error("LIQUIDITY_RECEIPT_FAILED");
      const received = [...steps.flatMap((s, i) => (s.received ?? []).map(amount => `${plan.claimPositions?.[i]?.positionId ?? "LP fees"}: ${amount}`)), ...(final.received ?? []).map(amount => plan.operation === "withdraw" ? `Withdrawal: ${amount}` : amount)];
      await ctx.runMutation(internal.liquidity.finishExecution, { ...args, success: true, legsJson: JSON.stringify(final.legs), transactionHash: steps.at(-1)!.transactionHash, received,
        ...(final.deposited ? { deposited: final.deposited, depositedUsd: final.depositedUsd } : {}) });
    } catch (error) {
      // A signed envelope with an unknown outcome keeps its nonce reservation.
      // It is never treated as a fresh quote/second purchase on retry.
      const diagnostic = liquidityDiagnostic(error, "LP_EXECUTION_FAILED");
      const uncertain = steps.some(s => !s.confirmed && !s.reverted);
      const settledDeposit = stage === "reconcile_position";
      const permanent = /LIQUIDITY_QUOTE_EXPIRED|INSUFFICIENT|LP_POSITION_|LP_WALLET_INACTIVE|LIQUIDITY_TRANSACTION_REVERTED/.test(diagnostic);
      if (uncertain || settledDeposit || !permanent && (context.execution.retryCount ?? 0) < LIQUIDITY_WRITE_ATTEMPTS - 1) {
        await ctx.runMutation(internal.liquidity.deferExecution, { ...args, stage, diagnostic, readOnly: settledDeposit || diagnostic === "LP_EXECUTION_DISABLED" });
      } else await ctx.runMutation(internal.liquidity.finishExecution, { ...args, success: false, legsJson: "[]", diagnostic });
    } finally {
      // The persisted pending envelope is additionally checked by the shared
      // wallet lock; no unrelated action can take its nonce between jobs.
      await ctx.runMutation(internal.wallets.releaseWalletExecutionLock, { walletId, requestId, leaseToken });
    }
  },
});
export const finishExecution = internalMutation({
  args: { executionId: v.id("liquidityExecutions"), success: v.boolean(), legsJson: v.string(), transactionHash: v.optional(v.string()), diagnostic: v.optional(v.string()), received: v.optional(v.array(v.string())),
    deposited: v.optional(v.array(v.object({ symbol: v.string(), amount: v.string(), usd: v.number() }))), depositedUsd: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const e = await ctx.db.get(args.executionId); if (!e || ["confirmed", "failed"].includes(e.status)) return;
    const conversation = await ctx.db.get(e.conversationId); if (!conversation) return;
    const d = liquidityDraftSchema.parse(JSON.parse(conversation.stateJson)), plan = JSON.parse(e.planJson) as LiquidityQuotePlan;
    const steps = JSON.parse(e.stepsJson) as SignedStep[];
    const claimsByPosition = new Map<string, LiquidityClaimedFee[]>();
    for (let index = 0; index < steps.length; index++) {
      if (!steps[index].confirmed || plan.calls[index]?.purpose !== "claim") continue;
      const claimedPositionId = plan.claimPositions?.[index]?.positionId;
      if (!claimedPositionId) continue;
      const parsed = (steps[index].received ?? []).map(parseLiquidityClaimedFee).filter((fee): fee is LiquidityClaimedFee => Boolean(fee));
      if (parsed.length) claimsByPosition.set(claimedPositionId, [...(claimsByPosition.get(claimedPositionId) ?? []), ...parsed]);
    }
    let positionId = d.fields.position;
    if (args.success && (d.operation === "open" || d.operation === "add")) {
      const existing = positionId ? await ctx.db.query("liquidityManagedPositions").withIndex("by_public_id", q => q.eq("publicId", positionId!)).unique() : null;
      if (existing && existing.ownerXUserId !== e.ownerXUserId) throw new Error("Position owner mismatch");
      if (existing && (existing.version !== plan.version || existing.poolId.toLowerCase() !== plan.poolId.toLowerCase() || existing.token.toLowerCase() !== plan.token.toLowerCase())) throw new Error("LP_POSITION_SETTINGS_CONFLICT");
      if (d.operation === "add" && !existing) throw new Error("LP_POSITION_MISSING");
      if (existing) {
        const legs = [...new Map(( [...JSON.parse(existing.legsJson), ...JSON.parse(args.legsJson)] as LiquidityLeg[]).map(l => [l.tokenId, l])).values()];
        if (legs.length > 100) throw new Error("LP_POSITION_CAPACITY");
        await ctx.db.patch(existing._id, { legsJson: JSON.stringify(legs), updatedAt: Date.now() });
      }
      else {
        for (let attempt = 0; ; attempt++) {
          positionId = `LP-${keccak256(stringToHex(`${e._id}:${attempt}`)).slice(2, 10).toUpperCase()}`;
          if (!await ctx.db.query("liquidityManagedPositions").withIndex("by_public_id", q => q.eq("publicId", positionId!)).first()) break;
        }
        await ctx.db.insert("liquidityManagedPositions", { publicId: positionId, ownerXUserId: e.ownerXUserId, walletId: e.walletId, version: plan.version, token: plan.token, symbol: plan.symbol, poolId: plan.poolId, fieldsJson: JSON.stringify(d.fields), legsJson: args.legsJson, autoCompoundRequested: false, status: "active", createdAt: Date.now(), updatedAt: Date.now() });
      }
    } else if (args.success && d.operation === "withdraw" && positionId) {
      const existing = await ctx.db.query("liquidityManagedPositions").withIndex("by_public_id", q => q.eq("publicId", positionId!)).unique();
      if (existing?.ownerXUserId === e.ownerXUserId) await ctx.db.patch(existing._id, { status: "closed", autoCompoundRequested: false, updatedAt: Date.now() });
    }
    const historicalClaims = new Map<string, LiquidityClaimedFee[]>();
    if (args.success && claimsByPosition.size) {
      const priorExecutions = await ctx.db.query("liquidityExecutions").withIndex("by_owner_updated", q => q.eq("ownerXUserId", e.ownerXUserId)).order("desc").take(500);
      for (const prior of priorExecutions) {
        if (prior._id === e._id || prior.status !== "confirmed") continue;
        try {
          const priorPlan = JSON.parse(prior.planJson) as LiquidityQuotePlan, priorSteps = JSON.parse(prior.stepsJson) as SignedStep[];
          for (let index = 0; index < priorSteps.length; index++) {
            if (priorPlan.calls[index]?.purpose !== "claim") continue;
            const priorPositionId = priorPlan.claimPositions?.[index]?.positionId;
            if (!priorPositionId || !claimsByPosition.has(priorPositionId)) continue;
            const parsed = (priorSteps[index].received ?? []).map(parseLiquidityClaimedFee).filter((fee): fee is LiquidityClaimedFee => Boolean(fee));
            historicalClaims.set(priorPositionId, mergeLiquidityClaimedFees(historicalClaims.get(priorPositionId) ?? [], parsed));
          }
        } catch { /* A malformed historical row must not block a confirmed claim. */ }
      }
    }
    if (args.success) for (const [claimedPositionId, claimed] of claimsByPosition) {
      const claimedPosition = await ctx.db.query("liquidityManagedPositions").withIndex("by_public_id", q => q.eq("publicId", claimedPositionId)).unique();
      if (!claimedPosition || claimedPosition.ownerXUserId !== e.ownerXUserId) continue;
      let previous: LiquidityClaimedFee[] = [];
      try { previous = claimedPosition.feesClaimedJson ? JSON.parse(claimedPosition.feesClaimedJson) as LiquidityClaimedFee[] : historicalClaims.get(claimedPositionId) ?? []; } catch { previous = historicalClaims.get(claimedPositionId) ?? []; }
      const now = Date.now();
      await ctx.db.patch(claimedPosition._id, { feesClaimedJson: JSON.stringify(mergeLiquidityClaimedFees(previous, claimed)),
        lastClaimedJson: JSON.stringify(claimed), lastClaimedAt: now, updatedAt: now });
    }
    const claimLinks = plan.claimPositions ? steps.map((s, i) => `${plan.claimPositions![i].positionId} TXN: https://robinhoodchain.blockscout.com/tx/${s.transactionHash}`).join("\n\n") : undefined;
    const successTitle = d.operation === "claim" ? "Delta Liquidity LP fee collection confirmed"
      : d.operation === "withdraw" ? "Delta Liquidity LP fees collected and position withdrawn"
      : d.operation === "add" ? "Delta Liquidity position opened" : "Delta Liquidity position opened";
    const completionDetails = d.operation === "open" || d.operation === "add"
      ? liquidityOpenedDetails(d, args.deposited, args.depositedUsd, plan.requestedBudgetUsd, plan.partialReprice)
      : args.received?.length ? [`Received: ${args.received.join(", ")}`] : [];
    const completionGuidance = liquidityCompletionGuidance(d.operation, positionId);
    const successMessage = [
      `✅ ${positionId || "Liquidity"}: ${successTitle}!`, "",
      ...completionDetails,
      ...(completionGuidance ? ["", completionGuidance] : []),
      "", claimLinks ?? `TXN: https://robinhoodchain.blockscout.com/tx/${args.transactionHash}`,
    ].join("\n");
    const message = args.success
      ? conversation.source === "x"
        ? withGuidedHelpCompletion(successMessage)
        : successMessage
      : steps.some((s, i) => s.confirmed && plan.calls[i]?.purpose === "claim")
        ? `⚠️ Some LP fees were collected, but the remaining request did not complete. Already-collected fees are in your wallet.\n\nCompleted collections:\n\n${steps.flatMap((s, i) => s.confirmed && plan.calls[i]?.purpose === "claim" ? [`${plan.claimPositions?.[i]?.positionId ?? positionId ?? "LP fees"}: ${(s.received ?? []).join(", ")} TXN: https://robinhoodchain.blockscout.com/tx/${s.transactionHash}`] : []).join("\n\n")}`
      : steps.some((step, index) => step.confirmed && ["funding_buy", "funding_usdg_to_eth", "funding_wrap"].includes(plan.calls[index]?.purpose))
        ? liquidityFundingFailureMessage(plan, steps)
      : steps.some(s => s.confirmed) ? "⚠️ The liquidity request stopped after some steps completed. Earlier approvals or wrapping may have succeeded; the failed step was not repeated. Check your wallet before retrying."
        : "❌ The liquidity request failed before any step confirmed. Please request a new quote.";
    const positionIds = [...new Set([
      ...(plan.claimPositions?.map(position => position.positionId) ?? []),
      ...(positionId ? [positionId] : []),
    ])];
    await ctx.db.patch(e._id, { status: args.success ? "confirmed" : "failed", response: message, diagnostic: args.diagnostic,
      ...(positionIds.length ? { positionIds } : {}), updatedAt: Date.now(), deliveryStatus: "pending", deliveryAttempts: 0, deliveryNextAttemptAt: Date.now() });
    await ctx.db.patch(conversation._id, { active: false, updatedAt: Date.now() });
    const resultTurnId = e.turnId ?? conversation.currentTurnId;
    if (resultTurnId) {
      const resultTurn = await ctx.db.get(resultTurnId);
      if (resultTurn?.conversationId === conversation._id && resultTurn.ownerXUserId === e.ownerXUserId)
        await ctx.db.patch(resultTurnId, { status: "ready", response: message });
    }
    await ctx.scheduler.runAfter(0, internal.liquidity.deliverExecution, { executionId: e._id });
  },
});

export const operatorRecoveryContext = internalQuery({ args: { executionId: v.id("liquidityExecutions"), confirmPostId: v.string() }, handler: async (ctx, args) => {
  const execution = await ctx.db.get(args.executionId); if (!execution) throw new Error("Missing liquidity execution");
  const conversation = await ctx.db.get(execution.conversationId), turnId = execution.turnId ?? conversation?.currentTurnId;
  const turn = turnId ? await ctx.db.get(turnId) : null;
  if (!conversation || !turn || turn.conversationId !== conversation._id || turn.requestKey !== `x:${args.confirmPostId}`
    || conversation.ownerXUserId !== execution.ownerXUserId || turn.ownerXUserId !== execution.ownerXUserId) throw new Error("Recovery binding mismatch");
  const wallet = await ctx.db.get(execution.walletId);
  if (!wallet || wallet.ownerXUserId !== execution.ownerXUserId || wallet.status !== "active") throw new Error("Recovery wallet mismatch");
  return { execution, conversation, turn, wallet };
} });

// Operator supplies only an execution and replacement hash. The signer reads
// the chain and verifies the receipt against the already-authorized plan; no
// caller-supplied NFT, calldata, block, or deposit facts are trusted.
export const operatorRecoverFailedOpen = action({
  args: { secret: v.string(), executionId: v.id("liquidityExecutions"), transactionHash: v.string(), confirmPostId: v.string(), replacementPlanJson: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ positionId: string; response?: string; idempotent: boolean }> => {
    if (!process.env.WEB_AUTH_SECRET || args.secret !== process.env.WEB_AUTH_SECRET) throw new Error("Operator authorization failed");
    if (!/^0x[a-fA-F0-9]{64}$/.test(args.transactionHash)) throw new Error("Invalid recovery transaction hash");
    const context = await ctx.runQuery(internal.liquidity.operatorRecoveryContext, { executionId: args.executionId, confirmPostId: args.confirmPostId });
    const draft = liquidityDraftSchema.parse(JSON.parse(context.conversation.stateJson));
    const original = validateLiquidityQuote(JSON.parse(context.execution.planJson), { owner: context.wallet.address, draft, legs: [] });
    const plan = args.replacementPlanJson
      ? validateLiquidityOpenRefresh(original, validateLiquidityQuote(JSON.parse(args.replacementPlanJson), { owner: context.wallet.address, draft, legs: [] }))
      : original;
    const receipt = validateLiquidityFinalReceipt(await signer("/v1/liquidity/receipt", {
      transactionHash: args.transactionHash, plan, step: plan.calls.length - 1,
    }), plan.operation);
    if (receipt.status !== "confirmed" || !receipt.blockNumber || !receipt.legs.length) throw new Error("Replacement liquidity transaction is not confirmed");
    return ctx.runMutation(internal.liquidity.recordOperatorRecoveredOpen, {
      executionId: args.executionId, transactionHash: args.transactionHash, blockNumber: receipt.blockNumber,
      legsJson: JSON.stringify(receipt.legs), confirmPostId: args.confirmPostId,
      ...(args.replacementPlanJson ? { replacementPlanJson: JSON.stringify(plan) } : {}),
      ...(receipt.deposited ? { depositedJson: JSON.stringify(receipt.deposited) } : {}), ...(receipt.depositedUsd ? { depositedUsd: receipt.depositedUsd } : {}),
    });
  },
});

export const recordOperatorRecoveredOpen = internalMutation({
  args: {
    executionId: v.id("liquidityExecutions"), transactionHash: v.string(),
    blockNumber: v.string(), legsJson: v.string(), confirmPostId: v.string(),
    depositedJson: v.optional(v.string()), depositedUsd: v.optional(v.number()), replacementPlanJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!/^0x[a-fA-F0-9]{64}$/.test(args.transactionHash) || !/^\d+$/.test(args.blockNumber)) throw new Error("Invalid recovery receipt");
    const execution = await ctx.db.get(args.executionId); if (!execution) throw new Error("Missing liquidity execution");
    const conversation = await ctx.db.get(execution.conversationId), turnId = execution.turnId ?? conversation?.currentTurnId;
    const turn = turnId ? await ctx.db.get(turnId) : null;
    if (!conversation || !turn || turn.conversationId !== conversation._id || turn.requestKey !== `x:${args.confirmPostId}`
      || conversation.ownerXUserId !== execution.ownerXUserId || turn.ownerXUserId !== execution.ownerXUserId) throw new Error("Recovery binding mismatch");
    const existingPosition = await ctx.db.query("liquidityManagedPositions").withIndex("by_owner", q => q.eq("ownerXUserId", execution.ownerXUserId)).collect()
      .then(rows => rows.find(row => JSON.parse(row.legsJson).some((leg: LiquidityLeg) => leg.tokenId && args.legsJson.includes(`\"tokenId\":\"${leg.tokenId}\"`))));
    if (execution.status === "confirmed" && existingPosition) return { positionId: existingPosition.publicId, response: execution.response, idempotent: true };
    if (execution.status !== "failed" || !["SIMULATION_OR_REVERT", "LIQUIDITY_TRANSACTION_REVERTED"].includes(execution.diagnostic ?? "")) throw new Error("Execution is not eligible for recovery");
    const draft = liquidityDraftSchema.parse(JSON.parse(conversation.stateJson));
    const originalPlan = JSON.parse(execution.planJson) as LiquidityQuotePlan;
    const plan = args.replacementPlanJson ? validateLiquidityOpenRefresh(originalPlan, JSON.parse(args.replacementPlanJson)) : originalPlan;
    const steps = JSON.parse(execution.stepsJson) as SignedStep[];
    const finalAttempt = steps[plan.calls.length - 1], confirmedPrefix = steps.slice(0, plan.calls.length - 1);
    if (draft.operation !== "open" || plan.operation !== "open" || ![plan.calls.length - 1, plan.calls.length].includes(steps.length)
      || confirmedPrefix.some((step, index) => !step.confirmed || !step.transactionHash || step.reverted
        || !["funding_wrap", "funding_buy", "funding_usdg_to_eth", "approval", "approval_reset", "initialize"].includes(plan.calls[index]?.purpose))
      || (finalAttempt && (!finalAttempt.reverted || finalAttempt.confirmed || !finalAttempt.transactionHash))) throw new Error("Recovery prerequisite mismatch");
    const openData = plan.calls.at(-1)?.data;
    if (!openData) throw new Error("Recovery plan has no open call");
    const decoded = decodeFunctionData({ abi: deltaLiquidityAbi, data: openData as `0x${string}` });
    const recoveredPool = decoded.functionName === "openV4" ? liquidityPoolId(decoded.args[0])
      : decoded.functionName === "openV3" ? decoded.args[0].toLowerCase() : null;
    if (!recoveredPool || plan.version !== (decoded.functionName === "openV4" ? 4 : 3) || recoveredPool !== plan.poolId.toLowerCase()
      || plan.calls.at(-1)?.purpose !== "open" || plan.calls.at(-1)?.to.toLowerCase() !== "0x5ca6214227d1195c4b7b4b96847b8966c688295d") throw new Error("Recovered open differs from the authorized pool");
    const recoveredBands = decoded.functionName === "openV3" || decoded.functionName === "openV4" ? decoded.args[1] : [];
    const legs = JSON.parse(args.legsJson) as LiquidityLeg[];
    if (!Array.isArray(legs) || legs.length !== recoveredBands.length || legs.length < 1 || legs.length > 20
      || new Set(legs.map(leg => leg.tokenId)).size !== legs.length
      || legs.some((leg, index) => !/^\d+$/.test(leg.tokenId) || !/^\d+$/.test(leg.liquidity) || BigInt(leg.liquidity) <= 0n
        || leg.tickLower !== recoveredBands[index]?.tickLower || leg.tickUpper !== recoveredBands[index]?.tickUpper
        || (decoded.functionName === "openV4" && BigInt(leg.liquidity) !== decoded.args[1][index]!.liquidity))) throw new Error("Recovered NFT bands do not match the open call");
    const deposited = args.depositedJson ? JSON.parse(args.depositedJson) as Array<{ symbol: string; amount: string; usd: number }> : undefined;
    if (deposited && (!Array.isArray(deposited) || deposited.length !== 2 || deposited.some(asset => !/^[A-Za-z0-9_.-]{1,32}$/.test(asset.symbol)
      || !/^\d+(?:\.\d+)?$/.test(asset.amount) || !Number.isFinite(asset.usd) || asset.usd < 0))) throw new Error("Invalid recovered deposit details");
    if (args.depositedUsd !== undefined && (!Number.isFinite(args.depositedUsd) || args.depositedUsd <= 0)) throw new Error("Invalid recovered deposit value");
    let positionId: string;
    for (let attempt = 0; ; attempt++) {
      positionId = `LP-${keccak256(stringToHex(`${execution._id}:${attempt}`)).slice(2, 10).toUpperCase()}`;
      if (!await ctx.db.query("liquidityManagedPositions").withIndex("by_public_id", q => q.eq("publicId", positionId)).first()) break;
    }
    await ctx.db.insert("liquidityManagedPositions", { publicId: positionId, ownerXUserId: execution.ownerXUserId, walletId: execution.walletId,
      version: plan.version, token: plan.token, symbol: plan.symbol, poolId: plan.poolId, fieldsJson: JSON.stringify(draft.fields), legsJson: JSON.stringify(legs),
      autoCompoundRequested: false, status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    const recoveredPlan = plan;
    const revertedHistory = execution.revertedOpenStepsJson ? JSON.parse(execution.revertedOpenStepsJson) as SignedStep[] : [];
    if (finalAttempt) revertedHistory.push(finalAttempt);
    const recoveredSteps = [...confirmedPrefix, { transactionHash: args.transactionHash, signedTransaction: "operator-verified-on-chain-recovery", toAddress: plan.calls.at(-1)!.to,
      valueWei: plan.calls.at(-1)!.value, nonce: finalAttempt?.nonce ?? (confirmedPrefix.at(-1)!.nonce + 1), confirmed: true, blockNumber: args.blockNumber }];
    const response = [
      `✅ ${positionId}: Delta Liquidity position opened!`, "", ...liquidityOpenedDetails(draft, deposited, args.depositedUsd,
        plan.requestedBudgetUsd, Boolean(plan.partialReprice)),
      "", liquidityCompletionGuidance("open", positionId), "", `TXN: https://robinhoodchain.blockscout.com/tx/${args.transactionHash}`,
    ].join("\n");
    await ctx.db.patch(execution._id, { planJson: JSON.stringify(recoveredPlan), stepsJson: JSON.stringify(recoveredSteps),
      ...(revertedHistory.length ? { revertedOpenStepsJson: JSON.stringify(revertedHistory) } : {}), status: "confirmed", stage: "recovered_open", positionIds: [positionId],
      diagnostic: "LP_RECOVERED_AFTER_REPRICE", response, retryCount: execution.retryCount, nextAttemptAt: undefined, leaseUntil: undefined,
      deliveryStatus: "handed_off", deliveryNextAttemptAt: undefined, deliveryDiagnostic: "LP_RECOVERY_REPLY_QUEUED", updatedAt: Date.now() });
    await ctx.db.patch(conversation._id, { active: false, updatedAt: Date.now() });
    await ctx.db.patch(turn._id, { status: "ready", response });
    await ctx.scheduler.runAfter(0, internal.xReplies.publishLiquidityRecoveryOutcome, { postId: args.confirmPostId, text: response, executionId: execution._id });
    return { positionId, response, idempotent: false };
  },
});
const DELIVERY_ATTEMPTS = 12;
export const reserveDelivery = internalMutation({ args: { executionId: v.id("liquidityExecutions") }, handler: async (ctx, args) => {
  const e = await ctx.db.get(args.executionId);
  if (!e || !["confirmed", "failed"].includes(e.status) || e.deliveryStatus !== "pending" || !e.response
    || (e.deliveryNextAttemptAt ?? Infinity) > Date.now()) return null;
  const conversation = await ctx.db.get(e.conversationId);
  if (!conversation || conversation.ownerXUserId !== e.ownerXUserId || !liquidityOwnerAllowed(e.ownerXUserId, conversation.source)) return null;
  const attempt = (e.deliveryAttempts ?? 0) + 1;
  if (attempt > DELIVERY_ATTEMPTS) {
    await ctx.db.patch(e._id, { deliveryStatus: "manual_review", deliveryNextAttemptAt: undefined, deliveryDiagnostic: "LP_RESULT_DELIVERY_EXHAUSTED" }); return null;
  }
  // Also a lease: duplicate scheduled actions cannot deliver concurrently.
  await ctx.db.patch(e._id, { deliveryAttempts: attempt, deliveryNextAttemptAt: Date.now() + 180_000 });
  return attempt;
} });
export const settleDelivery = internalMutation({ args: { executionId: v.id("liquidityExecutions"), attempt: v.number(), handedOff: v.boolean() }, handler: async (ctx, args) => {
  const e = await ctx.db.get(args.executionId);
  if (!e || e.deliveryStatus !== "pending" || e.deliveryAttempts !== args.attempt) return;
  const exhausted = args.attempt >= DELIVERY_ATTEMPTS, delay = Math.min(15 * 60_000, 60_000 * 2 ** (args.attempt - 1));
  await ctx.db.patch(e._id, { deliveryStatus: args.handedOff ? "handed_off" : exhausted ? "manual_review" : "pending",
    deliveryNextAttemptAt: args.handedOff || exhausted ? undefined : Date.now() + delay,
    deliveryDiagnostic: args.handedOff ? undefined : exhausted ? "LP_RESULT_DELIVERY_EXHAUSTED" : "LP_RESULT_DELIVERY_RETRY" });
  if (!args.handedOff && !exhausted) await ctx.scheduler.runAfter(delay, internal.liquidity.deliverExecution, { executionId: e._id });
} });
export const deliverExecution = internalAction({ args: { executionId: v.id("liquidityExecutions") }, handler: async (ctx, args) => {
  const attempt = await ctx.runMutation(internal.liquidity.reserveDelivery, args);
  if (attempt === null) return;
  let handedOff = false;
  try {
    const context = await ctx.runQuery(internal.liquidity.executionContext, args);
    if (context?.execution.response && context.conversation && context.turn) {
      if (context.conversation.source === "x") {
        if (!context.turn.requestKey.startsWith("x:")) throw new Error("LP_RESULT_SOURCE_MISMATCH");
        handedOff = await ctx.runAction(internal.xReplies.deliverLiquidityResult, { postId: context.turn.requestKey.slice(2), executionId: args.executionId });
      } else {
        if (!context.conversation.scope.startsWith("terminal:")) throw new Error("LP_RESULT_SOURCE_MISMATCH");
        await ctx.runMutation(internal.wallets.recordTerminalMessage, { sessionId: context.conversation.scope.slice("terminal:".length), ownerXUserId: context.execution.ownerXUserId, role: "assistant", messageType: "result", text: context.execution.response, requestId: `liquidity-result:${args.executionId}` });
        handedOff = true;
      }
    }
  } catch { /* Retry message delivery only; never persist provider bodies. */ }
  await ctx.runMutation(internal.liquidity.settleDelivery, { ...args, attempt, handedOff });
} });
