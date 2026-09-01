import { v } from "convex/values";
import { createPublicClient, parseAbi, type Address } from "viem";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { reliableHttp } from "../lib/rpc-http";
import { geckoSharedFetch } from "../lib/gecko-shared";
import { isTokenIndexExcluded } from "../lib/token-index-exclusions";
import {
  HOUR_MS,
  LIFETIME_VOLUME_BACKFILL_MS,
  LIFETIME_VOLUME_BATCH_LIMIT,
  LIFETIME_VOLUME_DISCOVERY_MS,
  LIFETIME_VOLUME_HISTORICAL_CANDLE_LIMIT,
  LIFETIME_VOLUME_RECENT_CANDLE_LIMIT,
  LIFETIME_VOLUME_REFRESH_MS,
  LIFETIME_VOLUME_LEASE_MS,
  lifetimeVolumeRecentCandleLimit,
  volumeRetryDelay,
  volumeRetryAfterMs,
  parseOhlcvCandles,
  parseRecentHours,
  ponsV4PoolId,
  serializeRecentHours,
  lifetimeVolumeSummary,
} from "../lib/lifetime-volume";

const NETWORK = "robinhood";
// Keep this well below GeckoTerminal's keyless ceiling because homepage and
// token-page market reads share the deployment's outbound IP and allowance.
const REQUEST_SPACING_MS = 10_000;
const CURVE_FINALIZATION_GRACE_MS = 2 * HOUR_MS;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function memeHook() view returns(address)",
]);

type VolumeSource = "bonding_curve" | "v4_pool";

type Candidate = {
  tokenAddress: string;
  poolAddress?: string;
  pairToken: string;
  source: VolumeSource;
  launchCreatedAt: number;
  backfillComplete: boolean;
  backfillBeforeTimestamp?: number;
  freezeWhenComplete: boolean;
  checkpointRevision?: number;
  lastSuccessAt?: number;
  volumeProvider?: "gecko" | "onchain";
  bucketedThroughAt?: number;
  onchainTrackingStartedAt?: number;
};

type ResolvedCandidate = Candidate & { poolAddress: string };

const resolvedCandidateValidator = v.object({
  tokenAddress: v.string(),
  poolAddress: v.string(),
  pairToken: v.string(),
  source: v.union(v.literal("bonding_curve"), v.literal("v4_pool")),
  launchCreatedAt: v.number(),
  backfillComplete: v.boolean(),
  backfillBeforeTimestamp: v.optional(v.number()),
  freezeWhenComplete: v.boolean(),
  checkpointRevision: v.optional(v.number()),
  lastSuccessAt: v.optional(v.number()),
  volumeProvider: v.optional(v.union(v.literal("gecko"), v.literal("onchain"))),
  bucketedThroughAt: v.optional(v.number()),
  onchainTrackingStartedAt: v.optional(v.number()),
});

function sourceOf(checkpoint: { source?: VolumeSource }): VolumeSource {
  // Rows created before dual-source accounting always describe the launch's
  // curve address and migrate in place without rewriting historical totals.
  return checkpoint.source ?? "bonding_curve";
}

async function workerState(ctx: QueryCtx) {
  return ctx.db.query("lifetimeVolumeWorker").withIndex("by_key", q => q.eq("key", "global")).unique();
}

async function ownsLease(ctx: QueryCtx, leaseToken?: string) {
  if (!leaseToken) return false; // Fence pre-deployment workers as well as expired workers.
  const state = await workerState(ctx);
  return state?.leaseToken === leaseToken && (state.leaseUntil ?? 0) > Date.now();
}

async function scheduleWorker(ctx: MutationCtx, state: Doc<"lifetimeVolumeWorker">, at: number) {
  if (state.scheduledId) {
    const pending = await ctx.db.system.get(state.scheduledId);
    if (pending?.state.kind === "pending") await ctx.scheduler.cancel(state.scheduledId);
  }
  const generation = state.generation + 1;
  const scheduledAt = Math.max(Date.now(), at, state.blockedUntil ?? 0);
  const scheduledId = await ctx.scheduler.runAt(scheduledAt, internal.lifetimeVolume.runRefreshBatch, { generation });
  await ctx.db.patch(state._id, { generation, scheduledId, scheduledAt, updatedAt: Date.now() });
}

async function queueRefresh(ctx: MutationCtx): Promise<{ status: string }> {
  let state = await workerState(ctx);
  if (!state) {
    const id = await ctx.db.insert("lifetimeVolumeWorker", { key: "global", generation: 0, throttleCount: 0, updatedAt: Date.now() });
    state = (await ctx.db.get(id))!;
  }
  if ((state.leaseUntil ?? 0) > Date.now()) return { status: "already_running" };
  if (state.scheduledId) {
    const scheduled = await ctx.db.system.get(state.scheduledId);
    if (scheduled?.state.kind === "pending" && (state.scheduledAt ?? 0) <= Math.max(Date.now(), state.blockedUntil ?? 0)) {
      return { status: "already_scheduled" };
    }
  }
  await scheduleWorker(ctx, state, Date.now());
  return { status: "scheduled" };
}

export const requestRefresh = internalMutation({ args: {}, handler: queueRefresh });

