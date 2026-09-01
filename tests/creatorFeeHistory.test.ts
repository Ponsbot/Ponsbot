/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import * as history from "../convex/creatorFeeHistory";
import * as site from "../convex/site";
import { FEE_PRICE_BUCKET_MS, FEE_PRICE_DAY_MS, feePriceBucket, historicalEthCandles, parseClaimedAsset } from "../lib/historical-fee-prices";

const now = Date.parse("2026-08-31T12:00:00Z"), hour = 3_600_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const copy = <T>(obj: T): T => structuredClone(obj);
const handler = (fn: any) => fn._handler;

function fixture() {
  const tables: Record<string, any[]> = {}, reads: string[] = [];
  let seq = 0;
  const db: any = {
    query(table: string) {
      reads.push(table);
      const filters: Array<(row: any) => boolean> = [];
      const b: any = {
        eq: (key: string, value: any) => { filters.push(row => row[key] === value); return b; },
        lte: (key: string, value: any) => { filters.push(row => row[key] <= value); return b; },
      };
      const rows = () => (tables[table] ?? []).filter(row => filters.every(f => f(row))).map(copy);
      const q: any = { withIndex: (_: string, fn?: any) => { fn?.(b); return q; }, collect: async () => rows(),
        take: async (n: number) => rows().slice(0, n), first: async () => rows()[0] ?? null,
        unique: async () => { const r = rows(); if (r.length > 1) throw new Error("duplicate index"); return r[0] ?? null; },
        paginate: async ({ cursor, numItems }: any) => { const r = rows(), offset = Number(cursor ?? 0);
          return { page: r.slice(offset, offset + numItems), continueCursor: String(offset + numItems), isDone: offset + numItems >= r.length }; },
      }; return q;
    },
    get: async (id: string) => copy(Object.values(tables).flat().find(row => row._id === id) ?? null),
    insert: async (table: string, value: any) => { const id = `${table}-${++seq}`; (tables[table] ??= []).push({ _id: id, ...copy(value) }); return id; },
    patch: async (id: string, patch: any) => { const row = Object.values(tables).flat().find(row => row._id === id); if (!row) throw new Error("missing row"); Object.assign(row, copy(patch)); },
  };
  const scheduler = { runAfter: vi.fn(async () => "job") };
  const ctx: any = { db, scheduler };
  const dispatch = (ref: any, args: any) => { const [module, name] = getFunctionName(ref).split(":"); return handler((module === "site" ? site : history as any)[name])(ctx, args); };
  ctx.runQuery = dispatch; ctx.runMutation = dispatch;
  const call = (name: keyof typeof history, args: any = {}) => handler(history[name])(ctx, args);
  const legacy = (n: number, fields: any = {}) => db.insert("walletTransactions", { requestId: `r${n}`, chainId: 4663,
    status: "confirmed", callKind: "pons_v2_claim_fees", transactionHash: hash(n), claimedDisplay: "1 ETH", createdAt: now - hour,
    updatedAt: now - hour, ...fields });
  const vault = async (n: number, fields: any = {}, programFields: any = {}) => {
    const programId = await db.insert("automatedFeePrograms", { privateTest: false, ...programFields });
    return db.insert("automatedFeeRuns", { programId, status: "confirmed", pairTokenAddress: addr(0), grossClaimed: "1000000000000000000",
      beneficiaryDelivered: "950000000000000000", buybackSpent: "50000000000000000", processingTransactionHash: hash(n),
      deliveryTransactionHash: hash(n + 1000), updatedAt: now - hour, ...fields });
  };
  const stats = () => tables.creatorFeeStats?.[0], state = () => tables.creatorFeeHistoryWorker?.[0];
  const markTimeAndPrice = async (work: any, prices: number[] = [2000]) => {
    for (const [i, row] of work.rows.entries()) {
      const claimedAt = row.recordedAt;
      await call("recordTime", { leaseToken: work.leaseToken, id: row._id, claimedAt, blockTime: false });
      await call("savePrices", { leaseToken: work.leaseToken, prices: [{ bucketAt: feePriceBucket(claimedAt), priceUsd: prices[i] ?? prices[0] }] });
    }
    return call("finishBatch", { leaseToken: work.leaseToken, ids: work.rows.map((row: any) => row._id) });
  };
  return { tables, reads, db, ctx, scheduler, call, legacy, vault, stats, state, markTimeAndPrice };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network"); })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("historical ETH price source", () => {
  it("uses five-minute open, not close or the current price", () => {
    const start = now - hour;
    expect(historicalEthCandles([[start / 1000, 1900, 2500, 2000, 2400, 1]], start, now, now)).toEqual([{ bucketAt: start, priceUsd: 2000 }]);
    expect(feePriceBucket(start + 123456)).toBe(start);
  });
  it("filters invalid, out-of-range, incomplete and misaligned candles", () => {
    expect(historicalEthCandles([
      [now / 1000, 1, 3, 2, 2], [(now - 1) / 1000, 1, 3, 2, 2], [(now - hour) / 1000, 1, 3, 9, 2],
      [(now - hour) / 1000, 1, 3, NaN, 2], [(now - 2 * hour) / 1000, 1, 3, 2, 2],
    ], now - hour, now, now)).toEqual([]);
  });
  it("parses decimals without silently inventing an asset", () => {
    expect(parseClaimedAsset("0.00000025 eth")).toEqual({ amount: 0.00000025, symbol: "ETH" });
    for (const value of ["0 ETH", "NaN ETH", "3", "3 ETH more", "-1 ETH"]) expect(parseClaimedAsset(value)).toBeNull();
  });
});

