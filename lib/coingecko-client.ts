const FREE_API = "https://api.coingecko.com/api/v3/";
const PAID_API = "https://pro-api.coingecko.com/api/v3/";
const FREE_ONCHAIN = "https://api.geckoterminal.com/api/v2/";
const PAID_ONCHAIN = "https://pro-api.coingecko.com/api/v3/onchain/";

export function coinGeckoPaidKey() {
  return process.env.COINGECKO_PRO_API_KEY?.trim() || undefined;
}

/** Endpoints CoinGecko currently reserves for Analyst and higher. Keep Basic
 * deployments on their established pool/RPC paths without spending calls on
 * predictable entitlement failures. */
export function coinGeckoAnalystOnchainEnabled() {
  return /^(1|true|yes|on)$/i.test(process.env.COINGECKO_ANALYST_ONCHAIN_ENABLED?.trim() ?? "");
}

export function paidCoinGeckoUrl(freeUrl: string) {
  if (freeUrl.startsWith(FREE_ONCHAIN)) return PAID_ONCHAIN + freeUrl.slice(FREE_ONCHAIN.length);
  if (freeUrl.startsWith(FREE_API)) return PAID_API + freeUrl.slice(FREE_API.length);
  throw new Error("invalid CoinGecko URL");
}

export function coinGeckoHeaders(paid: boolean, extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("accept", "application/json;version=20230302");
  headers.set("user-agent", "PonsBot/1.0");
  const key = coinGeckoPaidKey();
  if (paid && key) headers.set("x-cg-pro-api-key", key);
  return headers;
}

/** Paid CoinGecko first, with the public endpoint retained as a safe fallback. */
export async function coinGeckoFetch(freeUrl: string, init: RequestInit = {}) {
  const key = coinGeckoPaidKey();
  if (key) {
    try {
      const paid = await fetch(paidCoinGeckoUrl(freeUrl), { ...init, headers: coinGeckoHeaders(true, init.headers) });
      if (paid.ok) return paid;
    } catch { /* Public fallback below. */ }
  }
  return fetch(freeUrl, { ...init, headers: coinGeckoHeaders(false, init.headers) });
}

export const COINGECKO_FREE_ONCHAIN_PREFIX = FREE_ONCHAIN;
