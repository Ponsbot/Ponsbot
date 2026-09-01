import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";

const CAMPAIGN_KEY = "automatic";
export const FREE_LAUNCH_GRANT_WEI = "0"; // Grants are estimated per launch.
const FUNDING_LEASE_MS = 2 * 60_000;

function environmentConfiguration() {
  const enabled = process.env.FREE_LAUNCH_SPONSOR_ENABLED?.trim().toLowerCase() === "true";
  const totalSlots = Number(process.env.FREE_LAUNCH_TOTAL_SLOTS?.trim() || "0");
  if (!Number.isSafeInteger(totalSlots) || totalSlots < 0) {
    throw new Error("FREE_LAUNCH_TOTAL_SLOTS must be a non-negative integer");
  }
  return { enabled, totalSlots };
}

async function synchronizedCampaign(ctx: MutationCtx) {
  const configured = environmentConfiguration();
  const now = Date.now();
  const existing = await ctx.db.query("freeLaunchCampaigns")
    .withIndex("by_key", (q) => q.eq("key", CAMPAIGN_KEY)).unique();
  if (!existing) {
    const id = await ctx.db.insert("freeLaunchCampaigns", {
      key: CAMPAIGN_KEY,
      ...configured,
      reservedSlots: 0,
      issuedSlots: 0,
      completedLaunches: 0,
      grantWei: FREE_LAUNCH_GRANT_WEI,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(id);
  }
  if (existing.enabled !== configured.enabled
    || existing.totalSlots !== configured.totalSlots
    || existing.grantWei !== FREE_LAUNCH_GRANT_WEI) {
    const synchronized = { ...configured, grantWei: FREE_LAUNCH_GRANT_WEI, updatedAt: now };
    await ctx.db.patch(existing._id, synchronized);
    return { ...existing, ...synchronized };
  }
  return existing;
}

export const reserve = internalMutation({
  args: {
    ownerXUserId: v.string(),
    walletId: v.id("cryptoWallets"),
    recipientAddress: v.string(),
    requestId: v.string(),
    grantWei: v.string(),
    launchFeeWei: v.string(),
    estimatedGas: v.string(),
    bufferedGasCostWei: v.string(),
  },
  handler: async (ctx, args) => {
    const campaign = await synchronizedCampaign(ctx);
    if (!campaign?.enabled) return { eligible: false as const, reason: "inactive" };
    const existing = await ctx.db.query("freeLaunchRedemptions")
      .withIndex("by_owner_x_user_id", (q) => q.eq("ownerXUserId", args.ownerXUserId)).unique();
    if (existing) {
      if (existing.requestId === args.requestId && ["reserved", "funding", "funded", "manual_review"].includes(existing.status)) {
        return {
          eligible: true as const,
          alreadyFunded: existing.status === "funded" || existing.status === "manual_review",
          grantWei: existing.grantWei,
          sponsorTransactionHash: existing.sponsorTransactionHash,
        };
      }
      // The initial live campaign used a fixed 0.001 ETH grant that proved
      // insufficient after the funding transaction confirmed. Permit exactly
      // one corrected retry for those legacy funded-but-never-launched rows,
      // while retaining the same campaign slot and one-launch-per-user rule.
      if (existing.status === "funded"
        && existing.grantWei === "1000000000000000"
        && !existing.launchTransactionHash
        && existing.requestId !== args.requestId) {
        const now = Date.now();
        await ctx.db.patch(existing._id, {
          walletId: args.walletId,
          recipientAddress: args.recipientAddress.toLowerCase(),
          requestId: args.requestId,
          status: "reserved",
          grantWei: args.grantWei,
          launchFeeWei: args.launchFeeWei,
          estimatedGas: args.estimatedGas,
          bufferedGasCostWei: args.bufferedGasCostWei,
          sponsorTransactionHash: undefined,
          fundingBroadcastAt: undefined,
          fundingNotFoundChecks: 0,
          fundingLastCheckedAt: undefined,
          diagnosticCode: undefined,
          updatedAt: now,
        });
        await ctx.db.patch(campaign._id, {
          issuedSlots: Math.max(0, campaign.issuedSlots - 1),
          reservedSlots: campaign.reservedSlots + 1,
          updatedAt: now,
        });
        return { eligible: true as const, alreadyFunded: false, grantWei: args.grantWei };
      }
      if (existing.status !== "failed_before_funding") {
        return { eligible: false as const, reason: "already_used" };
      }
    }
    if (campaign.issuedSlots + campaign.reservedSlots >= campaign.totalSlots) {
      return { eligible: false as const, reason: "exhausted" };
    }
    const now = Date.now();
    const redemption = {
      walletId: args.walletId,
      recipientAddress: args.recipientAddress.toLowerCase(),
      requestId: args.requestId,
      status: "reserved" as const,
      grantWei: args.grantWei,
      launchFeeWei: args.launchFeeWei,
      estimatedGas: args.estimatedGas,
      bufferedGasCostWei: args.bufferedGasCostWei,
      sponsorTransactionHash: undefined,
      launchTransactionHash: undefined,
      diagnosticCode: undefined,
      fundingBroadcastAt: undefined,
      fundingNotFoundChecks: 0,
      fundingLastCheckedAt: undefined,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, redemption);
    else await ctx.db.insert("freeLaunchRedemptions", {
      ownerXUserId: args.ownerXUserId,
      ...redemption,
      createdAt: now,
    });
    await ctx.db.patch(campaign._id, { reservedSlots: campaign.reservedSlots + 1, updatedAt: now });
    // campaign.grantWei is the dynamic-mode sentinel ("0"). The amount
    // actually estimated and persisted for this reservation must be returned.
    return { eligible: true as const, alreadyFunded: false, grantWei: args.grantWei };
  },
});

export const eligibility = internalMutation({
  args: { ownerXUserId: v.string() },
  handler: async (ctx, args) => {
    const campaign = await synchronizedCampaign(ctx);
    if (!campaign?.enabled) return { eligible: false as const, reason: "inactive" };
    const existing = await ctx.db.query("freeLaunchRedemptions")
      .withIndex("by_owner_x_user_id", (q) => q.eq("ownerXUserId", args.ownerXUserId)).unique();
    if (existing) {
      const legacyRetry = existing.status === "funded"
        && existing.grantWei === "1000000000000000"
        && !existing.launchTransactionHash;
      if (!legacyRetry && existing.status !== "failed_before_funding") {
        return { eligible: false as const, reason: "already_used" };
      }
    }
    if (campaign.issuedSlots + campaign.reservedSlots >= campaign.totalSlots) {
      return { eligible: false as const, reason: "exhausted" };
    }
    return { eligible: true as const };
  },
});

export const listRecoverable = internalQuery({
  args: {},
  handler: async (ctx) => {
    const staleBefore = Date.now() - 10 * 60_000;
    const [funding, reserved, manualReview] = await Promise.all([
      ctx.db.query("freeLaunchRedemptions")
        .withIndex("by_status", (q) => q.eq("status", "funding"))
        .take(20),
      ctx.db.query("freeLaunchRedemptions")
        .withIndex("by_status", (q) => q.eq("status", "reserved"))
        .take(20),
      ctx.db.query("freeLaunchRedemptions")
        .withIndex("by_status", (q) => q.eq("status", "manual_review"))
        .take(20),
    ]);
    return [...funding, ...reserved, ...manualReview]
      .filter((item) =>
        !!item.sponsorTransactionHash || item.updatedAt < staleBefore,
      )
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, 20)
      .map((item) => ({
        requestId: item.requestId,
        recipient: item.recipientAddress,
        grantWei: item.grantWei,
        transactionHash: item.sponsorTransactionHash,
      }));
  },
});

export const acquireFundingLease = internalMutation({
  args: { requestId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.query("freeLaunchCampaigns")
      .withIndex("by_key", (q) => q.eq("key", CAMPAIGN_KEY)).unique();
    if (!campaign?.enabled) return false;
    const now = Date.now();
    if (campaign.fundingLeaseUntil && campaign.fundingLeaseUntil > now
      && campaign.fundingLeaseToken !== args.leaseToken) return false;
    const redemption = await ctx.db.query("freeLaunchRedemptions")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!redemption || !["reserved", "funding"].includes(redemption.status)) return false;
    await ctx.db.patch(campaign._id, {
      fundingLeaseToken: args.leaseToken,
      fundingLeaseUntil: now + FUNDING_LEASE_MS,
      updatedAt: now,
    });
    await ctx.db.patch(redemption._id, { status: "funding", updatedAt: now });
    return true;
  },
});

