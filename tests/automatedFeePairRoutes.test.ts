import { describe, expect, it } from "vitest";
import { AUTOMATED_FEE_PAIR_ROUTES } from "../lib/automated-fee-pair-routes";
import { PONS_PAIR_CATALOG } from "../lib/pair-catalog";
import catalog from "../lib/pons-pair-catalog.json";

describe("automated fee paired-asset routes", () => {
  it("covers every verified route exactly once without inventing routes for unsupported assets", () => {
    expect(AUTOMATED_FEE_PAIR_ROUTES).toHaveLength(catalog.filter(entry => "route" in entry).length);
    // Explicit exception: a newly missing route must fail this test, not silently disappear.
    expect(catalog.filter(entry => !("route" in entry)).map(entry => entry.symbol)).toEqual(["wsNET"]);
    for (const route of AUTOMATED_FEE_PAIR_ROUTES) expect(PONS_PAIR_CATALOG.some(([address]) => address.toLowerCase() === route.pairAsset.toLowerCase())).toBe(true);
    expect(new Set(AUTOMATED_FEE_PAIR_ROUTES.map((route) => route.pairAsset.toLowerCase())).size)
      .toBe(AUTOMATED_FEE_PAIR_ROUTES.length);
  });

  it("uses strict direct V3 or V4 route shapes", () => {
    for (const route of AUTOMATED_FEE_PAIR_ROUTES) {
      expect(route.fee).toBeGreaterThan(0);
      if (route.kind === "v3") expect(route.tickSpacing).toBe(0);
      else expect(route.tickSpacing).not.toBe(0);
    }
  });
});