describe("deduplicated creator fee ledger", () => {
  it("keeps historical claims at their respective prices, including after replay", async () => {
    const f = fixture(); await f.legacy(1, { updatedAt: now - 2 * hour }); await f.legacy(2);
    const work = await f.call("beginBatch"); await f.markTimeAndPrice(work, [2000, 3000]);
    expect(f.stats()).toMatchObject({ claimCount: 2, pricedCount: 2, totalUsd: 5000 });
    await f.call("recordLegacyClaim", { requestId: "r1" });
    await f.call("finishBatch", { leaseToken: work.leaseToken, ids: work.rows.map((r: any) => r._id) });
    expect(f.stats().totalUsd).toBe(5000); expect(f.tables.creatorFeeClaims).toHaveLength(2);
  });
  it("deduplicates case variants and duplicate request rows by transaction hash", async () => {
    const f = fixture(); await f.legacy(170); await f.legacy(171, { transactionHash: hash(170).toUpperCase().replace("0X", "0x") });
    await f.call("beginBatch"); expect(f.stats().claimCount).toBe(1);
  });
  it("counts vault gross once, including buyback allocation but not delivery again", async () => {
    const f = fixture(); const id = await f.vault(1);
    await f.call("recordVaultClaim", { runId: id }); await f.call("recordVaultClaim", { runId: id });
    const work = await f.call("beginBatch"); await f.markTimeAndPrice(work);
    expect(f.stats()).toMatchObject({ claimCount: 1, totalUsd: 2000 });
    expect(f.tables.creatorFeeClaims[0]).toMatchObject({ amount: 1, rawAmount: "1000000000000000000", transactionHash: hash(1) });
  });
  it("excludes failed/pending claims, other actions/chains and private test cycles", async () => {
    const f = fixture(); await f.legacy(1, { status: "broadcast" }); await f.legacy(2, { callKind: "send" }); await f.legacy(3, { chainId: 1 });
    const test = await f.vault(4, {}, { privateTest: true }); const pending = await f.vault(5, { status: "submitted" });
    await f.call("recordVaultClaim", { runId: test }); await f.call("recordVaultClaim", { runId: pending }); await f.call("beginBatch");
    expect(f.tables.creatorFeeClaims).toBeUndefined();
  });
  it("keeps non-ETH assets unpriced instead of using current prices or a $1 peg", async () => {
    const f = fixture(); await f.legacy(1, { claimedDisplay: "5 USDG" }); await f.legacy(2, { claimedDisplay: "1 MSFT" });
    await f.db.insert("marketPriceCache", { key: "PAIR-USD:MSFT", value: 900, sourceTimestamp: now });
    const work = await f.call("beginBatch"); expect(work.rows).toEqual([]);
    expect(f.stats()).toMatchObject({ claimCount: 2, pricedCount: 0, totalUsd: 0 });
    expect(f.tables.creatorFeeClaims.every(row => row.status === "unsupported")).toBe(true);
  });
  it("does not value an ERC20 called ETH at the native ETH price", async () => {
    const f = fixture(); await f.legacy(1, { involvedPairTokenAddress: addr(123) }); await f.call("beginBatch");
    expect(f.tables.creatorFeeClaims[0].status).toBe("unsupported");
  });
  it("retains paired-asset units and decimals", async () => {
    const f = fixture(); await f.db.insert("tokenRegistry", { normalizedAddress: addr(1), symbol: "USDG", decimals: 6 });
    const id = await f.vault(1, { pairTokenAddress: addr(1), grossClaimed: "1500000" }); await f.call("recordVaultClaim", { runId: id });
    expect(f.tables.creatorFeeClaims[0]).toMatchObject({ amount: 1.5, assetSymbol: "USDG", status: "unsupported" });
  });
});

