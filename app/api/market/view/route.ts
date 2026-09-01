import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { createPublicClient, decodeEventLog, formatUnits, keccak256, parseAbi, type Address, type Hex } from "viem";
import { api } from "@/convex/_generated/api";
import { boundedJson, RequestBodyError } from "@/lib/bounded-json";
import { mapWithConcurrency, nextTokenCursor, perTokenScanRange, transferAttributedWallet } from "@/lib/bounded-concurrency";
import { reliableHttp } from "@/lib/rpc-http";
import { catalogMarketRefreshDue, freshMarketCap, geckoMarketCap, v4TokenTradeKind } from "@/lib/market-index-policy";
import { ponsV4PoolId } from "@/lib/lifetime-volume";
import { geckoSharedFetch } from "@/lib/gecko-shared";
import { readPublicMarketStates } from "@/lib/public-display-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const curveEvents = parseAbi([
  "event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 creatorTax)",
  "event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 creatorTax)",
]);
const curveBuyTopic = keccak256(new TextEncoder().encode("CurveBuy(address,address,uint256,uint256,uint256,uint256)"));
const curveSellTopic = keccak256(new TextEncoder().encode("CurveSell(address,address,uint256,uint256,uint256,uint256)"));
const transferEvent = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"])[0];
const transferTopic = keccak256(new TextEncoder().encode("Transfer(address,address,uint256)"));
const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function memeHook() view returns(address)", "function poolManager() view returns(address)",
]);
const v4SwapEvent = parseAbi(["event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)"])[0];
const DEAD = "0x000000000000000000000000000000000000dead";
const DEAD_TOPIC = `0x${"0".repeat(24)}${DEAD.slice(2)}` as Hex;
const tokenReadAbi = parseAbi(["function decimals() view returns(uint8)", "function totalSupply() view returns(uint256)"]);

type RawLog = { address: Address; blockNumber: Hex; transactionHash: Hex; logIndex: Hex; topics: [Hex, ...Hex[]]; data: Hex };
type PonsLaunchState = { phase: number; poolFee: number; tickSpacing: number };
type MarketCapSource = "gecko" | "onchain";
const GRADUATION_READ_TTL_MS = 60_000;
const INFRASTRUCTURE_READ_TTL_MS = 60 * 60_000;
const VERY_ACTIVE_H1_TRADES = Math.max(1, Number(process.env.MARKET_VERY_ACTIVE_H1_TRADES || 20));
const ACTIVE_LAUNCH_REFRESH_MS = 60_000;
const INACTIVE_LAUNCH_REFRESH_MS = 15 * 60_000;
const INACTIVE_BONDING_CURVE_MCAP_TTL_MS = 60 * 60_000;
let infrastructureCache: { factory: string; hook: Address; poolManager: Address; expiresAt: number } | undefined;

async function ponsInfrastructure(rpc: ReturnType<typeof createPublicClient>, factory: Address) {
  if (infrastructureCache?.factory.toLowerCase() === factory.toLowerCase() && infrastructureCache.expiresAt > Date.now()) return infrastructureCache;
  const [hook, poolManager] = await Promise.all([
    rpc.readContract({ address: factory, abi: factoryAbi, functionName: "memeHook" }),
    rpc.readContract({ address: factory, abi: factoryAbi, functionName: "poolManager" }),
  ]);
  infrastructureCache = { factory, hook, poolManager, expiresAt: Date.now() + INFRASTRUCTURE_READ_TTL_MS };
  return infrastructureCache;
}

