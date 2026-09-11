import { describe, expect, it } from "vitest";
import { PONS_PAIR_CATALOG, PUBLISHED_PAIR_SYMBOLS } from "../lib/pair-catalog";
import { knownLaunchPairTicker, parseWalletCommand } from "../convex/walletCommands";
import { AUTOMATED_FEE_PAIR_ROUTES } from "../lib/automated-fee-pair-routes";
const verified = [["0xBa0CAB75495255d0cB58E22B648bFED4ECD1F47E","SNOW","Snowflake"],["0xFDE6b5d9BB419B10C23268c74e369AbFF39C0460","RCAT","Red Cat"],["0x7f0aBeF0C07280F82c6a08ead09dEd6BAE2C13Fc","EWY","iShares MSCI South Korea ETF"],["0x329fcACEb9AD6F9580DD5F643fed0646900D043c","LMT","Lockheed Martin"],["0xc72b96e0E48ecd4DC75E1e45396e26300BC39681","INTC","Intel"],["0x116F00968269B7bfbaD4109cE591d6E74c0601d4","NET","Cloudflare"],["0x4D21483a44Bf67a86b77E3dA301411880797D452","BA","Boeing"],["0x3b14C39E89D60D627b42a1A4CA45b5bb45Fc12e2","RKLB","Rocket Lab"],["0xaE517A2903E68bd929Dfd15be875F8369D53e94a","CEG","Constellation Energy"],["0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4","QUBT","Quantum Computing"]];
describe("September verified Pons pairs", () => {
  it.each(verified)("indexes verified address %s as %s", (address, symbol, name) => {
    expect(PONS_PAIR_CATALOG.filter(([, s]) => s === symbol)).toEqual([[address, symbol, name, 18]]);
    expect(PUBLISHED_PAIR_SYMBOLS.filter(s => s === symbol)).toHaveLength(1);
    expect(knownLaunchPairTicker(name)).toBe(symbol);
    expect(knownLaunchPairTicker(symbol.toLowerCase())).toBe(symbol);
    expect(knownLaunchPairTicker("$" + symbol)).toBe(symbol);
    for (const identifier of [name, symbol.toLowerCase(), "$" + symbol]) {
      expect(parseWalletCommand(`launch Market Test ticker PTEST pair with ${identifier}`)).toMatchObject({kind: "launch", pairToken: symbol});
    }
    expect(AUTOMATED_FEE_PAIR_ROUTES.filter(r => r.pairAsset.toLowerCase() === address.toLowerCase())).toHaveLength(1);
  });
  it("does not publish unapproved GLXY or invent SEWY", () => {
    expect(PUBLISHED_PAIR_SYMBOLS).not.toContain("GLXY");
    expect(PUBLISHED_PAIR_SYMBOLS).not.toContain("SEWY");
    expect(PUBLISHED_PAIR_SYMBOLS.slice(-3)).toEqual(["cbBTC", "USDG", "ETH"]);
  });
});
