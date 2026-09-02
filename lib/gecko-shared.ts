import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { GeckoPriority } from "./gecko-budget-policy";
import { COINGECKO_FREE_ONCHAIN_PREFIX, coinGeckoHeaders, coinGeckoPaidKey, paidCoinGeckoUrl } from "./coingecko-client";

// Interactive callers may wait through the provider's normal one-minute
// cooldown when they explicitly request it. Liquidity discovery does not: it
// uses a recent cached provider snapshot immediately when the slot is busy.
// Waiting never bypasses the shared budget or an upstream Retry-After value.
export const GECKO_INTERACTIVE_WAIT_MS = 60_000;

/** Global cache + rolling budget. Denial is a cache miss, never an unbudgeted fetch. */
export type GeckoProvider = "auto" | "paid" | "free";
export type GeckoWorkload = "lifetime_volume";
export async function geckoSharedFetch(url: string, ttlMs = 60_000, timeoutMs = 8_000, allowStale = false, waitForSlot = false, freshAfter?: number, priority: GeckoPriority = "background", provider: GeckoProvider = "auto", workload?: GeckoWorkload): Promise<Response> {
  if (!url.startsWith(COINGECKO_FREE_ONCHAIN_PREFIX)) throw new Error("invalid Gecko URL");
  const paid = provider !== "free" && Boolean(coinGeckoPaidKey());
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL || process.env.CONVEX_URL;
  const secret = process.env.MARKET_INDEX_SECRET;
  if (!convexUrl || !secret) return new Response(null, { status: 503 });
  const client = new ConvexHttpClient(convexUrl);
  const key = `${paid ? "coingecko-paid" : "gecko"}:${url.slice(COINGECKO_FREE_ONCHAIN_PREFIX.length)}`;
  const leaseId = crypto.randomUUID();
  const reservation = { secret, key, leaseId, paid, ...(freshAfter !== undefined ? { freshAfter } : {}), ...(priority === "interactive" ? { priority } : {}), ...(workload ? { workload } : {}) };
  const waitBudget = priority === "interactive" ? GECKO_INTERACTIVE_WAIT_MS : 6_000;
  const waitUntil = Date.now() + waitBudget;
  let reserved = await client.mutation(api.marketData.reserveGecko, reservation);
  // Background batches only wait briefly for pacing. Interactive liquidity
  // analysis can wait through one ordinary cooldown, but a longer Retry-After
  // still returns immediately. Every retry reserves from the same global cap.
  for (let attempt = 0; waitForSlot && !reserved.acquired && attempt < (priority === "interactive" ? 8 : 2); attempt++) {
    if (!reserved.stale || (allowStale && reserved.json !== undefined) || !("retryAt" in reserved)) break;
    const delay = reserved.retryAt - Date.now();
    if (delay <= 0 || delay > (priority === "interactive" ? GECKO_INTERACTIVE_WAIT_MS : 3_000) || Date.now() + delay > waitUntil) break;
    await new Promise(resolve => setTimeout(resolve, delay));
    reserved = await client.mutation(api.marketData.reserveGecko, reservation);
  }
  const retryAt = "retryAt" in reserved ? reserved.retryAt : Date.now() + 60_000;
  const previous = () => new Response(reserved.json, { headers: { "content-type": "application/json",
    "x-market-observed-at": String(reserved.observedAt), ...(reserved.stale ? { "x-market-stale": "1" } : {}) } });
  if (!reserved.acquired) return reserved.json !== undefined && (!reserved.stale || allowStale)
    ? previous()
    : new Response(null, { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000))), "x-gecko-local-deferral": "1" } });
  let json: string | undefined; let status = 502; let retryAfter: string | null = null;
  const observedAt = Date.now();
  try {
    const response = await fetch(paid ? paidCoinGeckoUrl(url) : url, { headers: coinGeckoHeaders(paid), cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    status = response.status;
    retryAfter = response.headers.get("retry-after");
    if (response.ok) {
      const value = await response.json();
      if (!value || typeof value !== "object" || value.data === undefined || value.data === null) throw new Error("invalid Gecko payload");
      json = JSON.stringify(value);
    }
  } catch { status = 502; }
  await client.mutation(api.marketData.completeGecko, { secret, key, leaseId, json, ttlMs, observedAt, throttled: status === 429, paid,
    ...(retryAfter ? { retryAfter } : {}),
  }).catch(() => undefined);
  // Auto consumers retain public GeckoTerminal as a fallback if the paid
  // endpoint is unavailable. Explicit paid background accounting fails closed
  // when its shared monthly budget is exhausted rather than escaping the cap.
  if (json === undefined && paid && provider === "auto") {
    const fallback = await geckoSharedFetch(url, ttlMs, timeoutMs, allowStale, waitForSlot, freshAfter, priority, "free", workload).catch(() => undefined);
    if (fallback) return fallback;
  }
  if (json === undefined && allowStale && reserved.json !== undefined) return previous();
  return new Response(json ?? null, { status, headers: { "content-type": "application/json", "x-market-observed-at": String(observedAt),
    ...(retryAfter ? { "retry-after": retryAfter } : {}),
  } });
}
