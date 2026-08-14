import { parseUnits } from "viem";
import { rememberSharedPrice, sharedPrice } from "../shared-price-cache";

const CACHE_MS = 30_000;
const MAX_DEVIATION_BPS = 300;
const REQUEST_TIMEOUT_MS = 4_000;
const MAX_SOURCE_AGE_MS = 5 * 60_000;
let cached: { price: number; expiresAt: number } | undefined;

async function fetchJson(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: "no-store" });
  if (!response.ok) throw new Error(`price source failed (${response.status})`);
  return await response.json() as unknown;
}

function assertFresh(timestampMs: number, source: string) {
  const age = Date.now() - timestampMs;
  if (!Number.isFinite(timestampMs) || age < -60_000 || age > MAX_SOURCE_AGE_MS) {
    throw new Error(`${source} ETH/USD price is stale`);
  }
}

async function coinbaseEthUsd(signal?: AbortSignal) {
  const payload = await fetchJson("https://api.exchange.coinbase.com/products/ETH-USD/ticker", signal) as { price?: string; time?: string };
  const timestamp = Date.parse(payload.time || "");
  assertFresh(timestamp, "Coinbase");
  return Number(payload.price);
}

async function coinGeckoEthUsd(signal?: AbortSignal) {
  const payload = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_last_updated_at=true", signal) as {
    ethereum?: { usd?: number; last_updated_at?: number };
  };
  assertFresh(Number(payload.ethereum?.last_updated_at) * 1_000, "CoinGecko");
  return Number(payload.ethereum?.usd);
}

function validPrice(value: number) {
  return Number.isFinite(value) && value > 100 && value < 100_000;
}

export async function ethUsdPrice(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (cached && cached.expiresAt > Date.now()) return cached.price;
  const shared = await sharedPrice("eth-usd");
  if (shared && validPrice(shared)) { cached = { price: shared, expiresAt: Date.now() + CACHE_MS }; return shared; }
  const [coinbase, coinGecko] = await Promise.all([coinbaseEthUsd(signal), coinGeckoEthUsd(signal)]);
  if (!validPrice(coinbase) || !validPrice(coinGecko)) throw new Error("ETH/USD price source returned an invalid value");
  const midpoint = (coinbase + coinGecko) / 2;
  const deviationBps = Math.abs(coinbase - coinGecko) / midpoint * 10_000;
  if (deviationBps > MAX_DEVIATION_BPS) throw new Error("ETH/USD price sources disagree");
  // A higher ETH/USD price converts the requested dollars into less ETH, so
  // the wallet never spends more ETH merely because the feeds differ.
  const price = conservativeEthUsdPrice(coinbase, coinGecko);
  cached = { price, expiresAt: Date.now() + CACHE_MS };
  await rememberSharedPrice("eth-usd", price, Date.now(), CACHE_MS);
  return price;
}

export function conservativeEthUsdPrice(first: number, second: number) {
  if (!validPrice(first) || !validPrice(second)) throw new Error("ETH/USD price source returned an invalid value");
  return Math.max(first, second);
}

export function usdToEthWei(usd: string, ethUsd: number) {
  const value = Number(usd);
  if (!Number.isFinite(value) || value <= 0) throw new Error("USD amount must be positive");
  if (!validPrice(ethUsd)) throw new Error("ETH/USD price is invalid");
  // Fixed-point division avoids floating-point wei drift and always rounds down.
  const usdScaled = parseUnits(usd, 8);
  const priceScaled = BigInt(Math.round(ethUsd * 1e8));
  const wei = usdScaled * 10n ** 18n / priceScaled;
  if (wei <= 0n) throw new Error("USD amount is too small to convert to ETH");
  return wei;
}

export async function checkedUsdToEthWei(usd: string) {
  const maximum = Number(process.env.WALLET_MAX_TRANSACTION_USD || "10000");
  const value = Number(usd);
  if (!Number.isFinite(maximum) || maximum <= 0) throw new Error("WALLET_MAX_TRANSACTION_USD is invalid");
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`USD amount exceeds the $${maximum} transaction limit`);
  return usdToEthWei(usd, await ethUsdPrice());
}
