import { createPublicClient, http, parseAbi, type Address } from "viem";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  GRADUATION_ACTIVITY_WINDOW_MS, GRADUATION_CHECK_LIMIT, GRADUATION_RECENT_LAUNCH_WINDOW_MS,
  graduationAnnouncementText, graduationTokenPageUrl,
} from "../lib/graduation-announcement";

const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
]);
const MAX_ANNOUNCEMENTS_PER_RUN = 3;

type GraduationCandidate = {
  launchId: Id<"tokenLaunches">;
  tokenAddress: string;
  symbol: string;
  status?: "monitoring" | "posting" | "posted" | "ignored" | "uncertain";
  alreadyKnownGraduated: boolean;
};
type GraduationMonitorResult = { checked: number; posted: number; disabled?: boolean };

function graduationPostsEnabled() {
  return process.env.X_REPLIES_ENABLED === "true" && process.env.X_GRADUATION_POSTS_ENABLED !== "false";
}

export const recentCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const activityCutoff = now - GRADUATION_ACTIVITY_WINDOW_MS;
    const launchCutoff = now - GRADUATION_RECENT_LAUNCH_WINDOW_MS;
    const [activeStates, recentLaunches] = await Promise.all([
      ctx.db.query("tokenMarketState").withIndex("by_last_buy", (q) => q.gte("lastBuyAt", activityCutoff)).order("desc").take(GRADUATION_CHECK_LIMIT * 2),
      ctx.db.query("tokenLaunches").order("desc").take(GRADUATION_CHECK_LIMIT * 4),
    ]);
    const activeLaunches = await Promise.all(activeStates.map((state) => ctx.db.query("tokenLaunches")
      .withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", state.normalizedTokenAddress)).unique()));
    const candidates = [...new Map([...recentLaunches.filter((launch) => launch.createdAt >= launchCutoff), ...activeLaunches.filter(Boolean)]
      .map((launch) => [launch!._id, launch!])).values()];
    return candidates
      .filter((launch) => Boolean(launch.tokenAddress))
      .filter((launch) => launch.tokenAddress && !["posted", "ignored", "posting", "uncertain"].includes(launch.graduationAnnouncementStatus || ""))
      .slice(0, GRADUATION_CHECK_LIMIT)
      .map((launch) => ({
        launchId: launch._id, tokenAddress: launch.tokenAddress!, symbol: launch.symbol,
        status: launch.graduationAnnouncementStatus, alreadyKnownGraduated: launch.publicGraduated === true,
      }));
  },
});

export const applyChecksAndReserve = internalMutation({
  args: { checks: v.array(v.object({ launchId: v.id("tokenLaunches"), graduated: v.boolean() })) },
  handler: async (ctx, { checks }) => {
    const now = Date.now();
    const reserved: Array<{ launchId: typeof checks[number]["launchId"]; tokenAddress: string; symbol: string }> = [];
    for (const check of checks) {
      const launch = await ctx.db.get(check.launchId);
      if (!launch?.tokenAddress || ["posted", "ignored", "posting", "uncertain"].includes(launch.graduationAnnouncementStatus || "")) continue;
      const base = { graduationMonitorCheckedAt: now, publicGraduated: check.graduated, updatedAt: now };
      if (!launch.graduationAnnouncementStatus) {
        await ctx.db.patch(launch._id, { ...base, graduationAnnouncementStatus: check.graduated ? "ignored" : "monitoring" });
        continue;
      }
      if (!check.graduated) {
        await ctx.db.patch(launch._id, base);
        continue;
      }
      if (reserved.length >= MAX_ANNOUNCEMENTS_PER_RUN) continue;
      if (launch.graduationAnnouncementNextAttemptAt && launch.graduationAnnouncementNextAttemptAt > now) continue;
      await ctx.db.patch(launch._id, {
        ...base, graduationAnnouncementStatus: "posting", graduationAnnouncementAttemptedAt: now,
        graduationAnnouncementNextAttemptAt: undefined, graduationAnnouncementError: undefined,
      });
      reserved.push({ launchId: launch._id, tokenAddress: launch.tokenAddress, symbol: launch.symbol });
    }
    return reserved;
  },
});

