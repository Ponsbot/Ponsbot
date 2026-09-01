/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
const mocks = vi.hoisted(() => ({ gecko: vi.fn() }));
vi.mock("../lib/gecko-shared", () => ({ geckoSharedFetch: mocks.gecko }));
import * as volume from "../convex/lifetimeVolume";
import { HOUR_MS, LIFETIME_VOLUME_BACKFILL_MS, LIFETIME_VOLUME_BATCH_LIMIT, LIFETIME_VOLUME_DISCOVERY_MS, LIFETIME_VOLUME_LEASE_MS, LIFETIME_VOLUME_RECENT_CANDLE_LIMIT, LIFETIME_VOLUME_REFRESH_MS, lifetimeVolumeRecentCandleLimit, volumeRetryDelay, volumeRetryAfterMs } from "../lib/lifetime-volume";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const handler = (f: any) => f._handler;
const start = 1_800_000_000_000;
const copy = (x: any) => x === undefined ? undefined : structuredClone(x);
function fixture() {
  const tables: Record<string, any[]> = {}, jobs = new Map<string, any>(), operations: string[] = [];
  let idSequence = 0;
  const db: any = {
    query(table: string) {
      const tests: Array<(r: any) => boolean> = []; let sortKey: string | undefined;
      const b: any = {};
      for (const op of ["eq", "lte", "gt"]) b[op] = (key: string, value: any) => { tests.push(r => op === "eq" ? r[key] === value : op === "lte" ? r[key] <= value : r[key] > value); return b; };
      const results = () => [...(tables[table] ?? [])].filter(r => tests.every(t => t(r))).sort((a, b) => sortKey ? a[sortKey] - b[sortKey] : 0);
      const result = (op: string, n?: number) => { operations.push(`${table}:${op}`); const rows = results(); return copy(n === undefined ? rows : rows.slice(0, n)); };
      const q: any = { withIndex: (name: string, f?: any) => { if (name.endsWith("_due")) sortKey = "nextCheckAt"; f?.(b); return q; },
        collect: async () => result("collect"), take: async (n: number) => result("take", n),
        first: async () => result("first", 1)[0] ?? null, unique: async () => { const rows = result("unique"); if (rows.length > 1) throw new Error("duplicate"); return rows[0] ?? null; } };
      return q;
    },
    get: async (id: string) => copy(Object.values(tables).flat().find(r => r._id === id) ?? null),
    insert: async (table: string, row: any) => { const id = `${table}-${++idSequence}`; (tables[table] ??= []).push({ _id: id, ...copy(row) }); return id; },
    patch: async (id: string, fields: any) => { const row = Object.values(tables).flat().find(r => r._id === id); if (!row) throw new Error("missing row"); Object.assign(row, copy(fields)); },
    system: { get: async (id: string) => copy(jobs.get(id) ?? null) },
  };
  const scheduler = { runAt: vi.fn(async (when: number, ref: any, args: any) => { const id = `job-${++idSequence}`; jobs.set(id, { id, at: when, ref: getFunctionName(ref), args, state: { kind: "pending" } }); return id; }),
    cancel: vi.fn(async (id: string) => { jobs.get(id).state.kind = "canceled"; }) };
  const ctx: any = { db, scheduler };
  const mutations: string[] = [];
  ctx.runMutation = async (ref: any, args: any) => { const name = getFunctionName(ref); mutations.push(name); return handler((volume as any)[name.split(":")[1]])(ctx, args); };
  ctx.runQuery = async (ref: any, args: any) => handler((volume as any)[getFunctionName(ref).split(":")[1]])(ctx, args);
  const call = (name: keyof typeof volume, args: any = {}) => {
    if (name === "runRefreshBatch" || name === "beginBatch") {
      const job = [...jobs.values()].find(j => j.args.generation === args.generation && j.state.kind === "pending");
      if (job) job.state.kind = "inProgress";
    }
    return handler(volume[name])(ctx, args);
  };
  const state = () => tables.lifetimeVolumeWorker?.[0];
  const pending = () => [...jobs.values()].filter(j => j.state.kind === "pending");
  const begin = async () => { await call("requestRefresh"); const row = state(); jobs.get(row.scheduledId).state.kind = "inProgress"; return call("beginBatch", { generation: row.generation }); };
  const add = (n: number, fields: any = {}) => db.insert("tokenLifetimeVolumes", {
    tokenAddress: addr(n), normalizedTokenAddress: addr(n), poolAddress: addr(n + 100), normalizedPoolAddress: addr(n + 100),
    source: "bonding_curve", enabled: true, pairToken: addr(0), frozen: false, launchCreatedAt: start - 10 * HOUR_MS,
    confirmedVolumeUsd: 0, provisionalVolumeUsd: 0, recentHoursJson: "[]", backfillComplete: true,
    nextCheckAt: Date.now(), createdAt: start, updatedAt: start, ...fields,
  });
  const launch = (n: number, fields: any = {}) => db.insert("tokenLaunches", { tokenAddress: addr(n), normalizedTokenAddress: addr(n), poolAddress: addr(n + 100), publicPublished: true, createdAt: start - 10 * HOUR_MS, ...fields });
  return { ctx, db, tables, operations, jobs, mutations, state, pending, begin, add, launch, call };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); mocks.gecko.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("one durable volume worker", () => {
  it("yields for a minute on local budget denial without escalating provider throttling", async () => {
    const f = fixture(); await f.add(1); const work = await f.begin();
    await f.db.patch(f.state()._id, { throttleCount: 26, discoveryAt: start });
    await f.call("finishBatch", { leaseToken: work.leaseToken, checked: 0, throttled: false, budgetDeferred: true, retryAfterMs: 60_000 });
    expect(f.state().throttleCount).toBe(0);
    expect(f.state().lastError).toBeUndefined();
    expect(f.pending()).toHaveLength(1);
    expect(f.pending()[0].at).toBe(start + 60_000);
  });
  it("uses a sparse cumulative-stat cadence and bounded batches", () => {
    expect(LIFETIME_VOLUME_REFRESH_MS).toBe(6 * HOUR_MS);
    expect(LIFETIME_VOLUME_DISCOVERY_MS).toBe(6 * HOUR_MS);
    expect(LIFETIME_VOLUME_BACKFILL_MS).toBe(30 * 60_000);
    expect(LIFETIME_VOLUME_RECENT_CANDLE_LIMIT).toBe(8);
    expect(LIFETIME_VOLUME_BATCH_LIMIT).toBe(12);
  });
  it("honors numeric and HTTP-date retry headers", () => {
    expect(volumeRetryAfterMs("300", start)).toBe(300_000);
    expect(volumeRetryAfterMs(new Date(start + 600_000).toUTCString(), start)).toBe(600_000);
    expect(volumeRetryAfterMs("invalid", start)).toBe(90_000);
  });
  it("expands the small recent page after an outage so cumulative volume has no gap", () => {
    expect(lifetimeVolumeRecentCandleLimit(start - 3 * HOUR_MS, start)).toBe(LIFETIME_VOLUME_RECENT_CANDLE_LIMIT);
    expect(lifetimeVolumeRecentCandleLimit(start - 20 * HOUR_MS, start)).toBe(22);
  });
  it("retires all old continuations without queries, fetches or scheduling", async () => {
    const f = fixture(); for (let i = 0; i < 7; i++) expect(await f.call("refreshLifetimeVolume")).toMatchObject({ hasMore: false });
    expect(f.operations).toEqual([]); expect(f.pending()).toEqual([]); expect(mocks.gecko).not.toHaveBeenCalled();
  });
  it("coalesces seven refresh requests into one scheduled worker", async () => {
    const f = fixture(); for (let i = 0; i < 7; i++) await f.call("requestRefresh"); expect(f.pending()).toHaveLength(1);
    const generation = f.state().generation; const work = await f.begin();
    expect(work.leaseToken).toBe(String(generation)); expect(await f.call("beginBatch", { generation })).toBeNull();
    expect(await f.call("requestRefresh")).toEqual({ status: "already_running" }); expect(f.pending()).toHaveLength(1);
  });
  it("replaces the watchdog with one continuation and ignores duplicate finishes", async () => {
    const f = fixture(); await f.add(1, { nextCheckAt: start + 20 * 60_000 }); const work = await f.begin();
    await f.db.patch(f.state()._id, { discoveryAt: start });
    expect(await f.call("finishBatch", { leaseToken: work.leaseToken, checked: 0, throttled: false })).toBe(true);
    expect(f.pending()).toHaveLength(1); expect(f.pending()[0].at).toBe(start + 20 * 60_000);
    expect(await f.call("finishBatch", { leaseToken: work.leaseToken, checked: 0, throttled: false })).toBe(false);
    expect(f.pending()).toHaveLength(1);
  });
  it("recovers a crashed worker while fencing late responses from the old worker", async () => {
    const f = fixture(); await f.add(1); const old = await f.begin(); const candidate = (await f.call("duePools")).pools[0];
    vi.setSystemTime(start + LIFETIME_VOLUME_LEASE_MS + 1_001);
    const next = await f.call("beginBatch", { generation: f.state().generation }); expect(next.leaseToken).not.toBe(old.leaseToken);
    expect(await f.call("ingestCandles", { leaseToken: old.leaseToken, candidate, candles: [], requestedHistoricalPage: false, resultCount: 0 })).toMatchObject({ ignored: true });
    expect(await f.call("finishBatch", { leaseToken: old.leaseToken, checked: 1, throttled: false })).toBe(false);
    expect(f.state().leaseToken).toBe(next.leaseToken);
    expect(f.pending()).toHaveLength(1);
  });
  it("honors shared exponential backoff and cannot bypass it via cron/manual wakeups", async () => {
    const f = fixture(); await f.add(1); const first = await f.begin();
    await f.call("finishBatch", { leaseToken: first.leaseToken, checked: 0, throttled: true });
    expect(f.state().blockedUntil).toBe(start + 90_000);
    for (let i = 0; i < 7; i++) await f.call("requestRefresh"); expect(f.pending()).toHaveLength(1);
    expect(f.pending()[0].at).toBe(start + 90_000);
    await f.call("retryRateLimitedCheckpoints"); expect(f.pending()[0].at).toBe(start + 90_000);
    vi.setSystemTime(start + 90_000); const second = await f.begin();
    await f.call("finishBatch", { leaseToken: second.leaseToken, checked: 0, throttled: true });
    expect(f.state().blockedUntil).toBe(start + 270_000);
    expect(volumeRetryDelay(20)).toBe(30 * 60_000); expect(volumeRetryDelay(2, 45 * 60_000)).toBe(45 * 60_000);
  });
});

