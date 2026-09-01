import { v } from "convex/values";
import { formatUnits } from "viem";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { feePriceBucket, FEE_PRICE_BUCKET_MS, FEE_PRICE_DAY_MS, historicalEthCandles, parseClaimedAsset } from "../lib/historical-fee-prices";

const KEY = "public", HOUR = 60 * 60_000, BATCH = 20;
const native = (address?: string) => !address || /^0x0{40}$/i.test(address);
type ClaimInput = Pick<Doc<"creatorFeeClaims">, "transactionHash" | "source" | "assetSymbol" | "amount" | "recordedAt">
  & Partial<Pick<Doc<"creatorFeeClaims">, "assetAddress" | "rawAmount" | "blockNumber">>;

async function insertClaim(ctx: MutationCtx, input: ClaimInput) {
  if (!/^0x[0-9a-f]{64}$/i.test(input.transactionHash) || !Number.isFinite(input.amount) || input.amount <= 0) return;
  // One economic claim per transaction. Sweeps and beneficiary delivery are
  // deliberately not claims; neither is counted again after a vault process.
  const key = `4663:${input.transactionHash.toLowerCase()}`;
  if (await ctx.db.query("creatorFeeClaims").withIndex("by_key", q => q.eq("key", key)).unique()) return;
  const now = Date.now();
  const eth = input.assetSymbol === "ETH" && native(input.assetAddress);
  await ctx.db.insert("creatorFeeClaims", {
    ...input, transactionHash: input.transactionHash.toLowerCase(), key,
    status: eth ? "pending" : "unsupported", nextAttemptAt: now, updatedAt: now,
    ...(!eth ? { diagnosticCode: "HISTORICAL_ASSET_PRICE_UNAVAILABLE" } : {}),
  });
  const stats = await ctx.db.query("creatorFeeStats").withIndex("by_key", q => q.eq("key", KEY)).unique();
  const amounts: Record<string, number> = Object.assign(Object.create(null), stats ? JSON.parse(stats.amountsJson) : {});
  amounts[input.assetSymbol] = (amounts[input.assetSymbol] ?? 0) + input.amount;
  const value = { claimCount: (stats?.claimCount ?? 0) + 1, amountsJson: JSON.stringify(amounts), updatedAt: now };
  if (stats) await ctx.db.patch(stats._id, value);
  else await ctx.db.insert("creatorFeeStats", { key: KEY, totalUsd: 0, pricedCount: 0, ...value });
}

async function ingestLegacy(ctx: MutationCtx, row: Doc<"walletTransactions">) {
  if (row.chainId !== 4663 || row.status !== "confirmed" || row.callKind !== "pons_v2_claim_fees") return;
  const asset = parseClaimedAsset(row.claimedDisplay);
  if (!asset) return;
  await insertClaim(ctx, { transactionHash: row.transactionHash, source: "legacy", assetSymbol: asset.symbol,
    amount: asset.amount, assetAddress: row.involvedPairTokenAddress, blockNumber: row.blockNumber, recordedAt: row.updatedAt });
}

async function ingestVault(ctx: MutationCtx, row: Doc<"automatedFeeRuns">) {
  if (row.status !== "confirmed" || !row.grossClaimed || !/^\d+$/.test(row.grossClaimed)) return;
  const program = await ctx.db.get(row.programId);
  if (!program || program.privateTest) return;
  const address = row.pairTokenAddress.toLowerCase();
  const pair = native(address) ? null : await ctx.db.query("tokenRegistry")
    .withIndex("by_normalized_address", q => q.eq("normalizedAddress", address)).unique();
  // Do not guess decimals for an unknown paired asset.
  if (!native(address) && !pair) return;
  const hash = row.processingTransactionHash ?? row.transactionHash;
  if (!hash) return;
  await insertClaim(ctx, { source: "vault", transactionHash: hash, assetAddress: address,
    assetSymbol: native(address) ? "ETH" : pair!.symbol.toUpperCase(),
    amount: Number(formatUnits(BigInt(row.grossClaimed), native(address) ? 18 : pair!.decimals)), rawAmount: row.grossClaimed,
    blockNumber: row.processingBlockNumber ?? row.blockNumber, recordedAt: row.processingBroadcastAt ?? row.updatedAt });
}

