import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiquidityCandidate } from "../lib/liquidity-workflow";
import { newLiquidityDraft } from "../lib/liquidity-workflow";
import { compareLiquidityCandidates, liquidityFeeOpportunity } from "../lib/liquidity-analysis-policy";
import { liquidityResponseLines } from "../lib/liquidity-responses";
vi.mock("../convex/llm", () => ({ openRouter: vi.fn() }));
import { openRouter } from "../convex/llm";
import { rankLiquidityPoolsWithDiagnostics } from "../convex/liquidityAi";
const candidate = (id: string, hour: number, overrides: Partial<LiquidityCandidate> = {}): LiquidityCandidate => ({
  id: `0x${id.repeat(40)}`, version: 3, pair: "ETH", token0: `0x${"0".repeat(40)}`, token1: `0x${"1".repeat(40)}`,
  feePips: 3000, tickSpacing: 60, netLpFeePercent: .3, traderFeePercent: .3, tokenPriceUsd: .01, activeLiquidity: "100000",
  volumeHourUsd: hour, volumeSixHourUsd: hour * 6, volumeDayUsd: hour * 24, swapsHour: 100,
  activeDepthUsd: 10000, estimatedBudgetSharePercent: 1, observedAt: 1, marketObservedAt: 1, blockNumber: "1", reasons: ["fee_paying", "range_risk"], ...overrides,
});
beforeEach(() => vi.resetAllMocks());
describe("volume-first pool recommendations", () => {
  it("puts measured recent trading ahead of yesterday's idle volume in fallback", async () => {
    const idle = candidate("a", 0, { volumeDayUsd: 20000, volumeSixHourUsd: 10000 });
    const active = candidate("b", 300);
    expect(liquidityFeeOpportunity(idle)).toBe(0);
    expect([idle, active].sort(compareLiquidityCandidates)[0].id).toBe(active.id);
    vi.mocked(openRouter).mockRejectedValue(new Error("private upstream details"));
    const result = await rankLiquidityPoolsWithDiagnostics([idle, active], "$100");
    expect(result.candidates[0].id).toBe(active.id); expect(result.mode).toBe("fallback");
    expect(result.diagnostics).toEqual(["RANK_PROVIDER_UNAVAILABLE"]);
  });
  it("does not let high modeled fees displace substantially greater sustained volume", async () => {
    const speculative = candidate("a", 692, { netLpFeePercent: 4.762233, traderFeePercent: 4.862233, activeDepthUsd: 36, estimatedBudgetSharePercent: 9.326, swapsHour: 7 });
    const established = candidate("b", 397923, { volumeSixHourUsd: 3398376, volumeDayUsd: 8350359, netLpFeePercent: .83333, traderFeePercent: 1, activeDepthUsd: 6303, estimatedBudgetSharePercent: .06494 });
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ ranking: [speculative, established].map(p => ({ id: p.id, reasons: ["active_trading", "range_risk"] })) }));
    const result = await rankLiquidityPoolsWithDiagnostics([speculative, established], "$100");
    expect(result.candidates[0].id).toBe(established.id); expect(result.mode).toBe("repaired");
    expect(result.diagnostics).toContain("VOLUME_OR_RISK_ORDER_REPAIRED");
  });
  it("allows grounded AI comparisons between similarly active pools", async () => {
    const a = candidate("a", 1000), b = candidate("b", 800);
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ ranking: [b, a].map(p => ({ id: p.id, reasons: ["active_trading", "low_trader_cost"] })) }));
    const result = await rankLiquidityPoolsWithDiagnostics([a, b], "$100");
    expect(result.candidates.map(p => p.id)).toEqual([b.id, a.id]); expect(result.mode).toBe("ai");
  });
  it("does not force every pool to have one benefit and one downside", async () => {
    const strong = candidate("a", 2000, { volumeSixHourUsd: 12000, volumeDayUsd: 48000, reserveUsd: 100000 });
    const difficult = candidate("b", 0, { volumeSixHourUsd: 100, volumeDayUsd: 500, traderFeePercent: 9, netLpFeePercent: 8, activeDepthUsd: 10 });
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ ranking: [
      { id: strong.id, reasons: ["strong_recent_volume", "sustained_activity", "low_trader_cost"] },
      { id: difficult.id, reasons: ["quiet_recently", "very_high_trader_fee", "thin_depth"] },
    ] }));
    const result = await rankLiquidityPoolsWithDiagnostics([strong, difficult], "$100");
    expect(result.mode).toBe("ai");
    expect(result.candidates[0].reasons).toEqual(["strong_recent_volume", "sustained_activity", "low_trader_cost"]);
    expect(result.candidates[1].reasons).toEqual(["quiet_recently", "very_high_trader_fee", "thin_depth"]);
  });
  it("accepts a single material observation instead of padding the list", async () => {
    const quiet = candidate("a", 0, { volumeSixHourUsd: 10, volumeDayUsd: 100, traderFeePercent: 0.5, netLpFeePercent: 0.5, activeDepthUsd: 5000 });
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ ranking: [{ id: quiet.id, reasons: ["quiet_recently"] }] }));
    const result = await rankLiquidityPoolsWithDiagnostics([quiet], "$100");
    expect(result.mode).toBe("ai");
    expect(result.candidates[0].reasons).toEqual(["quiet_recently"]);
  });
  it("repairs one invalid reason without throwing away a valid ranking", async () => {
    const a = candidate("a", 1000), b = candidate("b", 800, { traderFeePercent: 1 });
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ ranking: [
      { id: b.id, reasons: ["low_trader_cost", "range_risk"] }, { id: a.id, reasons: ["active_trading", "range_risk"] },
    ] }));
    const result = await rankLiquidityPoolsWithDiagnostics([a, b], "$100");
    expect(result.candidates.map(p => p.id)).toEqual([b.id, a.id]);
    expect(result.candidates[0].reasons).not.toContain("low_trader_cost");
    expect(result.candidates[0].reasons).toContain("high_trader_fee");
    expect(result.diagnostics).toEqual(["POOL_REASONS_REPAIRED"]);
  });
  it("rejects invented IDs and persists a safe diagnostic", async () => {
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ ranking: [{ id: "invented", reasons: ["fee_paying", "range_risk"] }] }));
    const result = await rankLiquidityPoolsWithDiagnostics([candidate("a", 1000)], "$100");
    expect(result.mode).toBe("fallback"); expect(result.diagnostics).toEqual(["UNKNOWN_POOL"]);
  });
  it("warns about incomplete RPC coverage without broadly labeling imperfect pools higher risk", () => {
    const d = newLiquidityDraft("open"); d.phase = "pool";
    d.candidates = [candidate("a", 692, { traderFeePercent: 5, activeDepthUsd: 36, swapsHour: 7 })];
    d.analysis = { checkedAt: 1, stage: "high", summaries: 20, checkedPools: 12, verifiedPools: 1, diagnostics: ["DESCRIPTOR_LOOKUP_FAILED"] };
    const text = liquidityResponseLines(d, "LQ-12345678").join("\n");
    expect(text).toContain("comparison may be incomplete"); expect(text).not.toContain("higher risk"); expect(text).not.toContain("earnings forecast");
  });
  it("uses the higher-risk headline only for extreme pool conditions", () => {
    const d = newLiquidityDraft("open"); d.phase = "pool";
    d.candidates = [candidate("a", 100, { traderFeePercent: 9, activeDepthUsd: 100, swapsHour: 20 })];
    d.analysis = { checkedAt: 1, stage: "high", summaries: 20, checkedPools: 1, verifiedPools: 1, diagnostics: [] };
    expect(liquidityResponseLines(d, "LQ-12345678").join("\n")).toContain("higher risk");
  });
  it("does not advertise an earnings ranking based on depth alone", () => {
    const d = newLiquidityDraft("open"); d.phase = "pool";
    d.candidates = [candidate("a", 100, { volumeHourUsd: null, volumeSixHourUsd: null, volumeDayUsd: null })];
    expect(liquidityResponseLines(d, "LQ-12345678").join("\n")).toContain("Volume couldn't be determined, so these options are unranked.");
  });
});
