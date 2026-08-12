import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { createPublicClient, decodeEventLog, encodeAbiParameters, formatUnits, http, keccak256, parseAbi, type Address, type Hex } from "viem";
import { api } from "@/convex/_generated/api";
import { tokenMarketCapUsd } from "@/lib/token-market-cap";

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
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address;
const DEAD = "0x000000000000000000000000000000000000dead";

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
  const requested = await request.json().catch(() => ({ tokenAddresses: [] })) as { tokenAddresses?: string[] };
  const viewed = new Set((requested.tokenAddresses || []).filter((address) => /^0x[a-fA-F0-9]{40}$/.test(address)).map((address) => address.toLowerCase()));
  const now = Date.now();
  const lease = await convex.mutation(api.site.acquireMarketIndexLease, { now, secret });
  if (!lease.acquired) return NextResponse.json({ ok: true, indexed: false, market: await convex.query(api.site.getMarketStates, { tokenAddresses: [...viewed] }) });
  try {
    const rpc = createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 8_000 }) });
    const [targets, latest] = await Promise.all([convex.query(api.site.marketIndexTargets, {}), rpc.getBlockNumber()]);
    if (!targets.length) {
      await convex.mutation(api.site.recordMarketIndex, { secret, indexedThroughBlock: latest.toString(), marketCaps: [], events: [] });
      return NextResponse.json({ ok: true, indexed: true });
    }
    const from = lease.indexedThroughBlock ? BigInt(lease.indexedThroughBlock) + 1n : latest;
    const cappedFrom = latest > from && latest - from > 5_000n ? latest - 5_000n : from;
    const scanFrom = cappedFrom;
    const prioritized = targets.filter((target) => viewed.has(target.tokenAddress.toLowerCase()));
    const addressMap = new Map<string, { tokenAddress: string; curveAddress: string }>();
    for (const target of targets) {
      addressMap.set(target.curveAddress.toLowerCase(), target);
      addressMap.set(target.tokenAddress.toLowerCase(), target);
    }
    const [hook, poolManager] = await Promise.all([
      rpc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "memeHook" }),
      rpc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "poolManager" }),
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
    const phaseResults = phaseTargets.length ? await rpc.multicall({ contracts: phaseTargets.map((target) => ({ address: FACTORY, abi: factoryAbi, functionName: "getLaunchedToken" as const, args: [target.tokenAddress as Address] as const })), allowFailure: true }) : [];
    phaseResults.forEach((result, index) => {
      const target = phaseTargets[index]; const launch = result.status === "success" ? result.result : undefined;
      const isGraduated = launch?.phase === 2;
      graduationStatus.set(target.tokenAddress.toLowerCase(), isGraduated);
      if (launch) graduationMetadata.set(target.tokenAddress.toLowerCase(), { poolFee: launch.poolFee, tickSpacing: launch.tickSpacing, checkedAt: now });
      if (isGraduated && launch) addGraduatedPool(target, launch.poolFee, launch.tickSpacing);
    });
    const [incrementalDirectLogs, incrementalSwapLogs] = scanFrom <= latest ? await Promise.all([
      rpc.request({ method: "eth_getLogs", params: [{ fromBlock: `0x${scanFrom.toString(16)}`, toBlock: `0x${latest.toString(16)}`, address: [...addressMap.keys()] as Address[] }] }) as Promise<RawLog[]>,
      graduated.size ? rpc.request({ method: "eth_getLogs", params: [{ fromBlock: `0x${scanFrom.toString(16)}`, toBlock: `0x${latest.toString(16)}`, address: poolManager, topics: [keccak256(new TextEncoder().encode("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")), [...graduated.keys()] as Hex[]] }] }) as Promise<RawLog[]> : Promise.resolve([]),
    ]) : [[], []];
    // Backfill at most one actively viewed token per run. This never expands
    // the global incremental range and keeps an expensive first view bounded.
    const backfillTarget = prioritized.find((target) => !target.activityBackfilledAt);
    let backfilledToken: string | undefined;
    let backfillDirectLogs: RawLog[] = []; let backfillSwapLogs: RawLog[] = [];
    if (backfillTarget) {
      const dayBlock = await blockAtOrAfter(rpc, latest, BigInt(Math.floor((now - 24 * 60 * 60_000) / 1_000)));
      backfillDirectLogs = await rpc.request({ method: "eth_getLogs", params: [{ fromBlock: `0x${dayBlock.toString(16)}`, toBlock: `0x${latest.toString(16)}`, address: [backfillTarget.curveAddress, backfillTarget.tokenAddress] as Address[] }] }) as RawLog[];
      const poolEntry = [...graduated].find(([, item]) => item.tokenAddress.toLowerCase() === backfillTarget.tokenAddress.toLowerCase());
      if (poolEntry) backfillSwapLogs = await rpc.request({ method: "eth_getLogs", params: [{ fromBlock: `0x${dayBlock.toString(16)}`, toBlock: `0x${latest.toString(16)}`, address: poolManager, topics: [keccak256(new TextEncoder().encode("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")), [poolEntry[0]] as Hex[]] }] }) as RawLog[];
      backfilledToken = backfillTarget.tokenAddress;
    }
    const uniqueLogs = (items: RawLog[]) => [...new Map(items.map((log) => [`${log.transactionHash}:${log.logIndex}`, log])).values()];
    const logs = uniqueLogs([...incrementalDirectLogs, ...backfillDirectLogs]);
    const swapLogs = uniqueLogs([...incrementalSwapLogs, ...backfillSwapLogs]);
    const blockTimes = new Map<string, number>();
    const marketCaps = new Map<string, number | undefined>();
    const events: Array<{ tokenAddress: string; transactionHash: string; logIndex: number; kind: "buy" | "sell" | "burn"; walletAddress: string; tokenAmount: string; marketCapUsd?: number; usdAmount?: number; blockNumber: string; timestamp: number }> = [];
    for (const log of logs) {
      const target = addressMap.get(log.address.toLowerCase());
      if (!target) continue;
      let kind: "buy" | "sell" | "burn" | undefined; let walletAddress = ""; let amount = 0n;
      try {
        if (log.address.toLowerCase() === target.curveAddress.toLowerCase()) {
          const decoded = decodeEventLog({ abi: curveEvents, data: log.data, topics: log.topics });
          if (decoded.eventName === "CurveBuy") { kind = "buy"; walletAddress = decoded.args.buyer; amount = decoded.args.tokensOut; }
          else { kind = "sell"; walletAddress = decoded.args.seller; amount = decoded.args.tokensIn; }
        } else {
          const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
          if (decoded.args.to.toLowerCase() !== DEAD) continue;
          kind = "burn"; walletAddress = decoded.args.from; amount = decoded.args.value;
        }
      } catch { continue; }
      const blockNumber = BigInt(log.blockNumber);
      let timestamp = blockTimes.get(log.blockNumber);
      if (timestamp === undefined) {
        timestamp = Number((await rpc.getBlock({ blockNumber })).timestamp) * 1_000;
        blockTimes.set(log.blockNumber, timestamp);
      }
      const decimals = await rpc.readContract({ address: target.tokenAddress as Address, abi: parseAbi(["function decimals() view returns(uint8)"]), functionName: "decimals", blockNumber }).catch(() => 18);
      const marketCapUsd = kind === "burn" ? undefined : await tokenMarketCapUsd(target.tokenAddress as Address, blockNumber).catch(() => undefined);
      const tokenAmount = formatUnits(amount, decimals);
      const usdAmount = kind !== "burn" && marketCapUsd !== undefined ? Number(tokenAmount) * marketCapUsd / 1_000_000_000 : undefined;
      events.push({ tokenAddress: target.tokenAddress, transactionHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)), kind, walletAddress, tokenAmount, marketCapUsd, ...(usdAmount === undefined ? {} : { usdAmount }), blockNumber: blockNumber.toString(), timestamp });
    }
    for (const log of swapLogs) {
      try {
        const decoded = decodeEventLog({ abi: [v4SwapEvent], data: log.data, topics: log.topics });
        const target = graduated.get(decoded.args.id); if (!target) continue;
        const tokenDelta = target.tokenIsCurrency0 ? decoded.args.amount0 : decoded.args.amount1;
        const kind: "buy" | "sell" = tokenDelta < 0n ? "buy" : "sell";
        const blockNumber = BigInt(log.blockNumber);
        let timestamp = blockTimes.get(log.blockNumber);
        if (timestamp === undefined) { timestamp = Number((await rpc.getBlock({ blockNumber })).timestamp) * 1_000; blockTimes.set(log.blockNumber, timestamp); }
        const [transaction, decimals, marketCapUsd] = await Promise.all([
          rpc.getTransaction({ hash: log.transactionHash }),
          rpc.readContract({ address: target.tokenAddress as Address, abi: parseAbi(["function decimals() view returns(uint8)"]), functionName: "decimals", blockNumber }).catch(() => 18),
          tokenMarketCapUsd(target.tokenAddress as Address, blockNumber).catch(() => undefined),
        ]);
        const tokenAmount = formatUnits(tokenDelta < 0n ? -tokenDelta : tokenDelta, decimals);
        const usdAmount = marketCapUsd === undefined ? undefined : Number(tokenAmount) * marketCapUsd / 1_000_000_000;
        events.push({ tokenAddress: target.tokenAddress, transactionHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)), kind, walletAddress: transaction.from, tokenAmount, marketCapUsd, ...(usdAmount === undefined ? {} : { usdAmount }), blockNumber: blockNumber.toString(), timestamp });
      } catch { /* Ignore unrelated or malformed PoolManager logs. */ }
    }
    // Only actively viewed tokens receive current market-cap refreshes.
    await Promise.all(prioritized.map(async (target) => marketCaps.set(target.tokenAddress, await tokenMarketCapUsd(target.tokenAddress as Address).catch(() => undefined))));
    await convex.mutation(api.site.recordMarketIndex, {
      secret,
      indexedThroughBlock: latest.toString(),
      marketCaps: prioritized.map((target) => {
        const normalized = target.tokenAddress.toLowerCase(); const metadata = graduationMetadata.get(normalized);
        return { tokenAddress: target.tokenAddress, ...(marketCaps.get(target.tokenAddress) === undefined ? {} : { marketCapUsd: marketCaps.get(target.tokenAddress) }), graduated: graduationStatus.get(normalized) || false, ...(metadata ? { poolFee: metadata.poolFee, tickSpacing: metadata.tickSpacing, graduationCheckedAt: metadata.checkedAt } : {}), ...(backfilledToken?.toLowerCase() === normalized ? { activityBackfilledAt: now } : {}) };
      }),
      events,
    });
    return NextResponse.json({ ok: true, indexed: true, events: events.length, market: await convex.query(api.site.getMarketStates, { tokenAddresses: [...viewed] }) });
  } catch (error) {
    console.error("market_view_index_failed", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ ok: false }, { status: 502 });
  }
}
