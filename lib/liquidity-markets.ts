import { createPublicClient, decodeEventLog, erc20Abi, fallback, http, formatUnits, keccak256, parseAbiItem, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import { reliableHttp } from "./rpc-http";
import { geckoSharedFetch } from "./gecko-shared";
import { DELTA_LIQUIDITY, type LiquidityCandidate, type LiquidityDraft, type LiquidityFields } from "./liquidity-workflow";
import { liquidityPoolId, liquidityPoolKey, liquidityReadAbi } from "./liquidity-contracts";
import { liquidityAmounts, liquidityBands, liquidityMarketCapBands, liquidityTickAtSqrt } from "./liquidity-math";
import { compareLiquidityCandidates, liquidityHourlyActivity, liquidityMetric, liquidityVolumeTier, type LiquidityVolumeTier } from "./liquidity-analysis-policy";
import { ethUsdPrice } from "./wallet-signer/pricing";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
// Interactive discovery attempts the shared Gecko slot once. If it is busy or
// the upstream request fails, a recent cached snapshot is used immediately;
// the remaining budget is reserved for authenticating candidates on chain.
const LIQUIDITY_MARKET_WAIT_BUDGET_MS = 30_000;
const LIQUIDITY_POOL_VERIFICATION_RESERVE_MS = 45_000;
const LIQUIDITY_ANALYSIS_TIME_BUDGET_MS = LIQUIDITY_MARKET_WAIT_BUDGET_MS + LIQUIDITY_POOL_VERIFICATION_RESERVE_MS;
const GECKO_LIVE_RESPONSE_MAX_AGE_MS = 10 * 60_000;
// Pool discovery is only a ranking hint: every candidate is still verified
// against the canonical V3/V4 contracts before it can be selected or used.
// Keep a several-hour provider snapshot available during Gecko interruptions
// instead of discarding otherwise valid pools after one hour.
// Provider rows are discovery/ranking hints only. A stale row can never
// authorize a position: its descriptor, live liquidity and price are checked
// against canonical contracts at the current block before use.
const GECKO_INTERACTIVE_FALLBACK_MAX_AGE_MS = Number.POSITIVE_INFINITY;
export function liquidityRpc() {
  return createPublicClient({ transport: reliableHttp("https://rpc.mainnet.chain.robinhood.com", { batch: true, timeout: 15_000 }) });
}
/** Analysis only: bounded individual reads use the configured RPC (Alchemy),
 * then the public RPC. Execution transport and wallet authorization are unchanged. */
export function liquidityAnalysisRpc() {
  const publicUrl = "https://rpc.mainnet.chain.robinhood.com";
  const urls = [...new Set([process.env.ROBINHOOD_RPC_URL || publicUrl, publicUrl])];
  return createPublicClient({ transport: fallback(urls.map(url => http(url, { timeout: 5_000, retryCount: 1, retryDelay: 300 })), { rank: false, retryCount: 0 }) });
}
export async function liquidityConcurrent<T, R>(values: T[], callback: (value: T) => Promise<R>, width = 3) {
  const output: R[] = []; let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(width, values.length) }, async () => {
    while (cursor < values.length) { const index = cursor++; output[index] = await callback(values[index]); }
  })); return output;
}
type GeckoPool = { attributes: { address: string; reserve_in_usd?: string; base_token_price_usd?: string; quote_token_price_usd?: string; volume_usd?: { h1?: string; h6?: string; h24?: string }; transactions?: { h1?: { buys?: number; sells?: number } } }; relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } } };

/** Preserve the busiest options first, plus a large and a deep alternative. */
export function selectLiquidityCandidates(candidates: LiquidityCandidate[]) {
  const selected = new Map<string, LiquidityCandidate>();
  const add = (rows: LiquidityCandidate[]) => rows.forEach(p => { if (selected.size < 6) selected.set(p.id, p); });
  add([...candidates].sort(compareLiquidityCandidates).slice(0, 3));
  add([...candidates].sort((a, b) => (b.reserveUsd ?? -1) - (a.reserveUsd ?? -1)).filter(p => p.reserveUsd != null).slice(0, 1));
  add([...candidates].sort((a, b) => (b.activeDepthUsd ?? -1) - (a.activeDepthUsd ?? -1)).filter(p => p.activeDepthUsd != null).slice(0, 1));
  add([...candidates].sort(compareLiquidityCandidates));
  return [...selected.values()];
}
type Descriptor = { version: 3 | 4; pair: "ETH" | "USDG"; fee: number; spacing: number };
const descriptorKey = (d: Descriptor) => `${d.version}:${d.pair}:${d.fee}:${d.spacing}`;
type DiscoveryContext = { diagnostics: Set<string>; configuredLookups: number };
const descriptorCache = new Map<string, { at: number; value: Descriptor }>();
const initializeEvent = parseAbiItem("event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)");
const poolCreatedEvent = parseAbiItem("event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)");

