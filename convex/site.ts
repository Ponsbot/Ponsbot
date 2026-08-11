import { v } from "convex/values";
import { query } from "./_generated/server";
import { internalMutation } from "./_generated/server";

export const PREVIEW_WALLET = "0x0000000000000000000000000000000000000B07";
export const PREVIEW_TOKEN = "0x0000000000000000000000000000000000000A11";

function publicLaunch(launch: {
  name: string; symbol: string; imageUri: string; description?: string;
  website?: string; twitter?: string; telegram?: string; tokenAddress?: string;
  transactionHash: string; devBuySucceeded?: boolean; createdAt: number;
  pairToken?: string; poolAddress?: string; launcherUsername?: string;
}, creatorAddress?: string, launcherUsername?: string) {
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
    poolAddress: launch.poolAddress,
    creatorAddress,
    launcherUsername: launch.launcherUsername || launcherUsername,
    createdAt: launch.createdAt,
  };
}

export const listLaunches = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const launches = await ctx.db.query("tokenLaunches").order("desc").take(Math.min(Math.max(limit || 24, 1), 100));
    return await Promise.all(launches.filter((launch) => launch.tokenAddress).map(async (launch) => {
      const wallet = await ctx.db.get(launch.walletId);
      const user = launch.launcherUsername ? null : await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", (q) => q.eq("xUserId", launch.ownerXUserId)).unique();
      return publicLaunch(launch, wallet?.address, user?.username);
    }));
  },
});

export const getLaunch = query({
  args: { tokenAddress: v.string() },
  handler: async (ctx, { tokenAddress }) => {
    const normalized = tokenAddress.toLowerCase();
    const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", normalized)).unique()
      || (await ctx.db.query("tokenLaunches").collect()).find((item) => item.tokenAddress?.toLowerCase() === normalized);
    if (!launch) return null;
    const wallet = await ctx.db.get(launch.walletId);
    const user = launch.launcherUsername ? null : await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", (q) => q.eq("xUserId", launch.ownerXUserId)).unique();
    return publicLaunch(launch, wallet?.address, user?.username);
  },
});

export const getWallet = query({
  args: { address: v.string() },
  handler: async (ctx, { address }) => {
    const normalized = address.toLowerCase();
    const wallet = await ctx.db.query("cryptoWallets").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", normalized)).unique()
      || (await ctx.db.query("cryptoWallets").collect()).find((item) => item.address.toLowerCase() === normalized);
    return wallet ? { address: wallet.address, createdAt: wallet.createdAt } : null;
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
      name: "Ponsbot Preview", symbol: "PONSBOT", imageUri: "/ponsbot.png",
      description: "A preview launch showing how every token launched through Ponsbot gets its own page.",
      website: "https://ponsfamily.com", twitter: "https://x.com/Ponsbotfamily", devBuyWei: "20000000000000000",
      transactionHash: `0x${"1".repeat(64)}`, tokenAddress: PREVIEW_TOKEN, normalizedTokenAddress: PREVIEW_TOKEN.toLowerCase(), devBuySucceeded: true, createdAt: now, updatedAt: now,
    }); else if (existingLaunch.twitter !== "https://x.com/Ponsbotfamily") await ctx.db.patch(existingLaunch._id, { twitter: "https://x.com/Ponsbotfamily", updatedAt: now });
    const existingHoldings = await ctx.db.query("walletHoldingSnapshots").withIndex("by_wallet_address", (q) => q.eq("walletAddress", PREVIEW_WALLET)).collect();
    if (!existingHoldings.length) {
      await ctx.db.insert("walletHoldingSnapshots", { walletAddress: PREVIEW_WALLET, name: "Ether", symbol: "ETH", displayBalance: "1.284", updatedAt: now });
      await ctx.db.insert("walletHoldingSnapshots", { walletAddress: PREVIEW_WALLET, tokenAddress: PREVIEW_TOKEN, name: "Ponsbot Preview", symbol: "PONSBOT", displayBalance: "12,500,000", iconUrl: "/ponsbot.png", updatedAt: now });
      await ctx.db.insert("walletHoldingSnapshots", { walletAddress: PREVIEW_WALLET, tokenAddress: "0x0000000000000000000000000000000000005Ad0", name: "Sandisk", symbol: "SNDK", displayBalance: "842.75", updatedAt: now });
    }
    return { walletAddress: PREVIEW_WALLET, tokenAddress: PREVIEW_TOKEN };
  },
});
