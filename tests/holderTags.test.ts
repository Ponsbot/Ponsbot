import { describe, expect, it } from "vitest";
import { holderTag, PONS_V2_LAUNCH_LOCKER } from "../lib/holder-tags";

describe("holder labels", () => {
  it("labels the exact Pons V2 launch locker before generic liquidity", () => {
    expect(holderTag(PONS_V2_LAUNCH_LOCKER.toUpperCase(), undefined, PONS_V2_LAUNCH_LOCKER, "Liquidity Locker"))
      .toBe("Pons V2 Launch Locker");
  });

  it("retains creator and versioned Uniswap liquidity labels", () => {
    expect(holderTag("0xcreator", "0xcreator", undefined)).toBe("Creator");
    expect(holderTag("0xpool", undefined, undefined, "Uniswap V4 PoolManager")).toBe("Uniswap V4 Liquidity");
  });

  it("labels the pre-graduation liquidity address as the bonding curve", () => {
    expect(holderTag("0xcurve", undefined, "0xcurve", "Pons Curve", false)).toBe("Bonding Curve");
    expect(holderTag("0xcurve", undefined, "0xcurve", "Liquidity", true)).toBe("Liquidity");
  });
});