// Scheduled after confirmation: price-provider health can never interrupt a
// user's wallet workflow or block an automated payout.
export const recordLegacyClaim = internalMutation({
  args: { requestId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("walletTransactions").withIndex("by_request_id", q => q.eq("requestId", args.requestId)).unique();
    if (row) await ingestLegacy(ctx, row);
  },
});
export const recordVaultClaim = internalMutation({
  args: { runId: v.id("automatedFeeRuns") },
  handler: async (ctx, args) => { const row = await ctx.db.get(args.runId); if (row) await ingestVault(ctx, row); },
});

export const beginBatch = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let state = await ctx.db.query("creatorFeeHistoryWorker").withIndex("by_key", q => q.eq("key", KEY)).unique();
    if (state && ((state.leaseUntil ?? 0) > now || state.nextRunAt > now)) return null;
    if (!state) {
      const id = await ctx.db.insert("creatorFeeHistoryWorker", { key: KEY, legacyDone: false, vaultDone: false, nextRunAt: now, updatedAt: now });
      state = (await ctx.db.get(id))!;
    }
    const leaseToken = `${state._id}:${now}`;
    await ctx.db.patch(state._id, { leaseToken, leaseUntil: now + 5 * 60_000, updatedAt: now });
    // One bounded page per source. Completed backfills are never rescanned.
    if (!state.legacyDone) {
      const page = await ctx.db.query("walletTransactions").withIndex("by_status_created_at", q => q.eq("status", "confirmed"))
        .paginate({ cursor: state.legacyCursor ?? null, numItems: 100 });
      for (const row of page.page) await ingestLegacy(ctx, row);
      await ctx.db.patch(state._id, { legacyCursor: page.continueCursor, legacyDone: page.isDone });
    } else if (!state.vaultDone) {
      const page = await ctx.db.query("automatedFeeRuns").withIndex("by_status_next_retry", q => q.eq("status", "confirmed"))
        .paginate({ cursor: state.vaultCursor ?? null, numItems: 100 });
      for (const row of page.page) await ingestVault(ctx, row);
      await ctx.db.patch(state._id, { vaultCursor: page.continueCursor, vaultDone: page.isDone });
    }
    const rows = await ctx.db.query("creatorFeeClaims").withIndex("by_status_due", q => q.eq("status", "pending").lte("nextAttemptAt", now)).take(BATCH);
    return { leaseToken, rows };
  },
});

async function validLease(ctx: MutationCtx, leaseToken: string) {
  const state = await ctx.db.query("creatorFeeHistoryWorker").withIndex("by_key", q => q.eq("key", KEY)).unique();
  return state?.leaseToken === leaseToken && (state.leaseUntil ?? 0) > Date.now() ? state : null;
}

export const recordTime = internalMutation({
  args: { leaseToken: v.string(), id: v.id("creatorFeeClaims"), claimedAt: v.number(), blockTime: v.boolean() },
  handler: async (ctx, args) => {
    if (!await validLease(ctx, args.leaseToken)) return;
    const row = await ctx.db.get(args.id);
    if (!row || row.status !== "pending" || row.claimedAt !== undefined) return;
    if (!Number.isSafeInteger(args.claimedAt) || args.claimedAt <= 0 || args.claimedAt > Date.now()) return;
    await ctx.db.patch(row._id, { claimedAt: args.claimedAt, timestampSource: args.blockTime ? "block" : "recorded_confirmation" });
  },
});

export const cachedPrices = internalQuery({
  args: { buckets: v.array(v.number()) },
  handler: async (ctx, args) => Promise.all([...new Set(args.buckets)].slice(0, BATCH).map(async bucketAt =>
    ctx.db.query("historicalEthPrices").withIndex("by_bucket", q => q.eq("bucketAt", bucketAt)).unique())),
});
export const savePrices = internalMutation({
  args: { leaseToken: v.string(), prices: v.array(v.object({ bucketAt: v.number(), priceUsd: v.number() })) },
  handler: async (ctx, args) => {
    if (!await validLease(ctx, args.leaseToken)) return;
    for (const price of args.prices.slice(0, BATCH)) {
      if (!Number.isSafeInteger(price.bucketAt) || price.bucketAt % FEE_PRICE_BUCKET_MS !== 0
        || price.bucketAt <= 0 || price.bucketAt + FEE_PRICE_BUCKET_MS > Date.now()
        || !Number.isFinite(price.priceUsd) || price.priceUsd <= 0) continue;
      if (!await ctx.db.query("historicalEthPrices").withIndex("by_bucket", q => q.eq("bucketAt", price.bucketAt)).unique()) {
        await ctx.db.insert("historicalEthPrices", { ...price, source: "coinbase-exchange:ETH-USD:300:open", fetchedAt: Date.now() });
      }
    }
  },
});

