import { createPublicClient, parseAbi, zeroAddress, type Address } from "viem";
import { reliableHttp } from "../lib/rpc-http";
import { PONS_PAIR_CATALOG } from "../lib/pair-catalog";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import { v } from "convex/values";

const factoryAbi = parseAbi([
  "function approvedPairTokens(address asset) view returns (bool)",
  "function pairTokenEconomics(address asset) view returns (uint256 phantomQuote, uint256 graduationThreshold)",
]);
const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const ROBINHOOD_ASSET_CATALOG_URL = "https://api.robinhood.com/rhj/assets";
const ROBINHOOD_CATALOG_TTL_MS = 60 * 60 * 1_000;
const ROBINHOOD_CATALOG_TIMEOUT_MS = 20_000;
const ROBINHOOD_CATALOG_ATTEMPTS = 2;

type RobinhoodCatalogAsset = {
  tokenSymbol?: unknown;
  tokenName?: unknown;
  tokenDecimals?: unknown;
  status?: unknown;
  deployments?: Array<{ contractAddress?: unknown; chainId?: unknown }>;
};

async function refreshRobinhoodCatalog(ctx: ActionCtx) {
  let payload: { assets?: RobinhoodCatalogAsset[] } | undefined;
  let lastFailure = "unavailable";
  for (let attempt = 1; attempt <= ROBINHOOD_CATALOG_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(ROBINHOOD_ASSET_CATALOG_URL, {
        signal: AbortSignal.timeout(ROBINHOOD_CATALOG_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json() as { assets?: RobinhoodCatalogAsset[] };
      break;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : "unavailable";
      if (attempt < ROBINHOOD_CATALOG_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (!payload) throw new Error(`Robinhood asset catalog ${lastFailure}`);
  const assets = (payload.assets || []).flatMap(asset => {
    const symbol = typeof asset.tokenSymbol === "string" ? asset.tokenSymbol.trim() : "";
    const name = typeof asset.tokenName === "string" ? asset.tokenName.trim() : "";
    const decimals = Number(asset.tokenDecimals);
    const deployment = asset.deployments?.find(item => Number(item.chainId) === 4663);
    const address = typeof deployment?.contractAddress === "string" ? deployment.contractAddress : "";
    if (!symbol || !name || !/^0x[a-fA-F0-9]{40}$/.test(address) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return [];
    if (asset.status !== undefined && asset.status !== "ASSET_STATUS_ACTIVE") return [];
    return [{ address, symbol, name, decimals }];
  });
  if (assets.length < 50) throw new Error("Robinhood asset catalog was incomplete");
  const syncedAt = Date.now();
  await ctx.runMutation(internal.registry.replaceRobinhoodCatalog, { assets, syncedAt });
  return syncedAt;
}

export type PonsPairAsset = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  native: boolean;
  verifiedAt: number;
};

/**
 * Pons V2's allowlist is a mapping, not an enumerable array. Candidate ERC-20
 * addresses must therefore come from configuration (or a future event indexer),
 * and are revalidated against the factory every time this function runs.
 */
export async function discoverPonsV2PairAssets(options: {
  rpcUrl?: string;
  factory?: Address;
  candidates?: Address[];
} = {}): Promise<PonsPairAsset[]> {
  const rpcUrl = options.rpcUrl || process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const factory = options.factory;
  if (!factory) throw new Error("Pons V2 factory is required from the contract registry");
  const configured = options.candidates || [];
  const client = createPublicClient({ transport: reliableHttp(rpcUrl) });
  const verifiedAt = Date.now();
  const results: PonsPairAsset[] = [{
    address: zeroAddress, symbol: "ETH", name: "Ethereum", decimals: 18, native: true, verifiedAt,
  }];

  for (const address of [...new Set(configured.map((value) => value.toLowerCase()))] as Address[]) {
    if (address === zeroAddress) continue;
    try {
      const [approved, economics, symbol, name, decimals] = await Promise.all([
        client.readContract({ address: factory, abi: factoryAbi, functionName: "approvedPairTokens", args: [address] }),
        client.readContract({ address: factory, abi: factoryAbi, functionName: "pairTokenEconomics", args: [address] }),
        client.readContract({ address, abi: tokenAbi, functionName: "symbol" }),
        client.readContract({ address, abi: tokenAbi, functionName: "name" }),
        client.readContract({ address, abi: tokenAbi, functionName: "decimals" }),
      ]);
      if (approved && economics[0] > 0n && economics[1] > 0n) {
        results.push({ address, symbol, name, decimals, native: false, verifiedAt });
      }
    } catch (error) {
      console.error("pons_v2_pair_candidate_failed", { address, message: error instanceof Error ? error.message : "unknown" });
    }
  }
  return results;
}

export function parsePairCandidates(value: string): Address[] {
  return value.split(/[\s,;]+/).map((item) => item.trim()).filter((item): item is Address => /^0x[a-fA-F0-9]{40}$/.test(item));
}

export function formatPonsPairReply(assets: PonsPairAsset[]) {
  const labels = assets.map((asset) => asset.native ? "ETH" : `${asset.symbol} (${asset.name})`);
  return `🔗 Pons V2 currently accepts these launch pairs: ${labels.join(", ")}. I verified the ERC-20 options against the factory just now!`;
}

export const refreshRegistry = internalAction({
  args: { identifier: v.optional(v.string()) },
  handler: async (ctx, { identifier }): Promise<PonsPairAsset[]> => {
    await ctx.runMutation(internal.registry.ensureInitialized, {});
    const config = await ctx.runQuery(internal.registry.runtimeConfig, {});
    const factory = config.contracts.pons_v2_factory as Address | undefined;
    if (!factory) throw new Error("Pons V2 factory is missing from the contract registry");
    if (!identifier || /^\$?eth$/i.test(identifier)) {
      return [{ address: zeroAddress, symbol: "ETH", name: "Ethereum", decimals: 18, native: true, verifiedAt: Date.now() }];
    }
    const normalized = identifier.replace(/^\$/, "").toLowerCase();
    let candidate: { active: boolean; symbol: string; address: string; normalizedAddress: string; name: string; decimals: number } | undefined = config.pairs.find((item: { active: boolean; symbol: string; address: string; normalizedAddress: string; name: string; decimals: number }) => item.active
      && (item.symbol.toLowerCase() === normalized || item.address.toLowerCase() === normalized));
    const addressIdentifier = /^0x[a-fA-F0-9]{40}$/.test(identifier);
    const curatedCandidate = candidate && PONS_PAIR_CATALOG.some(([address]) =>
      address.toLowerCase() === candidate!.address.toLowerCase());
    // Revisit dynamically discovered tickers when the Robinhood snapshot is
    // stale. Otherwise an address/status change could remain pinned forever in
    // tokenRegistry merely because the ticker had been discovered once.
    if (!addressIdentifier && (!candidate || !curatedCandidate)) {
      let lookup = await ctx.runQuery(internal.registry.robinhoodCatalogLookup, { symbol: normalized });
      if (!lookup.syncedAt || Date.now() - lookup.syncedAt > ROBINHOOD_CATALOG_TTL_MS) {
        try {
          await refreshRobinhoodCatalog(ctx);
          lookup = await ctx.runQuery(internal.registry.robinhoodCatalogLookup, { symbol: normalized });
        } catch {
          // A previously cached exact mapping remains safe to verify against
          // the Pons factory. With no cached match, fail closed and resumably.
          if (lookup.matches.length === 0)
            throw new Error("requested Pons V2 pair was not found in the registry");
        }
      }
      // Never guess between duplicate ticker deployments.
      if (lookup.matches.length === 1) {
        const discovered = lookup.matches[0];
        await ctx.runMutation(internal.registry.upsertDiscoveredPairCandidate, {
          address: discovered.address, symbol: discovered.symbol, name: discovered.name, decimals: discovered.decimals,
        });
        candidate = {
          active: true, address: discovered.address, normalizedAddress: discovered.normalizedAddress,
          symbol: discovered.symbol, name: discovered.name, decimals: discovered.decimals,
        };
      } else candidate = undefined;
    }
    if (!candidate) throw new Error("requested Pons V2 pair was not found in the registry");
    const assets = await discoverPonsV2PairAssets({
      factory,
      candidates: [candidate.address as Address],
    });
    const verified = new Map(assets.filter((item) => !item.native).map((item) => [item.address.toLowerCase(), item]));
    const verifiedAt = Date.now();
    const asset = verified.get(candidate.normalizedAddress);
    await ctx.runMutation(internal.registry.updatePairVerification, {
      address: candidate.address,
      symbol: asset?.symbol || candidate.symbol,
      name: asset?.name || candidate.name,
      decimals: asset?.decimals ?? candidate.decimals,
      approved: Boolean(asset), verifiedAt,
    });
    return assets;
  },
});
