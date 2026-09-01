import { ConvexHttpClient } from "convex/browser";
import { createPublicClient, http, formatUnits, parseAbi, type Address } from "viem";
import { api } from "../convex/_generated/api";
import { geckoSharedFetch } from "./gecko-shared";
import { geckoMarketCap } from "./market-index-policy";
import { mapWithConcurrency } from "./bounded-concurrency";
import { ponsV4PoolId } from "./lifetime-volume";
import { quoteDetails } from "./token-market-cap";
import { WEBSITE_METADATA_TTL_MS } from "./website-refresh-policy";

type Rpc = ReturnType<typeof createPublicClient>;
export type WebsiteMarketTarget = { tokenAddress: string; curveAddress: string; pairToken: string; graduated: boolean; poolFee?: number; tickSpacing?: number };
export type WebsiteSnapshot = { tokenAddress: string; observedAt: number; marketCapUsd?: number; marketCapSource?: "gecko" | "onchain"; volume24hUsd?: number; volumeObservedAt?: number; graduated?: boolean; poolFee?: number; tickSpacing?: number };
const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function memeHook() view returns(address)",
]);
const tokenAbi = parseAbi(["function decimals() view returns(uint8)", "function totalSupply() view returns(uint256)"]);
const curveAbi = parseAbi(["function getReserves() view returns(uint256 quoteReserve,uint256 tokenReserve)"]);
const stateAbi = parseAbi(["function getSlot0(bytes32 id) view returns(uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)"]);

export function rpcBlockFresh(timestamp: bigint, now = Date.now()) {
  const age = now - Number(timestamp) * 1_000;
  return Number.isFinite(age) && age >= -30_000 && age <= 120_000;
}

/** Read-only website clients. Never used for signing, gas estimates, or execution. */
export function websiteRpcReader(client: ConvexHttpClient, secret: string, signal?: AbortSignal) {
  const publicUrl = process.env.WEBSITE_PUBLIC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const alchemyUrl = process.env.ROBINHOOD_RPC_URL;
  const make = (url: string) => createPublicClient({ transport: http(url, { timeout: 2_500, retryCount: 0, batch: { wait: 10, batchSize: 30 }, ...(signal ? { fetchOptions: { signal } } : {}) }) });
  const publicRpc = make(publicUrl);
  const alchemy = alchemyUrl && alchemyUrl !== publicUrl ? make(alchemyUrl) : undefined;
  let publicHealth: Promise<boolean> | undefined;
  let alchemyHealth: Promise<boolean> | undefined;
  const health = async (rpc: Rpc) => {
    const [chainId, block] = await Promise.all([rpc.getChainId(), rpc.getBlock({ blockTag: "latest" })]);
    return chainId === 4663 && rpcBlockFresh(block.timestamp);
  };
  return async <T>(read: (rpc: Rpc) => Promise<T>): Promise<T> => {
    signal?.throwIfAborted();
    publicHealth ??= health(publicRpc).catch(() => false);
    if (await publicHealth) {
      try { return await read(publicRpc); } catch { /* Small, budgeted paid fallback below. */ }
    }
    signal?.throwIfAborted();
    if (!alchemy || !await client.mutation(api.marketData.reserveAlchemy, { secret })) throw new Error("website RPC fallback unavailable");
    alchemyHealth ??= health(alchemy).catch(() => false);
    if (!await alchemyHealth) throw new Error("website RPC is stale or on the wrong chain");
    return read(alchemy);
  };
}

