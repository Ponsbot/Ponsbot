import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { automatedFeeEngineConfiguration, automatedFeeProcessingAllowed, type AutomatedFeeEngineEnvironment } from "../lib/automated-fee-policy";
import { vaultClaimResponse, type VaultClaimOutcome } from "../lib/vault-claim-response";

export function requestedVaultClaimsEnabled() {
  return process.env.X_CRYPTO_EXECUTION_ENABLED === "true"
    && process.env.AUTOMATED_FEE_BOT_COMMANDS_ENABLED === "true"
    && automatedFeeProcessingAllowed(automatedFeeEngineConfiguration(process.env as AutomatedFeeEngineEnvironment));
}

async function selectVaults(ctx: QueryCtx | MutationCtx, wallet: Doc<"cryptoWallets">, token?: string) {
  const address = wallet.address.toLowerCase();
  const programs = token
    ? await ctx.db.query("automatedFeePrograms").withIndex("by_token", q => q.eq("normalizedTokenAddress", token.toLowerCase())).collect()
    : await ctx.db.query("automatedFeePrograms").withIndex("by_beneficiary", q => q.eq("normalizedBeneficiaryAddress", address)).collect();
  const eligible: Array<{ program: Doc<"automatedFeePrograms">; symbol: string }> = [];
  for (const p of programs) {
    if (!["enrolled", "paused"].includes(p.status) || p.privateTest || !p.launchId
      || p.distributionMode !== "wallet" || p.normalizedBeneficiaryAddress !== address) continue;
    const launch = await ctx.db.get(p.launchId);
    if (!launch?.publicPublished || launch.holderFeeSharing
      || launch.tokenAddress?.toLowerCase() !== p.normalizedTokenAddress
      || launch.creatorFeeRecipient?.toLowerCase() !== p.normalizedVaultAddress) continue;
    eligible.push({ program: p, symbol: launch.symbol });
  }
  // Account-wide classification even for a token-specific claim: the automatic
  // reminder must not imply that a user's legacy tokens no longer need claims.
  const owned = (await Promise.all([
    ctx.db.query("tokenLaunches").withIndex("by_owner_created_at", q => q.eq("ownerXUserId", wallet.ownerXUserId)).collect(),
    ctx.db.query("tokenLaunches").withIndex("by_creator_fee_recipient", q => q.eq("normalizedCreatorFeeRecipient", address)).collect(),
  ])).flat();
  const hasLegacy = owned.some(l => l.publicPublished && !l.holderFeeSharing && l.tokenAddress
    && (l.creatorFeeRecipient || l.creatorAddress)?.toLowerCase() === address);
  return { eligible, onlyV2: eligible.length > 0 && !hasLegacy };
}

export const requestedClaimEligibility = internalQuery({
  args: { walletId: v.id("cryptoWallets"), tokenAddress: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!requestedVaultClaimsEnabled()) return false;
    const wallet = await ctx.db.get(args.walletId);
    if (!wallet || wallet.status !== "active" || wallet.chainId !== 4663) return false;
    return (await selectVaults(ctx, wallet, args.tokenAddress)).eligible.length > 0;
  },
});

