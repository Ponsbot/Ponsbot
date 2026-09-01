import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

export type WalletExecutionCacheKind = "v3_route" | "token_metadata" | "pons_pair";

function client() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  return url ? new ConvexHttpClient(url) : undefined;
}

export function walletExecutionCacheKey(kind: WalletExecutionCacheKind, ...parts: string[]) {
  return `${kind}:${parts.map((part) => part.trim().toLowerCase()).join(":")}`;
}

export async function sharedWalletExecutionCache<T>(key: string, kind: WalletExecutionCacheKind): Promise<T | undefined> {
  const convex = client();
  if (!convex) return undefined;
  const item = await convex.query(api.site.getWalletExecutionCache, { key }).catch(() => null);
  if (!item || item.kind !== kind) return undefined;
  try { return JSON.parse(item.valueJson) as T; } catch { return undefined; }
}

export async function rememberWalletExecutionCache(
  key: string, kind: WalletExecutionCacheKind, value: unknown, ttlMs: number,
) {
  const convex = client();
  const secret = process.env.MARKET_INDEX_SECRET;
  if (!convex || !secret) return;
  const valueJson = JSON.stringify(value);
  if (valueJson.length > 4_000) return;
  await convex.mutation(api.site.setWalletExecutionCache, { secret, key, kind, valueJson, ttlMs }).catch(() => undefined);
}
