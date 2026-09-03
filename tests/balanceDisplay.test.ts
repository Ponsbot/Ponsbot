import { describe, expect, it } from "vitest";
import { balanceWithUsd, formatBalanceUsd } from "../lib/balance-display";

describe("balance USD display", () => {
  it("formats ordinary and small dollar values", () => {
    expect(formatBalanceUsd(1234.567)).toBe("≈$1,234.57");
    expect(formatBalanceUsd(0.000012345)).toBe("≈$0.0000123");
  });

  it("appends a price without hiding the asset amount", () => {
    expect(balanceWithUsd("10 PONSBOT", 12.34)).toBe("10 PONSBOT (≈$12.34)");
    expect(balanceWithUsd("10 UNKNOWN", undefined)).toBe("10 UNKNOWN");
  });
});