/** Admission happens once, only for newly-created, authenticated claim requests. */
export const prepareRequestedClaims = internalMutation({
  args: { requestId: v.string(), tokenAddress: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", q => q.eq("requestId", args.requestId)).unique();
    if (!request || request.kind !== "claim_fees" || request.vaultClaimVersion !== 1
      || request.vaultClaimPreparedAt || request.status !== "simulating" || request.transactionHash
      || !requestedVaultClaimsEnabled()) return;
    const wallet = await ctx.db.get(request.walletId);
    if (!wallet || wallet.status !== "active" || wallet.chainId !== 4663 || wallet.ownerXUserId !== request.ownerXUserId
      || wallet.ownerXUserId === process.env.X_BOT_USER_ID) throw new Error("vault claim wallet binding mismatch");
    const { eligible, onlyV2 } = await selectVaults(ctx, wallet, args.tokenAddress);
    if (!eligible.length) return;
    const now = Date.now();
    await ctx.db.patch(request._id, { vaultClaimPreparedAt: now, vaultClaimOnlyV2: onlyV2, updatedAt: now });
    for (const { program: p, symbol } of eligible) {
      const pair = /^0x0{40}$/i.test(p.pairTokenAddress) ? null : await ctx.db.query("tokenRegistry")
        .withIndex("by_normalized_address", q => q.eq("normalizedAddress", p.normalizedPairTokenAddress)).unique();
      const native = /^0x0{40}$/i.test(p.pairTokenAddress);
      const pairKnown = native || (pair && /^[A-Za-z0-9_]{1,32}$/.test(pair.symbol)
        && Number.isInteger(pair.decimals) && pair.decimals >= 0 && pair.decimals <= 255);
      // As with legacy claim-all, non-ETH pairs are requested individually.
      const unavailable = p.status !== "enrolled" || !pairKnown || (!args.tokenAddress && !native);
      const active = (await Promise.all((["reserved", "submitted", "uncertain", "deferred"] as const).map(status => ctx.db.query("automatedFeeRuns")
        .withIndex("by_program_status", q => q.eq("programId", p._id).eq("status", status)).first()))).find(Boolean);
      const join = !unavailable && active?.beneficiaryAddress.toLowerCase() === wallet.address.toLowerCase() ? active : null;
      await ctx.db.insert("automatedFeeClaimRequests", {
        requestId: request.requestId, programId: p._id, walletId: wallet._id, beneficiaryAddress: wallet.address.toLowerCase(),
        tokenSymbol: symbol, assetSymbol: native ? "ETH" : pair?.symbol ?? "paired asset", assetDecimals: native ? 18 : pair?.decimals ?? 0,
        status: unavailable ? "unavailable" : join ? "running" : "queued", runId: join?._id,
        reason: !args.tokenAddress && !native ? "claim_pair_individually" : unavailable ? "processing_unavailable" : undefined,
        createdAt: now, updatedAt: now,
      });
      if (!unavailable && !join) await ctx.db.patch(p._id, {
        workState: p.workState === "running" ? "running" : "waiting",
        workDueAt: now, updatedAt: now,
      });
    }
    await ctx.scheduler.runAfter(0, internal.automatedFeeQueue.dispatch, {});
  },
});

/** Re-check persisted wallet authorization under the same mutation as assessment
 * or run reservation. Reassignment/cancellation cannot leave a force flag behind. */
export async function liveRequestedClaims(ctx: MutationCtx, p: Doc<"automatedFeePrograms">, runId?: Id<"automatedFeeRuns">) {
  const rows = [
    ...await ctx.db.query("automatedFeeClaimRequests").withIndex("by_program_status", q => q.eq("programId", p._id).eq("status", "queued")).collect(),
    ...runId ? await ctx.db.query("automatedFeeClaimRequests").withIndex("by_program_status_run", q => q.eq("programId", p._id).eq("status", "running").eq("runId", runId)).collect() : [],
  ];
  const valid: Doc<"automatedFeeClaimRequests">[] = [];
  for (const r of rows) {
    if (r.runId && r.runId !== runId) continue;
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", q => q.eq("requestId", r.requestId)).unique();
    const wallet = await ctx.db.get(r.walletId);
    const authorized = request?.kind === "claim_fees" && request.vaultClaimVersion === 1 && request.status === "simulating"
      && request.walletId === r.walletId && wallet?.ownerXUserId === request.ownerXUserId && wallet.status === "active"
      && wallet.chainId === 4663 && wallet.address.toLowerCase() === r.beneficiaryAddress
      && p.normalizedBeneficiaryAddress === r.beneficiaryAddress && p.status === "enrolled" && p.distributionMode === "wallet";
    if (!authorized || (!r.runId && Date.now() - r.createdAt > 15 * 60_000)) {
      await ctx.db.patch(r._id, { status: "unavailable", reason: "authorization_changed_or_expired", updatedAt: Date.now() });
    } else valid.push(r);
  }
  return valid;
}