export const beginBatch = internalMutation({
  args: { generation: v.number() },
  handler: async (ctx, { generation }): Promise<{ leaseToken: string; leaseUntil: number; discover: boolean } | null> => {
    const state = await workerState(ctx), now = Date.now();
    if (!state || state.generation !== generation || state.importManifestId || (state.leaseUntil ?? 0) > now) return null;
    if ((state.blockedUntil ?? 0) > now) {
      await scheduleWorker(ctx, { ...state, scheduledId: undefined }, state.blockedUntil!);
      return null;
    }
    const leaseToken = String(generation), leaseUntil = now + LIFETIME_VOLUME_LEASE_MS;
    await ctx.db.patch(state._id, { leaseToken, leaseUntil, scheduledId: undefined, scheduledAt: undefined, updatedAt: now });
    // One watchdog recovers a killed/timed-out action. A normal finish replaces it.
    await scheduleWorker(ctx, { ...state, scheduledId: undefined }, leaseUntil + 1_000);
    return { leaseToken, leaseUntil, discover: !state.discoveryAt || state.discoveryAt + LIFETIME_VOLUME_DISCOVERY_MS <= now };
  },
});

async function seedCheckpoint(ctx: MutationCtx, candidate: ResolvedCandidate, existing?: Doc<"tokenLifetimeVolumes">) {
  const now = Date.now();
  if (!existing) {
    await ctx.db.insert("tokenLifetimeVolumes", {
      tokenAddress: candidate.tokenAddress, normalizedTokenAddress: candidate.tokenAddress.toLowerCase(),
      poolAddress: candidate.poolAddress, normalizedPoolAddress: candidate.poolAddress.toLowerCase(),
      pairToken: candidate.pairToken, source: candidate.source, enabled: true, frozen: false,
      launchCreatedAt: candidate.launchCreatedAt, confirmedVolumeUsd: 0, provisionalVolumeUsd: 0,
      recentHoursJson: "[]", backfillComplete: false, nextCheckAt: now, createdAt: now, updatedAt: now,
    });
    return;
  }
  // Migrate the old three-hour freshness target without resetting accumulated totals or retry backoff.
  const dueAt = existing.frozen ? Number.MAX_SAFE_INTEGER : existing.lastError
    ? existing.enabled === false ? Math.max(now, (existing.lastAttemptAt ?? now) + LIFETIME_VOLUME_REFRESH_MS) : existing.nextCheckAt
    : Math.min(existing.nextCheckAt, (existing.lastSuccessAt ?? now) + LIFETIME_VOLUME_REFRESH_MS);
  if (existing.pairToken !== candidate.pairToken || existing.enabled !== true || existing.source !== candidate.source || existing.nextCheckAt !== dueAt) {
    await ctx.db.patch(existing._id, { pairToken: candidate.pairToken, source: candidate.source, enabled: true, nextCheckAt: dueAt, updatedAt: now });
  }
}