function descriptorStore() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL || process.env.CONVEX_URL;
  const secret = process.env.MARKET_INDEX_SECRET;
  return url && secret ? { client: new ConvexHttpClient(url), secret } : null;
}
async function readPersistedDescriptors(token: Address): Promise<Descriptor[]> {
  const store = descriptorStore(); if (!store) return [];
  try {
    const row = await store.client.query(api.marketData.readCache, { secret: store.secret, key: `liquidity-descriptors:${token}` });
    const parsed = row ? JSON.parse(row.json) as unknown : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is Descriptor => Boolean(d && typeof d === "object"
      && ((d as Descriptor).version === 3 || (d as Descriptor).version === 4)
      && ((d as Descriptor).pair === "ETH" || (d as Descriptor).pair === "USDG")
      && Number.isInteger((d as Descriptor).fee) && (d as Descriptor).fee > 0 && (d as Descriptor).fee <= 100_000
      && Number.isInteger((d as Descriptor).spacing) && (d as Descriptor).spacing > 0 && (d as Descriptor).spacing <= 32767));
  } catch { return []; }
}
async function persistDescriptors(token: Address, descriptors: Descriptor[]) {
  const store = descriptorStore(); if (!store || !descriptors.length) return;
  const merged = new Map<string, Descriptor>();
  const existing = await readPersistedDescriptors(token);
  for (const descriptor of existing) merged.set(descriptorKey(descriptor), descriptor);
  for (const descriptor of descriptors) merged.set(descriptorKey(descriptor), descriptor);
  if (merged.size === existing.length && existing.every(descriptor => merged.has(descriptorKey(descriptor)))) return;
  await store.client.mutation(api.marketData.writeCache, { secret: store.secret, key: `liquidity-descriptors:${token}`,
    json: JSON.stringify([...merged.values()]), observedAt: Date.now(), ttlMs: 30 * 24 * 60 * 60_000 }).catch(() => undefined);
}

/** Exact-topic fallback for arbitrary tokens when indexed market discovery is
 * unavailable. Four bounded eth_getLogs calls cover ETH/USDG on V3/V4; there
 * is no block-by-block scan. Returned descriptors are still verified through
 * the canonical factory/pool state before they can become recommendations. */
