import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { createPublicClient, encodeAbiParameters, http, isAddress, keccak256, parseAbi, parseAbiItem, zeroAddress } from "viem";
import { api } from "../convex/_generated/api.js";

const HOUR_MS = 3_600_000;
const STATE_VERSION = 1;
const NETWORK = "robinhood";
const FACTORY = process.env.PONS_V2_FACTORY_ADDRESS || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const OUTPUT = path.resolve(process.cwd(), ".deployment-private/lifetime-volume-backfill-state.json");
const MAX = Number(process.argv.find(value => value.startsWith("--max="))?.slice(6) || 0);
const IMPORT = process.argv.includes("--import");
const REFRESH_CATALOG = process.argv.includes("--refresh-catalog") || IMPORT;
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const rpcUrl = process.env.WEBSITE_PUBLIC_RPC_URL || process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
if (!convexUrl) throw new Error("NEXT_PUBLIC_CONVEX_URL is required");

const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function memeHook() view returns(address)",
]);
const tokenAbi = parseAbi(["function decimals() view returns(uint8)", "function symbol() view returns(string)"]);
const BUY = parseAbiItem("event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 creatorTax)");
const SELL = parseAbiItem("event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 creatorTax)");
const rpc = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 2, batch: { wait: 20, batchSize: 50 } }) });
const convex = new ConvexHttpClient(convexUrl);

