import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { createPublicClient, http, parseAbi, parseAbiItem, formatUnits, isAddress, zeroAddress, type Address, type Hash } from "viem";
import { api } from "../convex/_generated/api";
import { geckoSharedFetch } from "./gecko-shared";
import { mapWithConcurrency } from "./bounded-concurrency";
import { holderTag } from "./holder-tags";
import { ponsV4PoolId } from "./lifetime-volume";
import { v4TokenTradeKind } from "./market-index-policy";
import { activityHeadFresh, HOLDER_BASELINE_MS, mergePageTrades, positiveNumber, recentFromBlock, transferDeltas,
  type PageTrade, type PageHolder, type ActivityKind, type ActivityPayload } from "./token-activity-policy";

const TOKEN = parseAbi(["function decimals() view returns(uint8)", "function totalSupply() view returns(uint256)", "function balanceOf(address) view returns(uint256)"]);
const FACTORY = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function memeHook() view returns(address)", "function poolManager() view returns(address)",
]);
const V3 = parseAbi(["function token0() view returns(address)", "function token1() view returns(address)"]);
const BUY = parseAbiItem("event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 creatorTax)");
const SELL = parseAbiItem("event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 creatorTax)");
const SWAP4 = parseAbiItem("event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)");
const SWAP3 = parseAbiItem("event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)");
const TRANSFER = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const GECKO = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const POOL = /^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
type Launch = NonNullable<FunctionReturnType<typeof api.site.getLaunch>>;
type State = { baselineAttemptAt?: number; baselineAt?: number; candidates?: string[]; names?: Record<string, string>; throughBlock?: string; historySpan?: number };
type Previous = { json?: string; stateJson?: string; observedAt?: number };
type Metadata = { decimals: number; supply: string };
type GeckoTrade = { id?: string; attributes?: Record<string, unknown> };

function parse<T>(json: string | undefined, fallback: T): T { try { return json ? JSON.parse(json) as T : fallback; } catch { return fallback; } }
function wallet(value: unknown): value is Address { return typeof value === "string" && isAddress(value, { strict: false }); }
function jsonSafe<T>(value: T): T { return JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v)); }

export function normalizeGeckoTrades(items: GeckoTrade[], token: string, supply?: number): PageTrade[] {
  return items.flatMap((item, i) => {
    const a = item.attributes;
    if (!a || typeof a.tx_hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(a.tx_hash) || !wallet(a.tx_from_address)) return [];
    const output = String(a.to_token_address).toLowerCase() === token.toLowerCase();
    const input = String(a.from_token_address).toLowerCase() === token.toLowerCase();
    if (output === input) return [];
    const amount = output ? a.to_token_amount : a.from_token_amount;
    if (typeof amount !== "string" || positiveNumber(amount) === undefined) return [];
    const price = positiveNumber(output ? a.price_to_in_usd : a.price_from_in_usd);
    const timestamp = Date.parse(String(a.block_timestamp));
    if (!Number.isFinite(timestamp)) return [];
    const cap = price && supply ? price * supply : undefined;
    return [{ id: item.id || `${a.tx_hash}:${i}`, transactionHash: a.tx_hash,
      kind: output ? "buy" as const : "sell" as const, walletAddress: a.tx_from_address,
      tokenAmount: amount, timestamp, source: "gecko" as const,
      usdAmount: positiveNumber(a.volume_in_usd), marketCapUsd: cap && Number.isFinite(cap) ? cap : undefined }];
  });
}

