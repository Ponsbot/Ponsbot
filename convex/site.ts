import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";

export const PREVIEW_WALLET = "0x0000000000000000000000000000000000000B07";
export const PREVIEW_TOKEN = "0x0000000000000000000000000000000000000A11";

function publicLaunch(launch: {
  name: string; symbol: string; imageUri: string; description?: string;
  website?: string; twitter?: string; telegram?: string; tokenAddress?: string;
  transactionHash: string; devBuySucceeded?: boolean; createdAt: number;
  pairToken?: string; poolAddress?: string; launcherUsername?: string;
  creatorAddress?: string; pairSymbol?: string; publicLastBuyAt?: number; publicMarketCapUsd?: number; publicVolume24hUsd?: number; publicGraduated?: boolean;
  creatorFeeRecipient?: string; holderFeeSharing?: boolean;
}, creatorAddress?: string, launcherUsername?: string, pairSymbol?: string, lastBuyAt?: number, storedMarketCapUsd?: number, volume24hUsd?: number, graduated?: boolean, feeRecipientUsername?: string) {
  return {
    name: launch.name,
    symbol: launch.symbol,
    imageUri: launch.imageUri,
    description: launch.description,
    website: launch.website,
    twitter: launch.twitter,
    telegram: launch.telegram,
    tokenAddress: launch.tokenAddress,
    transactionHash: launch.transactionHash,
    devBuySucceeded: launch.devBuySucceeded,
    pairToken: launch.pairToken,
    pairSymbol: launch.pairSymbol || pairSymbol,
    poolAddress: launch.poolAddress,
    creatorAddress: launch.creatorAddress || creatorAddress,
    launcherUsername: launch.launcherUsername || launcherUsername,
    creatorFeeRecipient: launch.creatorFeeRecipient,
    holderFeeSharing: launch.holderFeeSharing,
    feeRecipientUsername,
    createdAt: launch.createdAt,
    lastBuyAt: launch.publicLastBuyAt ?? lastBuyAt,
    storedMarketCapUsd: launch.publicMarketCapUsd ?? storedMarketCapUsd,
    volume24hUsd: launch.publicVolume24hUsd ?? volume24hUsd,
    graduated: launch.publicGraduated ?? graduated,
  };
}

export const listLaunches = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const launches = await ctx.db.query("tokenLaunches").order("desc").take(Math.min(Math.max(limit || 24, 1), 100));
    return launches.filter((launch) => launch.tokenAddress).map((launch) => publicLaunch(launch, undefined, launch.launcherUsername, launch.pairToken === "0x0000000000000000000000000000000000000000" ? "ETH" : launch.pairSymbol));
  },
});

export const listLaunchesPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const result = await ctx.db.query("tokenLaunches").order("desc").paginate({ ...paginationOpts, numItems: Math.min(paginationOpts.numItems, 40) });
    const page = result.page.filter((launch) => launch.tokenAddress).map((launch) => publicLaunch(launch, undefined, launch.launcherUsername, launch.pairToken === "0x0000000000000000000000000000000000000000" ? "ETH" : launch.pairSymbol));
    return { ...result, page };
  },
});

export const getLaunch = query({
  args: { tokenAddress: v.string() },
  handler: async (ctx, { tokenAddress }) => {
    const normalized = tokenAddress.toLowerCase();
    const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", normalized)).unique();
    if (!launch) return null;
    const wallet = await ctx.db.get(launch.walletId);
    const user = launch.launcherUsername ? null : await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", (q) => q.eq("xUserId", launch.ownerXUserId)).unique();
    const pair = launch.pairToken ? await ctx.db.query("tokenRegistry").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", launch.pairToken!.toLowerCase())).unique() : null;
    const market = await ctx.db.query("tokenMarketState").withIndex("by_normalized_token", (q) => q.eq("normalizedTokenAddress", normalized)).unique();
    const feeWallet = launch.normalizedCreatorFeeRecipient ? await ctx.db.query("cryptoWallets")
      .withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", launch.normalizedCreatorFeeRecipient)).unique() : null;
    const feeUser = feeWallet && !feeWallet.xUsername ? await ctx.db.query("xReplyUsers")
      .withIndex("by_x_user_id", (q) => q.eq("xUserId", feeWallet.ownerXUserId)).unique() : null;
    return publicLaunch(launch, wallet?.address, user?.username, launch.pairToken === "0x0000000000000000000000000000000000000000" ? "ETH" : pair?.symbol, market?.lastBuyAt, market?.marketCapUsd, market?.volume24hUsd, market?.graduated, feeWallet?.xUsername || feeUser?.username);
  },
});