function poolId(token, pair, fee, spacing, hook) {
  const [currency0, currency1] = token.toLowerCase() < pair.toLowerCase() ? [token, pair] : [pair, token];
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [currency0, currency1, fee, spacing, hook],
  ));
}
function emptyState() {
  return { version: STATE_VERSION, cutoffHour: Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS,
    cursor: null, catalogComplete: false, entries: {}, api: { convex: 0, rpc: 0, gecko: 0, price: 0 }, updatedAt: Date.now() };
}
async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(OUTPUT, "utf8"));
    if (parsed.version !== STATE_VERSION) throw new Error("Backfill state version mismatch");
    return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return emptyState();
  }
}
async function saveState(state) {
  state.updatedAt = Date.now();
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  const temporary = `${OUTPUT}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, OUTPUT);
}
async function paidFetch(freeUrl) {
  const key = process.env.COINGECKO_PRO_API_KEY?.trim();
  if (key) {
    const paid = freeUrl.replace("https://api.geckoterminal.com/api/v2/", "https://pro-api.coingecko.com/api/v3/onchain/")
      .replace("https://api.coingecko.com/api/v3/", "https://pro-api.coingecko.com/api/v3/");
    const response = await fetch(paid, { headers: { accept: "application/json", "x-cg-pro-api-key": key, "user-agent": "PonsBot-Lifetime-Backfill/1.0" } });
    if (response.ok || response.status === 429) return response;
  }
  return fetch(freeUrl, { headers: { accept: "application/json", "user-agent": "PonsBot-Lifetime-Backfill/1.0" } });
}
async function geckoHistory(pool, cutoffHour, state) {
  const candles = new Map(); let before = Math.floor((cutoffHour + HOUR_MS) / 1000), requests = 0;
  for (let page = 0; page < 20; page++) {
    const url = `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${pool.toLowerCase()}/ohlcv/hour?aggregate=1&before_timestamp=${before}&limit=1000&currency=usd`;
    const response = await paidFetch(url); requests++; state.api.gecko++;
    if (response.status === 429) throw new Error(`GECKO_RATE_LIMITED:${response.headers.get("retry-after") || "unknown"}`);
    if (!response.ok) return { status: response.status, requests, candles: [], error: `HTTP_${response.status}` };
    const payload = await response.json(); const rows = payload?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(rows)) return { status: response.status, requests, candles: [], error: "INVALID_RESPONSE" };
    for (const row of rows) if (Array.isArray(row) && Number.isFinite(Number(row[0])) && Number.isFinite(Number(row[5]))) {
      const hour = Math.floor(Number(row[0]) * 1000 / HOUR_MS) * HOUR_MS;
      if (hour <= cutoffHour) candles.set(hour, Number(row[5]));
    }
    if (rows.length < 1000) break;
    const oldest = Math.min(...rows.map(row => Number(row[0])).filter(Number.isFinite));
    if (!Number.isFinite(oldest)) break;
    before = oldest - 1;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const ordered = [...candles.entries()].sort((a, b) => a[0] - b[0]);
  return { status: 200, requests, candles: ordered, firstHour: ordered[0]?.[0], lastHour: ordered.at(-1)?.[0],
    volumeUsd: ordered.reduce((sum, row) => sum + row[1], 0) };
}
async function catalog(state) {
  if (state.catalogComplete) return;
  const hook = await rpc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "memeHook" }); state.api.rpc++;
  let seen = Object.keys(state.entries).length;
  while (!state.catalogComplete && (!MAX || seen < MAX)) {
    const page = await convex.query(api.site.listLaunchesPage, { paginationOpts: { cursor: state.cursor, numItems: 40 }, sort: "oldest" }); state.api.convex++;
    for (const launch of page.page) {
      if (MAX && seen >= MAX) break;
      if (!launch.tokenAddress || !isAddress(launch.tokenAddress, { strict: false })) continue;
      const existing = state.entries[launch.tokenAddress.toLowerCase()];
      if (existing) {
        // A catalog collected while a token was still bonding must acquire its
        // graduated V4 source before import. Existing curve history is retained.
        if (launch.graduated === true && existing.phase !== 2) {
          const chain = await rpc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getLaunchedToken", args: [launch.tokenAddress] }); state.api.rpc++;
          if (chain.exists && chain.phase === 2 && !existing.sources.some(source => source.source === "v4_pool")) {
            const address = poolId(launch.tokenAddress, chain.pairToken, chain.poolFee, chain.tickSpacing, hook);
            const history = await geckoHistory(address, state.cutoffHour, state);
            existing.sources.push({ source: "v4_pool", address, gecko: history,
              coverage: history.candles.length ? "gecko" : "onchain_required" });
            existing.phase = 2;
            await saveState(state);
          }
        }
        continue;
      }
      const chain = await rpc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getLaunchedToken", args: [launch.tokenAddress] }); state.api.rpc++;
      if (!chain.exists || !isAddress(chain.curve, { strict: false })) continue;
      const receipt = await rpc.getTransactionReceipt({ hash: launch.transactionHash }); state.api.rpc++;
      const curve = await geckoHistory(chain.curve, state.cutoffHour, state);
      const sources = [{ source: "bonding_curve", address: chain.curve, gecko: curve,
        coverage: curve.candles.length ? "gecko" : "onchain_required" }];
      if (chain.phase === 2) {
        const address = poolId(launch.tokenAddress, chain.pairToken, chain.poolFee, chain.tickSpacing, hook);
        const history = await geckoHistory(address, state.cutoffHour, state);
        sources.push({ source: "v4_pool", address, gecko: history, coverage: history.candles.length ? "gecko" : "onchain_required" });
      }
      state.entries[launch.tokenAddress.toLowerCase()] = {
        tokenAddress: launch.tokenAddress, symbol: launch.symbol, launchCreatedAt: launch.createdAt,
        launchBlock: receipt.blockNumber.toString(), pairToken: chain.pairToken, pairSymbol: launch.pairSymbol || (chain.pairToken === zeroAddress ? "ETH" : undefined),
        pairDecimals: chain.pairToken === zeroAddress ? 18 : Number(await rpc.readContract({ address: chain.pairToken, abi: tokenAbi, functionName: "decimals" })),
        phase: chain.phase, sources,
      };
      if (chain.pairToken !== zeroAddress) state.api.rpc++;
      seen++; await saveState(state);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    state.cursor = page.continueCursor;
    state.catalogComplete = page.isDone;
    await saveState(state);
    if (MAX && seen >= MAX) break;
  }
}
async function fetchBlocks(blocks, state) {
  const values = new Map(); const items = [...new Set(blocks.map(String))];
  for (let i = 0; i < items.length; i += 40) {
    const chunk = items.slice(i, i + 40);
    const found = await Promise.all(chunk.map(block => rpc.getBlock({ blockNumber: BigInt(block) }))); state.api.rpc += chunk.length;
    found.forEach((header, index) => values.set(chunk[index], Number(header.timestamp) * 1000));
  }
  return values;
}
async function reconstructMissingCurves(state) {
  const pending = Object.values(state.entries).filter(entry => entry.sources.some(source => source.source === "bonding_curve" && source.coverage === "onchain_required"));
  if (!pending.length) return;
  const head = await rpc.getBlockNumber(); state.api.rpc++;
  const cutoffHeader = await rpc.getBlock({ blockNumber: head }); state.api.rpc++;
  const cutoffBlock = Number(cutoffHeader.timestamp) * 1000 <= state.cutoffHour + HOUR_MS ? head : head - 1n;
  const groups = [];
  for (let i = 0; i < pending.length; i += 40) groups.push(pending.slice(i, i + 40));
  for (const group of groups) {
    const addresses = group.map(entry => entry.sources.find(source => source.source === "bonding_curve").address);
    let start = group.reduce((minimum, entry) => BigInt(entry.launchBlock) < minimum ? BigInt(entry.launchBlock) : minimum, BigInt(group[0].launchBlock));
    const events = [];
    while (start <= cutoffBlock) {
      const end = start + 99_999n < cutoffBlock ? start + 99_999n : cutoffBlock;
      const [buys, sells] = await Promise.all([
        rpc.getLogs({ address: addresses, event: BUY, fromBlock: start, toBlock: end, strict: true }),
        rpc.getLogs({ address: addresses, event: SELL, fromBlock: start, toBlock: end, strict: true }),
      ]); state.api.rpc += 2;
      for (const row of buys) events.push({ address: row.address.toLowerCase(), block: row.blockNumber.toString(), raw: row.args.quoteIn.toString(), kind: "buy" });
      for (const row of sells) events.push({ address: row.address.toLowerCase(), block: row.blockNumber.toString(), raw: row.args.quoteOut.toString(), kind: "sell" });
      start = end + 1n; await saveState(state);
    }
    const times = await fetchBlocks(events.map(event => event.block), state);
    for (const entry of group) {
      const source = entry.sources.find(item => item.source === "bonding_curve");
      const rows = events.filter(event => event.address === source.address.toLowerCase());
      const hours = new Map();
      for (const row of rows) {
        const timestamp = times.get(row.block); if (timestamp === undefined) continue;
        const hour = Math.floor(timestamp / HOUR_MS) * HOUR_MS; if (hour > state.cutoffHour) continue;
        hours.set(hour, (hours.get(hour) || 0n) + BigInt(row.raw));
      }
      source.onchain = { events: rows.length, hourlyRawQuote: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, raw]) => [hour, raw.toString()]) };
      source.coverage = rows.length ? "onchain_unpriced" : "verified_zero";
    }
    await saveState(state);
  }
}

function nearestPrice(points, hour) {
  let best, distance = Infinity;
  for (const point of points) {
    const next = Math.abs(point[0] - hour);
    if (next < distance && Number.isFinite(point[1]) && point[1] > 0) { best = point[1]; distance = next; }
  }
  return distance <= 72 * HOUR_MS ? best : undefined;
}
async function coinPriceHistory(id, start, end, state) {
  const free = `https://api.coingecko.com/api/v3/coins/${id}/market_chart/range?vs_currency=usd&from=${Math.floor((start - HOUR_MS) / 1000)}&to=${Math.ceil((end + HOUR_MS) / 1000)}`;
  const response = await paidFetch(free); state.api.price++;
  if (!response.ok) throw new Error(`PRICE_HTTP_${response.status}:${id}`);
  const payload = await response.json();
  if (!Array.isArray(payload.prices) || !payload.prices.length) throw new Error(`PRICE_EMPTY:${id}`);
  return payload.prices.map(row => [Number(row[0]), Number(row[1])]);
}
async function stockPriceHistory(symbol, start, end, state) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${Math.floor((start - 72 * HOUR_MS) / 1000)}&period2=${Math.ceil((end + 72 * HOUR_MS) / 1000)}&interval=1h`;
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "PonsBot-Lifetime-Backfill/1.0" } }); state.api.price++;
  if (!response.ok) throw new Error(`STOCK_PRICE_HTTP_${response.status}:${symbol}`);
  const result = (await response.json())?.chart?.result?.[0];
  const timestamps = result?.timestamp, closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) throw new Error(`STOCK_PRICE_EMPTY:${symbol}`);
  return timestamps.flatMap((time, index) => Number.isFinite(Number(closes[index])) ? [[Number(time) * 1000, Number(closes[index])]] : []);
}
async function currentRobinhoodPrice(symbol, state) {
  const response = await fetch(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(symbol)}`, { headers: { accept: "application/json" } }); state.api.price++;
  const quote = response.ok ? (await response.json())?.quotes?.[0] : undefined;
  const bid = Number(quote?.bid), ask = Number(quote?.ask);
  if (!(bid > 0) || !(ask > 0)) throw new Error(`ROBINHOOD_PRICE_EMPTY:${symbol}`);
  return (bid + ask) / 2;
}
async function priceOnchainFallbacks(state) {
  const pending = Object.values(state.entries).filter(entry => entry.sources.some(source => ["onchain_unpriced", "onchain_estimated"].includes(source.coverage)));
  const historyCache = new Map();
  for (const entry of pending) {
    let symbol = entry.pairSymbol;
    if (!symbol && entry.pairToken !== zeroAddress) {
      symbol = await rpc.readContract({ address: entry.pairToken, abi: tokenAbi, functionName: "symbol" }); state.api.rpc++;
      entry.pairSymbol = symbol;
    }
    const source = entry.sources.find(item => ["onchain_unpriced", "onchain_estimated"].includes(item.coverage));
    const raw = source.onchain.hourlyRawQuote;
    if (!raw.length) { source.coverage = "verified_zero"; continue; }
    const start = Number(raw[0][0]), end = Number(raw.at(-1)[0]);
    const normalized = String(symbol || "").toUpperCase();
    let points, method = "";
    if (entry.pairToken === zeroAddress || normalized === "ETH") {
      const key = `coin:ethereum:${start}:${end}`;
      points = historyCache.get(key) ?? await coinPriceHistory("ethereum", start, end, state); historyCache.set(key, points); method = "coingecko_hourly";
    } else if (normalized === "CBBTC") {
      const key = `coin:coinbase-wrapped-btc:${start}:${end}`;
      points = historyCache.get(key) ?? await coinPriceHistory("coinbase-wrapped-btc", start, end, state); historyCache.set(key, points); method = "coingecko_hourly";
    } else if (normalized === "USDG") {
      points = raw.map(row => [Number(row[0]), 1]); method = "stable_usd";
    } else if (normalized !== "SPCX") {
      const key = `stock:${normalized}:${start}:${end}`;
      try {
        points = historyCache.get(key) ?? await stockPriceHistory(normalized, start, end, state);
        historyCache.set(key, points); method = "hourly_market_close";
      } catch {
        const current = await currentRobinhoodPrice(normalized, state);
        points = raw.map(row => [Number(row[0]), current]); method = "current_robinhood_estimate";
      }
    } else {
      const current = await currentRobinhoodPrice(normalized, state);
      points = raw.map(row => [Number(row[0]), current]); method = "current_robinhood_estimate";
    }
    const priced = raw.map(([hour, amount]) => {
      const price = nearestPrice(points, Number(hour));
      if (!(price > 0)) throw new Error(`PRICE_GAP:${normalized}:${hour}`);
      const units = Number(amount) / 10 ** entry.pairDecimals;
      return [Number(hour), units * price, price];
    });
    source.onchain.hourlyUsd = priced;
    source.onchain.volumeUsd = priced.reduce((sum, row) => sum + row[1], 0);
    source.onchain.priceMethod = method;
    source.coverage = method === "current_robinhood_estimate" ? "onchain_estimated" : "onchain_priced";
    await saveState(state);
  }
}

