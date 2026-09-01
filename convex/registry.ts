import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { PONS_PAIR_CATALOG } from "../lib/pair-catalog";
import { DEFAULT_PONS_V2_FACTORY, DEFAULT_PONS_V4_STATE_VIEW } from "../lib/pons-runtime-defaults";
import { TOKEN_INDEX_EXCLUSIONS, isTokenIndexExcluded } from "../lib/token-index-exclusions";

const BOOTSTRAP_CONTRACTS = {
  pons_v2_factory: DEFAULT_PONS_V2_FACTORY,
  pons_v2_launch_router: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
  pons_holder_distributor_factory: "0x70e95CC5f03DB2906081E7a8D16e4C4209291507",
  swap_router: "0xcaf681a66d020601342297493863e78c959e5cb2",
  swap_quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  v4_quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  universal_router: "0x8876789976decbfcbbbe364623c63652db8c0904",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  v4_state_view: DEFAULT_PONS_V4_STATE_VIEW,
} as const;
const CONTRACT_ENV_OVERRIDES: Partial<Record<keyof typeof BOOTSTRAP_CONTRACTS, string | undefined>> = {
  pons_v2_factory: process.env.PONS_V2_FACTORY_ADDRESS,
  v4_quoter: process.env.PONS_V4_QUOTER_ADDRESS,
  universal_router: process.env.PONS_V4_UNIVERSAL_ROUTER_ADDRESS,
  permit2: process.env.PONS_PERMIT2_ADDRESS,
  v4_state_view: process.env.PONS_V4_STATE_VIEW_ADDRESS,
};

// Searchable/tradable tokens that must not be offered as launch pairs.
const BOOTSTRAP_TOKENS = [
  ["0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07", "PONSBOT", "Pons Bot"],
  ["0x39dBED3a2bd333467115dE45665cC57F813C4571", "PONS", "Pons"],
] as const;