export async function POST(request: Request) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.MARKET_INDEX_SECRET;
  if (!convexUrl || !secret) return NextResponse.json({ ok: false }, { status: 503 });
  const convex = new ConvexHttpClient(convexUrl);
  let requested: { tokenAddresses?: unknown; surface?: unknown };
  try { requested = await boundedJson(request, 8_192); }
  catch (error) { return NextResponse.json({ ok: false, error: error instanceof RequestBodyError ? error.message : "invalid request" }, { status: error instanceof RequestBodyError ? error.status : 400 }); }
  if (requested.tokenAddresses !== undefined && !Array.isArray(requested.tokenAddresses)) return NextResponse.json({ ok: false, error: "tokenAddresses must be an array" }, { status: 400 });
  if (requested.surface !== undefined && requested.surface !== "launches" && requested.surface !== "token") return NextResponse.json({ ok: false, error: "invalid market surface" }, { status: 400 });
  const launchBrowse = requested.surface === "launches";
  const addresses = (requested.tokenAddresses || []) as unknown[];
  if (addresses.length > 50) return NextResponse.json({ ok: false, error: "too many token addresses" }, { status: 400 });
  const viewed = new Set(addresses.filter((address): address is string => typeof address === "string" && /^0x[a-fA-F0-9]{40}$/.test(address)).map((address) => address.toLowerCase()));
  const now = Date.now();
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  const viewerKey = createHash("sha256").update(`${forwarded}:${process.env.WEB_AUTH_SECRET || secret}`).digest("hex");
  const leaseId = randomUUID();
  const lease = await convex.mutation(api.site.acquireMarketIndexLease, { now, secret, viewerKey, leaseId });
  if (lease.rateLimited) return NextResponse.json({ ok: false, error: "market refresh rate limited" }, { status: 429, headers: { "retry-after": "60" } });
  const catalogDue = launchBrowse && catalogMarketRefreshDue(lease.catalogRefreshedAt, now);
  if (!lease.acquired) {
    // Valuations have their own lightweight worker. An activity-index lease
    // must never prevent /market/snapshot from refreshing a viewed token.
    const market = launchBrowse ? [] : await readPublicMarketStates(convexUrl, [...viewed]);
    return NextResponse.json({
      ok: true,
      indexed: false,
      market,
      nextRefreshMs: catalogDue ? ACTIVE_LAUNCH_REFRESH_MS : launchBrowse ? INACTIVE_LAUNCH_REFRESH_MS : ACTIVE_LAUNCH_REFRESH_MS,
    });
  }
  let leaseValid = true;
  const heartbeat = setInterval(() => {
    void convex.mutation(api.site.renewMarketIndexLease, { now: Date.now(), secret, leaseId }).then((renewed) => { leaseValid = renewed; }).catch(() => { leaseValid = false; });
  }, 30_000);
  try {
    const rpc = createPublicClient({ transport: reliableHttp(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 8_000 }) });
    const refreshCatalog = catalogDue;
    const [targets, catalogTargets, latest, runtimeConfig] = await Promise.all([
      convex.query(api.site.marketIndexTargets, { tokenAddresses: [...viewed] }),
      refreshCatalog ? convex.query(api.site.marketCatalogTargets, {}) : Promise.resolve([]),
      rpc.getBlockNumber(),
      convex.query(api.site.marketRuntimeConfig, {}),
    ]);
    if (!runtimeConfig.factory || !/^0x[a-fA-F0-9]{40}$/.test(runtimeConfig.factory)
      || !runtimeConfig.stateView || !/^0x[a-fA-F0-9]{40}$/.test(runtimeConfig.stateView)) throw new Error("Pons market infrastructure is not configured");
    const factory = runtimeConfig.factory as Address;
    if (!targets.length) {
      const recorded = leaseValid && await convex.mutation(api.site.recordMarketIndex, { secret, leaseId, indexedThroughBlock: latest.toString(), marketCaps: [], events: [] });
      if (!recorded) throw new Error("market index lease was lost before recording");
      return NextResponse.json({ ok: true, indexed: true });
    }
    const needsInitialCursor = targets.some((target) => !target.indexedThroughBlock);
    // Gecko supplies the public 24-hour trade/volume history. Start an
    // on-chain cursor in a bounded recent range instead of binary-searching
    // block timestamps on every cold serverless instance.
    const initialBlock = needsInitialCursor && latest > 10_000n ? latest - 10_000n : latest;
    const initialSingleTokenBackfill = targets.length === 1 && !targets[0].indexedThroughBlock;
    const incrementalRange = perTokenScanRange(targets.map((target) => target.indexedThroughBlock), initialBlock, latest, 10_000n);
    // A token page should populate its prior day immediately. Multi-card feed
    // refreshes remain chunked so one viewer cannot create an oversized scan.
    const scanFrom = initialSingleTokenBackfill ? initialBlock : incrementalRange.from;
    const scanTo = initialSingleTokenBackfill ? latest : incrementalRange.to;
    const prioritized = targets.filter((target) => viewed.has(target.tokenAddress.toLowerCase()));
    const addressMap = new Map<string, { tokenAddress: string; curveAddress: string }>();
    for (const target of targets) {
      addressMap.set(target.curveAddress.toLowerCase(), target);
      addressMap.set(target.tokenAddress.toLowerCase(), target);
    }
    const { hook, poolManager } = await ponsInfrastructure(rpc, factory);
    const graduated = new Map<string, { tokenAddress: string; tokenIsCurrency0: boolean }>();
    const officialPools = new Map<string, string>();
    const graduationStatus = new Map<string, boolean>();
    const graduationMetadata = new Map<string, { poolFee: number; tickSpacing: number; checkedAt: number }>();
    const addGraduatedPool = (target: typeof targets[number], poolFee: number, tickSpacing: number) => {
      const poolId = ponsV4PoolId(target.tokenAddress as Address, target.pairToken as Address, poolFee, tickSpacing, hook);
      graduated.set(poolId, {
        tokenAddress: target.tokenAddress,
        tokenIsCurrency0: target.tokenAddress.toLowerCase() < target.pairToken.toLowerCase(),
      });
      officialPools.set(target.tokenAddress.toLowerCase(), poolId);
    };
    for (const target of targets) {
      graduationStatus.set(target.tokenAddress.toLowerCase(), Boolean(target.graduated));
      if (target.graduated && target.poolFee !== undefined && target.tickSpacing !== undefined) addGraduatedPool(target, target.poolFee, target.tickSpacing);
      else if (!target.graduated) officialPools.set(target.tokenAddress.toLowerCase(), target.curveAddress.toLowerCase());
    }
    // A graduation flag without its pool key is insufficient for indexing.
    // Re-read those records so the exact V4 pool ID can be reconstructed.
    const phaseTargets = prioritized.filter((target) => target.poolFee === undefined || target.tickSpacing === undefined
      || (!target.graduated && (target.graduationCheckedAt === undefined || now - target.graduationCheckedAt >= GRADUATION_READ_TTL_MS)));
    const phaseResults: Array<{ status: "success"; result: PonsLaunchState } | { status: "failure" }> = [];
    await mapWithConcurrency(phaseTargets, 6, async (target, index) => {
      try {
        const result = await rpc.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [target.tokenAddress as Address] }) as PonsLaunchState;
        phaseResults[index] = { status: "success", result };
      } catch { phaseResults[index] = { status: "failure" }; }
    });
    phaseResults.forEach((result, index) => {
      const target = phaseTargets[index]; const launch = result.status === "success" ? result.result : undefined;
      if (!launch) return;
      const isGraduated = target.graduated || launch.phase === 2;
      graduationStatus.set(target.tokenAddress.toLowerCase(), isGraduated);
      if (launch) graduationMetadata.set(target.tokenAddress.toLowerCase(), { poolFee: launch.poolFee, tickSpacing: launch.tickSpacing, checkedAt: now });
      if (isGraduated && launch) addGraduatedPool(target, launch.poolFee, launch.tickSpacing);
      else if (!isGraduated) officialPools.set(target.tokenAddress.toLowerCase(), target.curveAddress.toLowerCase());
    });
    const liveVolumes = new Map<string, number>();
    const liveMarketCaps = new Map<string, number>();
    const veryActiveBondingCurves = new Set<string>();
    const poolOwners = new Map([...officialPools.entries()].map(([token, pool]) => [pool.toLowerCase(), token]));
    for (const target of catalogTargets) {
      const normalizedToken = target.tokenAddress.toLowerCase();
      if (target.graduated) {
        if (target.poolFee === undefined || target.tickSpacing === undefined) continue;
        const poolId = ponsV4PoolId(target.tokenAddress as Address, target.pairToken as Address, target.poolFee, target.tickSpacing, hook);
        poolOwners.set(poolId.toLowerCase(), normalizedToken);
      } else {
        poolOwners.set(target.curveAddress.toLowerCase(), normalizedToken);
      }
    }
    const poolIds = [...poolOwners.keys()];
    for (let offset = 0; offset < poolIds.length; offset += 30) {
      const batch = poolIds.slice(offset, offset + 30);
      const response = await geckoSharedFetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/multi/${batch.sort().join(",")}`).catch(() => undefined);
      const payload = response?.ok ? await response.json().catch(() => undefined) as { data?: Array<{ attributes?: { address?: string; volume_usd?: { h24?: string }; transactions?: { h1?: { buys?: number; sells?: number } }; market_cap_usd?: string | null; fdv_usd?: string | null } }> } | undefined : undefined;
      for (const pool of payload?.data || []) {
        const address = pool.attributes?.address?.toLowerCase();
        const token = address ? poolOwners.get(address) : undefined;
        const volume = Number(pool.attributes?.volume_usd?.h24);
        if (token && Number.isFinite(volume) && volume >= 0) liveVolumes.set(token, volume);
        const marketCap = geckoMarketCap(pool.attributes?.market_cap_usd, pool.attributes?.fdv_usd);
        if (token && marketCap !== undefined) liveMarketCaps.set(token, marketCap);
        const h1 = pool.attributes?.transactions?.h1;
        const h1Trades = Number(h1?.buys || 0) + Number(h1?.sells || 0);
        if (token && !graduationStatus.get(token) && h1Trades >= VERY_ACTIVE_H1_TRADES) veryActiveBondingCurves.add(token);
      }
    }
    const curveAddresses = targets.map((target) => target.curveAddress.toLowerCase() as Address);
    const tokenAddresses = targets.map((target) => target.tokenAddress.toLowerCase() as Address);
    const [incrementalCurveLogs, incrementalBurnLogs, incrementalSwapLogs] = scanFrom <= scanTo ? await Promise.all([
      rpc.request({ method: "eth_getLogs", params: [{ fromBlock: `0x${scanFrom.toString(16)}`, toBlock: `0x${scanTo.toString(16)}`, address: curveAddresses, topics: [[curveBuyTopic, curveSellTopic]] }] }) as Promise<RawLog[]>,
      rpc.request({ method: "eth_getLogs", params: [{ fromBlock: `0x${scanFrom.toString(16)}`, toBlock: `0x${scanTo.toString(16)}`, address: tokenAddresses, topics: [transferTopic, null, DEAD_TOPIC] }] }) as Promise<RawLog[]>,
      graduated.size ? rpc.request({ method: "eth_getLogs", params: [{ fromBlock: `0x${scanFrom.toString(16)}`, toBlock: `0x${scanTo.toString(16)}`, address: poolManager, topics: [keccak256(new TextEncoder().encode("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")), [...graduated.keys()] as Hex[]] }] }) as Promise<RawLog[]> : Promise.resolve([]),
    ]) : [[], [], []];
    const uniqueLogs = (items: RawLog[]) => [...new Map(items.map((log) => [`${log.transactionHash}:${log.logIndex}`, log])).values()];
    // Repair a bounded recent interval when a graduated token's persisted
    // last-buy time is stale. This covers a cursor that advanced while its V4
    // events failed to persist, without turning every ten-second refresh into
    // a large historical scan.
    const repairTargetTokens = new Set<string>();
    const staleGraduatedPoolIds = prioritized.flatMap((target) => {
      if (!target.graduated || (target.lastBuyAt !== undefined && now - target.lastBuyAt < 2 * 60_000)) return [];
      if (target.activityBackfilledAt !== undefined && now - target.activityBackfilledAt < 60_000) return [];
      const normalized = target.tokenAddress.toLowerCase();
      repairTargetTokens.add(normalized);
      return [...graduated.entries()].filter(([, value]) => value.tokenAddress.toLowerCase() === normalized).map(([poolId]) => poolId);
    });
    const repairFrom = latest > 10_000n ? latest - 10_000n : 0n;
    const repairSwapLogs = staleGraduatedPoolIds.length ? await rpc.request({ method: "eth_getLogs", params: [{ fromBlock: `0x${repairFrom.toString(16)}`, toBlock: `0x${latest.toString(16)}`, address: poolManager, topics: [keccak256(new TextEncoder().encode("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")), staleGraduatedPoolIds as Hex[]] }] }) as RawLog[] : [];
    const rawLogs = uniqueLogs([...incrementalCurveLogs, ...incrementalBurnLogs]);
    const rawSwapLogs = uniqueLogs([...incrementalSwapLogs, ...repairSwapLogs]);
    // The public table is defined as one day or 100 entries. Limit expensive
    // historical reserve/price reads to those entries before enrichment.
    const newestKeys = new Set([...rawLogs.map((log) => ({ log, target: addressMap.get(log.address.toLowerCase()) })), ...rawSwapLogs.map((log) => ({ log, target: graduated.get(log.topics[1]) }))]
      .filter((item) => Boolean(item.target))
      .sort((a, b) => BigInt(a.log.blockNumber) === BigInt(b.log.blockNumber) ? Number(BigInt(b.log.logIndex) - BigInt(a.log.logIndex)) : BigInt(a.log.blockNumber) > BigInt(b.log.blockNumber) ? -1 : 1)
      .slice(0, 250)
      .map(({ log }) => `${log.transactionHash}:${log.logIndex}`));
    const logs = rawLogs.filter((log) => newestKeys.has(`${log.transactionHash}:${log.logIndex}`));
    const swapLogs = rawSwapLogs.filter((log) => newestKeys.has(`${log.transactionHash}:${log.logIndex}`));
    const blockTimes = new Map<string, Promise<number>>();
    const blockTimestamp = (blockNumber: bigint, key: string) => {
      let pending = blockTimes.get(key);
      if (!pending) { pending = rpc.getBlock({ blockNumber }).then((block) => Number(block.timestamp) * 1_000); blockTimes.set(key, pending); }
      return pending;
    };
    const tokenDecimals = new Map<string, Promise<number>>();
    const decimalsFor = (tokenAddress: string) => {
      const key = tokenAddress.toLowerCase(); let pending = tokenDecimals.get(key);
      if (!pending) { pending = rpc.readContract({ address: tokenAddress as Address, abi: tokenReadAbi, functionName: "decimals" }).then(Number).catch(() => 18); tokenDecimals.set(key, pending); }
      return pending;
    };
    const marketCaps = new Map<string, { value: number; source: MarketCapSource }>();
    const supplies = new Map<string, Promise<bigint>>();
    const tokenSupply = async (tokenAddress: string) => {
      const key = tokenAddress.toLowerCase();
      let pending = supplies.get(key);
      if (!pending) { pending = rpc.readContract({ address: tokenAddress as Address, abi: tokenReadAbi, functionName: "totalSupply" }); supplies.set(key, pending); }
      return pending;
    };
    const eventMarketCaps = new Map<string, Promise<number | undefined>>();
    const eventMarketCap = (tokenAddress: string) => {
      const key = tokenAddress.toLowerCase();
      let pending = eventMarketCaps.get(key);
      if (!pending) {
        const gecko = liveMarketCaps.get(key);
        // Trade enrichment must not trigger another valuation job. It uses the
        // available snapshot; live valuations have their own per-token worker.
        pending = Promise.resolve(gecko ?? targets.find(t => t.tokenAddress.toLowerCase() === key)?.marketCapUsd);
        eventMarketCaps.set(key, pending);
      }
      return pending;
    };
    const events: Array<{ tokenAddress: string; transactionHash: string; logIndex: number; kind: "buy" | "sell" | "burn"; walletAddress: string; tokenAmount: string; marketCapUsd?: number; usdAmount?: number; blockNumber: string; timestamp: number }> = [];
    await mapWithConcurrency(logs, 6, async (log) => {
      const target = addressMap.get(log.address.toLowerCase());
      if (!target) return;
      let kind: "buy" | "sell" | "burn" | undefined; let walletAddress = ""; let amount = 0n;
      try {
        if (log.address.toLowerCase() === target.curveAddress.toLowerCase()) {
          const decoded = decodeEventLog({ abi: curveEvents, data: log.data, topics: log.topics });
          if (decoded.eventName === "CurveBuy") { kind = "buy"; walletAddress = decoded.args.buyer; amount = decoded.args.tokensOut; }
          else { kind = "sell"; walletAddress = decoded.args.seller; amount = decoded.args.tokensIn; }
        } else {
          const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
          if (decoded.args.to.toLowerCase() !== DEAD) return;
          kind = "burn"; walletAddress = decoded.args.from; amount = decoded.args.value;
        }
      } catch { return; }
      const blockNumber = BigInt(log.blockNumber);
      const timestamp = await blockTimestamp(blockNumber, log.blockNumber);
      const decimals = await decimalsFor(target.tokenAddress);
      const marketCapUsd = kind === "burn" ? undefined : await eventMarketCap(target.tokenAddress);
      const tokenAmount = formatUnits(amount, decimals);
      const totalSupply = kind !== "burn" && marketCapUsd !== undefined ? await tokenSupply(target.tokenAddress).catch(() => 0n) : 0n;
      const displaySupply = Number(formatUnits(totalSupply, decimals));
      const usdAmount = kind !== "burn" && marketCapUsd !== undefined && displaySupply > 0 ? Number(tokenAmount) * marketCapUsd / displaySupply : undefined;
      events.push({ tokenAddress: target.tokenAddress, transactionHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)), kind, walletAddress, tokenAmount, marketCapUsd, ...(usdAmount === undefined ? {} : { usdAmount }), blockNumber: blockNumber.toString(), timestamp });
    });
    await mapWithConcurrency(swapLogs, 6, async (log) => {
      try {
        const decoded = decodeEventLog({ abi: [v4SwapEvent], data: log.data, topics: log.topics });
        const target = graduated.get(decoded.args.id); if (!target) return;
        const tokenDelta = target.tokenIsCurrency0 ? decoded.args.amount0 : decoded.args.amount1;
        const kind = v4TokenTradeKind(tokenDelta); if (!kind) return;
        const blockNumber = BigInt(log.blockNumber);
        const timestamp = await blockTimestamp(blockNumber, log.blockNumber);
        const [transaction, receipt, decimals, marketCapUsd] = await Promise.all([
          rpc.getTransaction({ hash: log.transactionHash }),
          rpc.getTransactionReceipt({ hash: log.transactionHash }),
          decimalsFor(target.tokenAddress),
          eventMarketCap(target.tokenAddress),
        ]);
        const tokenAmount = formatUnits(tokenDelta < 0n ? -tokenDelta : tokenDelta, decimals);
        const totalSupply = marketCapUsd === undefined ? 0n : await tokenSupply(target.tokenAddress).catch(() => 0n);
        const displaySupply = Number(formatUnits(totalSupply, decimals));
        const usdAmount = marketCapUsd !== undefined && displaySupply > 0 ? Number(tokenAmount) * marketCapUsd / displaySupply : undefined;
        const infrastructure = new Set([poolManager.toLowerCase(), hook.toLowerCase(), factory.toLowerCase(), target.tokenAddress.toLowerCase(), DEAD]);
        const participants = receipt.logs.flatMap((receiptLog) => {
          if (receiptLog.address.toLowerCase() !== target.tokenAddress.toLowerCase()) return [];
          try {
            const transfer = decodeEventLog({ abi: [transferEvent], data: receiptLog.data, topics: receiptLog.topics });
            return [{ from: transfer.args.from, to: transfer.args.to }];
          } catch { return []; }
        });
        const walletAddress = transferAttributedWallet(kind, participants, infrastructure, transaction.from);
        events.push({ tokenAddress: target.tokenAddress, transactionHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)), kind, walletAddress, tokenAmount, marketCapUsd, ...(usdAmount === undefined ? {} : { usdAmount }), blockNumber: blockNumber.toString(), timestamp });
      } catch { /* Ignore unrelated or malformed PoolManager logs. */ }
    });
    // GeckoTerminal's exact official Pons pool is the primary source. Only use
    // onchain calculation when Gecko has no usable market cap/FDV and the
    // shared Convex value is stale, preventing every viewer/serverless instance
    // from repeating the same contract reads.
    await Promise.all(prioritized.map(async (target) => {
      const normalized = target.tokenAddress.toLowerCase();
      const gecko = liveMarketCaps.get(normalized);
      if (gecko !== undefined) { marketCaps.set(target.tokenAddress, { value: gecko, source: "gecko" }); return; }
      if (launchBrowse && !target.graduated && !veryActiveBondingCurves.has(normalized)
        && target.marketCapUsd !== undefined && target.marketCapUpdatedAt !== undefined
        && now - target.marketCapUpdatedAt < INACTIVE_BONDING_CURVE_MCAP_TTL_MS) return;
      if (freshMarketCap(target.marketCapUsd, target.marketCapUpdatedAt, now)) return;
      // Missing Gecko prices are handled by /market/snapshot's budgeted
      // public-RPC-first worker, never by historical trade indexing.
    }));
    if (refreshCatalog) {
      const snapshots = catalogTargets.flatMap((target) => {
        const normalized = target.tokenAddress.toLowerCase();
        const marketCapUsd = liveMarketCaps.get(normalized);
        const volume24hUsd = liveVolumes.get(normalized);
        return marketCapUsd === undefined && volume24hUsd === undefined ? [] : [{
          tokenAddress: target.tokenAddress,
          ...(marketCapUsd === undefined ? {} : { marketCapUsd }),
          ...(volume24hUsd === undefined ? {} : { volume24hUsd }),
          observedAt: now,
        }];
      });
      if (snapshots.length) {
        const catalogRecorded = leaseValid && await convex.mutation(api.site.recordCatalogMarketSnapshots, { secret, leaseId, snapshots });
        if (!catalogRecorded) throw new Error("market index lease was lost before recording catalog snapshots");
      }
    }
    const recorded = leaseValid && await convex.mutation(api.site.recordMarketIndex, {
      secret,
      leaseId,
      indexedThroughBlock: scanTo.toString(),
      marketCaps: prioritized.map((target) => {
        const normalized = target.tokenAddress.toLowerCase(); const metadata = graduationMetadata.get(normalized);
        const nextCursor = nextTokenCursor(target.indexedThroughBlock, scanTo);
        const completedInitialBackfill = target.activityBackfilledAt === undefined && BigInt(nextCursor) >= latest;
        const currentMarketCap = marketCaps.get(target.tokenAddress);
        return { tokenAddress: target.tokenAddress, indexedThroughBlock: nextCursor, ...(currentMarketCap === undefined ? {} : { marketCapUsd: currentMarketCap.value, marketCapUpdatedAt: now, marketCapSource: currentMarketCap.source }), ...(liveVolumes.get(normalized) === undefined ? {} : { volume24hUsd: liveVolumes.get(normalized) }), graduated: graduationStatus.get(normalized) || false, ...(metadata ? { poolFee: metadata.poolFee, tickSpacing: metadata.tickSpacing, graduationCheckedAt: metadata.checkedAt } : {}), ...((completedInitialBackfill || repairTargetTokens.has(normalized)) ? { activityBackfilledAt: now } : target.activityBackfilledAt !== undefined ? { activityBackfilledAt: target.activityBackfilledAt } : {}) };
      }),
      events,
    });
    if (!recorded) throw new Error("market index lease was lost before recording");
    return NextResponse.json({
      ok: true,
      indexed: true,
      events: events.length,
      market: await convex.query(api.site.getMarketStates, { tokenAddresses: [...viewed] }),
      nextRefreshMs: veryActiveBondingCurves.size > 0 ? ACTIVE_LAUNCH_REFRESH_MS : INACTIVE_LAUNCH_REFRESH_MS,
    });
  } catch (error) {
    console.error("market_view_index_failed", error instanceof Error ? error.message : "unknown");
    await convex.mutation(api.site.releaseMarketIndexLease, { secret, leaseId }).catch(() => undefined);
    return NextResponse.json({ ok: false }, { status: 502 });
  } finally {
    clearInterval(heartbeat);
  }
}