export const tokenActivity = query({
  args: { tokenAddress: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { tokenAddress, limit }) => ctx.db.query("tokenActivity")
    .withIndex("by_token_time", (q) => q.eq("normalizedTokenAddress", tokenAddress.toLowerCase()).gte("timestamp", Date.now() - 24 * 60 * 60_000))
    .order("desc").take(Math.min(Math.max(limit || 100, 1), 100)),
});

export const marketIndexTargets = query({
  args: { tokenAddresses: v.optional(v.array(v.string())) },
  handler: async (ctx, { tokenAddresses }) => {
    const requested = await Promise.all((tokenAddresses || []).slice(0, 50).map((address) => ctx.db.query("tokenLaunches")
      .withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", address.toLowerCase())).unique()));
    const launches = requested.filter((item) => item !== null);
    return Promise.all(launches
    .filter((launch) => launch.tokenAddress && launch.poolAddress)
    .map(async (launch) => {
      const market = await ctx.db.query("tokenMarketState").withIndex("by_normalized_token", (q) => q.eq("normalizedTokenAddress", launch.tokenAddress!.toLowerCase())).unique();
      return { tokenAddress: launch.tokenAddress!, curveAddress: launch.poolAddress!, pairToken: launch.pairToken || "0x0000000000000000000000000000000000000000", indexedThroughBlock: market?.indexedThroughBlock, graduated: market?.graduated, poolFee: market?.poolFee, tickSpacing: market?.tickSpacing, activityBackfilledAt: market?.activityBackfilledAt };
    }));
  },
});

export const marketRuntimeConfig = query({
  args: {},
  handler: async (ctx) => {
    const factory = await ctx.db.query("protocolContracts").withIndex("by_key", (q) => q.eq("key", "pons_v2_factory")).unique();
    return { factory: factory?.active ? factory.address : null };
  },
});

export const acquireMarketIndexLease = mutation({
  args: { now: v.number(), secret: v.string(), viewerKey: v.string() },
  handler: async (ctx, { now, secret, viewerKey }) => {
    if (!process.env.MARKET_INDEX_SECRET || secret !== process.env.MARKET_INDEX_SECRET) throw new Error("market index authorization failed");
    const viewer = await ctx.db.query("marketViewerRateLimits").withIndex("by_key", (q) => q.eq("key", viewerKey)).unique();
    const sameWindow = Boolean(viewer && now - viewer.windowStartedAt < 60_000);
    const count = sameWindow ? viewer!.count : 0;
    if (count >= 12) return { acquired: false, rateLimited: true, indexedThroughBlock: undefined };
    if (viewer) await ctx.db.patch(viewer._id, { windowStartedAt: sameWindow ? viewer.windowStartedAt : now, count: count + 1, updatedAt: now });
    else await ctx.db.insert("marketViewerRateLimits", { key: viewerKey, windowStartedAt: now, count: 1, updatedAt: now });
    const current = await ctx.db.query("marketIndexState").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    if (current && current.leaseUntil > now) {
      await ctx.db.patch(current._id, { lastViewerAt: now, updatedAt: now });
      return { acquired: false, indexedThroughBlock: current.indexedThroughBlock };
    }
    if (current) {
      await ctx.db.patch(current._id, { leaseUntil: now + 30_000, lastViewerAt: now, updatedAt: now });
      return { acquired: true, indexedThroughBlock: current.indexedThroughBlock };
    }
    await ctx.db.insert("marketIndexState", { key: "global", leaseUntil: now + 30_000, lastViewerAt: now, updatedAt: now });
    return { acquired: true };
  },
});

export const cleanupMarketViewerRateLimits = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db.query("marketViewerRateLimits").filter((q) => q.lt(q.field("updatedAt"), Date.now() - 24 * 60 * 60_000)).take(500);
    await Promise.all(expired.map((record) => ctx.db.delete(record._id)));
    return expired.length;
  },
});