export const ensureInitialized = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const exclusionCleanup = await ctx.db.query("protocolContracts")
      .withIndex("by_key", (q) => q.eq("key", "token_index_exclusions_v1")).unique();
    if (!exclusionCleanup) for (const normalizedTokenAddress of TOKEN_INDEX_EXCLUSIONS) {
      const program = await ctx.db.query("automatedFeePrograms")
        .withIndex("by_token", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress)).unique();
      if (program && !program.privateTest) {
        for (const run of await ctx.db.query("automatedFeeRuns")
          .withIndex("by_program_created_at", (q) => q.eq("programId", program._id)).collect()) await ctx.db.delete(run._id);
        await ctx.db.delete(program._id);
      }
      const reservation = await ctx.db.query("automatedFeeEnrollmentReservations")
        .withIndex("by_predicted_token", (q) => q.eq("normalizedPredictedTokenAddress", normalizedTokenAddress)).unique();
      if (reservation) await ctx.db.delete(reservation._id);
      for (const launch of await ctx.db.query("tokenLaunches")
        .withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress)).collect()) await ctx.db.delete(launch._id);
      for (const activity of await ctx.db.query("tokenActivity")
        .withIndex("by_token_time", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress)).collect()) await ctx.db.delete(activity._id);
      for (const bucket of await ctx.db.query("tokenVolumeBuckets")
        .withIndex("by_token_hour", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress)).collect()) await ctx.db.delete(bucket._id);
      for (const lifetime of await ctx.db.query("tokenLifetimeVolumes")
        .withIndex("by_token", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress)).collect()) await ctx.db.delete(lifetime._id);
      const market = await ctx.db.query("tokenMarketState")
        .withIndex("by_normalized_token", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress)).unique();
      if (market) await ctx.db.delete(market._id);
      const registered = await ctx.db.query("tokenRegistry")
        .withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", normalizedTokenAddress)).unique();
      if (registered) await ctx.db.delete(registered._id);
      for (const indexed of await ctx.db.query("walletTokenIndex")
        .withIndex("by_token", (q) => q.eq("normalizedTokenAddress", normalizedTokenAddress)).collect()) await ctx.db.delete(indexed._id);
      for (const snapshot of await ctx.db.query("walletHoldingSnapshots")
        .withIndex("by_token_address", (q) => q.eq("tokenAddress", normalizedTokenAddress)).collect()) await ctx.db.delete(snapshot._id);
    }
    if (!exclusionCleanup) {
      const publicStats = await ctx.db.query("platformStatsCache").withIndex("by_key", (q) => q.eq("key", "public")).unique();
      if (publicStats) await ctx.db.delete(publicStats._id);
      await ctx.db.insert("protocolContracts", {
        key: "token_index_exclusions_v1", address: "0x0000000000000000000000000000000000000000",
        normalizedAddress: "0x0000000000000000000000000000000000000000", active: false, updatedAt: now,
      });
    }
    const addressMigration = await ctx.db.query("protocolContracts").withIndex("by_key", (q) => q.eq("key", "normalized_address_migration_v1")).unique();
    if (!addressMigration) {
      for (const wallet of await ctx.db.query("cryptoWallets").collect()) {
        if (!wallet.normalizedAddress) await ctx.db.patch(wallet._id, { normalizedAddress: wallet.address.toLowerCase(), updatedAt: now });
      }
      for (const launch of await ctx.db.query("tokenLaunches").collect()) {
        if (launch.tokenAddress && !launch.normalizedTokenAddress) await ctx.db.patch(launch._id, { normalizedTokenAddress: launch.tokenAddress.toLowerCase(), updatedAt: now });
      }
      await ctx.db.insert("protocolContracts", { key: "normalized_address_migration_v1", address: "0x0000000000000000000000000000000000000000", normalizedAddress: "0x0000000000000000000000000000000000000000", active: false, updatedAt: now });
    }
    const usernameMigration = await ctx.db.query("protocolContracts").withIndex("by_key", (q) => q.eq("key", "wallet_username_migration_v1")).unique();
    if (!usernameMigration) {
      for (const wallet of await ctx.db.query("cryptoWallets").collect()) {
        const user = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", (q) => q.eq("xUserId", wallet.ownerXUserId)).unique();
        if (user?.username) await ctx.db.patch(wallet._id, { xUsername: user.username, updatedAt: now });
      }
      await ctx.db.insert("protocolContracts", { key: "wallet_username_migration_v1", address: "0x0000000000000000000000000000000000000000", normalizedAddress: "0x0000000000000000000000000000000000000000", active: false, updatedAt: now });
    }
    const successfulLaunchMigration = await ctx.db.query("protocolContracts").withIndex("by_key", (q) => q.eq("key", "successful_launcher_migration_v1")).unique();
    if (!successfulLaunchMigration) {
      const firstLaunchByUser = new Map<string, number>();
      for (const launch of await ctx.db.query("tokenLaunches").collect()) {
        if (!launch.publicPublished || !launch.tokenAddress) continue;
        const existing = firstLaunchByUser.get(launch.ownerXUserId);
        if (existing === undefined || launch.createdAt < existing) firstLaunchByUser.set(launch.ownerXUserId, launch.createdAt);
      }
      for (const user of await ctx.db.query("xReplyUsers").collect()) {
        const firstSuccessfulLaunchAt = firstLaunchByUser.get(user.xUserId);
        await ctx.db.patch(user._id, {
          hasSuccessfulLaunch: firstSuccessfulLaunchAt !== undefined,
          ...(firstSuccessfulLaunchAt !== undefined ? { firstSuccessfulLaunchAt } : {}),
          updatedAt: now,
        });
      }
      await ctx.db.insert("protocolContracts", { key: "successful_launcher_migration_v1", address: "0x0000000000000000000000000000000000000000", normalizedAddress: "0x0000000000000000000000000000000000000000", active: false, updatedAt: now });
    }
    const inferredLaunchSocialMigration = await ctx.db.query("protocolContracts").withIndex("by_key", (q) => q.eq("key", "remove_inferred_launcher_socials_v1")).unique();
    if (!inferredLaunchSocialMigration) {
      for (const launch of await ctx.db.query("tokenLaunches").collect()) {
        if (!launch.twitter || !launch.launcherUsername) continue;
        const inferredProfile = `https://x.com/${launch.launcherUsername.replace(/^@/, "")}`;
        if (launch.twitter.toLowerCase() !== inferredProfile.toLowerCase()) continue;
        const postId = launch.sourcePostId || launch.requestId.match(/^x:(\d+):/)?.[1];
        const interaction = postId ? await ctx.db.query("xReplyInteractions").withIndex("by_post_id", (q) => q.eq("postId", postId)).unique() : null;
        const explicitlySupplied = interaction
          ? /\b(?:x|twitter)(?:\s+link)?\s*(?:is|=|:)?\s*(?:@[a-zA-Z0-9_]{1,15}|(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/[a-zA-Z0-9_]{1,15})\b/i.test(interaction.text)
          : true;
        if (!explicitlySupplied) await ctx.db.patch(launch._id, { twitter: undefined, updatedAt: now });
      }
      await ctx.db.insert("protocolContracts", { key: "remove_inferred_launcher_socials_v1", address: "0x0000000000000000000000000000000000000000", normalizedAddress: "0x0000000000000000000000000000000000000000", active: false, updatedAt: now });
    }
    const launchViewMigration = await ctx.db.query("protocolContracts").withIndex("by_key", (q) => q.eq("key", "public_launch_view_migration_v1")).unique();
    if (!launchViewMigration) {
      for (const launch of await ctx.db.query("tokenLaunches").collect()) {
        const wallet = await ctx.db.get(launch.walletId);
        const pair = launch.pairToken ? await ctx.db.query("tokenRegistry").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", launch.pairToken!.toLowerCase())).unique() : null;
        const market = launch.tokenAddress ? await ctx.db.query("tokenMarketState").withIndex("by_normalized_token", (q) => q.eq("normalizedTokenAddress", launch.tokenAddress!.toLowerCase())).unique() : null;
        await ctx.db.patch(launch._id, {
          creatorAddress: wallet?.address,
          pairSymbol: launch.pairToken === "0x0000000000000000000000000000000000000000" ? "ETH" : pair?.symbol,
          publicLastBuyAt: market?.lastBuyAt, publicMarketCapUsd: market?.marketCapUsd,
          publicVolume24hUsd: market?.volume24hUsd, publicGraduated: market?.graduated, updatedAt: now,
        });
      }
      await ctx.db.insert("protocolContracts", { key: "public_launch_view_migration_v1", address: "0x0000000000000000000000000000000000000000", normalizedAddress: "0x0000000000000000000000000000000000000000", active: false, updatedAt: now });
    }
    const publishedLaunchMigration = await ctx.db.query("protocolContracts").withIndex("by_key", (q) => q.eq("key", "public_published_launch_migration_v2")).unique();
    if (!publishedLaunchMigration) {
      for (const launch of await ctx.db.query("tokenLaunches").collect()) {
        const transaction = await ctx.db.query("walletTransactions").withIndex("by_request_id", (q) => q.eq("requestId", launch.requestId)).unique();
        const shouldPublish = Boolean(launch.tokenAddress && transaction?.status === "confirmed");
        if (launch.publicPublished !== shouldPublish) await ctx.db.patch(launch._id, { publicPublished: shouldPublish, updatedAt: now });
      }
      await ctx.db.insert("protocolContracts", { key: "public_published_launch_migration_v2", address: "0x0000000000000000000000000000000000000000", normalizedAddress: "0x0000000000000000000000000000000000000000", active: false, updatedAt: now });
    }
    const launchIndexMigration = await ctx.db.query("protocolContracts").withIndex("by_key", (q) => q.eq("key", "confirmed_launch_index_migration_v1")).unique();
    if (!launchIndexMigration) {
      for (const indexed of await ctx.db.query("walletTokenIndex").collect()) {
        if (!indexed.involvedByLaunch) continue;
        const launches = await ctx.db.query("tokenLaunches")
          .withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", indexed.normalizedTokenAddress)).collect();
        if (launches.length > 0 && launches.every((launch) => launch.publicPublished !== true)) await ctx.db.delete(indexed._id);
      }
      await ctx.db.insert("protocolContracts", { key: "confirmed_launch_index_migration_v1", address: "0x0000000000000000000000000000000000000000", normalizedAddress: "0x0000000000000000000000000000000000000000", active: false, updatedAt: now });
    }
    const previouslyInitialized = Boolean(await ctx.db.query("protocolContracts").withIndex("by_key", (q) => q.eq("key", "pons_v2_factory")).unique());
    for (const [key, fallbackAddress] of Object.entries(BOOTSTRAP_CONTRACTS)) {
      const override = CONTRACT_ENV_OVERRIDES[key as keyof typeof BOOTSTRAP_CONTRACTS]?.trim();
      const address = override || fallbackAddress;
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error(`${key} contract address is invalid`);
      const existing = await ctx.db.query("protocolContracts").withIndex("by_key", (q) => q.eq("key", key)).unique();
      if (!existing) await ctx.db.insert("protocolContracts", { key, address, normalizedAddress: address.toLowerCase(), active: true, updatedAt: now });
      else if (override && existing.address.toLowerCase() !== address.toLowerCase()) {
        await ctx.db.patch(existing._id, { address, normalizedAddress: address.toLowerCase(), active: true, updatedAt: now });
      }
    }
    for (const [address, symbol, name, configuredDecimals] of PONS_PAIR_CATALOG) {
      if (isTokenIndexExcluded(address)) continue;
      const normalizedAddress = address.toLowerCase();
      const decimals = configuredDecimals ?? 18;
      const existing = await ctx.db.query("tokenRegistry").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", normalizedAddress)).unique();
      if (!existing) await ctx.db.insert("tokenRegistry", {
        address, normalizedAddress, symbol, name, decimals, pairCandidate: true,
        pairApproved: false, active: true, updatedAt: now,
      });
      else if (!existing.active || !existing.pairCandidate || existing.symbol !== symbol || existing.name !== name || existing.decimals !== decimals) {
        await ctx.db.patch(existing._id, {
          address, normalizedAddress, symbol, name, decimals,
          pairCandidate: true, active: true, updatedAt: now,
        });
      }
    }
    for (const [address, symbol, name] of BOOTSTRAP_TOKENS) {
      if (isTokenIndexExcluded(address)) continue;
      const normalizedAddress = address.toLowerCase();
      const existing = await ctx.db.query("tokenRegistry").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", normalizedAddress)).unique();
      if (!existing) await ctx.db.insert("tokenRegistry", {
        address, normalizedAddress, symbol, name, decimals: 18, pairCandidate: false,
        pairApproved: false, active: true, updatedAt: now,
      });
      else if (existing.pairCandidate || !existing.active || existing.symbol !== symbol || existing.name !== name || existing.decimals !== 18) {
        await ctx.db.patch(existing._id, {
          address, normalizedAddress, symbol, name, decimals: 18,
          pairCandidate: false, pairApproved: false, active: true, updatedAt: now,
        });
      }
    }
    if (previouslyInitialized) return;
    const launches = await ctx.db.query("tokenLaunches").collect();
    for (const launch of launches) {
      if (!launch.tokenAddress || launch.publicPublished !== true) continue;
      if (isTokenIndexExcluded(launch.tokenAddress)) continue;
      const normalizedTokenAddress = launch.tokenAddress.toLowerCase();
      const existing = await ctx.db.query("walletTokenIndex").withIndex("by_wallet_token", (q) => q.eq("walletId", launch.walletId).eq("normalizedTokenAddress", normalizedTokenAddress)).unique();
      if (!existing) await ctx.db.insert("walletTokenIndex", {
        walletId: launch.walletId, tokenAddress: launch.tokenAddress, normalizedTokenAddress,
        symbol: launch.symbol.toUpperCase(), involvedByLaunch: true,
        involvedByTransaction: Boolean(launch.devBuySucceeded), createdAt: launch.createdAt, updatedAt: now,
      });
    }
  },
});

