import { v } from "convex/values";
import { mutation, query, internalAction, internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { isTokenIndexExcluded } from "../lib/token-index-exclusions";
import { newerSnapshot, reserveProviderAttempt, snapshotFresh, WEBSITE_MARKET_TTL_MS, WEBSITE_REFRESH_LEASE_MS, WEBSITE_REFRESH_RETRY_MS } from "../lib/website-refresh-policy";
import { COINGECKO_PAID_REQUESTS_PER_MINUTE, GECKO_REQUESTS_PER_MINUTE, geckoBudgetRetryAt, geckoRetryAt } from "../lib/gecko-budget-policy";
import { activityDue, ACTIVITY_LEASE_MS } from "../lib/token-activity-policy";

function authorize(secret: string) {
  if (!process.env.MARKET_INDEX_SECRET || secret !== process.env.MARKET_INDEX_SECRET) throw new Error("market data authorization failed");
}
const address = (value: string) => /^0x[0-9a-f]{40}$/i.test(value);

async function budget(ctx: MutationCtx, key: string, limit: number) {
  const now = Date.now();
  const current = await ctx.db.query("websiteProviderBudget").withIndex("by_key", q => q.eq("key", key)).unique();
  if (current?.blockedUntil && current.blockedUntil > now) return false;
  const next = reserveProviderAttempt(current?.attempts ?? [], now, limit);
  if (!next.allowed) return false;
  if (current) await ctx.db.patch(current._id, { attempts: next.attempts });
  else await ctx.db.insert("websiteProviderBudget", { key, attempts: next.attempts });
  return true;
}

export const acquire = mutation({
  args: { secret: v.string(), tokens: v.array(v.string()), leaseId: v.string(), viewerKey: v.string() },
  handler: async (ctx, { secret, tokens, leaseId, viewerKey }) => {
    authorize(secret);
    if (tokens.length > 20) throw new Error("too many visible tokens");
    const now = Date.now();
    const targets = [];
    for (const token of [...new Set(tokens.map(t => t.toLowerCase()))]) {
      if (!address(token) || isTokenIndexExcluded(token)) continue;
      // This small row is sufficient to reject duplicate/in-flight/fresh work.
      // Do not repeatedly load full launch metadata and market history first.
      const job = await ctx.db.query("websiteRefreshJobs").withIndex("by_token", q => q.eq("token", token)).unique();
      if (job && (job.leaseUntil > now || job.retryAt > now)) continue;
      const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", token)).unique();
      if (!launch?.publicPublished || !launch.tokenAddress || !launch.poolAddress) continue;
      const state = await ctx.db.query("tokenMarketState").withIndex("by_normalized_token", q => q.eq("normalizedTokenAddress", token)).unique();
      const capAt = Math.max(state?.marketCapUpdatedAt ?? 0, launch.publicMarketCapUpdatedAt ?? 0);
      const cap = (state?.marketCapUpdatedAt ?? 0) >= (launch.publicMarketCapUpdatedAt ?? 0) ? state?.marketCapUsd : launch.publicMarketCapUsd;
      if (snapshotFresh(cap, capAt, now)) {
        const fresh = { token, leaseId, leaseUntil: 0, retryAt: capAt + WEBSITE_MARKET_TTL_MS };
        if (job) await ctx.db.patch(job._id, fresh); else await ctx.db.insert("websiteRefreshJobs", fresh);
        continue;
      }
      targets.push({ tokenAddress: token, curveAddress: launch.poolAddress, pairToken: launch.pairToken ?? `0x${"0".repeat(40)}`,
        graduated: state?.graduated === true || launch.publicGraduated === true,
        poolFee: state?.poolFee, tickSpacing: state?.tickSpacing, job });
    }
    if (!targets.length) return [];
    // Only charge an IP when it actually requests upstream work, not a cache hit.
    const key = `snapshot:${viewerKey}`;
    const viewer = await ctx.db.query("marketViewerRateLimits").withIndex("by_key", q => q.eq("key", key)).unique();
    const sameWindow = viewer && now - viewer.windowStartedAt < 60_000;
    const count = sameWindow ? viewer.count : 0;
    if (count >= 12) return [];
    const values = { key, count: count + 1, windowStartedAt: sameWindow ? viewer.windowStartedAt : now, updatedAt: now };
    if (viewer) await ctx.db.patch(viewer._id, values); else await ctx.db.insert("marketViewerRateLimits", values);
    for (const target of targets) {
      const values = { token: target.tokenAddress, leaseId, leaseUntil: now + WEBSITE_REFRESH_LEASE_MS, retryAt: 0 };
      if (target.job) await ctx.db.patch(target.job._id, values); else await ctx.db.insert("websiteRefreshJobs", values);
    }
    return targets.map(({ job: _job, ...target }) => target);
  },
});

const snapshot = v.object({ tokenAddress: v.string(), observedAt: v.number(), marketCapUsd: v.optional(v.number()),
  marketCapSource: v.optional(v.union(v.literal("gecko"), v.literal("onchain"))), volume24hUsd: v.optional(v.number()), volumeObservedAt: v.optional(v.number()),
  graduated: v.optional(v.boolean()), poolFee: v.optional(v.number()), tickSpacing: v.optional(v.number()),
});
export const complete = mutation({
  args: { secret: v.string(), leaseId: v.string(), tokens: v.array(v.string()), snapshots: v.array(snapshot) },
  handler: async (ctx, { secret, leaseId, tokens, snapshots }) => {
    authorize(secret);
    if (tokens.length > 20 || snapshots.length > 20) throw new Error("too many snapshots");
    const now = Date.now();
    for (const token of tokens) {
      const normalized = token.toLowerCase();
      const job = await ctx.db.query("websiteRefreshJobs").withIndex("by_token", q => q.eq("token", normalized)).unique();
      if (!job || job.leaseId !== leaseId || job.leaseUntil <= now) continue;
      const next = snapshots.find(s => s.tokenAddress.toLowerCase() === normalized);
      const valid = next && next.observedAt <= now && next.observedAt >= now - 120_000;
      const capValid = valid && next.marketCapUsd !== undefined && Number.isFinite(next.marketCapUsd) && next.marketCapUsd > 0;
      await ctx.db.patch(job._id, { leaseUntil: 0, retryAt: capValid ? next.observedAt + WEBSITE_MARKET_TTL_MS : now + WEBSITE_REFRESH_RETRY_MS });
      if (!valid || isTokenIndexExcluded(normalized)) continue;
      const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", normalized)).unique();
      if (!launch?.publicPublished) continue;
      const state = await ctx.db.query("tokenMarketState").withIndex("by_normalized_token", q => q.eq("normalizedTokenAddress", normalized)).unique();
      const cap = capValid && newerSnapshot(Math.max(state?.marketCapUpdatedAt ?? 0, launch.publicMarketCapUpdatedAt ?? 0), next.observedAt);
      const volumeAt = next.volumeObservedAt ?? next.observedAt;
      const volume = next.volume24hUsd !== undefined && Number.isFinite(next.volume24hUsd) && next.volume24hUsd >= 0 && volumeAt <= now && volumeAt >= now - 120_000
        && newerSnapshot(Math.max(state?.volume24hUpdatedAt ?? 0, launch.publicVolume24hUpdatedAt ?? 0), volumeAt);
      const phase = next.graduated !== undefined && newerSnapshot(state?.graduationCheckedAt, next.observedAt);
      const graduated = state?.graduated === true || launch.publicGraduated === true || next.graduated === true;
      const fields = { ...(cap ? { marketCapUsd: next.marketCapUsd, marketCapUpdatedAt: next.observedAt, marketCapSource: next.marketCapSource } : {}),
        ...(volume ? { volume24hUsd: next.volume24hUsd, volume24hUpdatedAt: volumeAt } : {}),
        ...(phase ? { graduated, graduationUpdatedAt: next.observedAt, graduationCheckedAt: next.observedAt,
          ...(next.poolFee === undefined ? {} : { poolFee: next.poolFee }), ...(next.tickSpacing === undefined ? {} : { tickSpacing: next.tickSpacing }) } : {}),
      };
      if (!Object.keys(fields).length) continue;
      if (state) await ctx.db.patch(state._id, { ...fields, updatedAt: now });
      else await ctx.db.insert("tokenMarketState", { tokenAddress: normalized, normalizedTokenAddress: normalized, ...fields, updatedAt: now });
      await ctx.db.patch(launch._id, {
        ...(cap ? { publicMarketCapUsd: next.marketCapUsd, publicMarketCapUpdatedAt: next.observedAt } : {}),
        ...(volume ? { publicVolume24hUsd: next.volume24hUsd, publicVolume24hUpdatedAt: volumeAt } : {}),
        ...(phase ? { publicGraduated: graduated, publicGraduationUpdatedAt: next.observedAt } : {}), updatedAt: now,
      });
    }
  },
});

export const reserveAlchemy = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => { authorize(secret); return budget(ctx, "website-alchemy-tokens", 12); },
});