export const recordMarketIndex = mutation({
  args: {
    secret: v.string(),
    indexedThroughBlock: v.string(), marketCaps: v.array(v.object({ tokenAddress: v.string(), indexedThroughBlock: v.string(), marketCapUsd: v.optional(v.number()), graduated: v.optional(v.boolean()), poolFee: v.optional(v.number()), tickSpacing: v.optional(v.number()), graduationCheckedAt: v.optional(v.number()), activityBackfilledAt: v.optional(v.number()) })),
    events: v.array(v.object({ tokenAddress: v.string(), transactionHash: v.string(), logIndex: v.number(), kind: v.union(v.literal("buy"), v.literal("sell"), v.literal("burn")), walletAddress: v.string(), tokenAmount: v.string(), marketCapUsd: v.optional(v.number()), usdAmount: v.optional(v.number()), blockNumber: v.string(), timestamp: v.number() })),
  },
  handler: async (ctx, { secret, indexedThroughBlock, marketCaps, events }) => {
    if (!process.env.MARKET_INDEX_SECRET || secret !== process.env.MARKET_INDEX_SECRET) throw new Error("market index authorization failed");
    const now = Date.now();
    for (const event of events) {
      const exists = await ctx.db.query("tokenActivity").withIndex("by_transaction_log", (q) => q.eq("transactionHash", event.transactionHash).eq("logIndex", event.logIndex)).unique();
      if (!exists) {
        const normalizedTokenAddress = event.tokenAddress.toLowerCase();
        await ctx.db.insert("tokenActivity", { ...event, normalizedTokenAddress, volumeBucketed: true, createdAt: now });
        if (event.kind !== "burn" && event.usdAmount !== undefined) {
          // Five-minute buckets avoid unbounded event scans while keeping the
          // rolling 24-hour figure close to the exact cutoff.
          const hourStartedAt = Math.floor(event.timestamp / 300_000) * 300_000;
          const bucket = await ctx.db.query("tokenVolumeBuckets").withIndex("by_token_hour", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress).eq("hourStartedAt", hourStartedAt)).unique();
          if (bucket) await ctx.db.patch(bucket._id, { volumeUsd: bucket.volumeUsd + event.usdAmount, updatedAt: now });
          else await ctx.db.insert("tokenVolumeBuckets", { normalizedTokenAddress, hourStartedAt, volumeUsd: event.usdAmount, updatedAt: now });
        }
      }
    }
    for (const item of marketCaps) {
      const normalizedTokenAddress = item.tokenAddress.toLowerCase();
      const state = await ctx.db.query("tokenMarketState").withIndex("by_normalized_token", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress)).unique();
      const lastBuyAt = events.filter((event) => event.kind === "buy" && event.tokenAddress.toLowerCase() === normalizedTokenAddress).reduce<number | undefined>((latest, event) => latest === undefined || event.timestamp > latest ? event.timestamp : latest, state?.lastBuyAt);
      if (!state?.volumeBucketsInitializedAt) {
        const legacyEvents = await ctx.db.query("tokenActivity").withIndex("by_token_bucketed_time", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress).eq("volumeBucketed", undefined)).take(200);
        const totals = new Map<number, number>();
        for (const event of legacyEvents) {
          if (event.kind !== "burn" && event.usdAmount !== undefined && event.timestamp >= now - 24 * 60 * 60_000) {
            const bucketStart = Math.floor(event.timestamp / 300_000) * 300_000;
            totals.set(bucketStart, (totals.get(bucketStart) || 0) + event.usdAmount);
          }
          await ctx.db.patch(event._id, { volumeBucketed: true });
        }
        for (const [hourStartedAt, additionalVolume] of totals) {
          const bucket = await ctx.db.query("tokenVolumeBuckets").withIndex("by_token_hour", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress).eq("hourStartedAt", hourStartedAt)).unique();
          if (bucket) await ctx.db.patch(bucket._id, { volumeUsd: bucket.volumeUsd + additionalVolume, updatedAt: now });
          else await ctx.db.insert("tokenVolumeBuckets", { normalizedTokenAddress, hourStartedAt, volumeUsd: additionalVolume, updatedAt: now });
        }
        if (legacyEvents.length < 200 && state) await ctx.db.patch(state._id, { volumeBucketsInitializedAt: now, updatedAt: now });
      }
      const buckets = await ctx.db.query("tokenVolumeBuckets").withIndex("by_token_hour", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress).gte("hourStartedAt", now - 24 * 60 * 60_000)).collect();
      const volume24hUsd = buckets.reduce((sum, bucket) => sum + bucket.volumeUsd, 0);
      const patch = { tokenAddress: item.tokenAddress, normalizedTokenAddress, lastBuyAt, marketCapUsd: item.marketCapUsd, volume24hUsd, graduated: item.graduated, poolFee: item.poolFee, tickSpacing: item.tickSpacing, graduationCheckedAt: item.graduationCheckedAt, activityBackfilledAt: item.activityBackfilledAt, ...(state?.volumeBucketsInitializedAt ? { volumeBucketsInitializedAt: state.volumeBucketsInitializedAt } : {}), indexedThroughBlock: item.indexedThroughBlock, updatedAt: now };
      if (state) await ctx.db.patch(state._id, patch); else await ctx.db.insert("tokenMarketState", patch);
      const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress)).unique();
      if (launch) await ctx.db.patch(launch._id, { publicLastBuyAt: lastBuyAt, publicMarketCapUsd: item.marketCapUsd, publicVolume24hUsd: volume24hUsd, publicGraduated: item.graduated, updatedAt: now });
    }
    const cursor = await ctx.db.query("marketIndexState").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    if (cursor) await ctx.db.patch(cursor._id, { indexedThroughBlock, leaseUntil: 0, updatedAt: now });
  },
});

