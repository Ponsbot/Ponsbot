import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/gecko-shared", () => ({ geckoSharedFetch: vi.fn() }));
vi.mock("../lib/gecko-token-market", () => ({ GECKO_TOKEN_BATCH_SIZE: 30, geckoTokenMarkets: vi.fn() }));
import { mergeCatalogSnapshots } from "../lib/website-market-catalog";
describe("catalog token and pool fallback merge", () => {
  const now = 1000000;
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