export const finishAnnouncement = internalMutation({
  args: {
    launchId: v.id("tokenLaunches"), status: v.union(v.literal("posted"), v.literal("rejected"), v.literal("uncertain")),
    postId: v.optional(v.string()), error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const launch = await ctx.db.get(args.launchId);
    if (!launch || launch.graduationAnnouncementStatus !== "posting") return;
    const now = Date.now();
    if (args.status === "posted") {
      await ctx.db.patch(launch._id, {
        graduationAnnouncementStatus: "posted", graduationAnnouncementPostId: args.postId,
        graduationAnnouncementPostedAt: now, graduationAnnouncementError: undefined, updatedAt: now,
      });
    } else if (args.status === "uncertain") {
      await ctx.db.patch(launch._id, { graduationAnnouncementStatus: "uncertain", graduationAnnouncementError: args.error, updatedAt: now });
    } else {
      await ctx.db.patch(launch._id, {
        graduationAnnouncementStatus: "monitoring", graduationAnnouncementError: args.error,
        graduationAnnouncementNextAttemptAt: now + 5 * 60_000, updatedAt: now,
      });
    }
  },
});

export const monitorGraduations = internalAction({
  args: {},
  handler: async (ctx): Promise<GraduationMonitorResult> => {
    if (!graduationPostsEnabled()) return { checked: 0, posted: 0, disabled: true };
    const candidates = await ctx.runQuery(internal.graduationAnnouncements.recentCandidates, {}) as GraduationCandidate[];
    if (!candidates.length) return { checked: 0, posted: 0 };
    const config = await ctx.runQuery(internal.registry.runtimeConfig, {});
    const factory = config.contracts.pons_v2_factory as Address | undefined;
    if (!factory) throw new Error("Pons V2 factory is missing from the contract registry");
    const rpc = createPublicClient({
      batch: { multicall: true },
      transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 12_000 }),
    });
    const rpcCandidates = candidates.filter((candidate) => !candidate.alreadyKnownGraduated);
    const results = rpcCandidates.length ? await rpc.multicall({
      contracts: rpcCandidates.map((candidate) => ({
        address: factory, abi: factoryAbi, functionName: "getLaunchedToken" as const, args: [candidate.tokenAddress as Address] as const,
      })), allowFailure: true,
    }) : [];
    const phases = new Map(rpcCandidates.map((candidate, index) => {
      const result = results[index];
      const launched = result?.status === "success" ? result.result as { phase: number } : undefined;
      return [candidate.launchId, launched?.phase] as const;
    }));
    const checks: Array<{ launchId: Id<"tokenLaunches">; graduated: boolean }> = candidates.flatMap((candidate) => {
      if (candidate.alreadyKnownGraduated) return [{ launchId: candidate.launchId, graduated: true }];
      const phase = phases.get(candidate.launchId);
      return phase === undefined ? [] : [{ launchId: candidate.launchId, graduated: phase === 2 }];
    });
    const reserved = await ctx.runMutation(internal.graduationAnnouncements.applyChecksAndReserve, { checks });
    let posted = 0;
    for (const launch of reserved) {
      const url = graduationTokenPageUrl(launch.tokenAddress, process.env.NEXT_PUBLIC_SITE_URL);
      const result = await ctx.runAction(internal.xReplies.publishStandalonePost, { text: graduationAnnouncementText(launch.symbol, url) });
      await ctx.runMutation(internal.graduationAnnouncements.finishAnnouncement, {
        launchId: launch.launchId, status: result.status, postId: result.postId, error: result.error,
      });
      if (result.status === "posted") posted += 1;
    }
    return { checked: checks.length, posted };
  },
});
