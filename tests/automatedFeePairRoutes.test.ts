import { describe, expect, it } from "vitest";
import { AUTOMATED_FEE_PAIR_ROUTES } from "../lib/automated-fee-pair-routes";
import { PONS_PAIR_CATALOG } from "../lib/pair-catalog";

describe("automated fee paired-asset routes", () => {
  it("covers each reviewed executable pair route exactly once", () => {
    expect(AUTOMATED_FEE_PAIR_ROUTES.length).toBeLessThanOrEqual(PONS_PAIR_CATALOG.length);
    expect(new Set(AUTOMATED_FEE_PAIR_ROUTES.map((route) => route.pairAsset.toLowerCase())).size)
      .toBe(AUTOMATED_FEE_PAIR_ROUTES.length);
    expect(AUTOMATED_FEE_PAIR_ROUTES.map((route) => route.symbol)).not.toEqual(expect.arrayContaining(["TSM", "RBLX"]));
  });

  it("uses strict direct V3 or V4 route shapes", () => {
    for (const route of AUTOMATED_FEE_PAIR_ROUTES) {
      expect(route.fee).toBeGreaterThan(0);
      if (route.kind === "v3") expect(route.tickSpacing).toBe(0);
      else expect(route.tickSpacing).not.toBe(0);
    }
  });
});
