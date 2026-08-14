import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const BOOTSTRAP_CONTRACTS = {
  pons_v2_factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  pons_v2_launch_router: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
  swap_router: "0xcaf681a66d020601342297493863e78c959e5cb2",
  swap_quoter: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  v4_quoter: process.env.PONS_V4_QUOTER_ADDRESS || "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  universal_router: process.env.PONS_V4_UNIVERSAL_ROUTER_ADDRESS || "0x8876789976decbfcbbbe364623c63652db8c0904",
  permit2: process.env.PONS_PERMIT2_ADDRESS || "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const;
const ENV_MANAGED_CONTRACTS = new Set(["v4_quoter", "universal_router", "permit2"]);

const BOOTSTRAP_PAIRS = [
  ["0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", "NVDA", "NVIDIA"],
  ["0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea", "SPCX", "SpaceX"],
  ["0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", "GOOGL", "Alphabet Class A"],
  ["0x322f0929c4625ed5bad873c95208d54e1c003b2d", "TSLA", "Tesla"],
  ["0x1b0e319c6a659f002271b69db8a7df2f911c153e", "GME", "GameStop"],
  ["0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", "AAPL", "Apple"],
  ["0x117cc2133c37b721f49de2a7a74833232b3b4c0c", "SPY", "SPDR S&P 500 ETF Trust"],
  ["0xB90A19fF0Af67f7779afF50A882A9CfF42446400", "SNDK", "Sandisk"],
  ["0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", "AMD", "AMD"],
  ["0x12f190a9F9d7D37a250758b26824B97CE941bF54", "AMZN", "Amazon"],
  ["0xe93237C50D904957Cf27E7B1133b510C669c2e74", "MSFT", "Microsoft"],
  ["0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", "META", "Meta"],
  ["0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", "CRCL", "Circle"],
  ["0x6330D8C3178a418788dF01a47479c0ce7CCF450b", "COIN", "Coinbase"],
  ["0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", "MU", "Micron"],
  ["0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", "PLTR", "Palantir"],
  ["0x5fc5360d0400a0fd4f2af552add042d716f1d168", "USDG", "Global Dollar"],
] as const;

export const ensureInitialized = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
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
    const previouslyInitialized = Boolean(await ctx.db.query("protocolContracts").withIndex("by_key", (q) => q.eq("key", "pons_v2_factory")).unique());
    for (const [key, address] of Object.entries(BOOTSTRAP_CONTRACTS)) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error(`${key} contract address is invalid`);
      const existing = await ctx.db.query("protocolContracts").withIndex("by_key", (q) => q.eq("key", key)).unique();
      if (!existing) await ctx.db.insert("protocolContracts", { key, address, normalizedAddress: address.toLowerCase(), active: true, updatedAt: now });
      else if (ENV_MANAGED_CONTRACTS.has(key) && existing.address.toLowerCase() !== address.toLowerCase()) {
        await ctx.db.patch(existing._id, { address, normalizedAddress: address.toLowerCase(), active: true, updatedAt: now });
      }
    }
    for (const [address, symbol, name] of BOOTSTRAP_PAIRS) {
      const normalizedAddress = address.toLowerCase();
      const existing = await ctx.db.query("tokenRegistry").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", normalizedAddress)).unique();
      if (!existing) await ctx.db.insert("tokenRegistry", {
        address, normalizedAddress, symbol, name, decimals: 18, pairCandidate: true,
        pairApproved: false, active: true, updatedAt: now,
      });
    }
    if (previouslyInitialized) return;
    const launches = await ctx.db.query("tokenLaunches").collect();
    for (const launch of launches) {
      if (!launch.tokenAddress) continue;
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
      symbol: args.symbol.toUpperCase(), name: args.name, decimals: args.decimals,
      pairApproved: args.approved, verifiedAt: args.verifiedAt, updatedAt: Date.now(),
    });
  },
});
