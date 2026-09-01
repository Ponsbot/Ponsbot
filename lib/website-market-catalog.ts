import { ConvexHttpClient } from "convex/browser";
import type { Address } from "viem";
import { api } from "../convex/_generated/api";
import { geckoSharedFetch } from "./gecko-shared";
import { geckoMarketCap } from "./market-index-policy";
import { ponsV4PoolId } from "./lifetime-volume";
import { mapWithConcurrency } from "./bounded-concurrency";
import type { WebsiteSnapshot } from "./website-market";

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
  const ids = [...pools.keys()].sort();
  const offset = lease.offset < ids.length ? lease.offset : 0;
  const selected = ids.slice(offset, offset + 300);
  const nextOffset = offset + selected.length >= ids.length ? 0 : offset + selected.length;
  const chunks: string[][] = [];
  for (let i = 0; i < selected.length; i += 30) chunks.push(selected.slice(i, i + 30));
  const snapshots: WebsiteSnapshot[] = [];
  // Bound this low-priority batch and let the shared Gecko budget prioritize
  // whatever is already being viewed; failures retain prior catalog values.
  await mapWithConcurrency(chunks.slice(0, 10), 1, async batch => {
    const response = await geckoSharedFetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/multi/${batch.join(",")}`, 60_000, 8_000, false, true).catch(() => undefined);
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
  await client.mutation(api.marketData.recordCatalog, { secret, leaseId, snapshots, nextOffset });
}
