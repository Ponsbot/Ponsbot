import { describe, expect, it } from "vitest";
import catalog from "../lib/pons-pair-catalog.json";
import { PONS_PAIR_CATALOG, PUBLISHED_PAIR_SYMBOLS } from "../lib/pair-catalog";
import { knownLaunchPairTicker, parseWalletCommand } from "../convex/walletCommands";
import { AUTOMATED_FEE_PAIR_ROUTES } from "../lib/automated-fee-pair-routes";
import { walletHelpMessage } from "../convex/xWalletIntent";

const assets = [
  ["V", "Visa", "0x9BFF87700337babF5099e99F322F888DafB1d551"],
  ["JPM", "JPMorgan Chase", "0x07c44dA0848960bFf894F17584dB8B2F60B2409E"],
  ["MCD", "McDonald's", "0x2fdaa4604F10F4AE7f66fa48A174bCd25b1ece20"],
  ["GDX", "VanEck Gold Miners ETF", "0xBDFa7A06458Aa26b8E736E0fC87aD37C3BB8Ac2e"],
  ["PYPL", "PayPal", "0xa45aBDc77918F7B9199b022eEe400C0BC5712BD2"],
  ["BMNR", "BitMine Immersion Technologies", "0x9a7842EDed60b0FE1e03eEc342C82A397c821eD0"],
  ["DIS", "Disney", "0x501B1B3B79750313AD2C4CcCD08586c4C17d7283"],
  ["UBER", "Uber", "0xbd335Aa5A1693F0121A5c0Ef18A080E9958DA78b"],
] as const;

describe("October 29 approved Pons assets", () => {
  it.each(assets)("integrates %s into the index, help, parser and fee routes", (symbol, name, address) => {
    expect(PONS_PAIR_CATALOG.filter(([, s]) => s === symbol)).toHaveLength(1);
    expect(PONS_PAIR_CATALOG.find(([, s]) => s === symbol)).toEqual([address, symbol, name, 18]);
    expect(PUBLISHED_PAIR_SYMBOLS.filter(s => s === symbol)).toHaveLength(1);
    for (const input of [symbol, "$" + symbol.toLowerCase(), name.toLowerCase()]) {
      expect(knownLaunchPairTicker(input)).toBe(symbol);
      expect(parseWalletCommand(`launch Example ticker EXAMPLE pair with ${input}`)).toMatchObject({ kind: "launch", pairToken: symbol });
    }
    expect(walletHelpMessage("pairs")).toContain(symbol);
    expect(AUTOMATED_FEE_PAIR_ROUTES.find(r => r.symbol === symbol)).toMatchObject({
      pairAsset: address, kind: symbol === "BMNR" ? "v3" : "v4",
      fee: symbol === "BMNR" ? 10000 : 50000, tickSpacing: symbol === "BMNR" ? 0 : 500,
    });
  });
  it("keeps catalog identities unique and the published native/stable assets last", () => {
    expect(new Set(catalog.map(p => p.address.toLowerCase())).size).toBe(catalog.length);
    expect(new Set(catalog.map(p => p.symbol.toLowerCase())).size).toBe(catalog.length);
    expect(PUBLISHED_PAIR_SYMBOLS.slice(-3)).toEqual(["cbBTC", "USDG", "ETH"]);
  });
});