describe("discovery and due-time indexing", () => {
  it("preserves historical totals while migrating to the six-hour target", async () => {
    const f = fixture(); await f.launch(1); await f.launch(2);
    await f.add(1, { enabled: undefined, pairToken: undefined, confirmedVolumeUsd: 999, lastSuccessAt: start - HOUR_MS, nextCheckAt: start + 2 * HOUR_MS });
    await f.add(2, { lastError: "429", nextCheckAt: start + 5 * 60_000 }); const work = await f.begin();
    await f.call("discoverSources", work);
    expect(f.tables.tokenLifetimeVolumes[0]).toMatchObject({ confirmedVolumeUsd: 999, enabled: true, nextCheckAt: start + 2 * HOUR_MS });
    expect(f.tables.tokenLifetimeVolumes[1].nextCheckAt).toBe(start + 5 * 60_000);
  });
  it("never processes private, excluded or orphaned sources", async () => {
    const f = fixture(); await f.launch(1, { publicPublished: false }); await f.add(1); await f.launch(2);
    await f.add(2, { source: "v4_pool", poolAddress: addr(300), normalizedPoolAddress: addr(300) });
    const work = await f.begin(); await f.call("discoverSources", work);
    expect(f.tables.tokenLifetimeVolumes.slice(0, 2).every(r => r.enabled === false)).toBe(true);
    expect((await f.call("duePools")).pools).toHaveLength(1);
  });
  it("pins graduation observation instead of restarting the grace period on every refresh", async () => {
    const f = fixture(); await f.launch(1, { publicGraduated: true }); await f.add(1); const work = await f.begin();
    expect(await f.call("discoverSources", work)).toHaveLength(1); expect(f.tables.tokenLifetimeVolumes[0].graduationObservedAt).toBe(start);
    vi.setSystemTime(start + 60_000); await f.call("discoverSources", work); expect(f.tables.tokenLifetimeVolumes[0].graduationObservedAt).toBe(start);
  });
  it("cannot register a source after its launch becomes private or is removed", async () => {
    const f = fixture(); const id = await f.launch(1, { publicGraduated: true }); const work = await f.begin();
    const candidates = await f.call("discoverSources", work); await f.db.patch(id, { publicPublished: false });
    await f.call("registerResolvedSource", { leaseToken: work.leaseToken, candidate: { ...candidates[0], poolAddress: addr(300) } });
    expect(f.tables.tokenLifetimeVolumes).toHaveLength(1);
  });
  it("reads only a bounded due batch, without full catalog scans", async () => {
    const f = fixture(); for (let n = 1; n < 50; n++) await f.add(n); f.operations.length = 0;
    const due = await f.call("duePools"); expect(due.pools).toHaveLength(12); expect(due.hasMore).toBe(true);
    expect(f.operations).toEqual(["tokenLifetimeVolumes:take"]);
  });
  it("does not hot-loop over disabled sources with stale due dates", async () => {
    const f = fixture(); await f.add(1, { enabled: false, nextCheckAt: start - HOUR_MS }); await f.add(2, { nextCheckAt: start + HOUR_MS });
    expect((await f.call("duePools")).pools).toEqual([]); const work = await f.begin();
    await f.db.patch(f.state()._id, { discoveryAt: start });
    await f.call("finishBatch", { leaseToken: work.leaseToken, checked: 0, throttled: false });
    expect(f.state().scheduledAt).toBe(start + HOUR_MS);
  });
});