// Full catalog discovery is deliberately slower than incremental accounting.
export const discoverSources = internalMutation({
  args: { leaseToken: v.string() },
  handler: async (ctx, { leaseToken }): Promise<Candidate[]> => {
    if (!await ownsLease(ctx, leaseToken)) return [];
    const now = Date.now();
    const [launches, checkpoints, markets] = await Promise.all([
      ctx.db.query("tokenLaunches").withIndex("by_public_created_at", (q) => q.eq("publicPublished", true)).collect(),
      ctx.db.query("tokenLifetimeVolumes").collect(),
      ctx.db.query("tokenMarketState").collect(),
    ]);
    const marketsByToken = new Map(markets.map((item) => [item.normalizedTokenAddress, item]));
    const byTokenSource = new Map(checkpoints.map((item) => [`${item.normalizedTokenAddress}:${sourceOf(item)}`, item]));
    const unresolved: Candidate[] = [];
    const publicSources = new Set<string>();
    for (const launch of launches) {
      if (!launch.tokenAddress || isTokenIndexExcluded(launch.tokenAddress) || !launch.poolAddress || !/^0x(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(launch.poolAddress)) continue;
      const normalizedToken = launch.tokenAddress.toLowerCase();
      publicSources.add(`${normalizedToken}:bonding_curve`);
      const market = marketsByToken.get(normalizedToken);
      const graduated = launch.publicGraduated === true || market?.graduated === true;
      const curve = byTokenSource.get(`${normalizedToken}:bonding_curve`);
      const v4 = byTokenSource.get(`${normalizedToken}:v4_pool`);
      await seedCheckpoint(ctx, {
          tokenAddress: launch.tokenAddress,
          poolAddress: launch.poolAddress,
          pairToken: launch.pairToken || ZERO_ADDRESS,
          source: "bonding_curve",
          launchCreatedAt: launch.createdAt,
          backfillComplete: curve?.backfillComplete ?? false,
          backfillBeforeTimestamp: curve?.backfillBeforeTimestamp,
          freezeWhenComplete: false,
      }, curve);
      if (graduated && curve?.volumeProvider === "onchain" && !curve.frozen) {
        // Token-level five-minute buckets include post-graduation V4 trades. Stop
        // the curve checkpoint immediately so the V4 source is solely responsible
        // for graduated trading volume and the two sources cannot overlap.
        await ctx.db.patch(curve._id, {
          frozen: true,
          nextCheckAt: Number.MAX_SAFE_INTEGER,
          graduationObservedAt: curve.graduationObservedAt ?? now,
          updatedAt: now,
        });
      } else if (graduated && !curve?.frozen && curve?.graduationObservedAt === undefined) {
        const row = curve ?? await ctx.db.query("tokenLifetimeVolumes").withIndex("by_pool", q => q.eq("normalizedPoolAddress", launch.poolAddress!.toLowerCase())).unique();
        // Pin the first observation; repeated market refreshes must not move the two-hour grace window.
        if (row) await ctx.db.patch(row._id, { graduationObservedAt: now });
      }
      if (graduated) {
        publicSources.add(`${normalizedToken}:v4_pool`);
        const candidate: Candidate = {
          tokenAddress: launch.tokenAddress,
          poolAddress: v4?.poolAddress,
          pairToken: launch.pairToken || ZERO_ADDRESS,
          source: "v4_pool",
          launchCreatedAt: launch.createdAt,
          backfillComplete: v4?.backfillComplete ?? false,
          backfillBeforeTimestamp: v4?.backfillBeforeTimestamp,
          freezeWhenComplete: false,
        };
        if (v4) await seedCheckpoint(ctx, { ...candidate, poolAddress: v4.poolAddress }, v4);
        else unresolved.push(candidate);
      }
    }
    for (const row of checkpoints) if (!publicSources.has(`${row.normalizedTokenAddress}:${sourceOf(row)}`) && row.enabled !== false) {
      await ctx.db.patch(row._id, { enabled: false, nextCheckAt: Number.MAX_SAFE_INTEGER, updatedAt: now });
    }
    const state = (await workerState(ctx))!;
    await ctx.db.patch(state._id, { discoveryAt: now });
    return unresolved;
  },
});

export const registerResolvedSource = internalMutation({
  args: { leaseToken: v.string(), candidate: resolvedCandidateValidator },
  handler: async (ctx, { leaseToken, candidate }) => {
    if (!await ownsLease(ctx, leaseToken)) return;
    if (isTokenIndexExcluded(candidate.tokenAddress)) return;
    const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", candidate.tokenAddress.toLowerCase())).first()
      ?? await ctx.db.query("tokenLaunches").withIndex("by_token_address", q => q.eq("tokenAddress", candidate.tokenAddress)).first();
    if (!launch?.publicPublished) return;
    const existing = await ctx.db.query("tokenLifetimeVolumes").withIndex("by_pool", q => q.eq("normalizedPoolAddress", candidate.poolAddress.toLowerCase())).unique();
    await seedCheckpoint(ctx, candidate, existing ?? undefined);
  },
});

export const duePools = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ pools: ResolvedCandidate[]; hasMore: boolean }> => {
    const now = Date.now();
    const rows = await ctx.db.query("tokenLifetimeVolumes").withIndex("by_enabled_due", q => q.eq("enabled", true).lte("nextCheckAt", now)).take(LIFETIME_VOLUME_BATCH_LIMIT + 1);
    return { pools: rows.slice(0, LIFETIME_VOLUME_BATCH_LIMIT).filter(row => !row.frozen && row.enabled === true).map(row => ({
      tokenAddress: row.tokenAddress, poolAddress: row.poolAddress, pairToken: row.pairToken ?? ZERO_ADDRESS,
      source: sourceOf(row), launchCreatedAt: row.launchCreatedAt, backfillComplete: row.backfillComplete,
      backfillBeforeTimestamp: row.backfillBeforeTimestamp, checkpointRevision: row.revision ?? 0,
      lastSuccessAt: row.lastSuccessAt, volumeProvider: row.volumeProvider, bucketedThroughAt: row.bucketedThroughAt,
      onchainTrackingStartedAt: row.onchainTrackingStartedAt,
      freezeWhenComplete: sourceOf(row) === "bonding_curve" && row.graduationObservedAt !== undefined && now >= row.graduationObservedAt + CURVE_FINALIZATION_GRACE_MS,
    })), hasMore: rows.length > LIFETIME_VOLUME_BATCH_LIMIT };
  },
});

export const recordAttemptFailure = internalMutation({
  args: { leaseToken: v.optional(v.string()), candidate: resolvedCandidateValidator, error: v.string(), retryAfterMs: v.optional(v.number()) },
  handler: async (ctx, { leaseToken, candidate, error, retryAfterMs }) => {
    if (!await ownsLease(ctx, leaseToken)) return;
    const now = Date.now();
    const normalizedPoolAddress = candidate.poolAddress.toLowerCase();
    const existing = await ctx.db.query("tokenLifetimeVolumes").withIndex("by_pool", (q) => q.eq("normalizedPoolAddress", normalizedPoolAddress)).unique();
    if (!existing || existing.enabled !== true || candidate.checkpointRevision !== (existing.revision ?? 0)) return;
    const patch = {
      lastAttemptAt: now,
      lastError: error.slice(0, 300),
      nextCheckAt: now + Math.max(retryAfterMs ?? LIFETIME_VOLUME_REFRESH_MS, 60_000),
      revision: (existing.revision ?? 0) + 1,
      updatedAt: now,
    };
    await ctx.db.patch(existing._id, patch);
  },
});