function importEntries(state) {
  const recentCutoff = state.cutoffHour - 71 * HOUR_MS;
  return Object.values(state.entries).flatMap(entry => entry.sources.map(source => {
    const hours = source.coverage === "gecko" ? source.gecko.candles
      : source.onchain?.hourlyUsd?.map(row => [row[0], row[1]]) ?? [];
    const confirmedVolumeUsd = source.coverage === "gecko" ? source.gecko.volumeUsd
      : source.onchain?.volumeUsd ?? 0;
    return {
      tokenAddress: entry.tokenAddress, poolAddress: source.address, pairToken: entry.pairToken,
      source: source.source, launchCreatedAt: entry.launchCreatedAt, confirmedVolumeUsd,
      recentHoursJson: JSON.stringify(hours.filter(row => row[0] >= recentCutoff).sort((a, b) => b[0] - a[0]).slice(0, 72)),
      ...(hours.length ? { oldestBackfilledHour: Math.min(...hours.map(row => row[0])) } : {}),
      latestCompletedHour: state.cutoffHour,
      volumeProvider: source.coverage === "gecko" ? "gecko" : "onchain",
      frozen: source.source === "bonding_curve" && entry.phase === 2,
    };
  }));
}

async function importManifest(state) {
  const secret = process.env.MARKET_INDEX_SECRET;
  if (!secret) throw new Error("MARKET_INDEX_SECRET is required for --import");
  if (!state.catalogComplete) throw new Error("cannot import an incomplete catalog");
  const unresolved = Object.values(state.entries).flatMap(entry => entry.sources)
    .filter(source => !["gecko", "onchain_priced", "onchain_estimated", "verified_zero"].includes(source.coverage));
  if (unresolved.length) throw new Error(`cannot import ${unresolved.length} unresolved sources`);
  const entries = importEntries(state);
  const manifestId = createHash("sha256").update(JSON.stringify({ cutoffHour: state.cutoffHour, entries })).digest("hex");
  await convex.mutation(api.lifetimeVolume.beginBackfillImport, { secret, manifestId, cutoffHour: state.cutoffHour, expectedSources: entries.length });
  for (let index = 0; index < entries.length; index += 20) {
    const progress = await convex.mutation(api.lifetimeVolume.importBackfillBatch, { secret, manifestId, entries: entries.slice(index, index + 20) });
    console.error(`Imported ${progress.completedSources}/${progress.expectedSources}`);
  }
  const summary = await convex.mutation(api.lifetimeVolume.finalizeBackfillImport, { secret, manifestId });
  return { manifestId, ...summary };
}

