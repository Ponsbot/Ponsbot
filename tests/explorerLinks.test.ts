import { describe, expect, it } from "vitest";
import { currentExplorerLinks } from "../lib/explorer-links";
import { splitTerminalMessage } from "../lib/terminal-message";
describe("Robinhood Etherscan explorer links", () => {
  const address = `0x${"1".repeat(40)}`;
  it.each(["address", "tx", "token"])("upgrades saved %s links", path => {
    expect(currentExplorerLinks(`View https://robinhoodchain.blockscout.com/${path}/${address}`))
      .toBe(`View https://robin.etherscan.io/${path}/${address}`);
  });
  it("converts NFT and transaction-history paths without losing precision", () => {
    expect(currentExplorerLinks(`https://robinhoodchain.blockscout.com/token/${address}/instance/900719925474099312345`))
      .toBe(`https://robin.etherscan.io/nft/${address}/900719925474099312345`);
    expect(currentExplorerLinks(`https://robinhoodchain.blockscout.com/address/${address}?tab=txs`))
      .toBe(`https://robin.etherscan.io/address/${address}#transactions`);
  });
  it("does not change backend data APIs or unrelated hosts", () => {
    for (const url of ["https://robinhoodchain.blockscout.com/api/v2/addresses/123", "https://example.com/token/123", "https://robinhoodchain.blockscout.com.evil.test/token/123"])
      expect(currentExplorerLinks(url)).toBe(url);
  });
  it("renders historical terminal links using the current explorer", () => {
    expect(splitTerminalMessage(`TXN: https://robinhoodchain.blockscout.com/tx/${address}.`))
      .toEqual(["TXN: ", { url: `https://robin.etherscan.io/tx/${address}`, suffix: "." }]);
  });
});