export const acquireCatalog = mutation({
  args: { secret: v.string(), leaseId: v.string() },
  handler: async (ctx, { secret, leaseId }) => {
    authorize(secret);
    const now = Date.now(), key = "website-catalog";
    const row = await ctx.db.query("websiteReadCache").withIndex("by_key", q => q.eq("key", key)).unique();
    if (row && (row.expiresAt > now || (row.leaseUntil ?? 0) > now)) return false;
    const values = { key, expiresAt: now + 15 * 60_000, leaseId, leaseUntil: now + 60_000 };
    if (row) await ctx.db.patch(row._id, values); else await ctx.db.insert("websiteReadCache", values);
    const offset = Number(row?.json ?? 0);
    return { offset: Number.isInteger(offset) && offset >= 0 ? offset : 0 };
  },
});

export const recordCatalog = mutation({
  args: { secret: v.string(), leaseId: v.string(), snapshots: v.array(snapshot), nextOffset: v.optional(v.number()) },
  handler: async (ctx, { secret, leaseId, snapshots, nextOffset }) => {
    authorize(secret);
    if (snapshots.length > 300) throw new Error("too many catalog snapshots");
    const now = Date.now();
    const lock = await ctx.db.query("websiteReadCache").withIndex("by_key", q => q.eq("key", "website-catalog")).unique();
    if (!lock || lock.leaseId !== leaseId || (lock.leaseUntil ?? 0) <= now) return;
    for (const next of snapshots) {
      const token = next.tokenAddress.toLowerCase();
      if (isTokenIndexExcluded(token) || next.observedAt > now || next.observedAt < now - 120_000) continue;
      const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", token)).unique();
      if (!launch?.publicPublished) continue;
      const state = await ctx.db.query("tokenMarketState").withIndex("by_normalized_token", q => q.eq("normalizedTokenAddress", token)).unique();
      const cap = next.marketCapUsd !== undefined && Number.isFinite(next.marketCapUsd) && next.marketCapUsd > 0
        && newerSnapshot(Math.max(state?.marketCapUpdatedAt ?? 0, launch.publicMarketCapUpdatedAt ?? 0), next.observedAt);
      const volume = next.volume24hUsd !== undefined && Number.isFinite(next.volume24hUsd) && next.volume24hUsd >= 0
        && newerSnapshot(Math.max(state?.volume24hUpdatedAt ?? 0, launch.publicVolume24hUpdatedAt ?? 0), next.observedAt);
      if (!cap && !volume) continue;
      const fields = { ...(cap ? { marketCapUsd: next.marketCapUsd, marketCapUpdatedAt: next.observedAt, marketCapSource: "gecko" as const } : {}),
        ...(volume ? { volume24hUsd: next.volume24hUsd, volume24hUpdatedAt: next.observedAt } : {}) };
      if (state) await ctx.db.patch(state._id, { ...fields, updatedAt: now });
      else await ctx.db.insert("tokenMarketState", { tokenAddress: token, normalizedTokenAddress: token, ...fields, updatedAt: now });
      await ctx.db.patch(launch._id, {
        ...(cap ? { publicMarketCapUsd: next.marketCapUsd, publicMarketCapUpdatedAt: next.observedAt } : {}),
        ...(volume ? { publicVolume24hUsd: next.volume24hUsd, publicVolume24hUpdatedAt: next.observedAt } : {}), updatedAt: now,
      });
    }
    await ctx.db.patch(lock._id, { leaseUntil: 0, ...(nextOffset !== undefined && Number.isInteger(nextOffset) && nextOffset >= 0 ? { json: String(nextOffset) } : {}) });
  },
});

