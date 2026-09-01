/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquire, complete, completeGecko, reserveGecko } from "../convex/marketData";
import { geckoBudgetRetryAt, geckoRetryAt } from "../lib/gecko-budget-policy";
const now = 1_800_000_000_000, token = `0x${"1".repeat(40)}`;
const handler = (fn: any) => fn._handler;
function fixture() {
  const tables: Record<string, any[]> = {}, reads: string[] = [];
  let count = 0;
  const ctx: any = { db: {
    query(table: string) {
      reads.push(table);
      const predicates: Array<(r: any) => boolean> = [];
      const index: any = { eq: (key: string, value: any) => { predicates.push(r => r[key] === value); return index; } };
      const q: any = { withIndex: (_: string, fn: any) => { fn(index); return q; }, unique: async () => tables[table]?.find(r => predicates.every(p => p(r))) ?? null };
      return q;
    },
    insert: async (table: string, data: any) => { const id = String(++count); (tables[table] ??= []).push({ _id: id, ...data }); return id; },
    patch: async (id: string, patch: any) => Object.assign(Object.values(tables).flat().find(r => r._id === id), patch),
  } };
  return { tables, reads, ctx, add: ctx.db.insert, call: (fn: any, args: any) => handler(fn)(ctx, { secret: "test", ...args }) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("MARKET_INDEX_SECRET", "test"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("small-row market refresh guard", () => {
  it.each([{ leaseUntil: now + 10_000, retryAt: 0 }, { leaseUntil: 0, retryAt: now + 10_000 }])("avoids reading metadata and state for guarded work", async guard => {
    const f = fixture(); await f.add("websiteRefreshJobs", { token, ...guard });
    expect(await f.call(acquire, { tokens: [token], leaseId: "new", viewerKey: "viewer" })).toEqual([]);
    expect(f.reads).toEqual(["websiteRefreshJobs"]);
  });
  it("memoizes freshness from an existing snapshot, but allows work again when it expires", async () => {
    const f = fixture(); await f.add("tokenLaunches", { normalizedTokenAddress: token, tokenAddress: token, poolAddress: token, publicPublished: true, publicMarketCapUsd: 100, publicMarketCapUpdatedAt: now - 30_000 });
    const args = { tokens: [token], leaseId: "new", viewerKey: "viewer" };
    expect(await f.call(acquire, args)).toEqual([]); f.reads.length = 0;
    expect(await f.call(acquire, args)).toEqual([]); expect(f.reads).toEqual(["websiteRefreshJobs"]);
    vi.setSystemTime(now + 30_001);
    expect(await f.call(acquire, args)).toHaveLength(1);
  });
  it("does not extend freshness from a stale completion or another lease", async () => {
    const f = fixture(); await f.add("websiteRefreshJobs", { token, leaseId: "owner", leaseUntil: now + 20_000, retryAt: 0 });
    await f.call(complete, { tokens: [token], leaseId: "wrong", snapshots: [{ tokenAddress: token, observedAt: now, marketCapUsd: 100 }] });
    expect(f.tables.websiteRefreshJobs[0].retryAt).toBe(0);
  });
});
describe("global Gecko cooldown and pacing", () => {
  it("reserves the last three global slots for interactive requests without increasing the cap", async () => {
    const f = fixture();
    for (let i = 0; i < 21; i++) {
      vi.setSystemTime(now + i * 2500);
      expect(await f.call(reserveGecko, { key: `gecko:bg-${i}`, leaseId: `${i}` })).toMatchObject({ acquired: true });
    }
    vi.setSystemTime(now + 52500);
    expect(await f.call(reserveGecko, { key: "gecko:bg-overflow", leaseId: "bg" })).toMatchObject({ acquired: false });
    for (let i = 21; i < 24; i++) {
      vi.setSystemTime(now + i * 2500);
      expect(await f.call(reserveGecko, { key: `gecko:quote-${i}`, leaseId: `${i}`, priority: "interactive" })).toMatchObject({ acquired: true });
    }
    expect(await f.call(reserveGecko, { key: "gecko:interactive-overflow", leaseId: "overflow", priority: "interactive" })).toMatchObject({ acquired: false });
    expect(f.tables.websiteProviderBudget[0].attempts).toHaveLength(24);
  });
  it("gives a waiting quote the next slot and releases priority if the caller disappears", async () => {
    const f = fixture(); await f.call(reserveGecko, { key: "gecko:a", leaseId: "a" });
    expect(await f.call(reserveGecko, { key: "gecko:quote", leaseId: "quote", priority: "interactive" })).toMatchObject({ acquired: false, retryAt: now + 2500 });
    vi.setSystemTime(now + 2500);
    expect(await f.call(reserveGecko, { key: "gecko:bg", leaseId: "bg" })).toMatchObject({ acquired: false, retryAt: now + 3500 });
    expect(await f.call(reserveGecko, { key: "gecko:quote", leaseId: "quote", priority: "interactive" })).toMatchObject({ acquired: true });
    expect(f.tables.websiteProviderBudget[0].interactiveUntil).toBe(0);
    await f.call(reserveGecko, { key: "gecko:abandoned", leaseId: "abandoned", priority: "interactive" });
    vi.setSystemTime(now + 6000);
    expect(await f.call(reserveGecko, { key: "gecko:bg", leaseId: "bg" })).toMatchObject({ acquired: true });
  });
  it("does not let interactive priority bypass a provider cooldown", async () => {
    const f = fixture(); await f.add("websiteProviderBudget", { key: "gecko", attempts: [], blockedUntil: now + 600000 });
    expect(await f.call(reserveGecko, { key: "gecko:q", leaseId: "q", priority: "interactive" })).toMatchObject({ acquired: false, retryAt: now + 600000 });
    expect(f.tables.websiteProviderBudget[0].attempts).toEqual([]);
  });
  it("refreshes a live quote without reusing earlier cached volume, but keeps global cooldowns", async () => {
    const f = fixture();
    await f.add("websiteReadCache", { key: "gecko:quote", json: '{"data":[]}', expiresAt: now + 60_000, observedAt: now - 1000 });
    await f.add("websiteProviderBudget", { key: "gecko", attempts: [], blockedUntil: now + 3000 });
    const args = { key: "gecko:quote", leaseId: "fresh", freshAfter: now };
    expect(await f.call(reserveGecko, args)).toMatchObject({ acquired: false, stale: true, retryAt: now + 3000 });
    vi.setSystemTime(now + 3000);
    expect(await f.call(reserveGecko, args)).toMatchObject({ acquired: true });
    await f.call(completeGecko, { key: "gecko:quote", leaseId: "fresh", observedAt: now + 3000, ttlMs: 60000, throttled: false, json: '{"data":[1]}' });
    expect(await f.call(reserveGecko, args)).toMatchObject({ acquired: false, stale: false, json: '{"data":[1]}' });
    await expect(f.call(reserveGecko, { ...args, freshAfter: now + 60000 })).rejects.toThrow("invalid Gecko freshness");
  });
  it("spaces upstream reservations across different cache keys", async () => {
    const f = fixture();
    expect(await f.call(reserveGecko, { key: "gecko:a", leaseId: "a" })).toMatchObject({ acquired: true });
    expect(await f.call(reserveGecko, { key: "gecko:b", leaseId: "b" })).toMatchObject({ acquired: false, retryAt: now + 2_500 });
    vi.setSystemTime(now + 2_500);
    expect(await f.call(reserveGecko, { key: "gecko:b", leaseId: "b" })).toMatchObject({ acquired: true });
  });
  it("honors long provider cooldowns across all consumers and never shortens one", async () => {
    const f = fixture(); await f.call(reserveGecko, { key: "gecko:a", leaseId: "a" });
    await f.call(completeGecko, { key: "gecko:a", leaseId: "a", observedAt: now, ttlMs: 60_000, throttled: true, retryAfter: "600" });
    vi.setSystemTime(now + 61_000);
    expect(await f.call(reserveGecko, { key: "gecko:b", leaseId: "b" })).toMatchObject({ acquired: false, retryAt: now + 600_000 });
    expect(f.tables.websiteProviderBudget[0].attempts).toHaveLength(1);
  });
  it("still serves fresh cached data during a global cooldown", async () => {
    const f = fixture(); await f.add("websiteProviderBudget", { key: "gecko", attempts: [], blockedUntil: now + 600_000 });
    await f.add("websiteReadCache", { key: "gecko:a", json: '{"data":[]}', expiresAt: now + 20_000, observedAt: now });
    expect(await f.call(reserveGecko, { key: "gecko:a", leaseId: "a" })).toMatchObject({ acquired: false, stale: false, json: '{"data":[]}' });
  });
  it("accepts HTTP dates and retains the rolling minute cap", () => {
    expect(geckoRetryAt(new Date(now + 600_000).toUTCString(), now)).toBe(now + 600_000);
    expect(geckoRetryAt("broken", now)).toBe(now + 60_000);
    expect(geckoBudgetRetryAt(Array(24).fill(now - 10_000), undefined, now)).toBe(now + 50_000);
  });
});
