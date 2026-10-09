import { describe, expect, it } from "vitest";
import { PONS_PAIR_CATALOG, PUBLISHED_PAIR_SYMBOLS } from "../lib/pair-catalog";
import { knownLaunchPairTicker, parseWalletCommand } from "../convex/walletCommands";
import { AUTOMATED_FEE_PAIR_ROUTES } from "../lib/automated-fee-pair-routes";
const assets = [{"address":"0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D","symbol":"P","name":"Everpure","decimals":18},{"address":"0x156E175DD063a8cE274C50654eF40e0032b3fbcF","symbol":"AVGO","name":"Broadcom","decimals":18},{"address":"0x9D9c6684F596F66a64C030B93A886D51Fd4D7931","symbol":"NBIS","name":"Nebius Group","decimals":18},{"address":"0xb0992820E760d836549ba69BC7598b4af75dEE03","symbol":"ORCL","name":"Oracle","decimals":18},{"address":"0x9b23573b156B52565012F5cE02CDF60AFBaa70Be","symbol":"PENG","name":"Penguin Solutions","decimals":18},{"address":"0x27c99fBde9D0d2AA4f4Bfb4943f237843DdF6958","symbol":"DDOG","name":"Datadog","decimals":18},{"address":"0x75742c18BC1f1C5c5f448f4C9D9C6F66dafAAa38","symbol":"SOXX","name":"iShares Semiconductor ETF","decimals":18}];
describe("October Pons pairing assets", () => {
  it.each(assets)("indexes and parses $symbol", ({ symbol, address, name }) => {
    expect(PONS_PAIR_CATALOG.filter(([,s])=>s===symbol)).toHaveLength(1);
    expect(PONS_PAIR_CATALOG.find(([,s])=>s===symbol)?.[0]).toBe(address);
    expect(PUBLISHED_PAIR_SYMBOLS.filter(s=>s===symbol)).toHaveLength(1);
    for (const input of [symbol, "$"+symbol.toLowerCase(), name.toLowerCase()]) {
      expect(knownLaunchPairTicker(input)).toBe(symbol);
      expect(parseWalletCommand("launch Example ticker EXAMPLE pair with "+input)).toMatchObject({kind:"launch",pairToken:symbol});
    }
    expect(AUTOMATED_FEE_PAIR_ROUTES.find(r=>r.symbol===symbol)).toMatchObject({pairAsset:address,kind:"v4",fee:50000,tickSpacing:["NBIS","ORCL"].includes(symbol)?1000:500});
  });
  it("preserves the published list ending", () => expect(PUBLISHED_PAIR_SYMBOLS.slice(-3)).toEqual(["cbBTC","USDG","ETH"]));
});