/** Public-RPC only. Display failure never falls through to a paid historical worker. */
export async function refreshTokenActivity(client: ConvexHttpClient, secret: string, token: Address, kind: ActivityKind, leaseId: string, previous: Previous) {
  const signal = AbortSignal.timeout(40_000);
  const rpc = createPublicClient({ transport: http(process.env.WEBSITE_PUBLIC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", {
    timeout: 4_000, retryCount: 0, batch: { wait: 10, batchSize: 30 }, fetchOptions: { signal },
  }) });
  const old = parse<ActivityPayload>(previous.json, {});
  const state = parse<State>(previous.stateJson, {});
  const pending = new Map<string, Promise<unknown>>();
  async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const full = `metadata:activity:${key}`;
    const exists = pending.get(full); if (exists) return exists as Promise<T>;
    const task = (async () => {
      signal.throwIfAborted();
      const entry = await client.query(api.marketData.readCache, { secret, key: full }).catch(() => null);
      if (entry) return JSON.parse(entry.json) as T;
      const value = jsonSafe(await load());
      await client.mutation(api.marketData.writeCache, { secret, key: full, json: JSON.stringify(value), observedAt: Date.now(), ttlMs }).catch(() => undefined);
      return value;
    })(); pending.set(full, task); return task;
  }
  // One shared head sample per 30 seconds across viewed tokens and both tables.
  const head = () => cached("head", 30_000, async () => {
    const [chain, block] = await Promise.all([rpc.getChainId(), rpc.getBlock({ blockTag: "latest" })]);
    if (chain !== 4663 || block.number === null || !activityHeadFresh(block.timestamp)) throw new Error("public_rpc_unhealthy");
    const number = block.number > 20n ? block.number - 20n : block.number;
    const stable = await rpc.getBlock({ blockNumber: number });
    const sampleNumber = number > 1000n ? number - 1000n : 0n;
    const sample = await rpc.getBlock({ blockNumber: sampleNumber });
    return { number: number.toString(), timestamp: stable.timestamp.toString(), hash: stable.hash!,
      from: recentFromBlock(number, stable.timestamp, sampleNumber, sample.timestamp).toString() };
  });
  const metadata = () => cached<Metadata>(`${token}:metadata`, 3_600_000, async () => {
    await head();
    const [decimals, supply] = await Promise.all([
      rpc.readContract({ address: token, abi: TOKEN, functionName: "decimals" }),
      rpc.readContract({ address: token, abi: TOKEN, functionName: "totalSupply" }),
    ]);
    return { decimals, supply: supply.toString() };
  });
  const launch = await client.query(api.site.getLaunch, { tokenAddress: token }) as Launch | null;
  if (!launch) throw new Error("launch_unavailable");

  async function pools() {
    const response = await geckoSharedFetch(`${GECKO}/tokens/${token}/pools`, 300_000, 4_000, true);
    const payload = response.ok ? await response.json() : null;
    return (Array.isArray(payload?.data) ? payload.data : []).map((p: { attributes?: { address?: string } }) => p.attributes?.address?.toLowerCase())
      .filter((p: unknown): p is string => typeof p === "string" && POOL.test(p)).slice(0, 2) as string[];
  }

  if (kind === "trades") {
    const [metadataResult, poolResult, indexResult] = await Promise.allSettled([
      metadata(), pools(), client.query(api.site.tokenActivity, { tokenAddress: token, limit: 100 }),
    ]);
    const meta = metadataResult.status === "fulfilled" ? metadataResult.value : undefined;
    const selected = poolResult.status === "fulfilled" ? poolResult.value : [];
    if (!selected.length && launch.poolAddress && POOL.test(launch.poolAddress)) selected.push(launch.poolAddress.toLowerCase());
    const supply = meta ? positiveNumber(formatUnits(BigInt(meta.supply), meta.decimals)) : undefined;
    let geckoGood = false;
    const geckoRows: PageTrade[] = [];
    await mapWithConcurrency(selected, 2, async pool => {
      try {
        const response = await geckoSharedFetch(`${GECKO}/pools/${pool}/trades`, 60_000, 4_000, true);
        const payload = response.ok ? await response.json() : null;
        if (!Array.isArray(payload?.data)) return;
        if (response.headers.get("x-market-stale") !== "1") geckoGood = true;
        geckoRows.push(...normalizeGeckoTrades(payload.data, token, supply).map(row => ({ ...row, pool })));
      } catch { /* Other venues and the public recent tail remain independent. */ }
    });
    const indexed: PageTrade[] = indexResult.status === "fulfilled" ? indexResult.value.filter(r => r.kind !== "burn").map(r => ({
      id: `${r.transactionHash}:${r.logIndex}`, transactionHash: r.transactionHash, logIndex: r.logIndex,
      kind: r.kind as "buy" | "sell", walletAddress: r.walletAddress, tokenAmount: r.tokenAmount, timestamp: r.timestamp,
      // The older index sometimes uses current valuation for historical trades. Do not present it as trade-time USD.
      source: "index" as const,
    })) : [];
    const chainRows: PageTrade[] = []; let rpcGood = false; let partial = false; let replaceSince: number | undefined;
    if (meta) try {
      const h = await head(); const toBlock = BigInt(h.number);
      let fromBlock = BigInt(h.from);
      if (state.throughBlock && BigInt(state.throughBlock) < toBlock) {
        const overlap = BigInt(state.throughBlock) > 64n ? BigInt(state.throughBlock) - 64n : 0n;
        if (overlap > fromBlock) fromBlock = overlap;
      }
      const config = await client.query(api.site.marketRuntimeConfig, {});
      if (!wallet(config.factory)) throw new Error("factory_unavailable");
      const factory = config.factory.toLowerCase() as Address;
      const phase = await cached(`${factory}:${token}:phase`, 60_000, async () => {
        const p = await rpc.readContract({ address: factory, abi: FACTORY, functionName: "getLaunchedToken", args: [token] });
        if (!p.exists || (p.phase !== 0 && p.phase !== 2)) throw new Error("token_migrating");
        return p;
      });
      type Event = { hash: Hash; index: number; block: bigint; amount: bigint; kind: "buy" | "sell"; actor?: string; pool: string };
      const events: Event[] = [];
      if (phase.phase === 0) {
        const [buys, sells] = await Promise.all([
          rpc.getLogs({ address: phase.curve, event: BUY, fromBlock, toBlock, strict: true }),
          rpc.getLogs({ address: phase.curve, event: SELL, fromBlock, toBlock, strict: true }),
        ]);
        for (const log of buys) events.push({ hash: log.transactionHash, index: log.logIndex, block: log.blockNumber, amount: log.args.tokensOut, kind: "buy", actor: log.args.buyer, pool: phase.curve });
        for (const log of sells) events.push({ hash: log.transactionHash, index: log.logIndex, block: log.blockNumber, amount: log.args.tokensIn, kind: "sell", actor: log.args.seller, pool: phase.curve });
      } else {
        const deps = await cached(`${factory}:pools`, 3_600_000, async () => {
          const [hook, manager] = await Promise.all([rpc.readContract({ address: factory, abi: FACTORY, functionName: "memeHook" }), rpc.readContract({ address: factory, abi: FACTORY, functionName: "poolManager" })]);
          return { hook, manager };
        });
        const id = ponsV4PoolId(token, phase.pairToken, phase.poolFee, phase.tickSpacing, deps.hook);
        const logs = await rpc.getLogs({ address: deps.manager, event: SWAP4, args: { id }, fromBlock, toBlock, strict: true });
        const is0 = BigInt(token) < BigInt(phase.pairToken);
        for (const l of logs) { const amount = is0 ? l.args.amount0 : l.args.amount1;
          const kind = v4TokenTradeKind(amount);
          if (kind) events.push({ hash: l.transactionHash, index: l.logIndex, block: l.blockNumber, amount: amount < 0n ? -amount : amount, kind, pool: id }); }
        // A selected V3 venue is verified against token0/token1 before any log is accepted.
        for (const pool of selected.filter(wallet).slice(0, 1)) try {
          const key = await cached(`${pool}:v3`, 3_600_000, async () => {
            const [token0, token1] = await Promise.all([rpc.readContract({ address: pool, abi: V3, functionName: "token0" }), rpc.readContract({ address: pool, abi: V3, functionName: "token1" })]);
            return { token0, token1 };
          });
          if (![key.token0.toLowerCase(), key.token1.toLowerCase()].includes(token)) continue;
          const logs = await rpc.getLogs({ address: pool, event: SWAP3, fromBlock, toBlock, strict: true });
          for (const l of logs) { const amount = key.token0.toLowerCase() === token ? l.args.amount0 : l.args.amount1;
            if (amount !== 0n) events.push({ hash: l.transactionHash, index: l.logIndex, block: l.blockNumber, amount: amount < 0n ? -amount : amount, kind: amount < 0n ? "buy" : "sell", pool }); }
        } catch { partial = true; }
      }
      events.sort((a, b) => a.block === b.block ? b.index - a.index : a.block > b.block ? -1 : 1);
      const retained = events.slice(0, 100); if (events.length > retained.length) partial = true;
      let newLookups = 0;
      const timestamps = new Map<string, Promise<number>>(); const senders = new Map<string, Promise<Address>>();
      const existing = old.trades ?? [];
      await mapWithConcurrency(retained, 4, async event => {
        const id = `${event.hash}:${event.index}`;
        const row = existing.find(t => t.transactionHash.toLowerCase() === event.hash.toLowerCase() && t.logIndex === event.index);
        if (row) { chainRows.push(row); return; }
        if (++newLookups > 30) { partial = true; return; }
        try {
          const blockKey = event.block.toString();
          if (!timestamps.has(blockKey)) timestamps.set(blockKey, rpc.getBlock({ blockNumber: event.block }).then(b => Number(b.timestamp) * 1000));
          // PoolManager/SwapRouter is not an end user's wallet. Use transaction sender, never Swap.sender.
          if (!event.actor && !senders.has(event.hash)) senders.set(event.hash, rpc.getTransaction({ hash: event.hash }).then(t => t.from));
          const [timestamp, actor] = await Promise.all([timestamps.get(blockKey)!, event.actor ?? senders.get(event.hash)!]);
          chainRows.push({ id, transactionHash: event.hash, logIndex: event.index, pool: event.pool, kind: event.kind,
            walletAddress: actor, tokenAmount: formatUnits(event.amount, meta.decimals), timestamp, source: "rpc" });
        } catch { partial = true; }
      });
      rpcGood = true;
      if (!partial) {
        const block = await rpc.getBlock({ blockNumber: fromBlock });
        replaceSince = Number(block.timestamp) * 1000;
        state.throughBlock = h.number;
      }
    } catch { partial = true; }
    const oldRows = (old.trades ?? []).filter(t => !(t.source === "rpc" && replaceSince !== undefined && t.timestamp >= replaceSince));
    const trades = mergePageTrades([oldRows, indexed, geckoRows, chainRows]);
    return { json: geckoGood || rpcGood || (!previous.json && trades.length) ? JSON.stringify({ trades, partial }) : undefined,
      stateJson: JSON.stringify(state), observedAt: Date.now(), diagnostic: rpcGood ? undefined : "recent_public_rpc_unavailable" };
  }

  // Holders use a retained indexed baseline, plus public-RPC balance reads at ONE block.
  // If the explorer is unavailable, a small durable transfer-history batch runs only while viewed.
  const meta = await metadata(); const h = await head(); const toBlock = BigInt(h.number);
  let baselineGood = false;
  let candidates = new Set((state.candidates ?? []).filter(wallet).map(a => a.toLowerCase()));
  if (!state.baselineAttemptAt || Date.now() - state.baselineAttemptAt >= HOLDER_BASELINE_MS) {
    state.baselineAttemptAt = Date.now();
    try {
      const base = process.env.ROBINHOOD_EXPLORER_API || "https://robinhoodchain.blockscout.com/api/v2";
      const response = await fetch(`${base}/tokens/${token}/holders`, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(4_000)]) });
      const payload = response.ok ? await response.json() : null;
      if (Array.isArray(payload?.items) && payload.items.length) {
        const addresses = payload.items.map((i: { address?: { hash?: string } }) => i.address?.hash).filter(wallet) as string[];
        if (addresses.length) {
          candidates = new Set(addresses.slice(0, 100).map(a => a.toLowerCase())); state.baselineAt = Date.now(); baselineGood = true;
          state.names = {};
          for (const item of payload.items.slice(0, 100)) if (wallet(item?.address?.hash) && typeof item.address.name === "string") {
            state.names[item.address.hash.toLowerCase()] = item.address.name.slice(0, 100);
          }
        }
      }
    } catch { /* A challenge/timeout is not bypassed, and it cannot erase cached holders. */ }
  }
  let history = await client.query(api.marketData.holderHistory, { secret, token });
  let historyComplete = false;
  if (!state.baselineAt || Date.now() - state.baselineAt >= HOLDER_BASELINE_MS || history?.throughBlock) try {
    // Check the saved checkpoint before applying more deltas. An inconsistent history fails closed.
    if (history?.throughBlock) {
      const checkpoint = await rpc.getBlock({ blockNumber: BigInt(history.throughBlock) });
      if (checkpoint.hash?.toLowerCase() !== history.blockHash?.toLowerCase()) throw new Error("holder_history_reorg");
    }
    const start = history?.throughBlock ? BigInt(history.throughBlock) + 1n : BigInt(await cached(`${token}:launch-block`, 3_600_000, async () => {
      const receipt = await rpc.getTransactionReceipt({ hash: launch.transactionHash as Hash });
      if (receipt.status !== "success") throw new Error("launch_receipt_invalid");
      return receipt.blockNumber.toString();
    }));
    if (start <= toBlock) {
      let requestedSpan = Math.min(100_000, Math.max(1, state.historySpan ?? 100_000));
      const span = BigInt(requestedSpan);
      let end = start + span - 1n < toBlock ? start + span - 1n : toBlock;
      const historyDeadline = Date.now() + 6_000;
      for (let attempt = 0; attempt < 8; attempt++) {
        signal.throwIfAborted();
        if (Date.now() >= historyDeadline) break;
        try {
          const logs = await rpc.getLogs({ address: token, event: TRANSFER, fromBlock: start, toBlock: end, strict: true });
          if (logs.length > 600) throw new Error("holder_batch_too_large");
          const block = await rpc.getBlock({ blockNumber: end });
          const committed = await client.mutation(api.marketData.recordHolderHistory, { secret, token, leaseId, previousBlock: history?.throughBlock,
            throughBlock: end.toString(), blockHash: block.hash!, deltas: transferDeltas(logs) });
          if (committed) history = await client.query(api.marketData.holderHistory, { secret, token });
          // Reaching the head with a tiny final range must not shrink all future batches.
          state.historySpan = Math.min(100_000, requestedSpan * (logs.length < 150 ? 2 : 1));
          break;
        } catch (error) {
          if (end === start || attempt === 7) throw error;
          end = start + (end - start) / 2n;
          requestedSpan = Number(end - start + 1n);
          state.historySpan = requestedSpan;
        }
      }
    }
    historyComplete = history?.throughBlock === h.number;
  } catch { /* Keep the previous ranking; incomplete history is never advertised as complete. */ }
  for (const holder of history?.top ?? []) candidates.add(holder.address);
  for (const holder of old.holders ?? []) candidates.add(holder.address.toLowerCase());
  for (const address of [launch.creatorAddress, launch.poolAddress, "0x8366a39cc670b4001a1121b8f6a443a643e40951"]) if (wallet(address)) candidates.add(address.toLowerCase());
  let recentComplete = true;
  const changed = new Set<string>();
  try {
    const logs = await rpc.getLogs({ address: token, event: TRANSFER, fromBlock: BigInt(h.from), toBlock, strict: true });
    if (logs.length > 1000) recentComplete = false;
    for (const log of logs.slice(-1000).reverse()) { changed.add(log.args.from.toLowerCase()); changed.add(log.args.to.toLowerCase()); }
  } catch { recentComplete = false; }
  // Keep the known leaders, but put new entrants ahead of the old candidate buffer.
  candidates = new Set([...(old.holders ?? []).map(r => r.address.toLowerCase()), ...changed, ...candidates]);
  candidates.delete(zeroAddress);
  // History already covers ALL addresses when caught up. Otherwise these are explicitly known-holder results.
  if (historyComplete) candidates = new Set(history!.top.map(r => r.address));
  const selected = [...candidates].slice(0, 200);
  if (candidates.size > selected.length) recentComplete = false;
  const amounts: Array<{ address: string; raw: bigint }> = [];
  let failures = 0;
  await mapWithConcurrency(selected, 8, async address => {
    if (signal.aborted) { failures++; return; }
    try { const raw = await rpc.readContract({ address: token, abi: TOKEN, functionName: "balanceOf", args: [address as Address], blockNumber: toBlock });
      if (raw > 0n) amounts.push({ address, raw });
    } catch { failures++; }
  });
  // Never replace an existing ranking with a subset caused by failed balance calls.
  const holders: PageHolder[] = amounts.sort((a, b) => a.raw === b.raw ? a.address.localeCompare(b.address) : a.raw > b.raw ? -1 : 1).slice(0, 20).map(item => ({
    address: item.address, amount: formatUnits(item.raw, meta.decimals),
    percentage: BigInt(meta.supply) > 0n ? Number(item.raw * 1_000_000n / BigInt(meta.supply)) / 10_000 : undefined,
    tag: holderTag(item.address, launch.creatorAddress?.toLowerCase(), launch.poolAddress?.toLowerCase(), state.names?.[item.address] ?? "", Boolean(launch.graduated)),
  }));
  state.candidates = [...new Set([...holders.map(r => r.address), ...selected])].slice(0, 200);
  const partial = !historyComplete || !recentComplete || failures > 0;
  return { json: failures || !holders.length ? undefined : JSON.stringify({ holders, partial: baselineGood && !failures ? false : partial }),
    stateJson: JSON.stringify(state), observedAt: Date.now(), diagnostic: failures ? "holder_balance_read_failed" : partial ? "holder_history_incomplete" : undefined };
}