// Remove discovery/index records only; immutable transaction and private fee
// program history is retained. This never signs transactions or changes rights.
export const removePrivateTestIndexes = internalMutation({
  args: { tokenAddress: v.string(), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { tokenAddress, dryRun = true }) => {
    const normalized = tokenAddress.toLowerCase();
    if (!isTokenIndexExcluded(normalized)) throw new Error("token must be explicitly excluded first");
    const program = await ctx.db.query("automatedFeePrograms")
      .withIndex("by_token", q => q.eq("normalizedTokenAddress", normalized)).unique();
    if (!program?.privateTest) throw new Error("only verified private test tokens may use this cleanup");
    const launches = await ctx.db.query("tokenLaunches")
      .withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", normalized)).collect();
    if (launches.some(launch => launch.publicPublished)) throw new Error("public launch requires separate explicit removal");
    const registry = await ctx.db.query("tokenRegistry").withIndex("by_normalized_address", q => q.eq("normalizedAddress", normalized)).collect();
    const wallets = await ctx.db.query("walletTokenIndex").withIndex("by_token", q => q.eq("normalizedTokenAddress", normalized)).collect();
    // Snapshot rows predate normalized-address columns; compare every casing.
    const snapshots = (await ctx.db.query("walletHoldingSnapshots").collect()).filter(row => row.tokenAddress?.toLowerCase() === normalized);
    const market = await ctx.db.query("tokenMarketState").withIndex("by_normalized_token", q => q.eq("normalizedTokenAddress", normalized)).collect();
    const activity = await ctx.db.query("tokenActivity").withIndex("by_token_time", q => q.eq("normalizedTokenAddress", normalized)).collect();
    const volume = await ctx.db.query("tokenVolumeBuckets").withIndex("by_token_hour", q => q.eq("normalizedTokenAddress", normalized)).collect();
    const lifetime = await ctx.db.query("tokenLifetimeVolumes").withIndex("by_token", q => q.eq("normalizedTokenAddress", normalized)).collect();
    const records = { launches, registry, wallets, snapshots, market, activity, volume, lifetime };
    if (!dryRun) for (const rows of Object.values(records)) for (const row of rows) await ctx.db.delete(row._id);
    return { dryRun, counts: Object.fromEntries(Object.entries(records).map(([key, rows]) => [key, rows.length])), retainedPrivateProgram: true };
  },
});

export const runtimeConfig = internalQuery({
  args: {},
  handler: async (ctx) => {
    const contracts = await ctx.db.query("protocolContracts").collect();
    const byKey = Object.fromEntries(contracts.filter((item) => item.active).map((item) => [item.key, item.address]));
    const pairs = (await ctx.db.query("tokenRegistry").withIndex("by_pair_candidate", (q) => q.eq("pairCandidate", true)).collect())
      .filter((item) => item.active);
    return { contracts: byKey, pairs };
  },
});

export const updatePairVerification = internalMutation({
  args: { address: v.string(), symbol: v.string(), name: v.string(), decimals: v.number(), approved: v.boolean(), verifiedAt: v.number() },
  handler: async (ctx, args) => {
    const normalizedAddress = args.address.toLowerCase();
    const existing = await ctx.db.query("tokenRegistry").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", normalizedAddress)).unique();
    if (!existing) return;
    await ctx.db.patch(existing._id, {
      symbol: /^cbbtc$/i.test(args.symbol) ? "cbBTC" : args.symbol.toUpperCase(), name: args.name, decimals: args.decimals,
      pairApproved: args.approved, verifiedAt: args.verifiedAt, updatedAt: Date.now(),
    });
  },
});
