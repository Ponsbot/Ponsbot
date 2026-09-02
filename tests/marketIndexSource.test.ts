import { describe, expect, it } from "vitest";
import { CATALOG_GECKO_REFRESH_MS, catalogMarketRefreshDue, CURRENT_MARKET_CAP_TTL_MS, freshMarketCap, geckoLiquidityMarketCap, geckoLiquidityTotalSupplyMarketCap, geckoMarketCap, v4TokenTradeKind } from "../lib/market-index-policy";

describe("market index source selection", () => {
  it("prefers a verified Gecko market cap over FDV", () => {
    expect(geckoMarketCap("125000", "150000")).toBe(125000);
  });

  it("uses Gecko FDV for an unverified newly launched token", () => {
    expect(geckoMarketCap(null, "150000")).toBe(150000);
  });

  it("uses total-supply valuation for liquidity bounds", () => {
    expect(geckoLiquidityMarketCap("210000000", "420000000")).toBe(420000000);
    expect(geckoLiquidityMarketCap("210000000", null)).toBe(210000000);
    expect(geckoLiquidityTotalSupplyMarketCap("0.4745", "1000000000", "335000000", "336000000")).toBe(474500000);
    expect(geckoLiquidityTotalSupplyMarketCap(null, "1000000000", "335000000", "336000000")).toBe(336000000);
  });

  it("rejects missing and invalid Gecko values", () => {
    expect(geckoMarketCap(null, null)).toBeUndefined();
    expect(geckoMarketCap("0", "not-a-number")).toBeUndefined();
  });

  it("reuses the shared value only within the fallback TTL", () => {
    const now = 1_000_000;
    expect(freshMarketCap(100_000, now - CURRENT_MARKET_CAP_TTL_MS + 1, now)).toBe(true);
    expect(freshMarketCap(100_000, now - CURRENT_MARKET_CAP_TTL_MS, now)).toBe(false);
    expect(freshMarketCap(undefined, now, now)).toBe(false);
  });

  it("refreshes the complete Gecko catalog every fifteen minutes", () => {
    const now = 10_000_000;
    expect(catalogMarketRefreshDue(undefined, now)).toBe(true);
    expect(catalogMarketRefreshDue(now - CATALOG_GECKO_REFRESH_MS + 1, now)).toBe(false);
    expect(catalogMarketRefreshDue(now - CATALOG_GECKO_REFRESH_MS, now)).toBe(true);
  });

  it("uses the V4 BalanceDelta sign convention for indexed buys and sells", () => {
    expect(v4TokenTradeKind(10n)).toBe("buy");
    expect(v4TokenTradeKind(-10n)).toBe("sell");
    expect(v4TokenTradeKind(0n)).toBeUndefined();
  });
});
