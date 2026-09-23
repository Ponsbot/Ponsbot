import { describe, expect, it } from "vitest";
import { PONS_PAIR_CATALOG, PUBLISHED_PAIR_SYMBOLS } from "../lib/pair-catalog";
import { knownLaunchPairTicker, parseWalletCommand } from "../convex/walletCommands";
import { AUTOMATED_FEE_PAIR_ROUTES } from "../lib/automated-fee-pair-routes";

const additions = ["AMC", "SGOV", "BABA", "INDA", "IBM", "NFLX", "BULL", "NU", "SLV", "SHOP", "BE", "F", "TAO", "ORBIO", "SHROOM", "INDEX"];

describe("new Pons quote assets", () => {
  it.each([
    ["ORBIO", "Orbio.so", "0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3", "v4", 9000],
    ["SHROOM", "Mushroom", "0xab093def657f15df31b33922a95e047add645b29", "v3", 10000],
    ["INDEX", "The Index", "0x56910d4409f3a0c78c64dd8d0545ff0705389870", "v3", 10000],
  ])("supports verified non-catalog %s in paired launches and fee routes", (symbol, name, address, kind, fee) => {
    expect(PONS_PAIR_CATALOG.find(([,s])=>s===symbol)?.[0]).toBe(address);
    for(const identifier of [symbol, "$"+symbol, String(name).toLowerCase()])
      expect(parseWalletCommand(`launch Test ticker TEST pair with ${identifier}`)).toMatchObject({kind:"launch",pairToken:symbol});
    expect(AUTOMATED_FEE_PAIR_ROUTES.find(r=>r.symbol===symbol)).toMatchObject({pairAsset:address,kind,fee});
  });
  it("publishes and indexes each exactly once", () => {
    for (const symbol of additions) {
      expect(PUBLISHED_PAIR_SYMBOLS.filter(value => value === symbol)).toHaveLength(1);
      expect(PONS_PAIR_CATALOG.filter(([, value]) => value === symbol)).toHaveLength(1);
    }
  });
  it.each([
    ["Orbio.so", "ORBIO"], ["orBIO", "ORBIO"], ["$ORBIO", "ORBIO"],
    ["Mushroom", "SHROOM"], ["shroom", "SHROOM"], ["$SHROOM", "SHROOM"],
    ["The Index", "INDEX"], ["Index", "INDEX"], ["index", "INDEX"], ["$Index", "INDEX"],
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
