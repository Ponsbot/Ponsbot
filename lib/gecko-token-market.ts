import { geckoSharedFetch } from "./gecko-shared";
import type { GeckoPriority } from "./gecko-budget-policy";

const NETWORK = "robinhood";
export const GECKO_TOKEN_BATCH_SIZE = 30;

export type GeckoTokenMarket = {
  tokenAddress: string;
  observedAt: number;
  priceUsd?: number;
  marketCapUsd?: number;
  volume24hUsd?: number;
  reserveUsd?: number;
  lastTradeAt?: number;
};

function nonnegative(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function addressValues(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, unknown>;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key.toLowerCase(), item]));
}

/** One address-keyed request for price, cap, volume, reserve and activity.
 * Paid CoinGecko is primary when configured; the shared client retains public
 * GeckoTerminal and durable-cache fallback behavior.
 */
export async function geckoTokenMarkets(addresses: string[], options: {
  ttlMs?: number; timeoutMs?: number; allowStale?: boolean; waitForSlot?: boolean; priority?: GeckoPriority;
} = {}) {
  const tokens = [...new Set(addresses.map(value => value.toLowerCase()).filter(value => /^0x[0-9a-f]{40}$/.test(value)))];
  if (!tokens.length) return new Map<string, GeckoTokenMarket>();
  if (tokens.length > GECKO_TOKEN_BATCH_SIZE) throw new Error("too many Gecko token addresses");
  const url = `https://api.geckoterminal.com/api/v2/simple/networks/${NETWORK}/token_price/${tokens.join(",")}?include_market_cap=true&mcap_fdv_fallback=true&include_24hr_vol=true&include_total_reserve_in_usd=true&include_inactive_source=true`;
  const response = await geckoSharedFetch(url, options.ttlMs ?? 60_000, options.timeoutMs ?? 8_000,
    options.allowStale ?? true, options.waitForSlot ?? false, undefined, options.priority ?? "background");
  if (!response.ok) return new Map<string, GeckoTokenMarket>();
  // Clone so an injected/shared Response remains reusable by a compatibility
  // fallback; native fetch responses are still consumed only once upstream.
  const payload = await response.clone().json().catch(() => null) as { data?: { attributes?: Record<string, Record<string, unknown>> } } | null;
  const attributes = payload?.data?.attributes ?? {};
  const prices = addressValues(attributes.token_prices);
  const caps = addressValues(attributes.market_cap_usd);
  const volumes = addressValues(attributes.h24_volume_usd);
  const reserves = addressValues(attributes.total_reserve_in_usd);
  const trades = addressValues(attributes.last_trade_timestamp);
  const observedAt = Number(response.headers.get("x-market-observed-at")) || Date.now();
  const result = new Map<string, GeckoTokenMarket>();
  for (const token of tokens) {
    const seconds = nonnegative(trades[token]);
    result.set(token, { tokenAddress: token, observedAt,
      ...(nonnegative(prices[token]) === undefined ? {} : { priceUsd: nonnegative(prices[token]) }),
      ...(nonnegative(caps[token]) === undefined ? {} : { marketCapUsd: nonnegative(caps[token]) }),
      ...(nonnegative(volumes[token]) === undefined ? {} : { volume24hUsd: nonnegative(volumes[token]) }),
      ...(nonnegative(reserves[token]) === undefined ? {} : { reserveUsd: nonnegative(reserves[token]) }),
      ...(seconds === undefined ? {} : { lastTradeAt: seconds * 1_000 }),
    });
  }
  return result;
}

export function marketRefreshTtl(lastTradeAt: number | undefined, now = Date.now()) {
  if (!lastTradeAt || lastTradeAt > now + 60_000) return 60_000;
  const age = now - lastTradeAt;
  if (age <= 60 * 60_000) return 60_000;
  if (age <= 24 * 60 * 60_000) return 5 * 60_000;
  return 30 * 60_000;
}
