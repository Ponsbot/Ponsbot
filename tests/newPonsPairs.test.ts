import { describe, expect, it } from "vitest";
import { PONS_PAIR_CATALOG, PUBLISHED_PAIR_SYMBOLS } from "../lib/pair-catalog";
import { knownLaunchPairTicker } from "../convex/walletCommands";

const additions = ["AMC", "SGOV", "BABA", "INDA", "IBM", "NFLX", "BULL", "NU", "SLV", "SHOP", "BE", "F", "TAO"];

describe("new Pons quote assets", () => {
  it("publishes and indexes each exactly once", () => {
    for (const symbol of additions) {
      expect(PUBLISHED_PAIR_SYMBOLS.filter(value => value === symbol)).toHaveLength(1);
      expect(PONS_PAIR_CATALOG.filter(([, value]) => value === symbol)).toHaveLength(1);
    }
  });
  it.each([
    ["Bittensor", "TAO"], ["bittensor", "TAO"], ["tao", "TAO"], ["$TAO", "TAO"],
    ["Alibaba", "BABA"], ["Ford", "F"], ["iShares Silver Trust", "SLV"],
    ["iShares MSCI India ETF", "INDA"], ["Webull", "BULL"], ["Bloom Energy", "BE"],
    ["AMC Entertainment", "AMC"], ["iShares 0-3 Month Treasury Bond ETF", "SGOV"],
    ["Netflix", "NFLX"], ["Nu Holdings", "NU"], ["Shopify", "SHOP"],
  ])("recognizes %s as %s", (name, symbol) => expect(knownLaunchPairTicker(name)).toBe(symbol));
  it("pins the verified TAO address and keeps cbBTC, USDG, ETH last", () => {
    expect(PONS_PAIR_CATALOG.find(([, symbol]) => symbol === "TAO")).toEqual([
      "0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67", "TAO", "Bittensor", 18,
    ]);
    expect(PUBLISHED_PAIR_SYMBOLS.slice(-3)).toEqual(["cbBTC", "USDG", "ETH"]);
  });
});
