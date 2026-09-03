import { describe, expect, it } from "vitest";
import { xCashtagSafeText } from "../lib/x-cashtag-policy";

describe("X cashtag publication policy", () => {
  it("keeps one distinct ticker and renders later tickers as plain symbols", () => {
    expect(xCashtagSafeText("$PONS claimed fees and burned $PONSBOT. $PONS remains active."))
      .toBe("$PONS claimed fees and burned PONSBOT. $PONS remains active.");
  });

  it("does not alter dollar amounts", () => {
    expect(xCashtagSafeText("Bought $100 each of $AAA, $BBB, and $CCC."))
      .toBe("Bought $100 each of $AAA, BBB, and CCC.");
  });

  it("makes expanded symbol lists safe", () => {
    const result = xCashtagSafeText("Pairs: $NVDA • $SPCX • $ETH");
    expect(result).toBe("Pairs: $NVDA • SPCX • ETH");
  });
});