export const onchainBuckets = internalQuery({
  args: { tokenAddress: v.string(), after: v.number(), through: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("tokenVolumeBuckets").withIndex("by_token_hour", q =>
      q.eq("normalizedTokenAddress", args.tokenAddress.toLowerCase()).gt("hourStartedAt", args.after).lte("hourStartedAt", args.through)).collect();
    return { rows: rows.map(row => ({ bucketStartedAt: row.hourStartedAt, volumeUsd: row.volumeUsd })), through: args.through };
  },
});

export const ingestOnchainBuckets = internalMutation({
  args: { leaseToken: v.string(), candidate: resolvedCandidateValidator,
    rows: v.array(v.object({ bucketStartedAt: v.number(), volumeUsd: v.number() })), through: v.number() },
  handler: async (ctx, args) => {
    if (!await ownsLease(ctx, args.leaseToken) || args.rows.some(row => !Number.isFinite(row.volumeUsd) || row.volumeUsd < 0)) return false;
    const existing = await ctx.db.query("tokenLifetimeVolumes").withIndex("by_pool", q =>
      q.eq("normalizedPoolAddress", args.candidate.poolAddress.toLowerCase())).unique();
    if (!existing || existing.enabled !== true || existing.volumeProvider !== "onchain"
      || args.candidate.checkpointRevision !== (existing.revision ?? 0) || args.through < (existing.bucketedThroughAt ?? 0)) return false;
    const trackingStartedAt = existing.onchainTrackingStartedAt ?? existing.bucketedThroughAt ?? existing.launchCreatedAt;
    const recent = parseRecentHours(existing.bucketRecentJson);
    let delta = 0;
    for (const row of args.rows) {
      if (row.bucketStartedAt <= trackingStartedAt) continue;
      const previous = recent.get(row.bucketStartedAt);
      delta += row.volumeUsd - (previous ?? 0);
      recent.set(row.bucketStartedAt, row.volumeUsd);
    }
    const retained = new Map([...recent.entries()].filter(([timestamp]) => timestamp >= args.through - 72 * HOUR_MS));
    const confirmedVolumeUsd = Math.max(0, existing.confirmedVolumeUsd + delta);
    const bucketRecentJson = JSON.stringify([...retained.entries()].sort((a, b) => b[0] - a[0]).slice(0, 864));
    await ctx.db.patch(existing._id, { confirmedVolumeUsd, provisionalVolumeUsd: 0, bucketedThroughAt: args.through,
      onchainTrackingStartedAt: trackingStartedAt, bucketRecentJson,
      latestCompletedHour: Math.floor(args.through / HOUR_MS) * HOUR_MS, nextCheckAt: Date.now() + LIFETIME_VOLUME_REFRESH_MS,
      lastAttemptAt: Date.now(), lastSuccessAt: Date.now(), lastError: undefined, revision: (existing.revision ?? 0) + 1, updatedAt: Date.now() });
    const cache = await ctx.db.query("platformStatsCache").withIndex("by_key", q => q.eq("key", "public")).unique();
    if (cache && Number.isFinite(cache.lifetimeVolumeUsd) && delta !== 0) await ctx.db.patch(cache._id, {
      lifetimeVolumeUsd: Math.max(0, cache.lifetimeVolumeUsd! + delta), marketUpdatedAt: Math.max(cache.marketUpdatedAt, Date.now()),
    });
    return true;
  },
});

export const retryRateLimitedCheckpoints = internalMutation({
  args: {},
  // Compatibility for operator tooling: never clear checkpoint/provider backoff.
  handler: queueRefresh,
});

const importEntry = v.object({
  tokenAddress: v.string(), poolAddress: v.string(), pairToken: v.string(),
  source: v.union(v.literal("bonding_curve"), v.literal("v4_pool")),
  launchCreatedAt: v.number(), confirmedVolumeUsd: v.number(), recentHoursJson: v.string(),
  oldestBackfilledHour: v.optional(v.number()), latestCompletedHour: v.number(),
  volumeProvider: v.union(v.literal("gecko"), v.literal("onchain")), frozen: v.boolean(),
});

function authorizeImport(secret: string) {
  if (!process.env.MARKET_INDEX_SECRET || secret !== process.env.MARKET_INDEX_SECRET) throw new Error("lifetime volume import authorization failed");
}