export const getMarketStates = query({
  args: { tokenAddresses: v.array(v.string()) },
  handler: async (ctx, { tokenAddresses }) => Promise.all(tokenAddresses.slice(0, 20).map(async (tokenAddress) => {
    const state = await ctx.db.query("tokenMarketState").withIndex("by_normalized_token", (q) => q.eq("normalizedTokenAddress", tokenAddress.toLowerCase())).unique();
    return { tokenAddress, marketCapUsd: state?.marketCapUsd, volume24hUsd: state?.volume24hUsd, lastBuyAt: state?.lastBuyAt, graduated: state?.graduated };
  })),
});

export const getMarketPrice = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const item = await ctx.db.query("marketPriceCache").withIndex("by_key", (q) => q.eq("key", key)).unique();
    return item && item.expiresAt > Date.now() ? item : null;
  },
});

export const setMarketPrice = mutation({
  args: { secret: v.string(), key: v.string(), value: v.number(), sourceTimestamp: v.number(), ttlMs: v.number() },
  handler: async (ctx, args) => {
    if (!process.env.MARKET_INDEX_SECRET || args.secret !== process.env.MARKET_INDEX_SECRET) throw new Error("market price authorization failed");
    const existing = await ctx.db.query("marketPriceCache").withIndex("by_key", (q) => q.eq("key", args.key)).unique();
    const patch = { value: args.value, sourceTimestamp: args.sourceTimestamp, expiresAt: Date.now() + args.ttlMs, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, patch); else await ctx.db.insert("marketPriceCache", { key: args.key, ...patch });
  },
});

