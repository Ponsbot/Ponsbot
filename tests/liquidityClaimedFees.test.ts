import { describe, expect, it } from "vitest";
import { mergeLiquidityClaimedFees, parseLiquidityClaimedFee } from "../lib/liquidity-claimed-fees";

describe("liquidity claimed fee accounting", () => {
  it("accepts the USD-valued receipt format used by LP claims", () => {
    expect(parseLiquidityClaimedFee("1,234.5 PONSBOT ($67.89)")).toEqual({ symbol: "PONSBOT", amount: "1234.5", usd: 67.89 });
    expect(parseLiquidityClaimedFee("0.00125 ETH")).toEqual({ symbol: "ETH", amount: "0.00125" });
  });

  it("merges repeated claims by normalized asset symbol", () => {
    expect(mergeLiquidityClaimedFees(
      [{ symbol: "eth", amount: "0.01", usd: 25 }],
      [{ symbol: "ETH", amount: "0.02", usd: 50 }],
    )).toEqual([{ symbol: "ETH", amount: "0.03", usd: 75 }]);
  });

  it("rejects arbitrary receipt text", () => {
    expect(parseLiquidityClaimedFee("LP-123: 1 ETH ($2,000)")).toBeUndefined();
  });
});