describe("bounded and recoverable backfill", () => {
  it("caps scanning at one 100-row page and pricing at 20 rows", async () => {
    const f = fixture(); for (let i = 0; i < 101; i++) await f.legacy(i + 1);
    const work = await f.call("beginBatch"); expect(f.stats().claimCount).toBe(100); expect(work.rows).toHaveLength(20);
    expect(f.state().legacyDone).toBe(false); expect(await f.call("beginBatch")).toBeNull();
    await f.markTimeAndPrice(work); expect(f.scheduler.runAfter).toHaveBeenCalledOnce();
    vi.setSystemTime(now + 60_000); await f.call("beginBatch"); expect(f.stats().claimCount).toBe(101);
  });
  it("does not rescan completed source tables on hourly refresh", async () => {
    const f = fixture(); await f.db.insert("creatorFeeHistoryWorker", { key: "public", legacyDone: true, vaultDone: true, nextRunAt: now });
    const work = await f.call("beginBatch"); await f.call("finishBatch", { leaseToken: work.leaseToken, ids: [] });
    expect(f.reads).not.toContain("walletTransactions"); expect(f.reads).not.toContain("automatedFeeRuns"); expect(f.scheduler.runAfter).not.toHaveBeenCalled();
    expect(await f.call("beginBatch")).toBeNull();
  });
  it("does not skip every other hourly cron because of worker runtime", async () => {
    const f = fixture(); await f.db.insert("creatorFeeHistoryWorker", { key: "public", legacyDone: true, vaultDone: true, nextRunAt: now });
    vi.setSystemTime(now + 7 * 60_000); const work = await f.call("beginBatch");
    vi.setSystemTime(now + 8 * 60_000); await f.call("finishBatch", { leaseToken: work.leaseToken, ids: [] });
    vi.setSystemTime(now + hour + 7 * 60_000); expect(await f.call("beginBatch")).not.toBeNull();
  });
  it("backfills vaults after legacy pagination using the processing block, not delivery", async () => {
    const f = fixture(); await f.vault(123, { processingBlockNumber: "100", deliveryBlockNumber: "200", processingBroadcastAt: now - 2 * hour });
    const first = await f.call("beginBatch"); await f.call("finishBatch", { leaseToken: first.leaseToken, ids: [] });
    vi.setSystemTime(now + 60_000); const second = await f.call("beginBatch");
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]).toMatchObject({ blockNumber: "100", recordedAt: now - 2 * hour });
    expect(f.state()).toMatchObject({ legacyDone: true, vaultDone: true });
  });
  it("fences stale worker writes after its lease expires", async () => {
    const f = fixture(); await f.legacy(1); const old = await f.call("beginBatch"); vi.setSystemTime(now + 6 * 60_000);
    const next = await f.call("beginBatch"); expect(next.leaseToken).not.toBe(old.leaseToken);
    await f.call("savePrices", { leaseToken: old.leaseToken, prices: [{ bucketAt: now - hour, priceUsd: 999 }] });
    expect(f.tables.historicalEthPrices).toBeUndefined();
  });
  it("never overwrites a saved historical bucket on provider changes", async () => {
    const f = fixture(); const work = await f.call("beginBatch");
    for (const priceUsd of [2000, 9999]) await f.call("savePrices", { leaseToken: work.leaseToken, prices: [{ bucketAt: now - hour, priceUsd }] });
    expect(f.tables.historicalEthPrices).toHaveLength(1); expect(f.tables.historicalEthPrices[0].priceUsd).toBe(2000);
  });
  it("uses small aggregate updates without rescanning platform statistics", async () => {
    const f = fixture(); await f.legacy(1); await f.db.insert("platformStatsCache", { key: "public", lifetimeVolumeUsd: 456, wallets: 42 });
    const work = await f.call("beginBatch"); f.reads.length = 0; await f.markTimeAndPrice(work);
    expect(f.tables.platformStatsCache[0]).toMatchObject({ feesClaimedUsd: 2000, feeValuationVersion: 1, lifetimeVolumeUsd: 456, wallets: 42 });
    expect(f.reads).not.toContain("walletTransactions"); expect(f.reads).not.toContain("tokenLifetimeVolumes");
  });
});