export const beginBackfillImport = mutation({
  args: { secret: v.string(), manifestId: v.string(), cutoffHour: v.number(), expectedSources: v.number() },
  handler: async (ctx, args) => {
    authorizeImport(args.secret);
    if (!/^[a-f0-9]{64}$/.test(args.manifestId) || args.cutoffHour % HOUR_MS || args.cutoffHour > Date.now()
      || !Number.isInteger(args.expectedSources) || args.expectedSources < 1 || args.expectedSources > 2_000) throw new Error("invalid lifetime volume manifest");
    let state = await workerState(ctx);
    if (!state) {
      const id = await ctx.db.insert("lifetimeVolumeWorker", { key: "global", generation: 0, throttleCount: 0, updatedAt: Date.now() });
      state = (await ctx.db.get(id))!;
    }
    if (state.importManifestId && state.importManifestId !== args.manifestId) throw new Error("another lifetime volume import is active");
    const previouslyImported = state.importManifestId === args.manifestId
      ? state.importCompletedSources ?? 0
      : (await ctx.db.query("tokenLifetimeVolumes").collect()).filter(row => row.backfillManifestId === args.manifestId).length;
    if (state.scheduledId) {
      const scheduled = await ctx.db.system.get(state.scheduledId);
      if (scheduled?.state.kind === "pending") await ctx.scheduler.cancel(state.scheduledId);
    }
    await ctx.db.patch(state._id, { generation: state.generation + 1, scheduledId: undefined, scheduledAt: undefined,
      leaseToken: undefined, leaseUntil: undefined, importManifestId: args.manifestId, importCutoffHour: args.cutoffHour,
      importExpectedSources: args.expectedSources, importCompletedSources: previouslyImported,
      updatedAt: Date.now() });
    return { manifestId: args.manifestId, completedSources: previouslyImported };
  },
});

export const importBackfillBatch = mutation({
  args: { secret: v.string(), manifestId: v.string(), entries: v.array(importEntry) },
  handler: async (ctx, args) => {
    authorizeImport(args.secret);
    if (!args.entries.length || args.entries.length > 20) throw new Error("invalid lifetime volume import batch");
    const state = await workerState(ctx);
    if (!state || state.importManifestId !== args.manifestId || state.importCutoffHour === undefined) throw new Error("lifetime volume import is not active");
    let completed = state.importCompletedSources ?? 0;
    for (const entry of args.entries) {
      if (!isTokenIndexExcluded(entry.tokenAddress) && Number.isFinite(entry.confirmedVolumeUsd) && entry.confirmedVolumeUsd >= 0
        && entry.latestCompletedHour === state.importCutoffHour && entry.recentHoursJson.length <= 20_000) {
        const recent = parseRecentHours(entry.recentHoursJson);
        if (serializeRecentHours(recent) !== entry.recentHoursJson) throw new Error("invalid imported recent hours");
        const normalizedPoolAddress = entry.poolAddress.toLowerCase();
        const existing = await ctx.db.query("tokenLifetimeVolumes").withIndex("by_pool", q => q.eq("normalizedPoolAddress", normalizedPoolAddress)).unique();
        const values = { tokenAddress: entry.tokenAddress, normalizedTokenAddress: entry.tokenAddress.toLowerCase(), source: entry.source,
          poolAddress: entry.poolAddress, normalizedPoolAddress, pairToken: entry.pairToken, launchCreatedAt: entry.launchCreatedAt,
          confirmedVolumeUsd: entry.confirmedVolumeUsd, provisionalVolumeUsd: 0, recentHoursJson: entry.recentHoursJson,
          oldestBackfilledHour: entry.oldestBackfilledHour, latestCompletedHour: entry.latestCompletedHour,
          backfillBeforeTimestamp: undefined, backfillComplete: true, enabled: true, frozen: entry.frozen,
          // The imported hourly value covers the entire cutoff hour. Resume
          // five-minute buckets strictly after that hour to avoid overlap.
          volumeProvider: entry.volumeProvider, bucketedThroughAt: entry.volumeProvider === "onchain" ? state.importCutoffHour + HOUR_MS - 1 : undefined,
          onchainTrackingStartedAt: entry.volumeProvider === "onchain" ? state.importCutoffHour + HOUR_MS - 1 : undefined,
          bucketRecentJson: entry.volumeProvider === "onchain" ? "[]" : undefined,
          backfillManifestId: args.manifestId, nextCheckAt: entry.frozen ? Number.MAX_SAFE_INTEGER : Date.now() + LIFETIME_VOLUME_REFRESH_MS,
          lastAttemptAt: Date.now(), lastSuccessAt: Date.now(), lastError: undefined, updatedAt: Date.now() };
        if (existing) {
          if (existing.backfillManifestId !== args.manifestId) completed++;
          await ctx.db.patch(existing._id, { ...values, revision: (existing.revision ?? 0) + 1 });
        } else {
          completed++;
          await ctx.db.insert("tokenLifetimeVolumes", { ...values, revision: 1, createdAt: Date.now() });
        }
      } else throw new Error("invalid lifetime volume import entry");
    }
    await ctx.db.patch(state._id, { importCompletedSources: completed, updatedAt: Date.now() });
    return { completedSources: completed, expectedSources: state.importExpectedSources };
  },
});