export const getWallet = query({
  args: { address: v.string() },
  handler: async (ctx, { address }) => {
    const normalized = address.toLowerCase();
    const wallet = await ctx.db.query("cryptoWallets").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", normalized)).unique();
    if (!wallet) return null;
    const tokens = await ctx.db.query("walletTokenIndex").withIndex("by_wallet", (q) => q.eq("walletId", wallet._id)).take(100);
    const user = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", (q) => q.eq("xUserId", wallet.ownerXUserId)).unique();
    const publicTokens = await Promise.all(tokens.map(async (token) => {
      const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", token.normalizedTokenAddress)).unique();
      return { address: token.tokenAddress, symbol: token.symbol, isPonsbotLaunch: Boolean(launch), ...(launch?.imageUri ? { iconUrl: launch.imageUri } : {}) };
    }));
    return {
      address: wallet.address,
      createdAt: wallet.createdAt,
      username: user?.username,
      tokens: publicTokens,
    };
  },
});

export const seedPreview = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let user = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", (q) => q.eq("xUserId", "ponsbot-preview")).unique();
    let wallet = await ctx.db.query("cryptoWallets").withIndex("by_owner_x_user_id", (q) => q.eq("ownerXUserId", "ponsbot-preview")).unique();
    if (!wallet) {
      const walletId = await ctx.db.insert("cryptoWallets", { ownerXUserId: "ponsbot-preview", address: PREVIEW_WALLET, normalizedAddress: PREVIEW_WALLET.toLowerCase(), signerWalletRef: "preview-only", chainId: 4663, status: "frozen", createdAt: now, updatedAt: now });
      wallet = await ctx.db.get(walletId);
    }
    if (!user) {
      const userId = await ctx.db.insert("xReplyUsers", { xUserId: "ponsbot-preview", username: "PonsbotPreview", verified: false, walletId: wallet!._id, walletStatus: "frozen", createdAt: now, updatedAt: now });
      user = await ctx.db.get(userId);
    }
    const existingLaunch = await ctx.db.query("tokenLaunches").withIndex("by_token_address", (q) => q.eq("tokenAddress", PREVIEW_TOKEN)).unique();
    if (!existingLaunch) await ctx.db.insert("tokenLaunches", {
      requestId: "preview-launch", ownerXUserId: "ponsbot-preview", launcherUsername: "PonsbotPreview", walletId: wallet!._id, launchMode: "pons",
      name: "Pons Bot Preview", symbol: "PONSBOT", imageUri: "/ponsbot.png",
      description: "A preview launch showing how every token launched through Pons Bot gets its own page.",
      website: "https://ponsfamily.com", twitter: "https://x.com/Ponsbotfamily", devBuyWei: "20000000000000000",
      transactionHash: `0x${"1".repeat(64)}`, tokenAddress: PREVIEW_TOKEN, normalizedTokenAddress: PREVIEW_TOKEN.toLowerCase(), devBuySucceeded: true, createdAt: now, updatedAt: now,
      graduationAnnouncementStatus: "ignored",
    }); else if (existingLaunch.twitter !== "https://x.com/Ponsbotfamily") await ctx.db.patch(existingLaunch._id, { twitter: "https://x.com/Ponsbotfamily", updatedAt: now });
    const existingHoldings = await ctx.db.query("walletHoldingSnapshots").withIndex("by_wallet_address", (q) => q.eq("walletAddress", PREVIEW_WALLET)).collect();
    if (!existingHoldings.length) {
      await ctx.db.insert("walletHoldingSnapshots", { walletAddress: PREVIEW_WALLET, name: "Ethereum", symbol: "ETH", displayBalance: "1.284", updatedAt: now });
      await ctx.db.insert("walletHoldingSnapshots", { walletAddress: PREVIEW_WALLET, tokenAddress: PREVIEW_TOKEN, name: "Pons Bot Preview", symbol: "PONSBOT", displayBalance: "12,500,000", iconUrl: "/ponsbot.png", updatedAt: now });
      await ctx.db.insert("walletHoldingSnapshots", { walletAddress: PREVIEW_WALLET, tokenAddress: "0x0000000000000000000000000000000000005Ad0", name: "Sandisk", symbol: "SNDK", displayBalance: "842.75", updatedAt: now });
    }
    return { walletAddress: PREVIEW_WALLET, tokenAddress: PREVIEW_TOKEN };
  },
});
