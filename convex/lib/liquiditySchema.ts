import { defineTable } from "convex/server";
import { v } from "convex/values";
import { LIQUIDITY_DEPLOYMENT } from "../../lib/liquidity-policy";

const shape = v.union(v.literal("flat"), v.literal("bell"), v.literal("bid_ask"));
const feeTier = v.union(v.literal(100), v.literal(500), v.literal(3000), v.literal(10000));
const band = v.object({ tickLower: v.number(), tickUpper: v.number(), relativeLiquidityWeight: v.number() });

// Historical, inactive tables retained for schema/data compatibility only.
export const liquidityTables = {
  liquidityDrafts: defineTable({
    walletId: v.id("cryptoWallets"),
    ownerXUserId: v.string(),
    requestKey: v.string(),
    state: v.union(v.literal("draft"), v.literal("abandoned")),
    plan: v.object({
      version: v.literal(1),
      stage: v.literal("draft"),
      executionReady: v.literal(false),
      chainId: v.literal(LIQUIDITY_DEPLOYMENT.chainId),
      ownerWalletAddress: v.string(),
      protocol: v.literal(LIQUIDITY_DEPLOYMENT.protocol),
      factoryAddress: v.literal(LIQUIDITY_DEPLOYMENT.factory),
      positionManagerAddress: v.literal(LIQUIDITY_DEPLOYMENT.positionManager),
      ladderBuilderAddress: v.literal(LIQUIDITY_DEPLOYMENT.ladderBuilder),
      token0: v.string(), token1: v.string(), maxAmount0: v.string(), maxAmount1: v.string(),
      nativeInput: v.union(v.literal("none"), v.literal("token0"), v.literal("token1")),
      feeTier, tickSpacing: v.number(),
      rangeKind: v.union(v.literal("full_range"), v.literal("ticks")),
      shape, slippageBps: v.number(), bands: v.array(band),
    }),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_wallet_updated", ["walletId", "updatedAt"]).index("by_wallet_request", ["walletId", "requestKey"]),

  liquidityPositionGroups: defineTable({
    walletId: v.id("cryptoWallets"), ownerXUserId: v.string(), label: v.string(),
    chainId: v.literal(LIQUIDITY_DEPLOYMENT.chainId), protocol: v.literal(LIQUIDITY_DEPLOYMENT.protocol),
    positionManagerAddress: v.literal(LIQUIDITY_DEPLOYMENT.positionManager),
    poolAddress: v.string(), token0: v.string(), token1: v.string(), feeTier, shape,
    status: v.union(v.literal("active"), v.literal("closed"), v.literal("needs_refresh")),
    createdAt: v.number(), updatedAt: v.number(),
  }).index("by_wallet_label", ["walletId", "label"]).index("by_wallet_status", ["walletId", "status"]),

  liquidityPositionLegs: defineTable({
    groupId: v.id("liquidityPositionGroups"), nftKey: v.string(), tokenId: v.string(),
    tickLower: v.number(), tickUpper: v.number(), liquidity: v.string(),
    observedOwnerAddress: v.string(), observedAtBlock: v.string(), observedAt: v.number(),
    tokensOwed0: v.string(), tokensOwed1: v.string(),
  }).index("by_group", ["groupId"]).index("by_nft_key", ["nftKey"]),
};