export async function attachRequestedClaims(ctx: MutationCtx, p: Doc<"automatedFeePrograms">, runId: Id<"automatedFeeRuns">) {
  for (const r of await liveRequestedClaims(ctx, p, runId)) {
    await ctx.db.patch(r._id, { status: "running", runId, updatedAt: Date.now() });
  }
}

export const requestedClaimResult = internalQuery({
  args: { requestId: v.string(), legacyMessage: v.optional(v.string()), ethUsd: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", q => q.eq("requestId", args.requestId)).unique();
    const claims = await ctx.db.query("automatedFeeClaimRequests").withIndex("by_request", q => q.eq("requestId", args.requestId)).collect();
    const outcomes: VaultClaimOutcome[] = [];
    let individualPairs = false;
    for (const r of claims) {
      if (r.walletId !== request?.walletId) throw new Error("vault claim result binding mismatch");
      const p = await ctx.db.get(r.programId);
      const run = r.runId ? await ctx.db.get(r.runId) : null;
      let state: VaultClaimOutcome["state"] = "pending";
      let amount = "0", ponsbotBurned: string | undefined, transactionHash: string | undefined;
      if (r.status === "no_fees") state = r.reason === "waiting_pons_operator" ? "operator" : "no_fees";
      else if (run && run.programId === r.programId && run.beneficiaryAddress.toLowerCase() === r.beneficiaryAddress && run.status === "confirmed") {
        if (run.deliveryBlockNumber && run.beneficiaryDelivered && run.beneficiaryDelivered === run.beneficiaryAllocated && BigInt(run.beneficiaryDelivered) > 0n) {
          state = "paid"; amount = run.beneficiaryDelivered; ponsbotBurned = run.ponsbotBurned;
          transactionHash = run.deliveryTransactionHash || run.processingTransactionHash;
        } else state = "no_fees";
      } else if (r.status === "unavailable" || !p || p.status !== "enrolled" || p.normalizedBeneficiaryAddress !== r.beneficiaryAddress
        || (run && (run.programId !== r.programId || run.beneficiaryAddress.toLowerCase() !== r.beneficiaryAddress || ["manual_review", "reverted"].includes(run.status)))
        || (!run && Date.now() - r.createdAt > 15 * 60_000) || !requestedVaultClaimsEnabled()) state = "unavailable";
      if (r.reason === "claim_pair_individually") { individualPairs = true; continue; }
      outcomes.push({ tokenSymbol: r.tokenSymbol, assetSymbol: r.assetSymbol, assetDecimals: r.assetDecimals,
        assetAddress: p?.normalizedPairTokenAddress, state, amount, ponsbotBurned, transactionHash });
    }
    const pending = outcomes.some(o => o.state === "pending");
    const noFees = outcomes.length > 0 && outcomes.every(o => o.state === "no_fees");
    const pairNote = individualPairs ? "Non-ETH-paired tokens must be claimed individually." : "";
    const message = vaultClaimResponse(outcomes, request?.vaultClaimOnlyV2 === true,
      [args.legacyMessage, pairNote].filter(Boolean).join("\n") || undefined, args.ethUsd);
    return { hasVaults: claims.length > 0, pending, noFees, paid: outcomes.some(o => o.state === "paid"),
      unavailable: outcomes.some(o => o.state === "unavailable"), message,
      transactionHash: outcomes.find(o => o.transactionHash)?.transactionHash };
  },
});

export const EMPTY_CLAIM_MESSAGES = {
  v2: "ℹ️ Your tokens are Pons Bot V2 tokens. Creator-fee claims and payouts are automated: 95% goes to the creator, while 5% buys back and burns $PONSBOT. You don't need to claim manually.",
  legacy: "ℹ️ Your legacy tokens use manual fee claims. There are no ETH creator fees available to claim right now. Non-ETH-paired tokens must be claimed individually.",
  mixed: "ℹ️ Your Pons Bot V2 launches use automated creator-fee claims and payouts. There are no legacy ETH fees available to claim manually right now. Claim non-ETH-paired legacy tokens individually.",
  pausedV2: "ℹ️ Your Pons Bot V2 tokens use automated creator-fee claims and payouts, but processing is currently paused for one or more tokens. No manual claim was made.",
};
type Guidance = { kind: "v2" | "legacy" | "mixed"; message: string };