describe("atomic incremental volume accounting", () => {
  it("imports a manifest idempotently, fences the worker, and resumes from its cutoff", async () => {
    const previous = process.env.MARKET_INDEX_SECRET; process.env.MARKET_INDEX_SECRET = "import-secret";
    try {
      const f = fixture();
      await f.db.insert("platformStatsCache", { key: "public", launches: 1, wallets: 1, lifetimeVolumeUsd: 10, lifetimeVolumeCoverage: 1,
        feesClaimedJson: "[]", feesClaimedUsd: 0, feeClaimTransactions: 0, marketUpdatedAt: start, computedAt: start });
      await f.add(2, { confirmedVolumeUsd: 500, lastSuccessAt: start - 1 });
      await f.call("requestRefresh");
      const manifestId = "a".repeat(64), cutoffHour = Math.floor(start / HOUR_MS) * HOUR_MS;
      await f.call("beginBackfillImport", { secret: "import-secret", manifestId, cutoffHour, expectedSources: 1 });
      expect(await f.call("beginBatch", { generation: f.state().generation })).toBeNull();
      const entry = { tokenAddress: addr(1), poolAddress: addr(101), pairToken: addr(0), source: "bonding_curve",
        launchCreatedAt: cutoffHour - HOUR_MS, confirmedVolumeUsd: 75, recentHoursJson: JSON.stringify([[cutoffHour - HOUR_MS, 75]]),
        oldestBackfilledHour: cutoffHour - HOUR_MS, latestCompletedHour: cutoffHour, volumeProvider: "gecko", frozen: false };
      expect(await f.call("importBackfillBatch", { secret: "import-secret", manifestId, entries: [entry] })).toMatchObject({ completedSources: 1 });
      expect(await f.call("importBackfillBatch", { secret: "import-secret", manifestId, entries: [entry] })).toMatchObject({ completedSources: 1 });
      expect(await f.call("finalizeBackfillImport", { secret: "import-secret", manifestId })).toMatchObject({ totalUsd: 75, tokenCoverage: 1 });
      expect(f.tables.platformStatsCache[0]).toMatchObject({ lifetimeVolumeUsd: 75, lifetimeVolumeCoverage: 1 });
      expect(f.tables.tokenLifetimeVolumes.find(row => row.normalizedTokenAddress === addr(1))).toMatchObject({ backfillComplete: true, latestCompletedHour: cutoffHour, volumeProvider: "gecko" });
      expect(f.tables.tokenLifetimeVolumes.find(row => row.normalizedTokenAddress === addr(2))).toMatchObject({ enabled: false });
      expect(f.state().importManifestId).toBeUndefined(); expect(f.pending()).toHaveLength(1);
    } finally { process.env.MARKET_INDEX_SECRET = previous; }
  });
  it("adds only new indexed buckets for an onchain fallback source", async () => {
    const f = fixture(), cutoff = Math.floor(start / 300_000) * 300_000 - 600_000;
    await f.add(1, { volumeProvider: "onchain", bucketedThroughAt: cutoff, onchainTrackingStartedAt: cutoff, confirmedVolumeUsd: 100, lastSuccessAt: start - 1 });
    await f.db.insert("tokenVolumeBuckets", { normalizedTokenAddress: addr(1), hourStartedAt: cutoff + 300_000, volumeUsd: 7, updatedAt: start });
    await f.db.insert("tokenVolumeBuckets", { normalizedTokenAddress: addr(1), hourStartedAt: cutoff + 600_000, volumeUsd: 5, updatedAt: start });
    await f.db.insert("platformStatsCache", { key: "public", lifetimeVolumeUsd: 100, lifetimeVolumeCoverage: 1, marketUpdatedAt: start });
    const work = await f.begin(), candidate = (await f.call("duePools")).pools[0];
    const buckets = await f.call("onchainBuckets", { tokenAddress: addr(1), after: cutoff, through: cutoff + 600_000 });
    expect(buckets.rows).toHaveLength(2);
    expect(await f.call("ingestOnchainBuckets", { leaseToken: work.leaseToken, candidate, rows: buckets.rows, through: buckets.through })).toBe(true);
    expect(f.tables.tokenLifetimeVolumes[0]).toMatchObject({ confirmedVolumeUsd: 112, bucketedThroughAt: cutoff + 600_000 });
    expect(f.tables.platformStatsCache[0].lifetimeVolumeUsd).toBe(112);
    await f.db.patch(f.tables.tokenVolumeBuckets[0]._id, { volumeUsd: 9 });
    const revised = await f.call("onchainBuckets", { tokenAddress: addr(1), after: cutoff, through: cutoff + 600_000 });
    const revisedCandidate = { ...candidate, checkpointRevision: f.tables.tokenLifetimeVolumes[0].revision };
    expect(await f.call("ingestOnchainBuckets", { leaseToken: work.leaseToken, candidate: revisedCandidate, rows: revised.rows, through: revised.through })).toBe(true);
    expect(f.tables.tokenLifetimeVolumes[0].confirmedVolumeUsd).toBe(114);
  });
  it("moves provisional volume into the completed total without counting it twice", async () => {
    const f = fixture(); const hour = Math.floor(start / HOUR_MS) * HOUR_MS;
    await f.add(1, { confirmedVolumeUsd: 100, provisionalVolumeUsd: 5, lastSuccessAt: start - 1 });
    await f.db.insert("platformStatsCache", { key: "public", lifetimeVolumeUsd: 105, lifetimeVolumeCoverage: 1, marketUpdatedAt: start });
    vi.setSystemTime(start + HOUR_MS); const work = await f.begin();
    await f.call("ingestCandles", { leaseToken: work.leaseToken, candidate: (await f.call("duePools")).pools[0], candles: [{ hourStartedAt: hour, volumeUsd: 7 }], requestedHistoricalPage: false, resultCount: 1 });
    expect(f.tables.platformStatsCache[0].lifetimeVolumeUsd).toBe(107);
    expect(f.tables.tokenLifetimeVolumes[0]).toMatchObject({ confirmedVolumeUsd: 107, provisionalVolumeUsd: 0 });
  });
  it("adds first-token coverage once, including a legitimate empty initial response", async () => {
    const f = fixture(); await f.add(1); await f.db.insert("platformStatsCache", { key: "public", lifetimeVolumeUsd: 100, lifetimeVolumeCoverage: 1, marketUpdatedAt: start });
    const work = await f.begin(); const args = { leaseToken: work.leaseToken, candidate: (await f.call("duePools")).pools[0], candles: [], requestedHistoricalPage: false, resultCount: 0 };
    await f.call("ingestCandles", args); await f.call("ingestCandles", args);
    expect(f.tables.platformStatsCache[0]).toMatchObject({ lifetimeVolumeUsd: 100, lifetimeVolumeCoverage: 2 });
  });
  it("updates only the volume fields and applies historical corrections and current-hour deltas", async () => {
    const f = fixture(); const hour = Math.floor(start / HOUR_MS) * HOUR_MS;
    await f.add(1, { confirmedVolumeUsd: 100, provisionalVolumeUsd: 5, lastSuccessAt: start - 1000, recentHoursJson: JSON.stringify([[hour - HOUR_MS, 40]]), latestCompletedHour: hour - HOUR_MS });
    await f.db.insert("platformStatsCache", { key: "public", lifetimeVolumeUsd: 1000, lifetimeVolumeCoverage: 3, wallets: 42, feesClaimedUsd: 500, marketUpdatedAt: start - 1000, computedAt: start - 1000 });
    const work = await f.begin(), candidate = (await f.call("duePools")).pools[0]; f.operations.length = 0;
    await f.call("ingestCandles", { leaseToken: work.leaseToken, candidate, candles: [{ hourStartedAt: hour - HOUR_MS, volumeUsd: 45 }, { hourStartedAt: hour, volumeUsd: 8 }], requestedHistoricalPage: false, resultCount: 2 });
    expect(f.tables.platformStatsCache[0]).toMatchObject({ lifetimeVolumeUsd: 1008, lifetimeVolumeCoverage: 3, wallets: 42, feesClaimedUsd: 500, computedAt: start - 1000 });
    expect(f.tables.tokenLifetimeVolumes[0].nextCheckAt).toBe(start + LIFETIME_VOLUME_REFRESH_MS);
    expect(f.operations.some(x => /cryptoWallets|walletTransactions|marketPriceCache|tokenLaunches/.test(x))).toBe(false);
  });
  it("counts a graduated token once across curve and V4 sources", async () => {
    const f = fixture(); await f.add(1, { lastSuccessAt: start - 1, nextCheckAt: start + HOUR_MS });
    await f.add(1, { source: "v4_pool", poolAddress: addr(300), normalizedPoolAddress: addr(300) });
    await f.db.insert("platformStatsCache", { key: "public", lifetimeVolumeUsd: 100, lifetimeVolumeCoverage: 1, marketUpdatedAt: start });
    const work = await f.begin(); await f.call("ingestCandles", { leaseToken: work.leaseToken, candidate: (await f.call("duePools")).pools[0], candles: [{ hourStartedAt: start - HOUR_MS, volumeUsd: 25 }], requestedHistoricalPage: false, resultCount: 1 });
    expect(f.tables.platformStatsCache[0]).toMatchObject({ lifetimeVolumeUsd: 125, lifetimeVolumeCoverage: 1 });
  });
  it("rejects a duplicate historical page even when timestamps have not advanced", async () => {
    const f = fixture(); await f.add(1, { backfillComplete: false, backfillBeforeTimestamp: Math.floor(start / 1000), confirmedVolumeUsd: 100, lastSuccessAt: start });
    const work = await f.begin(); const args = { leaseToken: work.leaseToken, candidate: (await f.call("duePools")).pools[0], candles: [{ hourStartedAt: start - HOUR_MS, volumeUsd: 25 }], requestedHistoricalPage: true, resultCount: 1 };
    await f.call("ingestCandles", args); expect(f.tables.tokenLifetimeVolumes[0].confirmedVolumeUsd).toBe(125);
    expect(await f.call("ingestCandles", args)).toMatchObject({ ignored: true }); expect(f.tables.tokenLifetimeVolumes[0].confirmedVolumeUsd).toBe(125);
  });
  it("ignores legacy in-flight ingestion/failures without a worker lease", async () => {
    const f = fixture(); await f.add(1, { confirmedVolumeUsd: 123 }); const candidate = (await f.call("duePools")).pools[0];
    await f.call("ingestCandles", { candidate, candles: [], requestedHistoricalPage: false, resultCount: 0 });
    await f.call("recordAttemptFailure", { candidate, error: "429" });
    expect(f.tables.tokenLifetimeVolumes[0]).toMatchObject({ confirmedVolumeUsd: 123, nextCheckAt: start });
    expect(f.tables.tokenLifetimeVolumes[0].lastError).toBeUndefined();
  });
});