export const finalizeBackfillImport = mutation({
  args: { secret: v.string(), manifestId: v.string() },
  handler: async (ctx, args) => {
    authorizeImport(args.secret);
    const state = await workerState(ctx);
    if (!state || state.importManifestId !== args.manifestId || state.importExpectedSources !== state.importCompletedSources)
      throw new Error("lifetime volume import is incomplete");
    const rows = await ctx.db.query("tokenLifetimeVolumes").collect();
    const covered = rows.filter(row => row.backfillManifestId === args.manifestId && row.lastSuccessAt !== undefined && row.enabled !== false);
    for (const row of rows) if (row.enabled !== false && row.backfillManifestId !== args.manifestId) {
      await ctx.db.patch(row._id, { enabled: false, nextCheckAt: Number.MAX_SAFE_INTEGER, updatedAt: Date.now() });
    }
    const summary = lifetimeVolumeSummary(covered);
    const cache = await ctx.db.query("platformStatsCache").withIndex("by_key", q => q.eq("key", "public")).unique();
    if (!cache) throw new Error("platform stats cache is missing");
    await ctx.db.patch(cache._id, { lifetimeVolumeUsd: summary.totalUsd, lifetimeVolumeCoverage: summary.tokenCoverage,
      marketUpdatedAt: Date.now(), computedAt: Date.now() });
    await ctx.db.patch(state._id, { importManifestId: undefined, importCutoffHour: undefined, importExpectedSources: undefined,
      importCompletedSources: undefined, blockedUntil: 0, lastError: undefined, updatedAt: Date.now() });
    await scheduleWorker(ctx, { ...state, importManifestId: undefined, blockedUntil: 0 }, Date.now() + LIFETIME_VOLUME_REFRESH_MS);
    return summary;
  },
});

export const ingestCandles = internalMutation({
  args: {
    leaseToken: v.optional(v.string()),
    candidate: resolvedCandidateValidator,
    candles: v.array(v.object({ hourStartedAt: v.number(), volumeUsd: v.number() })),
    requestedHistoricalPage: v.boolean(),
    resultCount: v.number(),
  },
  handler: async (ctx, { leaseToken, candidate, candles, requestedHistoricalPage, resultCount }) => {
    if (!await ownsLease(ctx, leaseToken)) return { ignored: true, backfillComplete: true };
    const now = Date.now();
    const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const launchHour = Math.floor(candidate.launchCreatedAt / HOUR_MS) * HOUR_MS;
    const normalizedPoolAddress = candidate.poolAddress.toLowerCase();
    const existing = await ctx.db.query("tokenLifetimeVolumes").withIndex("by_pool", (q) => q.eq("normalizedPoolAddress", normalizedPoolAddress)).unique();
    if (!existing || existing.enabled !== true || candidate.checkpointRevision !== (existing.revision ?? 0)) {
      return { ignored: true, backfillComplete: true };
    }
    const eligible = candles.filter((item) => item.hourStartedAt >= launchHour && item.hourStartedAt <= currentHour);
    const completed = eligible.filter((item) => item.hourStartedAt < currentHour);
    const provisionalVolumeUsd = requestedHistoricalPage
      ? existing?.provisionalVolumeUsd ?? 0
      : eligible.find((item) => item.hourStartedAt === currentHour)?.volumeUsd ?? 0;
    let confirmedVolumeUsd = existing?.confirmedVolumeUsd ?? 0;
    let recent = parseRecentHours(existing?.recentHoursJson);
    let oldestBackfilledHour = existing?.oldestBackfilledHour;
    let latestCompletedHour = existing?.latestCompletedHour;

    if (requestedHistoricalPage) {
      for (const candle of completed) {
        // Historical pages are non-overlapping because the next request uses
        // one second before the oldest returned candle. The first/latest page
        // may overlap recent corrections, so retain those hours for delta updates.
        confirmedVolumeUsd += candle.volumeUsd;
        recent.set(candle.hourStartedAt, candle.volumeUsd);
      }
    } else {
      for (const candle of completed) {
        const previous = recent.get(candle.hourStartedAt);
        if (previous !== undefined) confirmedVolumeUsd += candle.volumeUsd - previous;
        else if (latestCompletedHour === undefined || candle.hourStartedAt > latestCompletedHour) confirmedVolumeUsd += candle.volumeUsd;
        recent.set(candle.hourStartedAt, candle.volumeUsd);
      }
    }
    if (completed.length) {
      const oldest = Math.min(...completed.map((item) => item.hourStartedAt));
      const latest = Math.max(...completed.map((item) => item.hourStartedAt));
      oldestBackfilledHour = oldestBackfilledHour === undefined ? oldest : Math.min(oldestBackfilledHour, oldest);
      latestCompletedHour = latestCompletedHour === undefined ? latest : Math.max(latestCompletedHour, latest);
    }
    recent = new Map([...recent.entries()].filter(([hour]) => latestCompletedHour === undefined || hour >= latestCompletedHour - 72 * HOUR_MS));
    const reachedLaunch = oldestBackfilledHour !== undefined && oldestBackfilledHour <= launchHour;
    const pageLimit = requestedHistoricalPage ? LIFETIME_VOLUME_HISTORICAL_CANDLE_LIMIT : LIFETIME_VOLUME_RECENT_CANDLE_LIMIT;
    const backfillComplete = (existing?.backfillComplete ?? false) || resultCount < pageLimit || reachedLaunch;
    const backfillBeforeTimestamp = backfillComplete || oldestBackfilledHour === undefined
      ? undefined
      : Math.floor(oldestBackfilledHour / 1_000) - 1;
    const frozen = candidate.source === "bonding_curve" && candidate.freezeWhenComplete && backfillComplete;
    const values = {
      tokenAddress: candidate.tokenAddress, normalizedTokenAddress: candidate.tokenAddress.toLowerCase(),
      source: candidate.source, frozen,
      poolAddress: candidate.poolAddress, normalizedPoolAddress, launchCreatedAt: candidate.launchCreatedAt,
      confirmedVolumeUsd: Math.max(0, confirmedVolumeUsd), provisionalVolumeUsd: Math.max(0, provisionalVolumeUsd),
      recentHoursJson: serializeRecentHours(recent), oldestBackfilledHour, latestCompletedHour,
      backfillBeforeTimestamp, backfillComplete,
      nextCheckAt: frozen ? Number.MAX_SAFE_INTEGER : now + (backfillComplete ? LIFETIME_VOLUME_REFRESH_MS : LIFETIME_VOLUME_BACKFILL_MS),
      lastAttemptAt: now, lastSuccessAt: now, lastError: undefined, updatedAt: now,
      revision: (existing.revision ?? 0) + 1,
    };
    await ctx.db.patch(existing._id, values);
    // Apply only this source's delta. This avoids re-reading all wallets, transactions,
    // launches and prices after every batch (including failed/empty batches).
    const cache = await ctx.db.query("platformStatsCache").withIndex("by_key", q => q.eq("key", "public")).unique();
    if (cache && Number.isFinite(cache.lifetimeVolumeUsd)) {
      const previous = existing.lastSuccessAt === undefined ? 0 : existing.confirmedVolumeUsd + existing.provisionalVolumeUsd;
      const delta = values.confirmedVolumeUsd + values.provisionalVolumeUsd - previous;
      const otherSources = existing.lastSuccessAt === undefined
        ? await ctx.db.query("tokenLifetimeVolumes").withIndex("by_token", q => q.eq("normalizedTokenAddress", existing.normalizedTokenAddress)).collect() : [];
      const firstCoverage = existing.lastSuccessAt === undefined && !otherSources.some(row => row._id !== existing._id && row.lastSuccessAt !== undefined);
      if (delta !== 0 || firstCoverage) await ctx.db.patch(cache._id, {
        lifetimeVolumeUsd: Math.max(0, cache.lifetimeVolumeUsd! + delta),
        lifetimeVolumeCoverage: (cache.lifetimeVolumeCoverage ?? 0) + (firstCoverage ? 1 : 0),
        marketUpdatedAt: Math.max(cache.marketUpdatedAt, now),
      });
    }
    return { backfillComplete, frozen, confirmedVolumeUsd: values.confirmedVolumeUsd, provisionalVolumeUsd: values.provisionalVolumeUsd };
  },
});

