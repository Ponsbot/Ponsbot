import { createPublicClient, http, parseAbi, zeroAddress, type Address } from "viem";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
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
  const client = createPublicClient({ transport: http(rpcUrl) });
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
    const candidate = config.pairs.find((item: { active: boolean; symbol: string; address: string; normalizedAddress: string; name: string; decimals: number }) => item.active
      && (item.symbol.toLowerCase() === normalized || item.address.toLowerCase() === normalized));
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
