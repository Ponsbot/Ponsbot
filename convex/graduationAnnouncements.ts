import { createPublicClient, parseAbi, type Address } from "viem";
import { reliableHttp } from "../lib/rpc-http";
import { mapWithConcurrency } from "../lib/bounded-concurrency";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  GRADUATION_CHECK_LIMIT,
  graduationNextCheckAt,
  graduationAnnouncementText,
  graduationTokenPageUrl,
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
type PonsLaunchState = { phase: number };

function graduationPostsEnabled() {
  return process.env.X_REPLIES_ENABLED === "true" && process.env.X_GRADUATION_POSTS_ENABLED !== "false";
}

export const recentCandidates = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Missing optional values sort before numeric timestamps, so this query
    // also performs the one-time migration of existing monitoring rows. Once a
    // row is checked it disappears from the due range until its backoff ends.
    const candidates = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_graduation_due", (q) =>
        q
          .eq("graduationAnnouncementStatus", "monitoring")
          .lte("graduationMonitorNextCheckAt", now),
      )
      .take(GRADUATION_CHECK_LIMIT);
    return candidates
      .filter((launch) => launch.publicPublished === true && Boolean(launch.tokenAddress))
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
      if (!launch?.tokenAddress || launch.publicPublished !== true || ["posted", "ignored", "posting", "uncertain"].includes(launch.graduationAnnouncementStatus || "")) continue;
      const nextCheckAt = graduationNextCheckAt(launch.createdAt, now);
      const base = {
        graduationMonitorCheckedAt: now,
        graduationMonitorNextCheckAt: check.graduated ? undefined : nextCheckAt,
        publicGraduated: check.graduated,
        updatedAt: now,
      };
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
        graduationAnnouncementPostedAt: now, graduationAnnouncementError: undefined,
        graduationMonitorNextCheckAt: undefined, updatedAt: now,
      });
    } else if (args.status === "uncertain") {
      await ctx.db.patch(launch._id, { graduationAnnouncementStatus: "uncertain", graduationAnnouncementError: args.error, graduationMonitorNextCheckAt: undefined, updatedAt: now });
    } else {
      await ctx.db.patch(launch._id, {
        graduationAnnouncementStatus: "monitoring", graduationAnnouncementError: args.error,
        graduationAnnouncementNextAttemptAt: now + 5 * 60_000,
        graduationMonitorNextCheckAt: now + 5 * 60_000, updatedAt: now,
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
      transport: reliableHttp(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 12_000 }),
    });
    const rpcCandidates = candidates.filter((candidate) => !candidate.alreadyKnownGraduated);
    // This client intentionally has no chain-level multicall deployment. Use
    // bounded direct reads so one failed token cannot abort every announcement.
    const results: Array<{ status: "success"; result: PonsLaunchState } | { status: "failure" }> = [];
    await mapWithConcurrency(rpcCandidates, 6, async (candidate, index) => {
      try {
        const result = await rpc.readContract({
          address: factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [candidate.tokenAddress as Address],
        }) as PonsLaunchState;
        results[index] = { status: "success", result };
      } catch { results[index] = { status: "failure" }; }
    });
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
      const result = await ctx.runAction(internal.xReplies.publishStandalonePost, { text: graduationAnnouncementText(launch.symbol, url), publicationKey: `graduation:${launch.launchId}`, launchId: launch.launchId });
      if (result.status === "queued") continue;
      await ctx.runMutation(internal.graduationAnnouncements.finishAnnouncement, {
        launchId: launch.launchId, status: result.status, postId: result.postId, error: result.error,
      });
      if (result.status === "posted") posted += 1;
    }
    return { checked: checks.length, posted };
  },
});
