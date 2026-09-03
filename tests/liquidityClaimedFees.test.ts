import { describe, expect, it } from "vitest";
import { liquidityClaimTotalLine, mergeLiquidityClaimedFees, parseLiquidityClaimedFee } from "../lib/liquidity-claimed-fees";

it("totals claim assets in ETH, USDG, token order", () => {
  expect(liquidityClaimTotalLine(["LP-AAAA: 2 PONSBOT ($1)", "LP-BBBB: 3 USDG ($3)", "LP-AAAA: 0.01 ETH ($20)", "LP-BBBB: 0.02 ETH ($40)"]))
    .toBe("Total: 0.03 ETH ($60), 3 USDG ($3), 2 PONSBOT ($1)");
});
it("does not present partial dollar valuations as complete totals", () => {
  expect(liquidityClaimTotalLine(["1 ETH ($2)", "2 ETH"])).toBe("Total: 3 ETH");
  expect(liquidityClaimTotalLine(["1e-7 ETH ($<0.01)"])).toBe("Total: 0.0000001 ETH");
});

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
