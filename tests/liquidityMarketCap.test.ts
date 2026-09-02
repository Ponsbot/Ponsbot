import { describe, expect, it, vi } from "vitest";
import { liquidityMarketCapInput, parseLiquidityMarketCap } from "../lib/liquidity-market-cap";
import { liquidityMarketCapBands, liquiditySqrtTick } from "../lib/liquidity-math";
import { newLiquidityDraft, updateLiquidityFields, validateLiquidityReview, liquidityStepFields } from "../lib/liquidity-workflow";
import { liquidityResponseLines } from "../lib/liquidity-responses";
import { liquidityMarketCapRangeSchema } from "../lib/liquidity-quote";
vi.mock("../convex/llm", () => ({ openRouter: vi.fn() }));
import { openRouter } from "../convex/llm";
import { extractLiquidityFields, liquidityEvidenceMatches } from "../convex/liquidityAi";

describe("USD market-cap range inputs", () => {
  it.each(["$50k to $150k MCap", "$50,000 to $150,000", "range 50000-150000", "from 50 thousand to 150 thousand market cap"])("parses %s as a range, not a spending budget", text => {
    expect(liquidityMarketCapInput(text, true)).toEqual({ lowerMarketCapUsd: 50000, upperMarketCapUsd: 150000 });
  });
  it.each(["$0", "-1", "Infinity", "1e6", "$10000000000000000"])("rejects invalid MCap %s", value => expect(parseLiquidityMarketCap(value)).toBeUndefined());
  it.each(["what if the range is $50k to $150k", "buy $50k to $150k", "25% below and 25% above", "50k or 150k", "50k to 150k and buy more"])("leaves ambiguous or unrelated text to intent parsing: %s", text => expect(liquidityMarketCapInput(text, true)).toBeNull());
  it("uses the range step context without invoking the AI or changing the deposit amount", async () => {
    vi.mocked(openRouter).mockClear();
    const draft = newLiquidityDraft("open", { token: "PONSBOT", amount: "100", unit: "usd" }); draft.phase = "range";
    const parsed = await extractLiquidityFields("$50k to $150k MCap", draft);
    expect(parsed.fields).toEqual({ lowerMarketCapUsd: 50000, upperMarketCapUsd: 150000 });
    expect(updateLiquidityFields(draft, parsed.fields).fields.amount).toBe("100");
    expect(openRouter).not.toHaveBeenCalled();
  });
  it("updates an existing quote with absolute bounds and discards legacy percentages and approval", () => {
    let d = newLiquidityDraft("open", { token: "PONSBOT", amount: "100", unit: "usd", pair: "ETH", version: 4, feePips: 3000, tickSpacing: 60, downPercent: 25, upPercent: 25, shape: "bell" });
    d.custom = true; d.analyzed = true; d.symbol = "PONSBOT"; d.tokenAddress = `0x${"1".repeat(40)}`;
    d.executionPlanJson = "old-plan"; d.review = { hash: `0x${"1".repeat(64)}`, expiresAt: 100, executionReady: true };
    const fields = liquidityStepFields("range $50k to $150k", d)!;
    d = updateLiquidityFields(d, fields);
    expect(d.phase).toBe("review"); expect(d.fields.downPercent).toBeUndefined(); expect(d.fields.upPercent).toBeUndefined();
    expect(d.fields.bands).toBe(5); expect(d.review).toBeUndefined(); expect(d.executionPlanJson).toBeUndefined();
    validateLiquidityReview(d);
    expect(liquidityResponseLines(d, "LQ-12345678").join("\n")).toContain("MCap range: $50,000 to $150,000");
    expect(() => validateLiquidityReview(updateLiquidityFields(d, { lowerMarketCapUsd: 160000 }))).toThrow("LP_INVALID_MCAP_RANGE");
  });
  it("requires both dollar bounds rather than borrowing old percentages", () => {
    const d = newLiquidityDraft("open", { token: "PONSBOT", amount: "100", unit: "usd", pair: "ETH", version: 4, feePips: 3000, tickSpacing: 60, downPercent: 25, upPercent: 25 });
    d.custom = true; d.analyzed = true;
    expect(updateLiquidityFields(d, { lowerMarketCapUsd: 50000 }).phase).toBe("range");
  });
  it("grounds expanded abbreviations in AI evidence without inventing scales", () => {
    expect(liquidityEvidenceMatches("lowerMarketCapUsd", "50000", "$50k")).toBe(true);
    expect(liquidityEvidenceMatches("upperMarketCapUsd", "1500000", "1.5 million")).toBe(true);
    expect(liquidityEvidenceMatches("upperMarketCapUsd", "1500000", "1.5")).toBe(false);
  });
});

describe("absolute MCap conversion (no RPC)", () => {
  for (const tokenIs0 of [true, false]) for (const pairDecimals of [6, 18]) {
    it(`keeps absolute boundaries with tokenIs0=${tokenIs0}, pair decimals=${pairDecimals}`, () => {
      const supply = 1e9, pairedAssetUsd = pairDecimals === 6 ? 1.01 : 2000;
      const ratio = .001 / pairedAssetUsd * 10 ** (pairDecimals - 18);
      const tick = Math.floor(Math.log(tokenIs0 ? ratio : 1 / ratio) / Math.log(1.0001));
      const input = { lowerUsd: 750000, upperUsd: 1250000, supply, pairedAssetUsd, tokenDecimals: 18, pairDecimals, tokenIs0, sqrt: liquiditySqrtTick(tick), spacing: 60, count: 5, shape: "bell" as const };
      const { bands, range } = liquidityMarketCapBands(input);
      expect(bands).toHaveLength(5);
      expect(range.roundedLowerUsd).toBeLessThanOrEqual(750000);
      expect(range.roundedLowerUsd).toBeGreaterThan(750000 / 1.0001 ** 60);
      expect(range.roundedUpperUsd).toBeGreaterThanOrEqual(1250000);
      expect(range.roundedUpperUsd).toBeLessThan(1250000 * 1.0001 ** 60);
      const moved = liquidityMarketCapBands({ ...input, sqrt: liquiditySqrtTick(tick + 100) });
      expect(moved.bands).toEqual(bands); // Moving spot does NOT move the range.
      expect(moved.range.referenceUsd).not.toBe(range.referenceUsd);
    });
  }
  it.each([{ supply: 0 }, { supply: Infinity }, { pairedAssetUsd: 0 }, { lowerUsd: 2000000 }, { upperUsd: 0 }])("rejects invalid conversion inputs %j", patch => {
    const input = { lowerUsd: 500000, upperUsd: 1500000, supply: 1e6, pairedAssetUsd: 1, tokenDecimals: 18, pairDecimals: 18, tokenIs0: true, sqrt: liquiditySqrtTick(0), spacing: 60, count: 1, shape: "flat" as const };
    expect(() => liquidityMarketCapBands({ ...input, ...patch })).toThrow();
  });
  it("supports a one-sided position when the market is outside the requested bounds", () => {
    const result = liquidityMarketCapBands({ lowerUsd: 10000, upperUsd: 20000, supply: 1e6, pairedAssetUsd: 1, tokenDecimals: 18, pairDecimals: 18, tokenIs0: true, sqrt: liquiditySqrtTick(0), spacing: 60, count: 1, shape: "flat" });
    expect(result.bands).toHaveLength(1);
    expect(result.range.referenceUsd).toBeGreaterThan(result.range.upperUsd);
    expect(() => liquidityMarketCapRangeSchema.parse(result.range)).not.toThrow();
  });
});
