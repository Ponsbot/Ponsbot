import { ConvexHttpClient } from "convex/browser";
import type { Address } from "viem";
import { api } from "../convex/_generated/api";
import { geckoSharedFetch } from "./gecko-shared";
import { geckoMarketCap } from "./market-index-policy";
import { ponsV4PoolId } from "./lifetime-volume";
import { mapWithConcurrency } from "./bounded-concurrency";
import type { WebsiteSnapshot } from "./website-market";
import { GECKO_TOKEN_BATCH_SIZE, geckoTokenMarkets } from "./gecko-token-market";

export function mergeCatalogSnapshots(snapshots: WebsiteSnapshot[], now = Date.now()): WebsiteSnapshot[] {
  const merged = new Map<string, WebsiteSnapshot>();
  // Reject stale inputs before merging so a fresh fallback never freshens old data.
  for (const next of [...snapshots].filter(s => Number.isFinite(s.observedAt) && s.observedAt <= now && s.observedAt >= now - 120_000).sort((a, b) => a.observedAt - b.observedAt)) {
    const key = next.tokenAddress.toLowerCase();
    const previous = merged.get(key);
    const defined = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
    merged.set(key, { ...previous, ...defined, tokenAddress: key, observedAt: Math.min(previous?.observedAt ?? next.observedAt, next.observedAt) } as WebsiteSnapshot);
  }
  return [...merged.values()];
}

/** Infrequent, Gecko-only off-screen refresh. No public or paid RPC calls. */
export async function refreshWebsiteCatalog(client: ConvexHttpClient, secret: string) {
  const leaseId = crypto.randomUUID();
  const lease = await client.mutation(api.marketData.acquireCatalog, { secret, leaseId });
  if (!lease) return;
  const [targets, config] = await Promise.all([client.query(api.site.marketCatalogTargets, {}), client.query(api.site.marketRuntimeConfig, {})]);
  const hookRecord = config.factory && config.stateView ? await client.query(api.marketData.readCache, {
    secret, key: `metadata:${config.factory.toLowerCase()}:${config.stateView.toLowerCase()}:hook`,
  }) : null;
  const hook: Address | undefined = hookRecord ? JSON.parse(hookRecord.json) : undefined;
  const pools = new Map<string, string>();
  for (const target of targets) {
    const pool = target.graduated
      ? hook && target.poolFee !== undefined && target.tickSpacing !== undefined
        ? ponsV4PoolId(target.tokenAddress as Address, target.pairToken as Address, target.poolFee, target.tickSpacing, hook) : undefined
      : target.curveAddress;
    if (pool) pools.set(pool.toLowerCase(), target.tokenAddress);
  }
  const tokens = [...new Set(targets.map(target => target.tokenAddress.toLowerCase()))].sort();
  const offset = lease.offset < tokens.length ? lease.offset : 0;
  const selected = tokens.slice(offset, offset + 300);
  const nextOffset = offset + selected.length >= tokens.length ? 0 : offset + selected.length;
  const chunks: string[][] = [];
  for (let i = 0; i < selected.length; i += GECKO_TOKEN_BATCH_SIZE) chunks.push(selected.slice(i, i + GECKO_TOKEN_BATCH_SIZE));
  const snapshots: WebsiteSnapshot[] = [];
  // Bound this low-priority batch and let the shared Gecko budget prioritize
  // whatever is already being viewed; failures retain prior catalog values.
  await mapWithConcurrency(chunks.slice(0, 10), 1, async batch => {
    const markets = await geckoTokenMarkets(batch, { ttlMs: 60_000, timeoutMs: 8_000, allowStale: true, waitForSlot: true }).catch(() => new Map());
    const missing: string[] = [];
    for (const token of batch) {
      const market = markets.get(token);
      if (!market || market.marketCapUsd === undefined || market.volume24hUsd === undefined) missing.push(token);
      if (!market) continue;
      snapshots.push({ tokenAddress: token, observedAt: market.observedAt,
        ...(market.marketCapUsd === undefined ? {} : { marketCapUsd: market.marketCapUsd }),
        ...(market.volume24hUsd === undefined ? {} : { volume24hUsd: market.volume24hUsd }),
        ...(market.lastTradeAt === undefined ? {} : { lastTradeAt: market.lastTradeAt }),
      });
    }
    // Compatibility fallback for tokens not yet indexed by the token endpoint.
    const fallbackPools = missing.flatMap(token => [...pools.entries()].filter(([, value]) => value.toLowerCase() === token).map(([pool]) => pool));
    if (!fallbackPools.length) return;
    const response = await geckoSharedFetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/multi/${fallbackPools.join(",")}`, 60_000, 8_000, true, true).catch(() => undefined);
    const data = response?.ok ? await response.json().catch(() => undefined) as { data?: Array<{ attributes?: { address?: string; market_cap_usd?: string; fdv_usd?: string; volume_usd?: { h24?: string } } }> } | undefined : undefined;
    const observedAt = Number(response?.headers.get("x-market-observed-at")) || Date.now();
    for (const pool of data?.data ?? []) {
      const tokenAddress = pools.get(pool.attributes?.address?.toLowerCase() ?? "");
      if (!tokenAddress) continue;
      const cap = geckoMarketCap(pool.attributes?.market_cap_usd, pool.attributes?.fdv_usd);
      const rawVolume = pool.attributes?.volume_usd?.h24;
      const volume = rawVolume ? Number(rawVolume) : NaN;
      if (cap === undefined && !Number.isFinite(volume)) continue;
      snapshots.push({ tokenAddress, observedAt, ...(cap === undefined ? {} : { marketCapUsd: cap }),
        ...(Number.isFinite(volume) && volume >= 0 ? { volume24hUsd: volume } : {}) });
    }
  });
  await client.mutation(api.marketData.recordCatalog, { secret, leaseId, snapshots: mergeCatalogSnapshots(snapshots), nextOffset });
}
