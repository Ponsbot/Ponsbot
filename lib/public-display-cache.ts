import "server-only";
import { unstable_cache } from "next/cache";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

// Only public display data is shared. Session verification, holdings, requests,
// and fee receipts never enter this cache. Writers can bypass it immediately.
const cachedMarkets = unstable_cache(async (url: string, tokens: string[]) =>
  new ConvexHttpClient(url).query(api.site.getMarketStates, { tokenAddresses: tokens }),
  ["public-market-display-v1"], { revalidate: 15 });

export function readPublicMarketStates(url: string, addresses: string[], fresh = false) {
  const tokens = [...new Set(addresses.map(a => a.toLowerCase()))].slice(0, 50).sort();
  return fresh
    ? new ConvexHttpClient(url).query(api.site.getMarketStates, { tokenAddresses: tokens })
    : cachedMarkets(url, tokens);
}

export const readTerminalCatalog = unstable_cache(async (url: string) => {
  const secret = process.env.WEB_AUTH_SECRET;
  if (!secret) throw new Error("terminal catalog not configured");
  return new ConvexHttpClient(url).query(api.site.terminalTokenCatalog, { secret });
}, ["terminal-public-catalog-v1"], { revalidate: 60 });
