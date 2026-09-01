import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

function client() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  return url ? new ConvexHttpClient(url) : undefined;
}

export async function sharedPrice(key: string) {
  const convex = client();
  if (!convex) return undefined;
  return await convex.query(api.site.getMarketPrice, { key }).then((item) => item?.value).catch(() => undefined);
}

export async function rememberSharedPrice(key: string, value: number, sourceTimestamp: number, ttlMs: number) {
  const convex = client(); const secret = process.env.MARKET_INDEX_SECRET;
  if (!convex || !secret || !Number.isFinite(value)) return;
  await convex.mutation(api.site.setMarketPrice, { secret, key, value, sourceTimestamp, ttlMs }).catch(() => undefined);
}