export const finishBatch = internalMutation({
  args: { leaseToken: v.string(), checked: v.number(), throttled: v.boolean(), budgetDeferred: v.optional(v.boolean()), retryAfterMs: v.optional(v.number()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!await ownsLease(ctx, args.leaseToken)) return false;
    const state = (await workerState(ctx))!, now = Date.now();
    const throttleCount = args.budgetDeferred ? 0 : args.throttled ? state.throttleCount + 1 : args.checked ? 0 : state.throttleCount;
    const blockedUntil = args.throttled ? now + volumeRetryDelay(throttleCount, args.retryAfterMs)
      : args.budgetDeferred ? now + Math.max(60_000, args.retryAfterMs ?? 0) : args.error ? now + 5 * 60_000 : 0;
    const first = await ctx.db.query("tokenLifetimeVolumes").withIndex("by_enabled_due", q => q.eq("enabled", true)).first();
    const nextDiscovery = (state.discoveryAt ?? 0) + LIFETIME_VOLUME_DISCOVERY_MS;
    const nextAt = Math.max(now + REQUEST_SPACING_MS, blockedUntil, Math.min(first?.nextCheckAt ?? nextDiscovery, nextDiscovery));
    await ctx.db.patch(state._id, {
      leaseToken: undefined, leaseUntil: undefined, blockedUntil, throttleCount,
      lastCompletedAt: now, lastError: args.error ?? (args.throttled ? "Gecko OHLCV throttled" : undefined), updatedAt: now,
    });
    await scheduleWorker(ctx, { ...state, blockedUntil }, nextAt);
    return true;
  },
});

// Intentionally inert: existing queued jobs use this exact no-argument entrypoint.
// They drain once after deployment and cannot create another continuation chain.
// Manual refreshes now use requestRefresh, which coalesces with the single worker.
export const refreshLifetimeVolume = internalAction({
  args: {},
  handler: async () => ({ checked: 0, hasMore: false, status: "legacy_continuation_retired" }),
});