export const cleanup = internalMutation({
  args: {},
  handler: async ctx => {
    const old = await ctx.db.query("websiteReadCache").withIndex("by_expiry", q => q.lt("expiresAt", Date.now() - 24 * 60 * 60_000)).take(300);
    for (const row of old) if ((row.leaseUntil ?? 0) < Date.now()) await ctx.db.delete(row._id);
  },
});

export const readCache = query({
  args: { secret: v.string(), key: v.string() },
  handler: async (ctx, { secret, key }) => {
    authorize(secret);
    const row = await ctx.db.query("websiteReadCache").withIndex("by_key", q => q.eq("key", key)).unique();
    return row?.json && row.expiresAt > Date.now() ? { json: row.json, observedAt: row.observedAt ?? 0 } : null;
  },
});
export const writeCache = mutation({
  args: { secret: v.string(), key: v.string(), json: v.string(), ttlMs: v.number(), observedAt: v.number() },
  handler: async (ctx, { secret, key, json, ttlMs, observedAt }) => {
    authorize(secret);
    const descriptor = key.startsWith("liquidity-descriptors:");
    if (!(key.startsWith("metadata:") || descriptor) || key.length > 250 || json.length > 20_000) throw new Error("invalid metadata cache");
    const row = await ctx.db.query("websiteReadCache").withIndex("by_key", q => q.eq("key", key)).unique();
    if (row && (row.observedAt ?? 0) > observedAt) return;
    const maximumTtl = descriptor ? 30 * 24 * 60 * 60_000 : 3_600_000;
    const values = { key, json, observedAt, expiresAt: observedAt + Math.min(Math.max(ttlMs, 1_000), maximumTtl) };
    if (row) await ctx.db.patch(row._id, values); else await ctx.db.insert("websiteReadCache", values);
  },
});

