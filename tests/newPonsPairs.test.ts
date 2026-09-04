import { describe, expect, it } from "vitest";
import { PONS_PAIR_CATALOG, PUBLISHED_PAIR_SYMBOLS } from "../lib/pair-catalog";
import { knownLaunchPairTicker } from "../convex/walletCommands";

const additions = ["AMC", "SGOV", "BABA", "INDA", "IBM", "NFLX", "BULL", "NU", "SLV", "SHOP", "BE", "F"];

describe("new Pons quote assets", () => {
  it("publishes and indexes each exactly once", () => {
    for (const symbol of additions) {
      expect(PUBLISHED_PAIR_SYMBOLS.filter(value => value === symbol)).toHaveLength(1);
      expect(PONS_PAIR_CATALOG.filter(([, value]) => value === symbol)).toHaveLength(1);
    }
  });
  it.each([
    ["Alibaba", "BABA"], ["Ford", "F"], ["iShares Silver Trust", "SLV"],
    ["iShares MSCI India ETF", "INDA"], ["Webull", "BULL"], ["Bloom Energy", "BE"],
    ["AMC Entertainment", "AMC"], ["iShares 0-3 Month Treasury Bond ETF", "SGOV"],
    ["Netflix", "NFLX"], ["Nu Holdings", "NU"], ["Shopify", "SHOP"],
  ])("recognizes %s as %s", (name, symbol) => expect(knownLaunchPairTicker(name)).toBe(symbol));
});