async function discoverOnChainDescriptors(token: Address, c: Pick<ReturnType<typeof liquidityAnalysisRpc>, "getLogs">, block: bigint, diagnostics: Set<string>, forceHistorical = false) {
  const descriptors = new Map<string, Descriptor>();
  if (!forceHistorical) {
    for (const descriptor of await readPersistedDescriptors(token)) descriptors.set(descriptorKey(descriptor), descriptor);
    if (descriptors.size) { diagnostics.add("PERSISTED_DISCOVERY_USED"); return [...descriptors.values()]; }
  }
  const pairs = [
    { pair: "ETH" as const, v3Quote: DELTA_LIQUIDITY.weth as Address, v4Quote: zeroAddress },
    { pair: "USDG" as const, v3Quote: DELTA_LIQUIDITY.usdg as Address, v4Quote: DELTA_LIQUIDITY.usdg as Address },
  ];
  let failed = 0;
  await liquidityConcurrent(pairs, async ({ pair, v3Quote, v4Quote }) => {
    if (token !== v3Quote) {
      const [token0, token1] = [token, v3Quote].sort() as [Address, Address];
      try {
        const logs = await c.getLogs({ address: DELTA_LIQUIDITY.v3Factory, event: poolCreatedEvent, args: { token0, token1 }, fromBlock: 0n, toBlock: block, strict: true });
        for (const log of logs.slice(-24)) {
          const fee = Number(log.args.fee), spacing = Number(log.args.tickSpacing);
          if (log.args.token0?.toLowerCase() === token0 && log.args.token1?.toLowerCase() === token1 && fee > 0 && fee <= 100_000 && spacing > 0 && spacing <= 32767) {
            const descriptor = { version: 3 as const, pair, fee, spacing };
            descriptors.set(descriptorKey(descriptor), descriptor);
          }
        }
        if (logs.length > 24) diagnostics.add("ONCHAIN_DISCOVERY_BOUNDED");
      } catch { failed++; }
    }
    if (token !== v4Quote) {
      const [currency0, currency1] = [token, v4Quote].sort() as [Address, Address];
      try {
        const logs = await c.getLogs({ address: DELTA_LIQUIDITY.v4Manager, event: initializeEvent, args: { currency0, currency1 }, fromBlock: 0n, toBlock: block, strict: true });
        for (const log of logs.slice(-24)) {
          const fee = Number(log.args.fee), spacing = Number(log.args.tickSpacing);
          if (log.args.currency0?.toLowerCase() === currency0 && log.args.currency1?.toLowerCase() === currency1 && log.args.hooks === zeroAddress && log.args.id && liquidityPoolId(log.args) === log.args.id && fee > 0 && fee <= 100_000 && spacing > 0 && spacing <= 32767) {
            const descriptor = { version: 4 as const, pair, fee, spacing };
            descriptors.set(descriptorKey(descriptor), descriptor);
          }
        }
        if (logs.length > 24) diagnostics.add("ONCHAIN_DISCOVERY_BOUNDED");
      } catch { failed++; }
    }
  }, 2);
  if (descriptors.size) diagnostics.add("ONCHAIN_DISCOVERY_USED");
  if (failed) diagnostics.add(failed === 4 ? "ONCHAIN_DISCOVERY_FAILED" : "SOME_ONCHAIN_DISCOVERY_FAILED");
  const result = [...descriptors.values()];
  await persistDescriptors(token, result);
  return result;
}
/** Explorers suggest keys; the pool hash/factory and live state verify them. */
async function discoveredDescriptor(token: Address, id: string, c: Pick<ReturnType<typeof liquidityRpc>, "readContract">, block: bigint, context: DiscoveryContext): Promise<Descriptor | null> {
  const cacheKey = `${token}:${id}`, cached = descriptorCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 3600_000) return cached.value;
  try {
    let currency0: string, currency1: string, fee: number, spacing: number, version: 3 | 4;
    if (/^0x[a-f0-9]{40}$/.test(id)) {
      [currency0, currency1, fee, spacing] = await Promise.all([
        c.readContract({ address: id as Address, abi: liquidityReadAbi, functionName: "token0", blockNumber: block }), c.readContract({ address: id as Address, abi: liquidityReadAbi, functionName: "token1", blockNumber: block }),
        c.readContract({ address: id as Address, abi: liquidityReadAbi, functionName: "fee", blockNumber: block }), c.readContract({ address: id as Address, abi: liquidityReadAbi, functionName: "tickSpacing", blockNumber: block }),
      ]); version = 3;
      const canonical = await c.readContract({ address: DELTA_LIQUIDITY.v3Factory, abi: liquidityReadAbi, functionName: "getPool", args: [currency0 as Address, currency1 as Address, fee], blockNumber: block });
      if (canonical.toLowerCase() !== id) { context.diagnostics.add("POOLS_UNSUPPORTED"); return null; }
    } else if (/^0x[a-f0-9]{64}$/.test(id)) {
      const params = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: "0", toBlock: "latest", address: DELTA_LIQUIDITY.v4Manager, topic0: keccak256(stringToHex("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")), topic1: id, topic0_1_opr: "and" });
      // One precisely indexed initialization lookup; no per-block scanning.
      // This also works while Blockscout is serving challenge/error pages.
      let a;
      try {
        const publicReader = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { timeout: 5_000, retryCount: 0 }) });
        const logs = await publicReader.getLogs({ address: DELTA_LIQUIDITY.v4Manager, event: initializeEvent, args: { id: id as Hex }, fromBlock: 0n, toBlock: block, strict: true });
        a = logs[0]?.args;
      } catch { context.diagnostics.add("PUBLIC_DESCRIPTOR_RPC_FAILED"); }
      // One exact event+pool-ID lookup, no range expansion, paging or retry
      // loop. A comparison can spend at most six configured-RPC fallbacks.
      // Providers that reject historical ranges simply fall through safely.
      const configuredUrl = process.env.ROBINHOOD_RPC_URL;
      if (!a && configuredUrl && configuredUrl !== "https://rpc.mainnet.chain.robinhood.com" && context.configuredLookups < 6) {
        context.configuredLookups++;
        try {
          const reader = createPublicClient({ transport: http(configuredUrl, { timeout: 4_000, retryCount: 0 }) });
          a = (await reader.getLogs({ address: DELTA_LIQUIDITY.v4Manager, event: initializeEvent, args: { id: id as Hex }, fromBlock: 0n, toBlock: block, strict: true }))[0]?.args;
        } catch { context.diagnostics.add("CONFIGURED_DESCRIPTOR_RPC_FAILED"); }
      }
      if (!a) {
        const response = await fetch(`https://robinhoodchain.blockscout.com/api?${params}`, { signal: AbortSignal.timeout(6000) });
        if (!response.ok) { context.diagnostics.add("DESCRIPTOR_LOOKUP_FAILED"); return null; }
        const json = await response.json() as { result?: Array<{ address: string; data: Hex; topics: [Hex, ...Hex[]] }> };
        const log = Array.isArray(json.result) ? json.result.find(l => l.address.toLowerCase() === DELTA_LIQUIDITY.v4Manager) : undefined;
        if (!log) { context.diagnostics.add("DESCRIPTOR_LOOKUP_FAILED"); return null; }
        a = decodeEventLog({ abi: [initializeEvent], data: log.data, topics: log.topics }).args;
      }
      if (a.id !== id || a.hooks !== zeroAddress || liquidityPoolId(a) !== id) { context.diagnostics.add("POOLS_UNSUPPORTED"); return null; }
      currency0 = a.currency0; currency1 = a.currency1; fee = a.fee; spacing = a.tickSpacing; version = 4;
    } else return null;
    const currencies = [currency0.toLowerCase(), currency1.toLowerCase()];
    if (!currencies.includes(token.toLowerCase()) || fee <= 0 || fee > 100_000 || spacing <= 0 || spacing > 32767) { context.diagnostics.add("POOLS_UNSUPPORTED"); return null; }
    const other = currencies.find(a => a !== token.toLowerCase());
    const pair = other === DELTA_LIQUIDITY.usdg ? "USDG" : other === (version === 3 ? DELTA_LIQUIDITY.weth : zeroAddress) ? "ETH" : null;
    if (!pair) { context.diagnostics.add("POOLS_UNSUPPORTED"); return null; }
    const value = { version, pair, fee, spacing } satisfies Descriptor;
    if (descriptorCache.size > 500) descriptorCache.delete(descriptorCache.keys().next().value!);
    descriptorCache.set(cacheKey, { at: Date.now(), value }); return value;
  } catch { context.diagnostics.add("DESCRIPTOR_LOOKUP_FAILED"); return null; }
}
/** Cheap provider hints only remove clearly incompatible pairs. Missing hints
 * still get verified on chain; hints can never authorize an execution. */