describe("worker integration without external services", () => {
  it("stops on the first 429, preserves all totals and never rebuilds platform stats", async () => {
    const f = fixture(); await f.launch(1); await f.launch(2); await f.add(1, { confirmedVolumeUsd: 100 }); await f.add(2);
    mocks.gecko.mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "180" } }));
    await f.call("requestRefresh"); expect(await f.call("runRefreshBatch", { generation: f.state().generation })).toEqual({ checked: 0, status: "rate_limited" });
    expect(mocks.gecko).toHaveBeenCalledTimes(1); expect(f.pending()).toHaveLength(1);
    expect(f.tables.tokenLifetimeVolumes[0].confirmedVolumeUsd).toBe(100);
    expect(f.state().blockedUntil).toBe(start + 180_000); expect(f.mutations).not.toContain("site:refreshPlatformStatsCache");
  });
  it("rejects malformed OHLCV data instead of clearing valid totals", async () => {
    const f = fixture(); await f.launch(1); await f.add(1, { confirmedVolumeUsd: 123, provisionalVolumeUsd: 4 });
    mocks.gecko.mockResolvedValue(new Response(JSON.stringify({ data: {} })));
    await f.call("requestRefresh"); await f.call("runRefreshBatch", { generation: f.state().generation });
    expect(f.tables.tokenLifetimeVolumes[0]).toMatchObject({ confirmedVolumeUsd: 123, provisionalVolumeUsd: 4, lastError: "GeckoTerminal OHLCV invalid response" });
    expect(f.mutations).not.toContain("site:refreshPlatformStatsCache");
  });
  it("does not silently finish a historical backfill when Gecko has no candles", async () => {
    const f = fixture(); await f.launch(1); await f.add(1, { confirmedVolumeUsd: 123, backfillComplete: false });
    mocks.gecko.mockResolvedValue(new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [] } } })));
    await f.call("requestRefresh"); await f.call("runRefreshBatch", { generation: f.state().generation });
    expect(f.tables.tokenLifetimeVolumes[0]).toMatchObject({ confirmedVolumeUsd: 123, backfillComplete: false,
      lastError: "GeckoTerminal OHLCV empty; onchain historical backfill required" });
  });
  it("successfully refreshes with a small recent page and schedules the next six-hour check", async () => {
    const f = fixture(); await f.launch(1); await f.add(1); const hour = Math.floor(start / HOUR_MS) * HOUR_MS;
    mocks.gecko.mockResolvedValue(new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [[(hour - HOUR_MS) / 1000, 1, 1, 1, 1, 50]] } } })));
    await f.call("requestRefresh"); await f.call("runRefreshBatch", { generation: f.state().generation });
    expect(f.tables.tokenLifetimeVolumes[0].confirmedVolumeUsd).toBe(50); expect(f.state().scheduledAt).toBe(start + LIFETIME_VOLUME_REFRESH_MS);
    expect(String(mocks.gecko.mock.calls[0][0])).toContain(`limit=${LIFETIME_VOLUME_RECENT_CANDLE_LIMIT}`);
    expect(f.mutations).not.toContain("site:refreshPlatformStatsCache");
  });
});