export const releaseFundingLease = internalMutation({
  args: { leaseToken: v.string() },
  handler: async (ctx, args) => {
    const campaign = await ctx.db.query("freeLaunchCampaigns")
      .withIndex("by_key", (q) => q.eq("key", CAMPAIGN_KEY)).unique();
    if (campaign?.fundingLeaseToken === args.leaseToken) {
      await ctx.db.patch(campaign._id, {
        fundingLeaseToken: undefined,
        fundingLeaseUntil: 0,
        updatedAt: Date.now(),
      });
    }
  },
});

export const markFunded = internalMutation({
  args: { requestId: v.string(), transactionHash: v.string() },
  handler: async (ctx, args) => {
    const redemption = await ctx.db.query("freeLaunchRedemptions")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!redemption || redemption.status === "funded" || redemption.status === "completed") return;
    if (!["reserved", "funding", "manual_review"].includes(redemption.status)) throw new Error("free launch redemption is not fundable");
    const campaign = await ctx.db.query("freeLaunchCampaigns")
      .withIndex("by_key", (q) => q.eq("key", CAMPAIGN_KEY)).unique();
    if (!campaign) throw new Error("free launch campaign disappeared during funding");
    const now = Date.now();
    const launchRequest = await ctx.db.query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    const launchCompleted = launchRequest?.status === "confirmed" && !!launchRequest.transactionHash;
    await ctx.db.patch(redemption._id, {
      status: launchCompleted ? "completed" : "funded",
      sponsorTransactionHash: args.transactionHash,
      ...(launchCompleted ? { launchTransactionHash: launchRequest.transactionHash } : {}),
      updatedAt: now,
    });
    if (redemption.status !== "manual_review" || launchCompleted) {
      await ctx.db.patch(campaign._id, {
        ...(redemption.status !== "manual_review" ? {
        reservedSlots: Math.max(0, campaign.reservedSlots - 1),
        issuedSlots: campaign.issuedSlots + 1,
        } : {}),
        ...(launchCompleted ? { completedLaunches: campaign.completedLaunches + 1 } : {}),
        updatedAt: now,
      });
    }
  },
});