export const runRefreshBatch = internalAction({
  args: { generation: v.number() },
  handler: async (ctx, { generation }): Promise<{ checked: number; status: string }> => {
    const work = await ctx.runMutation(internal.lifetimeVolume.beginBatch, { generation });
    if (!work) return { checked: 0, status: "coalesced" };
    let checked = 0, throttled = false, budgetDeferred = false;
    let retryAfterMs: number | undefined, batchError: string | undefined;
    const { leaseToken } = work;
    try {
      if (work.discover) {
        const unresolved = await ctx.runMutation(internal.lifetimeVolume.discoverSources, { leaseToken });
        if (unresolved.length) {
          const config = await ctx.runQuery(internal.registry.runtimeConfig, {});
          const factory = config.contracts.pons_v2_factory as Address | undefined;
          if (!factory) throw new Error("Pons V2 factory is missing from the contract registry");
          const rpc = createPublicClient({ transport: reliableHttp(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 12_000 }) });
          const hook = await rpc.readContract({ address: factory, abi: factoryAbi, functionName: "memeHook" });
          for (const candidate of unresolved) {
            if (Date.now() > work.leaseUntil - 45_000) break;
            try {
              const state = await rpc.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [candidate.tokenAddress as Address] });
              if (!state.exists || state.phase !== 2) continue;
              await ctx.runMutation(internal.lifetimeVolume.registerResolvedSource, { leaseToken, candidate: {
                ...candidate, pairToken: state.pairToken,
                poolAddress: ponsV4PoolId(candidate.tokenAddress as Address, state.pairToken, state.poolFee, state.tickSpacing, hook),
              } });
            } catch {
              // Retry unresolved sources at the next discovery, not in a hot loop.
            }
          }
        }
      }
      const { pools } = await ctx.runQuery(internal.lifetimeVolume.duePools, {});
      for (const [index, candidate] of pools.entries()) {
        if (Date.now() > work.leaseUntil - 30_000) break;
        if (candidate.volumeProvider === "onchain") {
          const through = Math.floor((Date.now() - 5 * 60_000) / 300_000) * 300_000;
          const overlapStart = Math.max(candidate.onchainTrackingStartedAt ?? candidate.launchCreatedAt,
            (candidate.bucketedThroughAt ?? candidate.launchCreatedAt) - 72 * HOUR_MS);
          const bucketed = await ctx.runQuery(internal.lifetimeVolume.onchainBuckets, {
            tokenAddress: candidate.tokenAddress, after: overlapStart, through,
          });
          if (await ctx.runMutation(internal.lifetimeVolume.ingestOnchainBuckets, { leaseToken, candidate, rows: bucketed.rows, through })) checked++;
          continue;
        }
        const requestedHistoricalPage = !candidate.backfillComplete && candidate.backfillBeforeTimestamp !== undefined;
        const candleLimit = requestedHistoricalPage
          ? LIFETIME_VOLUME_HISTORICAL_CANDLE_LIMIT
          : lifetimeVolumeRecentCandleLimit(candidate.lastSuccessAt);
        // A stable minute key lets concurrent consumers reuse a fetched latest page.
        const before = requestedHistoricalPage ? candidate.backfillBeforeTimestamp : Math.floor(Date.now() / 60_000) * 60 + 1;
        const url = `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${candidate.poolAddress.toLowerCase()}/ohlcv/hour?aggregate=1&before_timestamp=${before}&limit=${candleLimit}&currency=usd`;
        try {
          // Lifetime volume intentionally remains on the public GeckoTerminal
          // allowance and cannot consume paid CoinGecko credits.
          const response = await geckoSharedFetch(url, 60_000, 15_000, false, true, undefined, "background", "free");
          if (response.status === 429) {
            retryAfterMs = volumeRetryAfterMs(response.headers.get("retry-after"), Date.now());
            if (response.headers.get("x-gecko-local-deferral") === "1") {
              // No provider request occurred. Yield to live pages without marking
              // this token failed or escalating a local budget denial to 30 minutes.
              budgetDeferred = true;
              break;
            }
            await ctx.runMutation(internal.lifetimeVolume.recordAttemptFailure, {
              leaseToken, candidate, error: "GeckoTerminal OHLCV 429", retryAfterMs,
            });
            throttled = true;
            break;
          }
          if (!response.ok) throw new Error(`GeckoTerminal OHLCV ${response.status}`);
          const payload = await response.json() as { data?: { attributes?: { ohlcv_list?: unknown } } };
          if (!Array.isArray(payload.data?.attributes?.ohlcv_list)) throw new Error("GeckoTerminal OHLCV invalid response");
          const candles = parseOhlcvCandles(payload.data.attributes.ohlcv_list);
          if (payload.data.attributes.ohlcv_list.length && !candles.length) throw new Error("GeckoTerminal OHLCV invalid candles");
          if (!candidate.backfillComplete && candles.length === 0) {
            throw new Error("GeckoTerminal OHLCV empty; onchain historical backfill required");
          }
          const result = await ctx.runMutation(internal.lifetimeVolume.ingestCandles, {
            leaseToken, candidate, candles, requestedHistoricalPage, resultCount: candles.length,
          });
          if ("ignored" in result) break;
          checked += 1;
        } catch (error) {
          await ctx.runMutation(internal.lifetimeVolume.recordAttemptFailure, {
            leaseToken, candidate, error: error instanceof Error ? error.message : "Unknown GeckoTerminal OHLCV failure",
          });
        }
        if (index < pools.length - 1) await new Promise(resolve => setTimeout(resolve, REQUEST_SPACING_MS));
      }
    } catch (error) {
      batchError = error instanceof Error ? error.message.slice(0, 300) : "Volume worker failed";
    } finally {
      await ctx.runMutation(internal.lifetimeVolume.finishBatch, { leaseToken, checked, throttled, budgetDeferred, retryAfterMs, error: batchError });
    }
    return { checked, status: batchError ? "retry_scheduled" : budgetDeferred ? "budget_deferred" : throttled ? "rate_limited" : "completed" };
  },
});
