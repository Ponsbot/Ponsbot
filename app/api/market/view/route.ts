import { NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { createPublicClient, decodeEventLog, encodeAbiParameters, formatUnits, http, keccak256, parseAbi, type Address, type Hex } from "viem";
import { api } from "@/convex/_generated/api";
import { tokenMarketCapUsd } from "@/lib/token-market-cap";
import { boundedJson, RequestBodyError } from "@/lib/bounded-json";
import { mapWithConcurrency, nextTokenCursor, perTokenScanRange, transferAttributedWallet } from "@/lib/bounded-concurrency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const curveEvents = parseAbi([
  "event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 creatorTax)",
  "event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 creatorTax)",
]);
const transferEvent = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"])[0];
const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function memeHook() view returns(address)", "function poolManager() view returns(address)",
]);
const v4SwapEvent = parseAbi(["event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)"])[0];
const DEAD = "0x000000000000000000000000000000000000dead";
const tokenReadAbi = parseAbi(["function decimals() view returns(uint8)", "function totalSupply() view returns(uint256)"]);

type RawLog = { address: Address; blockNumber: Hex; transactionHash: Hex; logIndex: Hex; topics: [Hex, ...Hex[]]; data: Hex };

async function blockAtOrAfter(rpc: ReturnType<typeof createPublicClient>, latest: bigint, unixSeconds: bigint) {
  let low = 0n; let high = latest;
  while (low < high) {
    const middle = (low + high) / 2n;
    const block = await rpc.getBlock({ blockNumber: middle });
    if (block.timestamp < unixSeconds) low = middle + 1n; else high = middle;
  }
  return low;
}

