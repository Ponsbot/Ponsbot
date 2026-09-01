import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as market from "../convex/marketData";
import { recordCatalogMarketSnapshots } from "../convex/site";
import { PAGE_REFRESH_SESSION_MS, pageRefreshActive, reserveProviderAttempt, snapshotFresh } from "../lib/website-refresh-policy";

const token = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const handler = (f: any) => f._handler;
const now = 10_000_000;
function fixture() {
  const rows: Record<string, any[]> = {};
  const db: any = {
    query(table: string) {
      const tests: Array<(row: any) => boolean> = [];
      const b: any = { eq: (key: string, value: any) => { tests.push(r => r[key] === value); return b; }, lt: (key: string, value: any) => { tests.push(r => r[key] < value); return b; } };
      const result = () => (rows[table] ?? []).filter(r => tests.every(t => t(r)));
      const q: any = { withIndex: (_: string, f: any) => { f(b); return q; }, unique: async () => result()[0] ?? null, take: async (n: number) => result().slice(0, n), collect: async () => result() };
      return q;
    },
    get: async (id: string) => Object.values(rows).flat().find(r => r._id === id),
    insert: async (table: string, data: any) => { const id = `${table}-${rows[table]?.length ?? 0}`; (rows[table] ??= []).push({ _id: id, ...data }); return id; },
    patch: async (id: string, data: any) => Object.assign(await db.get(id), data),
    delete: async (id: string) => { for (const t of Object.keys(rows)) rows[t] = rows[t].filter(r => r._id !== id); },
  };
  const add = async (n: number, published = true) => db.insert("tokenLaunches", { tokenAddress: token(n), normalizedTokenAddress: token(n), poolAddress: token(n + 100), publicPublished: published });
  const acquire = (tokens: string[], leaseId = "one", viewerKey = "viewer") => handler(market.acquire)({ db }, { secret: "secret", tokens, leaseId, viewerKey });
  const complete = (tokens: string[], snapshots: any[], leaseId = "one") => handler(market.complete)({ db }, { secret: "secret", tokens, snapshots, leaseId });
  return { db, ctx: { db }, rows, add, acquire, complete };
}
beforeEach(() => { vi.stubEnv("MARKET_INDEX_SECRET", "secret"); vi.spyOn(Date, "now").mockReturnValue(now); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("legacy catalog workers", () => {
  it("cannot overwrite a fresher page snapshot while completing historical indexing", async () => {
    const f = fixture(); const id = await f.add(1);
    await f.db.patch(id, { publicMarketCapUsd: 500, publicMarketCapUpdatedAt: now, publicVolume24hUsd: 100, publicVolume24hUpdatedAt: now });
    await f.db.insert("tokenMarketState", { normalizedTokenAddress: token(1), marketCapUsd: 500, marketCapUpdatedAt: now, volume24hUsd: 100, volume24hUpdatedAt: now });
    await f.db.insert("marketIndexState", { key: "global", leaseId: "old", leaseUntil: now + 1000 });
    await handler(recordCatalogMarketSnapshots)(f.ctx, { secret: "secret", leaseId: "old", snapshots: [{ tokenAddress: token(1), observedAt: now - 1000, marketCapUsd: 20, volume24hUsd: 5 }] });
    expect(f.rows.tokenLaunches[0].publicMarketCapUsd).toBe(500);
    expect(f.rows.tokenMarketState[0].marketCapUsd).toBe(500);
    expect(f.rows.tokenMarketState[0].volume24hUsd).toBe(100);
  });
  it("can fill newer prices without downgrading independently fresher volume", async () => {
    const f = fixture(); const id = await f.add(1);
    await f.db.patch(id, { publicMarketCapUsd: 100, publicMarketCapUpdatedAt: now - 2000, publicVolume24hUsd: 100, publicVolume24hUpdatedAt: now });
    await f.db.insert("marketIndexState", { key: "global", leaseId: "old", leaseUntil: now + 1000 });
    await handler(recordCatalogMarketSnapshots)(f.ctx, { secret: "secret", leaseId: "old", snapshots: [{ tokenAddress: token(1), observedAt: now - 1000, marketCapUsd: 200, volume24hUsd: 5 }] });
    expect(f.rows.tokenLaunches[0].publicMarketCapUsd).toBe(200);
    expect(f.rows.tokenLaunches[0].publicVolume24hUsd).toBe(100);
    expect(f.rows.tokenMarketState[0].marketCapUsd).toBe(200);
    expect(f.rows.tokenMarketState[0].volume24hUsd).toBeUndefined();
  });
});

describe("five-minute browsing sessions", () => {
  it("stops at exactly five minutes, including time in background tabs", () => {
    expect(pageRefreshActive(now, now + PAGE_REFRESH_SESSION_MS - 1)).toBe(true);
    expect(pageRefreshActive(now, now + PAGE_REFRESH_SESSION_MS)).toBe(false);
    expect(pageRefreshActive(now, now + 24 * 60 * 60_000)).toBe(false);
  });
  it("does not consider future or missing snapshots fresh", () => {
    expect(snapshotFresh(100, now + 1, now)).toBe(false);
    expect(snapshotFresh(NaN, now, now)).toBe(false);
    expect(snapshotFresh(undefined, now, now)).toBe(false);
    expect(snapshotFresh(100, now - 59_999, now)).toBe(true);
    expect(snapshotFresh(100, now - 60_000, now)).toBe(false);
  });
});

describe("durable table snapshots and history", () => {
  const args = { secret: "secret", token: token(1), kind: "holders", leaseId: "one", viewerKey: "v" };
  it("shares a lease across viewers, but not across tokens or tabs", async () => {
    const f = fixture(); await f.add(1); await f.add(2);
    expect(await handler(market.acquireActivity)(f.ctx, args)).not.toBeNull();
    expect(await handler(market.acquireActivity)(f.ctx, { ...args, leaseId: "two" })).toBeNull();
    expect(await handler(market.acquireActivity)(f.ctx, { ...args, kind: "trades" })).not.toBeNull();
    expect(await handler(market.acquireActivity)(f.ctx, { ...args, token: token(2) })).not.toBeNull();
  });
  it("rejects non-public tokens and unauthorized reads/writes", async () => {
    const f = fixture(); await f.add(1, false);
    expect(await handler(market.acquireActivity)(f.ctx, args)).toBeNull();
    expect(await handler(market.activitySnapshot)(f.ctx, args)).toBeNull();
    await expect(handler(market.acquireActivity)(f.ctx, { ...args, secret: "wrong" })).rejects.toThrow("authorization");
  });
  it("a cache read cannot reserve upstream work", async () => {
    const f = fixture(); await f.add(1);
    expect(await handler(market.activitySnapshot)(f.ctx, args)).toMatchObject({ due: true, refreshing: false });
    expect(f.rows.websiteActivitySnapshots).toBeUndefined();
    expect(f.rows.websiteProviderBudget).toBeUndefined();
  });
  it("preserves last good holders and their timestamp on a failed refresh", async () => {
    const f = fixture(); await f.add(1); await handler(market.acquireActivity)(f.ctx, args);
    const json = JSON.stringify({ holders: [{ address: token(9), amount: "100" }] });
    await handler(market.completeActivity)(f.ctx, { ...args, json, observedAt: now });
    vi.mocked(Date.now).mockReturnValue(now + 61_000);
    await handler(market.acquireActivity)(f.ctx, { ...args, leaseId: "two" });
    await handler(market.completeActivity)(f.ctx, { ...args, leaseId: "two", diagnostic: "offline" });
    const result = await handler(market.activitySnapshot)(f.ctx, args);
    expect(result).toMatchObject({ json, observedAt: now, due: false });
    expect(f.rows.websiteActivitySnapshots[0].retryAt).toBe(now + 121_000);
  });
  it("late results cannot overwrite a newer lease or private snapshots", async () => {
    const f = fixture(); await f.add(1); await handler(market.acquireActivity)(f.ctx, args);
    vi.mocked(Date.now).mockReturnValue(now + 51_000);
    await handler(market.acquireActivity)(f.ctx, { ...args, leaseId: "two" });
    await handler(market.completeActivity)(f.ctx, { ...args, json: '{"holders":[]}', observedAt: now + 51_000 });
    expect(f.rows.websiteActivitySnapshots[0].json).toBeUndefined();
    expect(f.rows.websiteActivitySnapshots[0].leaseId).toBe("two");
  });
  it("caps a viewer at six new table refreshes per minute", async () => {
    const f = fixture();
    for (let i = 1; i <= 7; i++) { await f.add(i);
      const result = await handler(market.acquireActivity)(f.ctx, { ...args, token: token(i) });
      if (i <= 6) expect(result).not.toBeNull(); else expect(result).toBeNull();
    }
  });
  it("commits holder deltas once, without double-applying a retried range", async () => {
    const f = fixture(); await f.add(1); await handler(market.acquireActivity)(f.ctx, args);
    const batch = { ...args, throughBlock: "100", blockHash: `0x${"a".repeat(64)}`, deltas: [{ address: token(9), delta: "1000" }] };
    expect(await handler(market.recordHolderHistory)(f.ctx, batch)).toBe(true);
    expect(await handler(market.recordHolderHistory)(f.ctx, batch)).toBe(false);
    expect(f.rows.websiteHolderBalances[0].raw).toBe("1000");
    expect(await handler(market.recordHolderHistory)(f.ctx, { ...batch, previousBlock: "100", throughBlock: "101", deltas: [{ address: token(9), delta: "-1000" }] })).toBe(true);
    expect(f.rows.websiteHolderBalances).toHaveLength(0);
  });
  it("rejects inconsistent negative history and oversized snapshots", async () => {
    const f = fixture(); await f.add(1); await handler(market.acquireActivity)(f.ctx, args);
    await expect(handler(market.recordHolderHistory)(f.ctx, { ...args, throughBlock: "100", blockHash: `0x${"a".repeat(64)}`, deltas: [{ address: token(9), delta: "-1" }] })).rejects.toThrow("inconsistent");
    await expect(handler(market.completeActivity)(f.ctx, { ...args, json: "x".repeat(150001) })).rejects.toThrow("too large");
  });
  it("retains Gecko history on failure, marks it stale, and does not charge cache-only contention", async () => {
    const f = fixture(); const a = { secret: "secret", key: "gecko:test", leaseId: "a" };
    await handler(market.reserveGecko)(f.ctx, a);
    await handler(market.completeGecko)(f.ctx, { ...a, json: '{"data":[1]}', ttlMs: 60_000, observedAt: now, throttled: false });
    vi.mocked(Date.now).mockReturnValue(now + 61_000);
    const b = { ...a, leaseId: "b" };
    expect(await handler(market.reserveGecko)(f.ctx, b)).toMatchObject({ acquired: true, stale: true, json: '{"data":[1]}' });
    expect(await handler(market.reserveGecko)(f.ctx, { ...a, leaseId: "c" })).toMatchObject({ acquired: false, stale: true, json: '{"data":[1]}' });
    await handler(market.completeGecko)(f.ctx, { ...b, ttlMs: 60_000, observedAt: now + 61_000, throttled: true });
    expect(await handler(market.reserveGecko)(f.ctx, a)).toMatchObject({ acquired: false, stale: true, json: '{"data":[1]}', observedAt: now });
    await handler(market.cleanup)(f.ctx, {});
    expect(f.rows.websiteReadCache[0].json).toBe('{"data":[1]}');
  });
});

describe("per-token durable refresh leases", () => {
  it("coalesces duplicates across viewers but permits unrelated tokens", async () => {
    const f = fixture(); await f.add(1); await f.add(2);
    expect(await f.acquire([token(1), token(1).toUpperCase().replace("0X", "0x")])).toHaveLength(1);
    expect(await f.acquire([token(1)], "two", "other")).toEqual([]);
    expect(await f.acquire([token(2)], "two", "other")).toHaveLength(1);
  });
  it("never acquires private, nonexistent, or excluded tokens", async () => {
    const f = fixture(); await f.add(1, false);
    expect(await f.acquire([token(1), token(2), "0x9A235E8D56B3E397c39C999f88dd401827Ea7b07"])).toEqual([]);
  });
  it("uses fresh shared values without extending their source timestamp or writing rate limits", async () => {
    const f = fixture(); await f.add(1);
    await f.db.insert("tokenMarketState", { normalizedTokenAddress: token(1), marketCapUsd: 100, marketCapUpdatedAt: now - 20_000 });
    expect(await f.acquire([token(1)])).toEqual([]);
    expect(f.rows.marketViewerRateLimits).toBeUndefined();
    expect(f.rows.tokenMarketState[0].marketCapUpdatedAt).toBe(now - 20_000);
  });
  it("also honors a newer public-launch snapshot", async () => {
    const f = fixture(); const id = await f.add(1);
    await f.db.patch(id, { publicMarketCapUsd: 100, publicMarketCapUpdatedAt: now - 1 });
    expect(await f.acquire([token(1)])).toEqual([]);
  });
  it("retains old values and backs off on failed refreshes", async () => {
    const f = fixture(); await f.add(1);
    await f.db.insert("tokenMarketState", { normalizedTokenAddress: token(1), marketCapUsd: 100, marketCapUpdatedAt: now - 90_000 });
    await f.acquire([token(1)]); await f.complete([token(1)], []);
    expect(f.rows.tokenMarketState[0].marketCapUsd).toBe(100);
    expect(f.rows.tokenMarketState[0].marketCapUpdatedAt).toBe(now - 90_000);
    expect(f.rows.websiteRefreshJobs[0].leaseUntil).toBe(0);
    expect(await f.acquire([token(1)])).toEqual([]);
  });
  it("an expired worker cannot overwrite a newer worker or clear its lease", async () => {
    const f = fixture(); await f.add(1); await f.acquire([token(1)]);
    vi.mocked(Date.now).mockReturnValue(now + 46_000);
    await f.acquire([token(1)], "two");
    await f.complete([token(1)], [{ tokenAddress: token(1), observedAt: now, marketCapUsd: 100 }]);
    expect(f.rows.websiteRefreshJobs[0].leaseId).toBe("two");
    expect(f.rows.websiteRefreshJobs[0].leaseUntil).toBeGreaterThan(now + 46_000);
    expect(f.rows.tokenMarketState).toBeUndefined();
  });
  it("writes a usable result even when another token fails", async () => {
    const f = fixture(); await f.add(1); await f.add(2); await f.acquire([token(1), token(2)]);
    await f.complete([token(1), token(2)], [{ tokenAddress: token(1), observedAt: now, marketCapUsd: 150, marketCapSource: "gecko", volume24hUsd: 0 }]);
    expect(f.rows.tokenLaunches[0].publicMarketCapUsd).toBe(150);
    expect(f.rows.tokenMarketState[0].volume24hUsd).toBe(0);
    expect(f.rows.tokenLaunches[1].publicMarketCapUsd).toBeUndefined();
    expect(f.rows.websiteRefreshJobs.every(r => r.leaseUntil === 0)).toBe(true);
  });
  it("rejects invalid prices and preserves monotonic graduation", async () => {
    const f = fixture(); await f.add(1); await f.acquire([token(1)]);
    await f.db.insert("tokenMarketState", { normalizedTokenAddress: token(1), graduated: true, marketCapUsd: 300, marketCapUpdatedAt: now });
    await f.complete([token(1)], [{ tokenAddress: token(1), observedAt: now - 1000, marketCapUsd: 150, graduated: false }]);
    expect(f.rows.tokenMarketState[0].marketCapUsd).toBe(300);
    expect(f.rows.tokenMarketState[0].graduated).toBe(true);
  });
  it("rejects unauthorized refreshes and oversized batches", async () => {
    const f = fixture();
    await expect(handler(market.acquire)(f.ctx, { secret: "wrong", tokens: [], leaseId: "x", viewerKey: "x" })).rejects.toThrow("authorization");
    await expect(f.acquire(Array.from({ length: 21 }, (_, i) => token(i)))).rejects.toThrow("too many");
  });
});

describe("shared provider budgets and caching", () => {
  it("uses a rolling rather than fixed window", () => {
    const prior = Array.from({ length: 24 }, () => now - 1);
    expect(reserveProviderAttempt(prior, now, 24).allowed).toBe(false);
    expect(reserveProviderAttempt(prior, now + 59_999, 24).allowed).toBe(true);
  });
  it("bounds paid RPC fallback reservations across users", async () => {
    const f = fixture();
    for (let i = 0; i < 12; i++) expect(await handler(market.reserveAlchemy)(f.ctx, { secret: "secret" })).toBe(true);
    expect(await handler(market.reserveAlchemy)(f.ctx, { secret: "secret" })).toBe(false);
  });
  it("charges Gecko cache misses only and deduplicates in-flight keys", async () => {
    const f = fixture(); const args = { secret: "secret", key: "gecko:test", leaseId: "a" };
    expect(await handler(market.reserveGecko)(f.ctx, args)).toMatchObject({ acquired: true });
    expect(await handler(market.reserveGecko)(f.ctx, { ...args, leaseId: "b" })).toMatchObject({ acquired: false });
    await handler(market.completeGecko)(f.ctx, { ...args, json: '{"data":[]}', ttlMs: 60_000, observedAt: now, throttled: false });
    expect(await handler(market.reserveGecko)(f.ctx, args)).toMatchObject({ acquired: false, json: '{"data":[]}', observedAt: now });
    expect(f.rows.websiteProviderBudget[0].attempts).toHaveLength(1);
  });
  it("shares a 429 cooldown across every Gecko consumer", async () => {
    const f = fixture(); const args = { secret: "secret", key: "gecko:test", leaseId: "a" };
    await handler(market.reserveGecko)(f.ctx, args);
    await handler(market.completeGecko)(f.ctx, { ...args, ttlMs: 60_000, observedAt: now, throttled: true });
    expect(await handler(market.reserveGecko)(f.ctx, { ...args, key: "gecko:other" })).toMatchObject({ acquired: false });
  });
  it("limits Gecko upstream work to 24 requests in a rolling minute", async () => {
    const f = fixture();
    for (let i = 0; i < 24; i++) {
      vi.setSystemTime(now + i * 2500);
      expect(await handler(market.reserveGecko)(f.ctx, { secret: "secret", key: `gecko:${i}`, leaseId: "a", priority: "interactive" })).toMatchObject({ acquired: true });
    }
    expect(await handler(market.reserveGecko)(f.ctx, { secret: "secret", key: "gecko:last", leaseId: "a", priority: "interactive" })).toMatchObject({ acquired: false });
  });
  it("does not overwrite fresh visible data with older catalog results", async () => {
    const f = fixture(); const id = await f.add(1);
    await f.db.patch(id, { publicMarketCapUsd: 200, publicMarketCapUpdatedAt: now });
    await handler(market.acquireCatalog)(f.ctx, { secret: "secret", leaseId: "a" });
    await handler(market.recordCatalog)(f.ctx, { secret: "secret", leaseId: "a", snapshots: [{ tokenAddress: token(1), observedAt: now - 10, marketCapUsd: 100 }] });
    expect(f.rows.tokenLaunches[0].publicMarketCapUsd).toBe(200);
    expect(await handler(market.acquireCatalog)(f.ctx, { secret: "secret", leaseId: "b" })).toBe(false);
  });
});