export const reserveGecko = mutation({
  args: { secret: v.string(), key: v.string(), leaseId: v.string(), freshAfter: v.optional(v.number()), priority: v.optional(v.union(v.literal("background"), v.literal("interactive"))), paid: v.optional(v.boolean()) },
  handler: async (ctx, { secret, key, leaseId, freshAfter, priority = "background", paid = false }) => {
    authorize(secret);
    if (!(paid ? key.startsWith("coingecko-paid:") : key.startsWith("gecko:")) || key.length > 4_000) throw new Error("invalid Gecko cache key");
    const now = Date.now();
    if (freshAfter !== undefined && (!Number.isFinite(freshAfter) || freshAfter > now + 30_000 || freshAfter < now - 10 * 60_000)) throw new Error("invalid Gecko freshness request");
    const row = await ctx.db.query("websiteReadCache").withIndex("by_key", q => q.eq("key", key)).unique();
    const previous = { json: row?.json, observedAt: row?.observedAt, stale: true };
    if (row && row.expiresAt > now && (freshAfter === undefined || (row.observedAt ?? 0) >= freshAfter)) return { acquired: false, ...previous, stale: false };
    if ((row?.leaseUntil ?? 0) > now || (row?.retryAt ?? 0) > now) return { acquired: false, ...previous, retryAt: Math.max(row?.leaseUntil ?? 0, row?.retryAt ?? 0) };
    // Leave headroom below the free-tier 30/minute allowance. All website,
    // history, and display-price consumers reserve from this same budget.
    const providerKey = paid ? "coingecko-paid" : "gecko";
    const provider = await ctx.db.query("websiteProviderBudget").withIndex("by_key", q => q.eq("key", providerKey)).unique();
    const periodKey = new Date(now).toISOString().slice(0, 7);
    const configuredMonthly = Number(process.env.COINGECKO_PAID_MONTHLY_REQUEST_LIMIT || 90_000);
    const monthlyLimit = Number.isFinite(configuredMonthly) ? Math.min(Math.max(Math.floor(configuredMonthly), 1_000), 100_000) : 90_000;
    const samePeriod = provider?.periodKey === periodKey;
    const periodCount = samePeriod ? Math.max(provider?.periodCount ?? 0, provider?.officialPeriodCount ?? 0) : 0;
    const officialLimit = samePeriod && Number.isFinite(provider?.officialPeriodLimit) ? provider!.officialPeriodLimit! : monthlyLimit;
    const effectiveMonthlyLimit = Math.min(monthlyLimit, Math.max(1, Math.floor(officialLimit)));
    const nextMonth = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1);
    const monthlyRetry = paid && periodCount >= effectiveMonthlyLimit ? nextMonth : 0;
    const retryAt = Math.max(monthlyRetry, geckoBudgetRetryAt(provider?.attempts ?? [], provider?.blockedUntil, now, priority, paid), priority === "background" ? provider?.interactiveUntil ?? 0 : 0);
    if (retryAt > now) {
      // Short-lived priority reservation prevents a background batch repeatedly
      // winning the next slot. Abandoned callers release it by expiry; provider
      // cooldowns and the total rolling quota are never bypassed.
      if (priority === "interactive" && retryAt - now <= 10_000 && provider) {
        await ctx.db.patch(provider._id, { interactiveUntil: Math.max(provider.interactiveUntil ?? 0, retryAt + 1000) });
      }
      return { acquired: false, ...previous, retryAt };
    }
    const attempts = reserveProviderAttempt(provider?.attempts ?? [], now, paid ? COINGECKO_PAID_REQUESTS_PER_MINUTE : GECKO_REQUESTS_PER_MINUTE).attempts;
    const usage = paid ? { periodKey, periodCount: periodCount + 1 } : {};
    if (provider) await ctx.db.patch(provider._id, { attempts, ...usage, ...(priority === "interactive" ? { interactiveUntil: 0 } : {}) });
    else await ctx.db.insert("websiteProviderBudget", { key: providerKey, attempts, ...usage });
    const fields = { key, leaseId, leaseUntil: now + 20_000, expiresAt: row?.expiresAt ?? now };
    if (row) await ctx.db.patch(row._id, fields); else await ctx.db.insert("websiteReadCache", fields);
    return { acquired: true, ...previous };
  },
});