export async function POST(request: Request) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.MARKET_INDEX_SECRET;
  if (!convexUrl || !secret) return NextResponse.json({ ok: false }, { status: 503 });
  const convex = new ConvexHttpClient(convexUrl);
  let requested: { tokenAddresses?: unknown };
  try { requested = await boundedJson(request, 8_192); }
  catch (error) { return NextResponse.json({ ok: false, error: error instanceof RequestBodyError ? error.message : "invalid request" }, { status: error instanceof RequestBodyError ? error.status : 400 }); }
  if (requested.tokenAddresses !== undefined && !Array.isArray(requested.tokenAddresses)) return NextResponse.json({ ok: false, error: "tokenAddresses must be an array" }, { status: 400 });
  const addresses = (requested.tokenAddresses || []) as unknown[];
  if (addresses.length > 50) return NextResponse.json({ ok: false, error: "too many token addresses" }, { status: 400 });
  const viewed = new Set(addresses.filter((address): address is string => typeof address === "string" && /^0x[a-fA-F0-9]{40}$/.test(address)).map((address) => address.toLowerCase()));
  const now = Date.now();
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  const viewerKey = createHash("sha256").update(`${forwarded}:${process.env.WEB_AUTH_SECRET || secret}`).digest("hex");
  const leaseId = randomUUID();
  const lease = await convex.mutation(api.site.acquireMarketIndexLease, { now, secret, viewerKey, leaseId });
  if (lease.rateLimited) return NextResponse.json({ ok: false, error: "market refresh rate limited" }, { status: 429, headers: { "retry-after": "60" } });
  if (!lease.acquired) return NextResponse.json({ ok: true, indexed: false, market: await convex.query(api.site.getMarketStates, { tokenAddresses: [...viewed] }) });
  let leaseValid = true;
  const heartbeat = setInterval(() => {
    void convex.mutation(api.site.renewMarketIndexLease, { now: Date.now(), secret, leaseId }).then((renewed) => { leaseValid = renewed; }).catch(() => { leaseValid = false; });
  }, 30_000);
  try {
    const rpc = createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 8_000 }) });
    const [targets, latest, runtimeConfig] = await Promise.all([
      convex.query(api.site.marketIndexTargets, { tokenAddresses: [...viewed] }),
      rpc.getBlockNumber(),
      convex.query(api.site.marketRuntimeConfig, {}),
    ]);
    if (!runtimeConfig.factory || !/^0x[a-fA-F0-9]{40}$/.test(runtimeConfig.factory)
      || !runtimeConfig.stateView || !/^0x[a-fA-F0-9]{40}$/.test(runtimeConfig.stateView)) throw new Error("Pons market infrastructure is not configured");
    const factory = runtimeConfig.factory as Address;
    const marketInfrastructure = { factory, stateView: runtimeConfig.stateView as Address };
    if (!targets.length) {
      const recorded = leaseValid && await convex.mutation(api.site.recordMarketIndex, { secret, leaseId, indexedThroughBlock: latest.toString(), marketCaps: [], events: [] });
      if (!recorded) throw new Error("market index lease was lost before recording");
      return NextResponse.json({ ok: true, indexed: true });
    }
    const needsInitialCursor = targets.some((target) => !target.indexedThroughBlock);
    const initialBlock = needsInitialCursor ? await blockAtOrAfter(rpc, latest, BigInt(Math.floor((now - 24 * 60 * 60_000) / 1_000))) : latest;
    const { from: scanFrom, to: scanTo } = perTokenScanRange(targets.map((target) => target.indexedThroughBlock), initialBlock, latest);
    const prioritized = targets.filter((target) => viewed.has(target.tokenAddress.toLowerCase()));
    const addressMap = new Map<string, { tokenAddress: string; curveAddress: string }>();
    for (const target of targets) {
      addressMap.set(target.curveAddress.toLowerCase(), target);
      addressMap.set(target.tokenAddress.toLowerCase(), target);
    }
    const [hook, poolManager] = await Promise.all([
      rpc.readContract({ address: factory, abi: factoryAbi, functionName: "memeHook" }),
      rpc.readContract({ address: factory, abi: factoryAbi, functionName: "poolManager" }),
    ]);
    const graduated = new Map<string, { tokenAddress: string; tokenIsCurrency0: boolean }>();
    const graduationStatus = new Map<string, boolean>();
    const graduationMetadata = new Map<string, { poolFee: number; tickSpacing: number; checkedAt: number }>();
    const addGraduatedPool = (target: typeof targets[number], poolFee: number, tickSpacing: number) => {
      const token = target.tokenAddress.toLowerCase() as Address; const pair = target.pairToken.toLowerCase() as Address;
      const [currency0, currency1] = pair < token ? [pair, token] : [token, pair];
      const poolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [currency0, currency1, poolFee, tickSpacing, hook]));
      graduated.set(poolId, { tokenAddress: target.tokenAddress, tokenIsCurrency0: token === currency0 });
    };
    for (const target of targets) {
      graduationStatus.set(target.tokenAddress.toLowerCase(), Boolean(target.graduated));
      if (target.graduated && target.poolFee !== undefined && target.tickSpacing !== undefined) addGraduatedPool(target, target.poolFee, target.tickSpacing);
    }
    const phaseTargets = prioritized.filter((target) => !target.graduated);
    const phaseResults = phaseTargets.length ? await rpc.multicall({ contracts: phaseTargets.map((target) => ({ address: factory, abi: factoryAbi, functionName: "getLaunchedToken" as const, args: [target.tokenAddress as Address] as const })), allowFailure: true }) : [];
    phaseResults.forEach((result, index) => {
      const target = phaseTargets[index]; const launch = result.status === "success" ? result.result : undefined;
      const isGraduated = launch?.phase === 2;
      graduationStatus.set(target.tokenAddress.toLowerCase(), isGraduated);
      if (launch) graduationMetadata.set(target.tokenAddress.toLowerCase(), { poolFee: launch.poolFee, tickSpacing: launch.tickSpacing, checkedAt: now });
      if (isGraduated && launch) addGraduatedPool(target, launch.poolFee, launch.tickSpacing);
    });
    const [incrementalDirectLogs, incrementalSwapLogs] = scanFrom <= scanTo ? await Promise.all([
      rpc.request({ method: "eth_getLogs", params: [{ fromBlock: `0x${scanFrom.toString(16)}`, toBlock: `0x${scanTo.toString(16)}`, address: [...addressMap.keys()] as Address[] }] }) as Promise<RawLog[]>,
      graduated.size ? rpc.request({ method: "eth_getLogs", params: [{ fromBlock: `0x${scanFrom.toString(16)}`, toBlock: `0x${scanTo.toString(16)}`, address: poolManager, topics: [keccak256(new TextEncoder().encode("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")), [...graduated.keys()] as Hex[]] }] }) as Promise<RawLog[]> : Promise.resolve([]),
    ]) : [[], []];
    const uniqueLogs = (items: RawLog[]) => [...new Map(items.map((log) => [`${log.transactionHash}:${log.logIndex}`, log])).values()];
    const logs = uniqueLogs(incrementalDirectLogs);
    const swapLogs = uniqueLogs(incrementalSwapLogs);
    const transferParticipants = new Map<string, Array<{ from: string; to: string }>>();
    for (const log of logs) {
      const target = addressMap.get(log.address.toLowerCase());
      if (!target || log.address.toLowerCase() !== target.tokenAddress.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
        const key = `${log.transactionHash}:${target.tokenAddress.toLowerCase()}`;
        transferParticipants.set(key, [...(transferParticipants.get(key) || []), { from: decoded.args.from, to: decoded.args.to }]);
      } catch { /* Not a token transfer. */ }
    }
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
    const marketCaps = new Map<string, number | undefined>();
    const supplies = new Map<string, Promise<bigint>>();
    const tokenSupply = async (tokenAddress: string, blockNumber: bigint) => {
      const key = `${tokenAddress.toLowerCase()}:${blockNumber}`;
      let pending = supplies.get(key);
      if (!pending) { pending = rpc.readContract({ address: tokenAddress as Address, abi: tokenReadAbi, functionName: "totalSupply", blockNumber }); supplies.set(key, pending); }
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
      const marketCapUsd = kind === "burn" ? undefined : await tokenMarketCapUsd(target.tokenAddress as Address, blockNumber, undefined, marketInfrastructure).catch(() => undefined);
      const tokenAmount = formatUnits(amount, decimals);
      const totalSupply = kind !== "burn" && marketCapUsd !== undefined ? await tokenSupply(target.tokenAddress, blockNumber).catch(() => 0n) : 0n;
      const displaySupply = Number(formatUnits(totalSupply, decimals));
      const usdAmount = kind !== "burn" && marketCapUsd !== undefined && displaySupply > 0 ? Number(tokenAmount) * marketCapUsd / displaySupply : undefined;
      events.push({ tokenAddress: target.tokenAddress, transactionHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)), kind, walletAddress, tokenAmount, marketCapUsd, ...(usdAmount === undefined ? {} : { usdAmount }), blockNumber: blockNumber.toString(), timestamp });
    });
    await mapWithConcurrency(swapLogs, 6, async (log) => {
      try {
        const decoded = decodeEventLog({ abi: [v4SwapEvent], data: log.data, topics: log.topics });
        const target = graduated.get(decoded.args.id); if (!target) return;
        const tokenDelta = target.tokenIsCurrency0 ? decoded.args.amount0 : decoded.args.amount1;
        const kind: "buy" | "sell" = tokenDelta < 0n ? "buy" : "sell";
        const blockNumber = BigInt(log.blockNumber);
        const timestamp = await blockTimestamp(blockNumber, log.blockNumber);
        const [transaction, decimals, marketCapUsd] = await Promise.all([
          rpc.getTransaction({ hash: log.transactionHash }),
          decimalsFor(target.tokenAddress),
          tokenMarketCapUsd(target.tokenAddress as Address, blockNumber, undefined, marketInfrastructure).catch(() => undefined),
        ]);
        const tokenAmount = formatUnits(tokenDelta < 0n ? -tokenDelta : tokenDelta, decimals);
        const totalSupply = marketCapUsd === undefined ? 0n : await tokenSupply(target.tokenAddress, blockNumber).catch(() => 0n);
        const displaySupply = Number(formatUnits(totalSupply, decimals));
        const usdAmount = marketCapUsd !== undefined && displaySupply > 0 ? Number(tokenAmount) * marketCapUsd / displaySupply : undefined;
        const infrastructure = new Set([poolManager.toLowerCase(), hook.toLowerCase(), factory.toLowerCase(), target.tokenAddress.toLowerCase(), DEAD]);
        const participants = transferParticipants.get(`${log.transactionHash}:${target.tokenAddress.toLowerCase()}`) || [];
        const walletAddress = transferAttributedWallet(kind, participants, infrastructure, transaction.from);
        events.push({ tokenAddress: target.tokenAddress, transactionHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)), kind, walletAddress, tokenAmount, marketCapUsd, ...(usdAmount === undefined ? {} : { usdAmount }), blockNumber: blockNumber.toString(), timestamp });
      } catch { /* Ignore unrelated or malformed PoolManager logs. */ }
    });
    // Only actively viewed tokens receive current market-cap refreshes.
    await Promise.all(prioritized.map(async (target) => marketCaps.set(target.tokenAddress, await tokenMarketCapUsd(target.tokenAddress as Address, undefined, undefined, marketInfrastructure).catch(() => undefined))));
    const recorded = leaseValid && await convex.mutation(api.site.recordMarketIndex, {
      secret,
      leaseId,
      indexedThroughBlock: scanTo.toString(),
      marketCaps: prioritized.map((target) => {
        const normalized = target.tokenAddress.toLowerCase(); const metadata = graduationMetadata.get(normalized);
        const nextCursor = nextTokenCursor(target.indexedThroughBlock, scanTo);
        return { tokenAddress: target.tokenAddress, indexedThroughBlock: nextCursor, ...(marketCaps.get(target.tokenAddress) === undefined ? {} : { marketCapUsd: marketCaps.get(target.tokenAddress) }), graduated: graduationStatus.get(normalized) || false, ...(metadata ? { poolFee: metadata.poolFee, tickSpacing: metadata.tickSpacing, graduationCheckedAt: metadata.checkedAt } : {}), ...(BigInt(nextCursor) >= latest ? { activityBackfilledAt: now } : {}) };
      }),
      events,
    });
    if (!recorded) throw new Error("market index lease was lost before recording");
    return NextResponse.json({ ok: true, indexed: true, events: events.length, market: await convex.query(api.site.getMarketStates, { tokenAddresses: [...viewed] }) });
  } catch (error) {
    console.error("market_view_index_failed", error instanceof Error ? error.message : "unknown");
    await convex.mutation(api.site.releaseMarketIndexLease, { secret, leaseId }).catch(() => undefined);
    return NextResponse.json({ ok: false }, { status: 502 });
  } finally {
    clearInterval(heartbeat);
  }
}