describe("read-only provider worker", () => {
  it("resolves real block time then prices all claims in that bucket with one candle call", async () => {
    const f = fixture(); await f.legacy(1, { blockNumber: "123", updatedAt: now - 24 * hour }); await f.legacy(2, { blockNumber: "123" });
    const claimedAt = now - hour;
    const fetch = vi.fn(async (url: any, init: any) => {
      if (String(url).includes("rpc.")) { expect(JSON.parse(init.body)).toMatchObject({ method: "eth_getBlockByNumber", params: ["0x7b", false] });
        return new Response(JSON.stringify({ result: { number: "0x7b", timestamp: `0x${(claimedAt / 1000).toString(16)}` } })); }
      const u = new URL(url); expect(u.hostname).toBe("api.exchange.coinbase.com"); expect(u.searchParams.get("granularity")).toBe("300");
      expect(Date.parse(u.searchParams.get("end")!) - Date.parse(u.searchParams.get("start")!)).toBe(FEE_PRICE_DAY_MS);
      return new Response(JSON.stringify([[claimedAt / 1000, 1900, 2100, 2000, 2050]]));
    }); vi.stubGlobal("fetch", fetch); await f.call("refresh");
    expect(fetch).toHaveBeenCalledTimes(2); expect(f.stats().totalUsd).toBe(4000);
    expect(f.tables.creatorFeeClaims[0]).toMatchObject({ claimedAt, timestampSource: "block" });
  });
  it("uses cached historical data without any external price request", async () => {
    const f = fixture(); await f.legacy(1); await f.db.insert("historicalEthPrices", { bucketAt: now - hour, priceUsd: 2222 });
    await f.call("refresh"); expect(fetch).not.toHaveBeenCalled(); expect(f.stats().totalUsd).toBe(2222);
    expect(f.tables.creatorFeeClaims[0].timestampSource).toBe("recorded_confirmation");
  });
  it("leaves failed lookups pending and does not replace historical totals with zero", async () => {
    const f = fixture(); await f.legacy(1); const work = await f.call("beginBatch"); await f.markTimeAndPrice(work);
    vi.setSystemTime(now + hour); await f.legacy(2, { blockNumber: "123" }); await f.call("recordLegacyClaim", { requestId: "r2" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 }))); await f.call("refresh");
    expect(f.stats()).toMatchObject({ totalUsd: 2000, claimCount: 2, pricedCount: 1 });
    expect(f.tables.creatorFeeClaims[1]).toMatchObject({ status: "pending", diagnosticCode: "BLOCK_TIME_UNAVAILABLE" });
  });
  it("honors provider cooldown, redacts errors and never spins on missing prices", async () => {
    const f = fixture(); await f.legacy(1); vi.stubGlobal("fetch", vi.fn(async () => new Response("secret provider body", { status: 429, headers: { "retry-after": "7200" } })));
    await f.call("refresh"); expect(f.state()).toMatchObject({ nextRunAt: now + 2 * hour, lastError: "HISTORICAL_PRICE_RATE_LIMITED" });
    await f.call("refresh"); expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.tables)).not.toContain("secret provider body");
  });
  it("rejects mismatched block responses instead of using a wrong historical time", async () => {
    const f = fixture(); await f.legacy(1, { blockNumber: "123" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: { number: "0x7c", timestamp: "0x1" } }))));
    await f.call("refresh"); expect(f.state().lastError).toBe("HISTORICAL_BLOCK_INVALID"); expect(f.stats().pricedCount).toBe(0);
  });
  it("waits for an incomplete candle instead of manufacturing a current valuation", async () => {
    const f = fixture(); await f.legacy(1, { updatedAt: now - FEE_PRICE_BUCKET_MS / 2 }); vi.setSystemTime(now + 10_000);
    // This claim's bucket is already closed; use a truly current timestamp instead.
    await f.db.patch(f.tables.walletTransactions[0]._id, { updatedAt: now + 5_000 }); await f.call("refresh");
    expect(fetch).not.toHaveBeenCalled(); expect(f.stats().pricedCount).toBe(0); expect(f.tables.creatorFeeClaims[0].status).toBe("pending");
  });
});

describe("public historical fee stats", () => {
  it("uses only the immutable aggregate, ignoring today's market prices", async () => {
    const f = fixture(); await f.db.insert("creatorFeeStats", { key: "public", totalUsd: 4321, claimCount: 3, pricedCount: 2, amountsJson: '{"ETH":2,"MSFT":1}' });
    await f.db.insert("marketPriceCache", { key: "ETH-USD", value: 99999, sourceTimestamp: now });
    const result = await handler(site.platformStats)(f.ctx, {});
    expect(result).toMatchObject({ feesClaimedUsd: 4321, feeClaimTransactions: 3, feeClaimsUnpriced: 1, feeValuationVersion: 1 });
    expect(f.reads).not.toContain("marketPriceCache"); expect(f.reads).not.toContain("walletTransactions");
  });
  it("does not present an old cached mark-to-market value as historical", async () => {
    const f = fixture(); await f.db.insert("platformStatsCache", { key: "public", feesClaimedUsd: 9999, feesClaimedJson: "[]" });
    expect(await handler(site.platformStats)(f.ctx, {})).toMatchObject({ feesClaimedUsd: 0, feeValuationVersion: 0 });
  });
});
