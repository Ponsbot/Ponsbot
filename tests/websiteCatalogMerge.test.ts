import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";
vi.mock("../lib/gecko-shared", () => ({ geckoSharedFetch: vi.fn() }));
vi.mock("../lib/gecko-token-market", () => ({ GECKO_TOKEN_BATCH_SIZE: 30, geckoTokenMarkets: vi.fn() }));
import { mergeCatalogSnapshots, refreshWebsiteCatalog } from "../lib/website-market-catalog";
import { geckoSharedFetch } from "../lib/gecko-shared";
import { geckoTokenMarkets } from "../lib/gecko-token-market";
describe("catalog token and pool fallback merge", () => {
  const now = 1000000;
  it("never republishes the simple batch cap from the background catalog", async () => {
    const token = '0x0000000000000000000000000000000000000001';
    const pool = '0x0000000000000000000000000000000000000002';
    const at = Date.now();
    vi.mocked(geckoTokenMarkets).mockResolvedValue(new Map([[token, { tokenAddress: token, observedAt: at, marketCapUsd: 12976, volume24hUsd: 0 }]]));
    vi.mocked(geckoSharedFetch).mockResolvedValue(new Response(JSON.stringify({ data: [{ attributes: { address: pool, fdv_usd: '4858' } }] }), { headers: { 'x-market-observed-at': String(at) } }));
    const mutation = vi.fn(async (ref: Parameters<typeof getFunctionName>[0]) => getFunctionName(ref) === 'marketData:acquireCatalog' ? { offset: 0 } : null);
    const query = vi.fn(async (ref: Parameters<typeof getFunctionName>[0]) => getFunctionName(ref) === 'site:marketCatalogTargets'
      ? [{ tokenAddress: token, curveAddress: pool, graduated: false }] : {});
    await refreshWebsiteCatalog({ query, mutation } as unknown as ConvexHttpClient, 'test');
    const record = mutation.mock.calls.find(([ref]) => getFunctionName(ref) === 'marketData:recordCatalog');
    expect(record).toBeDefined();
    expect(record).toEqual([expect.anything(), expect.objectContaining({ snapshots: [expect.objectContaining({ tokenAddress: token, marketCapUsd: 4858 })] })]);
  });
  it("merges 600 primary/fallback records into 300 complete tokens", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ tokenAddress: `0x${i.toString(16).padStart(40, "0")}`, observedAt: now - 10, lastTradeAt: now - 100, marketCapUsd: 5 }));
    const merged = mergeCatalogSnapshots([...rows, ...rows.map(r => ({ tokenAddress: r.tokenAddress.toUpperCase(), observedAt: now, volume24hUsd: 10 }))], now);
    expect(merged).toHaveLength(300);
    expect(merged.every(r => r.marketCapUsd === 5 && r.volume24hUsd === 10 && r.lastTradeAt === now - 100)).toBe(true);
  });
  it("does not let stale fallback replace fresh data or undefined erase a field", () => {
    expect(mergeCatalogSnapshots([
      { tokenAddress: "0xabc", observedAt: now, marketCapUsd: 100 },
      { tokenAddress: "0xABC", observedAt: now - 130000, marketCapUsd: 1 },
      { tokenAddress: "0xabc", observedAt: now, marketCapUsd: undefined, volume24hUsd: 8 },
    ], now)).toEqual([{ tokenAddress: "0xabc", observedAt: now, marketCapUsd: 100, volume24hUsd: 8 }]);
  });
});