const state = await loadState();
if (REFRESH_CATALOG && state.catalogComplete) {
  state.cursor = null;
  state.catalogComplete = false;
  await saveState(state);
}
await catalog(state);
if (state.catalogComplete || MAX) await reconstructMissingCurves(state);
if (state.catalogComplete || MAX) await priceOnchainFallbacks(state);
await saveState(state);
const sources = Object.values(state.entries).flatMap(entry => entry.sources);
const totalUsd = sources.reduce((sum, source) => sum + (source.gecko?.volumeUsd || source.onchain?.volumeUsd || 0), 0);
const imported = IMPORT ? await importManifest(state) : undefined;
console.log(JSON.stringify({ status: state.catalogComplete ? "catalog_complete" : "partial", cutoffHour: state.cutoffHour,
  tokens: Object.keys(state.entries).length, sources: sources.length, geckoCovered: sources.filter(source => source.coverage === "gecko").length,
  onchainPriced: sources.filter(source => source.coverage === "onchain_priced").length,
  onchainEstimated: sources.filter(source => source.coverage === "onchain_estimated").length,
  onchainUnpriced: sources.filter(source => source.coverage === "onchain_unpriced").length, totalUsd,
  verifiedZero: sources.filter(source => source.coverage === "verified_zero").length,
  unresolved: sources.filter(source => source.coverage === "onchain_required").length, api: state.api, output: OUTPUT,
  ...(imported ? { imported } : {}) }, null, 2));