export const finishBatch = internalMutation({
  args: { leaseToken: v.string(), ids: v.array(v.id("creatorFeeClaims")), error: v.optional(v.string()), retryAfterMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const state = await validLease(ctx, args.leaseToken);
    if (!state) return;
    const now = Date.now();
    let addedUsd = 0, priced = 0;
    for (const id of args.ids.slice(0, BATCH)) {
      const row = await ctx.db.get(id);
      if (!row || row.status !== "pending") continue;
      const price = row.claimedAt === undefined ? null : await ctx.db.query("historicalEthPrices")
        .withIndex("by_bucket", q => q.eq("bucketAt", feePriceBucket(row.claimedAt!))).unique();
      const valueUsd = price ? row.amount * price.priceUsd : NaN;
      if (price && Number.isFinite(valueUsd) && valueUsd >= 0) {
        await ctx.db.patch(id, { status: "priced", priceBucketAt: price.bucketAt, priceUsd: price.priceUsd, valueUsd, diagnosticCode: undefined, updatedAt: now });
        addedUsd += valueUsd; priced++;
      } else {
        await ctx.db.patch(id, { nextAttemptAt: Math.floor(now / HOUR) * HOUR + HOUR, diagnosticCode: row.claimedAt === undefined ? "BLOCK_TIME_UNAVAILABLE" : "HISTORICAL_PRICE_UNAVAILABLE", updatedAt: now });
      }
    }
    const stats = await ctx.db.query("creatorFeeStats").withIndex("by_key", q => q.eq("key", KEY)).unique();
    if (stats && priced) await ctx.db.patch(stats._id, { totalUsd: stats.totalUsd + addedUsd, pricedCount: stats.pricedCount + priced, updatedAt: now });
    const cache = await ctx.db.query("platformStatsCache").withIndex("by_key", q => q.eq("key", KEY)).unique();
    if (cache && stats) await ctx.db.patch(cache._id, {
      feesClaimedUsd: stats.totalUsd + addedUsd, feeClaimTransactions: stats.claimCount,
      feeClaimsUnpriced: stats.claimCount - stats.pricedCount - priced,
      feeValuationVersion: stats.pricedCount + priced > 0 || (state.legacyDone && state.vaultDone) ? 1 : 0,
      feesClaimedJson: JSON.stringify(Object.entries(JSON.parse(stats.amountsJson) as Record<string, number>).map(([symbol, amount]) => ({ symbol, amount }))),
    });
    const more = !state.legacyDone || !state.vaultDone || Boolean(await ctx.db.query("creatorFeeClaims")
      .withIndex("by_status_due", q => q.eq("status", "pending").lte("nextAttemptAt", now)).first());
    const delay = args.error ? Math.max(HOUR, args.retryAfterMs ?? 0) : more ? 60_000 : HOUR;
    // Align idle due time to the next hour. "finish + one hour" would make
    // a slightly earlier cron miss every other run as execution time drifts.
    const nextRunAt = !more && !args.error ? Math.floor(now / HOUR) * HOUR + HOUR : now + delay;
    await ctx.db.patch(state._id, { leaseToken: undefined, leaseUntil: undefined, nextRunAt, lastError: args.error, updatedAt: now });
    // Only initial backfill/due backlog gets a continuation. Normal work is hourly.
    if (more) await ctx.scheduler.runAfter(delay, internal.creatorFeeHistory.refresh, {});
  },
});

/** Historical price fetches use Coinbase; block times use the public RPC.
 * No Alchemy, CDP signing, transaction submission, or X traffic. */
