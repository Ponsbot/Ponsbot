import { createPublicClient, http, parseAbi, zeroAddress, type Address } from "viem";

export const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address;
export const PONS_V2_LAUNCH_AND_BUY_ROUTER = "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948" as Address;
export const PONS_V2_PAIR_CANDIDATES = [
  "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", // SNDK
  "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", // AMD
  "0x12f190a9F9d7D37a250758b26824B97CE941bF54", // AMZN
  "0xe93237C50D904957Cf27E7B1133b510C669c2e74", // MSFT
  "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", // META
  "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", // CRCL
  "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", // COIN
  "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", // MU
  "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", // PLTR
] as const satisfies readonly Address[];

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
  const factory = options.factory || (process.env.PONS_V2_FACTORY_ADDRESS as Address | undefined) || PONS_V2_FACTORY;
  const configured = options.candidates || [
    ...PONS_V2_PAIR_CANDIDATES,
    ...parsePairCandidates(process.env.PONS_V2_PAIR_CANDIDATES || ""),
  ];
  const client = createPublicClient({ transport: http(rpcUrl) });
  const verifiedAt = Date.now();
  const results: PonsPairAsset[] = [{
    address: zeroAddress, symbol: "ETH", name: "Ether", decimals: 18, native: true, verifiedAt,
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
