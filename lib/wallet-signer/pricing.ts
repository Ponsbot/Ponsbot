import { parseUnits } from "viem";

const CACHE_MS = 30_000;
const MAX_DEVIATION_BPS = 300;
const REQUEST_TIMEOUT_MS = 4_000;
const MAX_SOURCE_AGE_MS = 5 * 60_000;
let cached: { price: number; expiresAt: number } | undefined;

async function fetchJson(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: "no-store" });
  if (!response.ok) throw new Error(`price source failed (${response.status})`);
  return await response.json() as unknown;
}

function assertFresh(timestampMs: number, source: string) {
  const age = Date.now() - timestampMs;
  if (!Number.isFinite(timestampMs) || age < -60_000 || age > MAX_SOURCE_AGE_MS) {
    throw new Error(`${source} ETH/USD price is stale`);
  }
}

async function coinbaseEthUsd() {
  const payload = await fetchJson("https://api.exchange.coinbase.com/products/ETH-USD/ticker") as { price?: string; time?: string };
  const timestamp = Date.parse(payload.time || "");
  assertFresh(timestamp, "Coinbase");
  return Number(payload.price);
}

async function coinGeckoEthUsd() {
  const payload = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_last_updated_at=true") as {
    ethereum?: { usd?: number; last_updated_at?: number };
  };
  assertFresh(Number(payload.ethereum?.last_updated_at) * 1_000, "CoinGecko");
  return Number(payload.ethereum?.usd);
}

function validPrice(value: number) {
  return Number.isFinite(value) && value > 100 && value < 100_000;
}

export async function ethUsdPrice() {
  if (cached && cached.expiresAt > Date.now()) return cached.price;
  const [coinbase, coinGecko] = await Promise.all([coinbaseEthUsd(), coinGeckoEthUsd()]);
  if (!validPrice(coinbase) || !validPrice(coinGecko)) throw new Error("ETH/USD price source returned an invalid value");
  const midpoint = (coinbase + coinGecko) / 2;
  const deviationBps = Math.abs(coinbase - coinGecko) / midpoint * 10_000;
  if (deviationBps > MAX_DEVIATION_BPS) throw new Error("ETH/USD price sources disagree");
  const price = Math.min(coinbase, coinGecko);
  cached = { price, expiresAt: Date.now() + CACHE_MS };
  return price;
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