export const recordFundingBroadcast = internalMutation({
  args: { requestId: v.string(), transactionHash: v.string() },
  handler: async (ctx, args) => {
    const redemption = await ctx.db.query("freeLaunchRedemptions")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!redemption || !["reserved", "funding"].includes(redemption.status)) return;
    await ctx.db.patch(redemption._id, {
      status: "funding",
      sponsorTransactionHash: args.transactionHash,
      fundingBroadcastAt: Date.now(),
      fundingNotFoundChecks: 0,
      updatedAt: Date.now(),
    });
  },
});

export const recordFundingStatusCheck = internalMutation({
  args: { requestId: v.string(), found: v.boolean() },
  handler: async (ctx, args) => {
    const redemption = await ctx.db.query("freeLaunchRedemptions")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!redemption || !["funding", "manual_review"].includes(redemption.status)) {
      return { manualReview: redemption?.status === "manual_review" };
    }
    const now = Date.now();
    if (args.found) {
      if (!(redemption.fundingNotFoundChecks || 0)) {
        return { manualReview: redemption.status === "manual_review" };
      }
      await ctx.db.patch(redemption._id, {
        fundingNotFoundChecks: 0,
        fundingLastCheckedAt: now,
        updatedAt: now,
      });
      return { manualReview: redemption.status === "manual_review" };
    }
    if (redemption.fundingLastCheckedAt && now - redemption.fundingLastCheckedAt < 30_000) {
      return { manualReview: redemption.status === "manual_review" };
    }
    const checks = (redemption.fundingNotFoundChecks || 0) + 1;
    const oldEnough = now - (redemption.fundingBroadcastAt || redemption.updatedAt) >= 10 * 60_000;
    if (redemption.status === "funding" && checks >= 5 && oldEnough) {
      const campaign = await ctx.db.query("freeLaunchCampaigns")
        .withIndex("by_key", (q) => q.eq("key", CAMPAIGN_KEY)).unique();
      await ctx.db.patch(redemption._id, {
        status: "manual_review",
        fundingNotFoundChecks: checks,
        fundingLastCheckedAt: now,
        diagnosticCode: "FREE_LAUNCH_FUNDING_TRANSACTION_NOT_FOUND",
        updatedAt: now,
      });
      if (campaign) await ctx.db.patch(campaign._id, {
        reservedSlots: Math.max(0, campaign.reservedSlots - 1),
        issuedSlots: campaign.issuedSlots + 1,
        updatedAt: now,
      });
      return { manualReview: true };
    }
    await ctx.db.patch(redemption._id, {
      fundingNotFoundChecks: checks,
      fundingLastCheckedAt: now,
      updatedAt: now,
    });
    return { manualReview: redemption.status === "manual_review" };
  },
});

export const markFundingReverted = internalMutation({
  args: { requestId: v.string(), diagnosticCode: v.string() },
  handler: async (ctx, args) => {
    const redemption = await ctx.db.query("freeLaunchRedemptions")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!redemption || !["reserved", "funding", "manual_review"].includes(redemption.status)) return;
    const campaign = await ctx.db.query("freeLaunchCampaigns")
      .withIndex("by_key", (q) => q.eq("key", CAMPAIGN_KEY)).unique();
    await ctx.db.patch(redemption._id, {
      status: "failed_before_funding",
      diagnosticCode: args.diagnosticCode,
      updatedAt: Date.now(),
    });
    if (campaign) await ctx.db.patch(campaign._id, redemption.status === "manual_review" ? {
      issuedSlots: Math.max(0, campaign.issuedSlots - 1),
      updatedAt: Date.now(),
    } : {
      reservedSlots: Math.max(0, campaign.reservedSlots - 1),
      updatedAt: Date.now(),
    });
  },
});

export const failBeforeFunding = internalMutation({
  args: { requestId: v.string(), diagnosticCode: v.string() },
  handler: async (ctx, args) => {
    const redemption = await ctx.db.query("freeLaunchRedemptions")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!redemption || !["reserved", "funding"].includes(redemption.status)) return;
    const campaign = await ctx.db.query("freeLaunchCampaigns")
      .withIndex("by_key", (q) => q.eq("key", CAMPAIGN_KEY)).unique();
    const now = Date.now();
    await ctx.db.patch(redemption._id, {
      status: "failed_before_funding",
      diagnosticCode: args.diagnosticCode,
      updatedAt: now,
    });
    if (campaign) await ctx.db.patch(campaign._id, {
      reservedSlots: Math.max(0, campaign.reservedSlots - 1),
      updatedAt: now,
    });
  },
});