function summaryPairCompatible(row: GeckoPool, token: Address) {
  const address = (id?: string) => id?.match(/0x[a-f0-9]{40}$/i)?.[0].toLowerCase();
  const base = address(row.relationships?.base_token?.data?.id), quote = address(row.relationships?.quote_token?.data?.id);
  if (!base || !quote) return true;
  if (base !== token && quote !== token) return false;
  return [zeroAddress, DELTA_LIQUIDITY.weth, DELTA_LIQUIDITY.usdg].includes((base === token ? quote : base) as typeof zeroAddress);
}
export async function discoverLiquidityPools(token: Address, budgetUsd?: number, quotePrices?: { ETH: number; USDG: number }, options: {
  fresh?: boolean; fields?: LiquidityFields; selected?: LiquidityCandidate;
} = {}): Promise<{ symbol: string; candidates: LiquidityCandidate[]; selected?: LiquidityCandidate; currentMarketCapUsd?: number; analysis: NonNullable<LiquidityDraft["analysis"]> }> {
  token = token.toLowerCase() as Address;
  const startedAt = Date.now(), diagnostics = new Set<string>();
  const discoveryContext: DiscoveryContext = { diagnostics, configuredLookups: 0 };
  const incompatibleSettings = new Set<string>();
  const c = options.fresh ? liquidityAnalysisRpc() : liquidityRpc(), block = await c.getBlockNumber();
  const [symbol, tokenDecimals] = await Promise.all([c.readContract({ address: token, abi: erc20Abi, functionName: "symbol", blockNumber: block }), c.readContract({ address: token, abi: erc20Abi, functionName: "decimals", blockNumber: block })]);
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(symbol)) throw new Error("UNSUPPORTED_TOKEN_SYMBOL");
  const prices: Partial<{ ETH: number; USDG: number }> = { ...quotePrices };
  if (options.fresh && !(prices.ETH && prices.ETH > 0)) {
    prices.ETH = await ethUsdPrice().catch(() => { diagnostics.add("ETH_USD_UNAVAILABLE"); return undefined; });
  }
  if (options.fresh && prices.ETH && !(prices.USDG && prices.USDG > 0)) {
    try {
      const pool = await c.readContract({ address: DELTA_LIQUIDITY.v3Factory, abi: liquidityReadAbi, functionName: "getPool", args: [DELTA_LIQUIDITY.weth, DELTA_LIQUIDITY.usdg, 100], blockNumber: block });
      if (pool === zeroAddress) throw new Error("No USDG pool");
      const [slot, active] = await Promise.all([
        c.readContract({ address: pool, abi: liquidityReadAbi, functionName: "slot0", blockNumber: block }),
        c.readContract({ address: pool, abi: liquidityReadAbi, functionName: "liquidity", blockNumber: block }),
      ]);
      const price = prices.ETH / ((Number(slot[0]) / 2 ** 96) ** 2 * 1e12);
      if (active <= 0n || !Number.isFinite(price) || price <= 0) throw new Error("Invalid USDG price");
      prices.USDG = price;
    } catch { diagnostics.add("USDG_USD_UNAVAILABLE"); }
  }
  if (options.fields?.unit === "eth") budgetUsd = prices.ETH ? Number(options.fields.amount) * prices.ETH : undefined;
  const supply = options.fields?.lowerMarketCapUsd !== undefined || options.fields?.upperMarketCapUsd !== undefined
    ? await c.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply", blockNumber: block }).then(n => Number(formatUnits(n, tokenDecimals))).catch(() => 0) : 0;
  const market: GeckoPool[] = [];
  let marketAt: number | null = null;
  try {
    for (let page = 1; page <= 3; page++) {
      if (page > 1 && Date.now() - startedAt >= LIQUIDITY_MARKET_WAIT_BUDGET_MS - 10_000) {
        diagnostics.add("ANALYSIS_TIME_BUDGET");
        break;
      }
      // Paid CoinGecko returns the broadest indexed pool set. The shared client
      // falls back to public GeckoTerminal and retained snapshots. Including an
      // inactive source prevents a quiet but valid pool from disappearing.
      const url = `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${token}/pools?page=${page}&include_inactive_source=true`;
      // A fresh request is made only when the shared slot is available now.
      // Otherwise geckoSharedFetch returns the latest cached provider payload,
      // including after an upstream timeout. Never wait behind the shared
      // cooldown in an interactive X or terminal workflow.
      const response = await geckoSharedFetch(url, 60_000, 8_000, options.fresh === true, options.fresh !== true,
        options.fresh ? startedAt : undefined, options.fresh ? "interactive" : "background");
      const responseAt = Number(response.headers.get("x-market-observed-at"));
      const recentCacheFallback = options.fresh === true && response.ok
        && (response.headers.get("x-market-stale") === "1" || Number.isFinite(responseAt) && responseAt < startedAt);
      if (recentCacheFallback) diagnostics.add("GECKO_RECENT_CACHE_FALLBACK");
      if (!response.ok) { diagnostics.add(response.headers.has("x-gecko-local-deferral") ? "GECKO_BUDGET_DEFERRED" : `GECKO_HTTP_${response.status}`); break; }
      const data = (await response.json() as { data: GeckoPool[] }).data;
      const at = Number(response.headers.get("x-market-observed-at"));
      const maximumAge = recentCacheFallback ? GECKO_INTERACTIVE_FALLBACK_MAX_AGE_MS : GECKO_LIVE_RESPONSE_MAX_AGE_MS;
      if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 30_000 || Date.now() - at >= maximumAge || options.fresh && at < startedAt && !recentCacheFallback || !Array.isArray(data)) { diagnostics.add("GECKO_STALE_OR_INVALID"); break; }
      market.push(...data.slice(0, 20).filter(row => /^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(row?.attributes?.address ?? ""))); marketAt = marketAt === null ? at : Math.min(marketAt, at);
      if (data.length < 20) break;
      if (page === 3) diagnostics.add("POOL_COVERAGE_BOUNDED");
    }
  } catch { diagnostics.add("GECKO_UNAVAILABLE"); }
  const selectedDescriptorKey = options.selected ? descriptorKey({
    version: options.selected.version,
    pair: options.selected.pair,
    fee: options.selected.feePips,
    spacing: options.selected.tickSpacing,
  }) : undefined;
  const verifiedDescriptors = new Map<string, Descriptor>();
  const readCandidate = async (descriptor: Descriptor): Promise<LiquidityCandidate | null> => {
    try {
      const key = liquidityPoolKey(token, descriptor.pair, descriptor.version, descriptor.fee, descriptor.spacing);
      let id: string, active: bigint, lpFee: number, traderFee: number, sqrt: bigint;
      if (descriptor.version === 3) {
        const pool = await c.readContract({ address: DELTA_LIQUIDITY.v3Factory, abi: liquidityReadAbi, functionName: "getPool", args: [key.currency0, key.currency1, key.fee], blockNumber: block });
        if (pool === zeroAddress) return null;
        const [slot, liquidity] = await Promise.all([
          c.readContract({ address: pool, abi: liquidityReadAbi, functionName: "slot0", blockNumber: block }),
          c.readContract({ address: pool, abi: liquidityReadAbi, functionName: "liquidity", blockNumber: block }),
        ]);
        if (slot[0] === 0n) return null;
        // Show the conservative LP portion if the two swap directions differ.
        const protocolShare = Math.max(...[slot[5] & 15, slot[5] >> 4].map(n => n > 0 ? 1 / n : 0));
        sqrt = slot[0];
        lpFee = key.fee / 10000 * (1 - protocolShare); traderFee = key.fee / 10000; active = liquidity; id = pool.toLowerCase();
      } else {
        id = liquidityPoolId(key);
        const [slot, liquidity] = await Promise.all([
          c.readContract({ address: DELTA_LIQUIDITY.v4View, abi: liquidityReadAbi, functionName: "getSlot0", args: [id as `0x${string}`], blockNumber: block }),
          c.readContract({ address: DELTA_LIQUIDITY.v4View, abi: liquidityReadAbi, functionName: "getLiquidity", args: [id as `0x${string}`], blockNumber: block }),
        ]);
        if (slot[0] === 0n || slot[3] > 100_000) return null;
        sqrt = slot[0];
        const protocol = Math.max(slot[2] & 4095, slot[2] >> 12);
        lpFee = slot[3] / 10000 * (1 - protocol / 1e6); traderFee = protocol / 10000 + lpFee; active = liquidity;
      }
      if (active === 0n || lpFee <= 0) return null;
      const row = market.find(p => p.attributes.address.toLowerCase() === id);
      const base = row?.relationships?.base_token?.data?.id?.toLowerCase().endsWith(token.toLowerCase());
      const quoteMatches = row?.relationships?.quote_token?.data?.id?.toLowerCase().endsWith(token.toLowerCase());
      const providerPrice = Number(base ? row?.attributes.base_token_price_usd : quoteMatches ? row?.attributes.quote_token_price_usd : undefined);
      const quoteDecimals = descriptor.pair === "ETH" ? 18 : 6, tokenIs0 = key.currency0 === token.toLowerCase();
      const ratio = (Number(sqrt) / 2 ** 96) ** 2 * 10 ** (tokenIs0 ? tokenDecimals - quoteDecimals : quoteDecimals - tokenDecimals);
      // Derive the quote asset USD price from a trusted caller or the same
      // fresh pool's quote-asset field, never an ungrounded token symbol.
      const otherPrice = Number(base ? row?.attributes.quote_token_price_usd : quoteMatches ? row?.attributes.base_token_price_usd : undefined);
      const referencePrice = prices[descriptor.pair];
      const quoteUsd = referencePrice && referencePrice > 0 ? referencePrice : otherPrice;
      const spotPrice = (tokenIs0 ? ratio : 1 / ratio) * quoteUsd;
      const price = Number.isFinite(spotPrice) && spotPrice > 0 ? spotPrice : providerPrice;
      const tick = liquidityTickAtSqrt(sqrt);
      const [a, b] = liquidityAmounts(active, Math.max(-887272, tick - 100), Math.min(887272, tick + 100), sqrt, false);
      const value = (a: bigint, b: bigint) => Number(formatUnits(a, tokenIs0 ? tokenDecimals : quoteDecimals)) * (tokenIs0 ? price : quoteUsd) + Number(formatUnits(b, tokenIs0 ? quoteDecimals : tokenDecimals)) * (tokenIs0 ? quoteUsd : price);
      const depth = value(a, b);
      let share: number | null = null;
      let shareBasis: "requested" | "reference" = "reference";
      // Validate explicit range/band compatibility even if dollar prices or the
      // budget conversion are unavailable. Missing prices only disable share.
      if (budgetUsd || options.fields) {
        try {
          const f = options.fields, shape = f?.shape ?? "flat", count = f?.bands ?? (shape === "flat" ? 1 : 5);
          const dollarRange = f?.lowerMarketCapUsd !== undefined || f?.upperMarketCapUsd !== undefined;
          const bands = dollarRange ? liquidityMarketCapBands({ lowerUsd: f?.lowerMarketCapUsd ?? 0, upperUsd: f?.upperMarketCapUsd ?? 0,
            supply, pairedAssetUsd: quoteUsd, tokenDecimals, pairDecimals: quoteDecimals, tokenIs0, sqrt, spacing: key.tickSpacing, count, shape }).bands
            : liquidityBands({ tick, spacing: key.tickSpacing, down: f?.downPercent ?? 25, up: f?.upPercent ?? 25, count, shape, tokenIs0 });
          const activeCapital = bands.reduce((total, band) => {
            const [x, y] = liquidityAmounts(active * BigInt(band.weight), band.tickLower, band.tickUpper, sqrt, false);
            return total + value(x, y);
          }, 0);
          const weight = bands.filter(band => tick >= band.tickLower && tick < band.tickUpper).reduce((total, band) => total + band.weight, 0);
          if (budgetUsd && Number.isFinite(activeCapital) && activeCapital > 0 && weight > 0) share = 100 * budgetUsd * weight / (budgetUsd * weight + activeCapital);
          if ((dollarRange || f?.downPercent !== undefined && f.upPercent !== undefined) && f?.shape && f.bands) shareBasis = "requested";
        } catch (error) {
          const f = options.fields;
          const completeRange = f?.lowerMarketCapUsd !== undefined && f.upperMarketCapUsd !== undefined
            || f?.downPercent !== undefined && f.upPercent !== undefined;
          const impossible = error instanceof Error && error.message === "INVALID_BANDS";
          if (completeRange && impossible) {
            const key = descriptorKey(descriptor);
            incompatibleSettings.add(key);
            diagnostics.add("POOL_SETTINGS_INCOMPATIBLE");
            if (key === selectedDescriptorKey) diagnostics.add("SELECTED_POOL_RANGE_BANDS_INCOMPATIBLE");
            return null;
          }
          diagnostics.add("SOME_RANGES_NOT_COMPARABLE");
        }
      }
      const volume = liquidityMetric(row?.attributes.volume_usd?.h1), volumeDayUsd = liquidityMetric(row?.attributes.volume_usd?.h24);
      const trades = row?.attributes.transactions?.h1;
      const buys = liquidityMetric(trades?.buys), sells = liquidityMetric(trades?.sells);
      verifiedDescriptors.set(descriptorKey(descriptor), descriptor);
      return {
        id, version: descriptor.version, pair: descriptor.pair, token0: key.currency0, token1: key.currency1, feePips: key.fee, tickSpacing: key.tickSpacing,
        netLpFeePercent: lpFee, traderFeePercent: traderFee, tokenPriceUsd: Number.isFinite(price) && price > 0 ? price : null,
        activeLiquidity: active.toString(), volumeHourUsd: volume !== null && Number.isFinite(volume) && volume >= 0 ? volume : null,
        activeDepthUsd: Number.isFinite(depth) && depth > 0 ? depth : null, estimatedBudgetSharePercent: share, shareBasis,
        volumeSixHourUsd: liquidityMetric(row?.attributes.volume_usd?.h6), volumeDayUsd, volumeTier: liquidityVolumeTier(volume, volumeDayUsd),
        reserveUsd: liquidityMetric(row?.attributes.reserve_in_usd),
        swapsHour: buys !== null && sells !== null && Number.isSafeInteger(buys + sells) ? buys + sells : null, observedAt: Date.now(), marketObservedAt: row ? marketAt : null, blockNumber: block.toString(),
        reasons: ["fee_paying", "range_risk"] as LiquidityCandidate["reasons"],
      } satisfies LiquidityCandidate;
    } catch { diagnostics.add("SOME_POOL_READS_FAILED"); return null; }
  };
  const candidates = new Map<string, LiquidityCandidate>(), checked = new Set<string>();
  const inspect = async (d: Descriptor, required = false) => {
    const key = descriptorKey(d);
    if (checked.has(key)) return;
    if (!required && Date.now() - startedAt > LIQUIDITY_ANALYSIS_TIME_BUDGET_MS) { diagnostics.add("ANALYSIS_TIME_BUDGET"); return; }
    checked.add(key);
    const candidate = await readCandidate(d);
    if (candidate) candidates.set(candidate.id, candidate);
  };
  const allRows = [...new Map(market.map(row => [row.attributes.address.toLowerCase(), row])).values()];
  const rows = allRows.filter(row => summaryPairCompatible(row, token));
  if (rows.length < allRows.length) diagnostics.add("POOLS_UNSUPPORTED");
  // Verify the selected pool before optional exploration can use the time budget.
  // It does not count as a busy option merely because the user selected it.
  if (options.selected) await inspect({ version: options.selected.version, pair: options.selected.pair, fee: options.selected.feePips, spacing: options.selected.tickSpacing }, true);
  const rowTier = (p: GeckoPool) => liquidityVolumeTier(liquidityMetric(p.attributes.volume_usd?.h1), liquidityMetric(p.attributes.volume_usd?.h24));
  let stage: LiquidityVolumeTier = "high", descriptorChecks = 0;
  // Filter cheap summaries BEFORE expensive RPC verification. Only verified,
  // active, fee-paying compatible pools count toward the three-option target.
  const sufficient = (tier: LiquidityVolumeTier) => [...candidates.values()].filter(p => {
    const order = { high: 2, low: 1, limited: 0 };
    return order[p.volumeTier ?? "limited"] >= order[tier] && (tier === "limited" || p.volumeHourUsd !== 0 && (liquidityHourlyActivity(p) ?? 0) > 0);
  }).length >= 3;
  for (const [tier, initialLimit, maxLimit] of [["high", 12, 32], ["low", 8, 16], ["limited", 4, 8]] as const) {
    stage = tier;
    const eligible = rows.filter(p => rowTier(p) === tier);
    const bySize = [...eligible].sort((a, b) => (liquidityMetric(b.attributes.reserve_in_usd) ?? -1) - (liquidityMetric(a.attributes.reserve_in_usd) ?? -1));
    const hourly = (p: GeckoPool) => liquidityMetric(p.attributes.volume_usd?.h1) ?? (liquidityMetric(p.attributes.volume_usd?.h24) ?? -24) / 24;
    const byVolume = [...eligible].sort((a, b) => hourly(b) - hourly(a));
    const ordered = [...new Map([...bySize.slice(0, 2), ...byVolume].map(row => [row.attributes.address.toLowerCase(), row])).values()];
    let inspected = 0;
    while (inspected < ordered.length && inspected < maxLimit && descriptorChecks < 48 && Date.now() - startedAt <= LIQUIDITY_ANALYSIS_TIME_BUDGET_MS) {
      const take = Math.min(inspected === 0 ? initialLimit : 4, maxLimit - inspected, 48 - descriptorChecks);
      const batch = ordered.slice(inspected, inspected + take); inspected += batch.length;
      await liquidityConcurrent(batch, async row => {
        if (Date.now() - startedAt > LIQUIDITY_ANALYSIS_TIME_BUDGET_MS) { diagnostics.add("ANALYSIS_TIME_BUDGET"); return; }
        descriptorChecks++;
        const descriptor = await discoveredDescriptor(token, row.attributes.address.toLowerCase(), c, block, discoveryContext);
        if (descriptor) await inspect(descriptor);
      }, 4);
      if (sufficient(tier)) break;
    }
    if (inspected < ordered.length) diagnostics.add("POOL_COVERAGE_BOUNDED");
    if (sufficient(tier)) break;
  }
  // Gecko provides useful volume rankings, but it must not be a hard
  // dependency for arbitrary tokens. Exact indexed event filters discover
  // compatible pool keys through Alchemy/configured RPC (with public fallback),
  // after which readCandidate verifies live canonical state at this block.
  if (candidates.size < 3 && Date.now() - startedAt <= LIQUIDITY_ANALYSIS_TIME_BUDGET_MS) {
    const onChain = await discoverOnChainDescriptors(token, c, block, diagnostics);
    await liquidityConcurrent(onChain, descriptor => inspect(descriptor, true), 4);
    if (!candidates.size && diagnostics.has("PERSISTED_DISCOVERY_USED")) {
      const refreshed = await discoverOnChainDescriptors(token, c, block, diagnostics, true);
      await liquidityConcurrent(refreshed, descriptor => inspect(descriptor, true), 4);
    }
  }
  // If discovery is sparse/unavailable, retain the established canonical-key
  // fallback. Unknown-volume pools are shown as limited, not as zero-volume.
  if (candidates.size < 3) {
    stage = "limited";
    const presets: Descriptor[] = [];
    for (const pair of ["ETH", "USDG"] as const) {
      for (const [fee, spacing] of [[100, 1], [500, 10], [3000, 60], [10000, 200]]) presets.push({ version: 3, pair, fee, spacing }, { version: 4, pair, fee, spacing });
      presets.push({ version: 4, pair, fee: 5000, spacing: 100 }, { version: 4, pair, fee: 3000, spacing: 50 });
    }
    await liquidityConcurrent(presets, inspect, 4);
  }
  // Every descriptor that produced a live canonical candidate becomes a
  // durable fallback, not only descriptors found by the historical log scan.
  await persistDescriptors(token, [...verifiedDescriptors.values()]);
  // A refresh never silently replaces the user's pool with a higher-ranked one.
  const selected = options.selected ? candidates.get(options.selected.id) : undefined;
  if (selectedDescriptorKey && incompatibleSettings.has(selectedDescriptorKey)) diagnostics.add("SELECTED_POOL_SETTINGS_INCOMPATIBLE");
  const all = [...candidates.values()];
  const shortlist = selectLiquidityCandidates(all).sort(compareLiquidityCandidates);
  const candidatePrice = shortlist.find(candidate => candidate.tokenPriceUsd)?.tokenPriceUsd;
  const providerPrice = market.map(row => {
    const base = row.relationships?.base_token?.data?.id?.toLowerCase().endsWith(token);
    const quote = row.relationships?.quote_token?.data?.id?.toLowerCase().endsWith(token);
    return Number(base ? row.attributes.base_token_price_usd : quote ? row.attributes.quote_token_price_usd : undefined);
  }).find(price => Number.isFinite(price) && price > 0);
  const currentMarketCapUsd = supply > 0 && (candidatePrice || providerPrice) ? supply * (candidatePrice || providerPrice!) : undefined;
  return { symbol, candidates: shortlist, ...(selected ? { selected } : {}), ...(currentMarketCapUsd && Number.isFinite(currentMarketCapUsd) ? { currentMarketCapUsd } : {}), analysis: {
    checkedAt: Date.now(), stage, summaries: allRows.length, checkedPools: checked.size, descriptorLookups: descriptorChecks,
    verifiedPools: all.length, diagnostics: [...diagnostics].sort((a, b) => Number(b.startsWith("SELECTED_POOL_")) - Number(a.startsWith("SELECTED_POOL_"))).slice(0, 12),
  } };
}

/** Read-only fallback for tokens outside the Pons/RWA catalog. */
export async function liquidityReferencePrice(token: Address, quotePrices: { ETH: number; USDG: number }) {
  const { candidates } = await discoverLiquidityPools(token, undefined, quotePrices);
  const eligible = candidates.filter(p => p.tokenPriceUsd && (p.activeDepthUsd ?? 0) >= 100 && (p.swapsHour ?? 0) > 0 && (p.volumeHourUsd ?? 0) > 0).sort((a, b) => (b.activeDepthUsd ?? 0) - (a.activeDepthUsd ?? 0));
  if (!eligible.length) throw new Error("LP_REFERENCE_PRICE_UNAVAILABLE");
  const best = eligible[0], comparable = eligible.filter(p => (p.activeDepthUsd ?? 0) >= best.activeDepthUsd! / 2);
  if (comparable.some(p => Math.abs(p.tokenPriceUsd! / best.tokenPriceUsd! - 1) > .2)) throw new Error("LP_REFERENCE_PRICE_DISAGREEMENT");
  return best.tokenPriceUsd!;
}