export const refresh = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const work = await ctx.runMutation(internal.creatorFeeHistory.beginBatch, {});
    if (!work) return;
    let error: string | undefined, retryAfterMs: number | undefined;
    const timed: Array<{ id: Doc<"creatorFeeClaims">["_id"]; claimedAt: number }> = [];
    const blocks = new Map<string, number>();
    try {
      for (const row of work.rows) {
        let claimedAt = row.claimedAt;
        if (claimedAt === undefined) {
          if (row.blockNumber && /^\d+$/.test(row.blockNumber)) {
            claimedAt = blocks.get(row.blockNumber);
            if (claimedAt === undefined) {
              const block = `0x${BigInt(row.blockNumber).toString(16)}`;
              const response = await fetch("https://rpc.mainnet.chain.robinhood.com", { method: "POST",
                headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(5_000),
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [block, false] }) });
              if (!response.ok) throw new Error("HISTORICAL_BLOCK_PROVIDER_UNAVAILABLE");
              const body = await response.json() as { result?: { timestamp?: string; number?: string } };
              if (!body.result?.timestamp || body.result.number?.toLowerCase() !== block) throw new Error("HISTORICAL_BLOCK_INVALID");
              claimedAt = Number(BigInt(body.result.timestamp)) * 1_000;
              if (!Number.isSafeInteger(claimedAt) || claimedAt <= 0 || claimedAt > Date.now()) throw new Error("HISTORICAL_BLOCK_INVALID");
              blocks.set(row.blockNumber, claimedAt);
            }
          } else claimedAt = row.recordedAt;
          await ctx.runMutation(internal.creatorFeeHistory.recordTime, { leaseToken: work.leaseToken, id: row._id, claimedAt, blockTime: Boolean(row.blockNumber) });
        }
        timed.push({ id: row._id, claimedAt });
      }
      const buckets = [...new Set(timed.map(row => feePriceBucket(row.claimedAt)))];
      const cached = await ctx.runQuery(internal.creatorFeeHistory.cachedPrices, { buckets });
      const missing = buckets.filter(bucket => bucket + FEE_PRICE_BUCKET_MS <= Date.now() && !cached.some(price => price?.bucketAt === bucket));
      // At most two historical daily requests per batch, at most 288 candles each.
      const days = [...new Set(missing.map(bucket => Math.floor(bucket / FEE_PRICE_DAY_MS) * FEE_PRICE_DAY_MS))].slice(0, 2);
      for (const day of days) {
        const url = new URL("https://api.exchange.coinbase.com/products/ETH-USD/candles");
        url.search = new URLSearchParams({ granularity: "300", start: new Date(day).toISOString(), end: new Date(day + FEE_PRICE_DAY_MS).toISOString() }).toString();
        const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json" } });
        if (!response.ok) {
          const retry = response.headers.get("retry-after");
          retryAfterMs = retry && Number.isFinite(Number(retry)) ? Number(retry) * 1_000 : retry ? Math.max(0, Date.parse(retry) - Date.now()) : undefined;
          throw new Error(response.status === 429 ? "HISTORICAL_PRICE_RATE_LIMITED" : "HISTORICAL_PRICE_PROVIDER_UNAVAILABLE");
        }
        const prices = historicalEthCandles(await response.json(), day, day + FEE_PRICE_DAY_MS, Date.now()).filter(price => missing.includes(price.bucketAt));
        await ctx.runMutation(internal.creatorFeeHistory.savePrices, { leaseToken: work.leaseToken, prices });
      }
    } catch (cause) {
      // Persist only fixed diagnostic codes, never provider bodies/URLs/secrets.
      error = cause instanceof Error && /^HISTORICAL_[A-Z_]+$/.test(cause.message) ? cause.message : "HISTORICAL_PROVIDER_UNAVAILABLE";
    } finally {
      await ctx.runMutation(internal.creatorFeeHistory.finishBatch, { leaseToken: work.leaseToken, ids: work.rows.map(row => row._id), error,
        ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}) });
    }
  },
});

export const status = internalQuery({
  args: {},
  handler: async ctx => ({
    stats: await ctx.db.query("creatorFeeStats").withIndex("by_key", q => q.eq("key", KEY)).unique(),
    worker: await ctx.db.query("creatorFeeHistoryWorker").withIndex("by_key", q => q.eq("key", KEY)).unique(),
  }),
});