// Informational fallback ONLY after the signer reports an empty legacy escrow.
// Never short-circuit a real claim: an upgraded/reassigned launch can still have
// old funds credited to the user's wallet before its vault took over.
export const emptyLegacyClaimMessage = internalQuery({
  args: { walletId: v.id("cryptoWallets"), tokenAddress: v.optional(v.string()) },
  handler: async (ctx, { walletId, tokenAddress }): Promise<Guidance | null> => {
    const wallet = await ctx.db.get(walletId);
    if (!wallet) return null;
    const walletAddress = wallet.address.toLowerCase();
    const token = tokenAddress?.toLowerCase();
    const programs = token
      ? await ctx.db.query("automatedFeePrograms").withIndex("by_token", q => q.eq("normalizedTokenAddress", token)).collect()
      : await ctx.db.query("automatedFeePrograms").withIndex("by_controller", q => q.eq("normalizedControllerAddress", wallet.address.toLowerCase())).collect();
    let hasV2 = false;
    let hasPausedV2 = false;
    for (const program of programs) {
      if (!["enrolled", "paused"].includes(program.status) || program.distributionMode !== "wallet" || program.privateTest || !program.launchId) continue;
      const launch = await ctx.db.get(program.launchId);
      // Exited vaults and holder-sharing launches must keep their normal claim
      // behavior. Match verified persisted assignment, not just a V2 badge.
      if (!launch?.publicPublished || launch.holderFeeSharing
        || launch.tokenAddress?.toLowerCase() !== program.normalizedTokenAddress
        || launch.creatorFeeRecipient?.toLowerCase() !== program.normalizedVaultAddress) continue;
      hasV2 = true;
      hasPausedV2 ||= program.status === "paused";
      if (!token) continue;
      const symbol = launch.symbol?.replace(/^\$/, "");
      const label = symbol && /^[A-Za-z0-9_]{1,32}$/.test(symbol) ? `$${symbol}` : "This token";
      if (program.status === "paused") return { kind: "v2", message: `ℹ️ ${label} uses automated creator-fee claims, but processing is currently paused. No manual claim was made.` };
      return { kind: "v2", message: `ℹ️ ${label} is a Pons Bot V2 token. Creator-fee claims and payouts are automated: 95% goes to the creator, while 5% buys back and burns $PONSBOT.` };
    }

    // Classify fee rights, not token holdings or historical launch ownership.
    // A reassigned launch must not make the previous owner's account "mixed".
    // Direct recipients also cover exited vaults returned to a user's wallet.
    const launches = token
      ? await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", token)).collect()
      : (await Promise.all([
          ctx.db.query("tokenLaunches").withIndex("by_owner_created_at", q => q.eq("ownerXUserId", wallet.ownerXUserId)).collect(),
          ctx.db.query("tokenLaunches").withIndex("by_creator_fee_recipient", q => q.eq("normalizedCreatorFeeRecipient", walletAddress)).collect(),
        ])).flat();
    const legacy = launches.find(launch => launch.publicPublished === true && launch.tokenAddress && !launch.holderFeeSharing
      && (launch.creatorFeeRecipient || launch.creatorAddress)?.toLowerCase() === walletAddress);
    if (token && legacy) {
      const symbol = legacy.symbol?.replace(/^\$/, "");
      const label = symbol && /^[A-Za-z0-9_]{1,32}$/.test(symbol) ? `$${symbol}` : "This token";
      return { kind: "legacy", message: `ℹ️ ${label} uses manual creator-fee claims. There aren't any fees available to claim in its paired asset right now.` };
    }
    if (hasV2 && legacy) return { kind: "mixed", message: EMPTY_CLAIM_MESSAGES.mixed
      + (hasPausedV2 ? " Processing is paused for one or more V2 tokens." : "") };
    if (hasV2) return { kind: "v2", message: hasPausedV2 ? EMPTY_CLAIM_MESSAGES.pausedV2 : EMPTY_CLAIM_MESSAGES.v2 };
    if (legacy) return { kind: "legacy", message: EMPTY_CLAIM_MESSAGES.legacy };
    return null;
  },
});