export const recordCoinGeckoUsage = internalMutation({
  args: {
    periodKey: v.string(), count: v.number(), limit: v.number(), remaining: v.number(),
    rateLimit: v.number(), plan: v.string(), observedAt: v.number(),
  },
  handler: async (ctx, args) => {
    if (!/^\d{4}-\d{2}$/.test(args.periodKey) || !Number.isInteger(args.count) || args.count < 0
      || !Number.isInteger(args.limit) || args.limit < 1 || !Number.isFinite(args.remaining) || args.remaining < 0
      || !Number.isFinite(args.rateLimit) || args.rateLimit < 1 || args.plan.length > 100
      || args.observedAt > Date.now() + 30_000 || args.observedAt < Date.now() - 10 * 60_000) throw new Error("invalid CoinGecko usage snapshot");
    const key = "coingecko-paid";
    const row = await ctx.db.query("websiteProviderBudget").withIndex("by_key", q => q.eq("key", key)).unique();
    const localCount = row?.periodKey === args.periodKey ? row.periodCount ?? 0 : 0;
    const values = {
      periodKey: args.periodKey, periodCount: Math.max(localCount, args.count),
      officialPeriodCount: args.count, officialPeriodLimit: args.limit,
      officialRemaining: args.remaining, officialRateLimit: args.rateLimit,
      officialPlan: args.plan, officialSyncedAt: args.observedAt,
    };
    if (row) await ctx.db.patch(row._id, values);
    else await ctx.db.insert("websiteProviderBudget", { key, attempts: [], ...values });
  },
});