export async function refreshWebsiteMarkets(client: ConvexHttpClient, secret: string, targets: WebsiteMarketTarget[], config: { factory: Address; stateView: Address }) {
  const signal = AbortSignal.timeout(30_000);
  const withRpc = websiteRpcReader(client, secret, signal);
  const pending = new Map<string, Promise<unknown>>();
  const namespace = `${config.factory.toLowerCase()}:${config.stateView.toLowerCase()}`;
  async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const fullKey = `metadata:${namespace}:${key}`;
    const existing = pending.get(fullKey);
    if (existing) return existing as Promise<T>;
    const task = (async () => {
      const stored = await client.query(api.marketData.readCache, { secret, key: fullKey }).catch(() => null);
      if (stored) return JSON.parse(stored.json) as T;
      const observedAt = Date.now(); const value = await load();
      await client.mutation(api.marketData.writeCache, { secret, key: fullKey, json: JSON.stringify(value), ttlMs: ttl, observedAt }).catch(() => undefined);
      return value;
    })();
    pending.set(fullKey, task);
    task.catch(() => pending.delete(fullKey));
    return task;
  }
  const hook = () => cached("hook", WEBSITE_METADATA_TTL_MS, () => withRpc(rpc => rpc.readContract({ address: config.factory, abi: factoryAbi, functionName: "memeHook" })));
  const pools = new Map<string, string>();
  const snapshots = new Map<string, WebsiteSnapshot>();
  const resolved = new Map<string, WebsiteMarketTarget>();
  const resolvePhase = async (target: WebsiteMarketTarget) => {
    const token = target.tokenAddress.toLowerCase();
    const state = await cached(`phase:${token}`, 60_000, () => withRpc(async rpc => {
      const result = await rpc.readContract({ address: config.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token as Address] });
      if (!result.exists || (result.phase !== 0 && result.phase !== 2)) throw new Error("token migrating or unavailable");
      return { curveAddress: result.curve, pairToken: result.pairToken, graduated: result.phase === 2, poolFee: result.poolFee, tickSpacing: result.tickSpacing };
    }));
    snapshots.set(token, { ...snapshots.get(token), tokenAddress: token, observedAt: Date.now(), graduated: state.graduated, poolFee: state.poolFee, tickSpacing: state.tickSpacing });
    return { ...target, ...state };
  };
  await mapWithConcurrency(targets, 4, async (target) => {
    const token = target.tokenAddress.toLowerCase();
    let current = target;
    // Gecko is attempted without live reads for known curves. Graduation is
    // independently monitored by the backend; fallback calculations revalidate
    // phase before touching reserves. Only a missing graduated key needs RPC here.
    if (target.graduated && (target.poolFee === undefined || target.tickSpacing === undefined)) {
      try {
        current = await resolvePhase(target);
      } catch { /* Gecko can still answer using the last verified pool; never mark a failed phase check fresh. */ }
    }
    resolved.set(token, current);
    try {
      const pool = current.graduated
        ? ponsV4PoolId(token as Address, current.pairToken as Address, current.poolFee!, current.tickSpacing!, await hook())
        : current.curveAddress;
      pools.set(pool.toLowerCase(), token);
    } catch { /* Missing pool configuration does not discard other tokens. */ }
  });
  const poolIds = [...pools.keys()].sort();
  if (poolIds.length) {
    const response = await geckoSharedFetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/multi/${poolIds.join(",")}`).catch(() => undefined);
    const payload = response?.ok ? await response.json().catch(() => undefined) as { data?: Array<{ attributes?: { address?: string; market_cap_usd?: string | null; fdv_usd?: string | null; volume_usd?: { h24?: string } } }> } | undefined : undefined;
    const observedAt = Number(response?.headers.get("x-market-observed-at")) || Date.now();
    for (const pool of payload?.data ?? []) {
      const token = pools.get(pool.attributes?.address?.toLowerCase() ?? "");
      if (!token) continue;
      const cap = geckoMarketCap(pool.attributes?.market_cap_usd, pool.attributes?.fdv_usd);
      const rawVolume = pool.attributes?.volume_usd?.h24;
      const volume = rawVolume === undefined || rawVolume === null || rawVolume === "" ? NaN : Number(rawVolume);
      snapshots.set(token, { ...snapshots.get(token), tokenAddress: token, observedAt,
        ...(cap === undefined ? {} : { marketCapUsd: cap, marketCapSource: "gecko" }),
        ...(Number.isFinite(volume) && volume >= 0 ? { volume24hUsd: volume, volumeObservedAt: observedAt } : {}),
      });
    }
  }
  await mapWithConcurrency(targets, 4, async (target) => {
    const token = target.tokenAddress.toLowerCase();
    if (snapshots.get(token)?.marketCapUsd !== undefined) return;
    let current = resolved.get(token)!;
    try {
      if (!current.graduated) current = await resolvePhase(current);
      const [metadata, quote] = await Promise.all([
        cached(`token:${token}`, WEBSITE_METADATA_TTL_MS, () => withRpc(async rpc => {
          const [decimals, supply] = await Promise.all([
            rpc.readContract({ address: token as Address, abi: tokenAbi, functionName: "decimals" }),
            rpc.readContract({ address: token as Address, abi: tokenAbi, functionName: "totalSupply" }),
          ]);
          return { decimals, supply: supply.toString() };
        })),
        cached(`quote:${current.pairToken.toLowerCase()}`, 60_000, () => withRpc(rpc => quoteDetails(rpc, current.pairToken as Address, signal, config.stateView))),
      ]);
      let tokenInQuote: number;
      if (!current.graduated) {
        const [q, t] = await withRpc(rpc => rpc.readContract({ address: current.curveAddress as Address, abi: curveAbi, functionName: "getReserves" }));
        tokenInQuote = Number(formatUnits(q, quote.decimals)) / Number(formatUnits(t, metadata.decimals));
      } else {
        const pool = ponsV4PoolId(token as Address, current.pairToken as Address, current.poolFee!, current.tickSpacing!, await hook());
        const [sqrt] = await withRpc(rpc => rpc.readContract({ address: config.stateView, abi: stateAbi, functionName: "getSlot0", args: [pool as `0x${string}`] }));
        const ratio = (Number(sqrt) / 2 ** 96) ** 2;
        tokenInQuote = (token < current.pairToken.toLowerCase() ? ratio : 1 / ratio) * 10 ** (metadata.decimals - quote.decimals);
      }
      const value = Number(formatUnits(BigInt(metadata.supply), metadata.decimals)) * tokenInQuote * quote.usd;
      if (!Number.isFinite(value) || value <= 0) return;
      snapshots.set(token, { ...snapshots.get(token), tokenAddress: token, observedAt: Date.now(), marketCapUsd: value, marketCapSource: "onchain" });
    } catch { /* Retain the last good Convex value and its original timestamp. */ }
  });
  return [...snapshots.values()];
}