export const syncCoinGeckoUsage = internalAction({
  args: {},
  handler: async (ctx) => {
    const key = process.env.COINGECKO_PRO_API_KEY?.trim();
    if (!key) return { status: "not_configured" as const };
    try {
      const response = await fetch("https://pro-api.coingecko.com/api/v3/key", {
        headers: { accept: "application/json", "x-cg-pro-api-key": key, "user-agent": "PonsBot/1.0" },
        cache: "no-store", signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return { status: "unavailable" as const, httpStatus: response.status };
      const value = await response.json() as Record<string, unknown>;
      const count = Number(value.api_key_current_total_monthly_calls ?? value.current_total_monthly_calls);
      const limit = Number(value.api_key_monthly_call_credit ?? value.monthly_call_credit);
      const remaining = Number(value.current_remaining_monthly_calls ?? Math.max(0, limit - count));
      const rateLimit = Number(value.api_key_rate_limit_request_per_minute ?? value.rate_limit_request_per_minute);
      const plan = typeof value.plan === "string" ? value.plan : "unknown";
      if (![count, limit, remaining, rateLimit].every(Number.isFinite)) return { status: "invalid_response" as const };
      const observedAt = Date.now();
      await ctx.runMutation(internal.marketData.recordCoinGeckoUsage, {
        periodKey: new Date(observedAt).toISOString().slice(0, 7), count: Math.floor(count), limit: Math.floor(limit),
        remaining: Math.max(0, remaining), rateLimit, plan, observedAt,
      });
      return { status: "synchronized" as const, count: Math.floor(count), limit: Math.floor(limit) };
    } catch {
      return { status: "unavailable" as const };
    }
  },
});
export const completeGecko = mutation({
  args: { secret: v.string(), key: v.string(), leaseId: v.string(), json: v.optional(v.string()), ttlMs: v.number(), observedAt: v.number(), throttled: v.boolean(), retryAfter: v.optional(v.string()), paid: v.optional(v.boolean()) },
  handler: async (ctx, { secret, key, leaseId, json, ttlMs, observedAt, throttled, retryAfter, paid = false }) => {
    authorize(secret);
    const row = await ctx.db.query("websiteReadCache").withIndex("by_key", q => q.eq("key", key)).unique();
    if (!row || row.leaseId !== leaseId || (row.leaseUntil ?? 0) <= Date.now()) return;
    const ok = json !== undefined && json.length < 500_000;
    const retryAt = throttled ? geckoRetryAt(retryAfter, Date.now()) : Date.now() + 60_000;
    // A failed refresh must not delete useful history or give old data a new timestamp.
    await ctx.db.patch(row._id, { ...(ok ? { json, observedAt,
      expiresAt: Date.now() + Math.min(Math.max(ttlMs, 1_000), 300_000) } : {}),
      retryAt: ok ? 0 : retryAt, leaseUntil: 0 });
    if (throttled) {
      const provider = await ctx.db.query("websiteProviderBudget").withIndex("by_key", q => q.eq("key", paid ? "coingecko-paid" : "gecko")).unique();
      if (provider) await ctx.db.patch(provider._id, { blockedUntil: Math.max(provider.blockedUntil ?? 0, retryAt) });
    }
  },
});

const activityKind = v.union(v.literal("trades"), v.literal("holders"));
async function visibleLaunch(ctx: Pick<QueryCtx, "db">, token: string) {
  if (!address(token) || isTokenIndexExcluded(token)) return null;
  const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", token)).unique();
  return launch?.publicPublished ? launch : null;
}

export const activitySnapshot = query({
  args: { secret: v.string(), token: v.string(), kind: activityKind },
  handler: async (ctx, { secret, token, kind }) => {
    authorize(secret); token = token.toLowerCase();
    if (!await visibleLaunch(ctx, token)) return null;
    const row = await ctx.db.query("websiteActivitySnapshots").withIndex("by_token_kind", q => q.eq("token", token).eq("kind", kind)).unique();
    return { json: row?.json, observedAt: row?.observedAt,
      due: activityDue(row?.observedAt, row?.retryAt ?? 0, row?.leaseUntil ?? 0, Date.now()),
      refreshing: (row?.leaseUntil ?? 0) > Date.now() };
  },
});

export const acquireActivity = mutation({
  args: { secret: v.string(), token: v.string(), kind: activityKind, leaseId: v.string(), viewerKey: v.string() },
  handler: async (ctx, { secret, token, kind, leaseId, viewerKey }) => {
    authorize(secret); token = token.toLowerCase();
    if (viewerKey.length > 100 || !await visibleLaunch(ctx, token)) return null;
    const row = await ctx.db.query("websiteActivitySnapshots").withIndex("by_token_kind", q => q.eq("token", token).eq("kind", kind)).unique();
    const now = Date.now();
    if (!activityDue(row?.observedAt, row?.retryAt ?? 0, row?.leaseUntil ?? 0, now)) return null;
    if (!await budget(ctx, "website-activity", 30)) return null;
    const key = `activity:${viewerKey}`;
    const viewer = await ctx.db.query("marketViewerRateLimits").withIndex("by_key", q => q.eq("key", key)).unique();
    const same = viewer && now - viewer.windowStartedAt < 60_000;
    if (same && viewer.count >= 6) return null;
    const rate = { key, windowStartedAt: same ? viewer.windowStartedAt : now, count: same ? viewer.count + 1 : 1, updatedAt: now };
    if (viewer) await ctx.db.patch(viewer._id, rate); else await ctx.db.insert("marketViewerRateLimits", rate);
    const fields = { token, kind, leaseId, leaseUntil: now + ACTIVITY_LEASE_MS, retryAt: 0 };
    if (row) await ctx.db.patch(row._id, fields); else await ctx.db.insert("websiteActivitySnapshots", fields);
    return { json: row?.json, stateJson: row?.stateJson, observedAt: row?.observedAt };
  },
});

export const completeActivity = mutation({
  args: { secret: v.string(), token: v.string(), kind: activityKind, leaseId: v.string(),
    json: v.optional(v.string()), stateJson: v.optional(v.string()), observedAt: v.optional(v.number()), diagnostic: v.optional(v.string()) },
  handler: async (ctx, { secret, token, kind, leaseId, json, stateJson, observedAt, diagnostic }) => {
    authorize(secret); token = token.toLowerCase();
    if ((json?.length ?? 0) > 150_000 || (stateJson?.length ?? 0) > 50_000) throw new Error("activity snapshot too large");
    const row = await ctx.db.query("websiteActivitySnapshots").withIndex("by_token_kind", q => q.eq("token", token).eq("kind", kind)).unique();
    const now = Date.now();
    if (!row || row.leaseId !== leaseId || row.leaseUntil <= now || !await visibleLaunch(ctx, token)) return;
    const good = json !== undefined && observedAt !== undefined && observedAt <= now && observedAt >= now - ACTIVITY_LEASE_MS
      && observedAt >= (row.observedAt ?? 0);
    if (good) {
      const value = JSON.parse(json);
      if (!Array.isArray(value[kind]) || value[kind].length > (kind === "trades" ? 100 : 20)) throw new Error("invalid activity rows");
    }
    await ctx.db.patch(row._id, { ...(good ? { json, observedAt } : {}), ...(stateJson === undefined ? {} : { stateJson }),
      leaseUntil: 0, retryAt: good ? 0 : now + 60_000, diagnostic: diagnostic?.slice(0, 100) });
  },
});

export const holderHistory = query({
  args: { secret: v.string(), token: v.string() },
  handler: async (ctx, { secret, token }) => {
    authorize(secret); token = token.toLowerCase();
    if (!await visibleLaunch(ctx, token)) return null;
    const state = await ctx.db.query("websiteHolderHistory").withIndex("by_token", q => q.eq("token", token)).unique();
    const top = await ctx.db.query("websiteHolderBalances").withIndex("by_token_rank", q => q.eq("token", token)).order("desc").take(100);
    return { throughBlock: state?.throughBlock, blockHash: state?.blockHash, top: top.map(r => ({ address: r.address, raw: r.raw })) };
  },
});

// One atomic, bounded display-history batch. No scheduling and no calls into wallet workflows.
export const recordHolderHistory = mutation({
  args: { secret: v.string(), token: v.string(), leaseId: v.string(), previousBlock: v.optional(v.string()),
    throughBlock: v.string(), blockHash: v.string(), deltas: v.array(v.object({ address: v.string(), delta: v.string() })) },
  handler: async (ctx, { secret, token, leaseId, previousBlock, throughBlock, blockHash, deltas }) => {
    authorize(secret); token = token.toLowerCase();
    if (deltas.length > 1200 || !/^\d+$/.test(throughBlock) || !/^0x[0-9a-f]{64}$/i.test(blockHash)) throw new Error("invalid holder history batch");
    const job = await ctx.db.query("websiteActivitySnapshots").withIndex("by_token_kind", q => q.eq("token", token).eq("kind", "holders")).unique();
    if (!job || job.leaseId !== leaseId || job.leaseUntil <= Date.now() || !await visibleLaunch(ctx, token)) return false;
    const state = await ctx.db.query("websiteHolderHistory").withIndex("by_token", q => q.eq("token", token)).unique();
    if (state?.throughBlock !== previousBlock || (previousBlock !== undefined && BigInt(throughBlock) <= BigInt(previousBlock))) return false;
    const seen = new Set<string>();
    for (const change of deltas) {
      const holder = change.address.toLowerCase();
      if (!address(holder) || seen.has(holder) || !/^-?\d{1,80}$/.test(change.delta)) throw new Error("invalid holder delta");
      seen.add(holder);
      const old = await ctx.db.query("websiteHolderBalances").withIndex("by_token_address", q => q.eq("token", token).eq("address", holder)).unique();
      const raw = BigInt(old?.raw ?? "0") + BigInt(change.delta);
      if (raw < 0n || raw > (1n << 256n) - 1n) throw new Error("holder history inconsistent");
      if (raw === 0n) { if (old) await ctx.db.delete(old._id); continue; }
      const fields = { token, address: holder, raw: raw.toString(), rank: Number(raw) };
      if (old) await ctx.db.patch(old._id, fields); else await ctx.db.insert("websiteHolderBalances", fields);
    }
    const fields = { token, throughBlock, blockHash, updatedAt: Date.now() };
    if (state) await ctx.db.patch(state._id, fields); else await ctx.db.insert("websiteHolderHistory", fields);
    return true;
  },
});
