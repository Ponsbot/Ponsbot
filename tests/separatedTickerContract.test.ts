import { describe, expect, it } from "vitest";
import { groundedCanonicalCommand } from "../convex/xWalletIntent";
import { explicitTickerContractPairs } from "../convex/wallets";

const address = "0xdba76f1cf96dbef90e5e1083b70d15ce6e87b76a";
describe("separated ticker and contract", () => {
  it("accepts the WSBonHOOD burn and retains its identity verification", () => {
    const text = `Another $WSB burn directly on the timeline! Watch the supply vanish. 🔥 👇 @Ponsbotfamily burn 1000000 ${address} Study the architectural alpha. We're here to stay. 🏁 #WallStBrett #RWA #Memecoin #Robinhood #TokenBurn`;
    expect(groundedCanonicalCommand(text)).toMatchObject({ kind: "burn", amount: "1000000", token: address });
    expect(explicitTickerContractPairs(text)).toEqual([{ ticker: "WSB", address }]);
  });
  it.each(["buy $14 of", "sell 10", "burn 10"])("accepts separated identifiers for %s", action => {
    const text = `For $WSB: @Ponsbotfamily ${action} ${address}`;
    expect(groundedCanonicalCommand(text)?.kind).not.toBeUndefined();
    expect(explicitTickerContractPairs(text)).toEqual([{ ticker: "WSB", address }]);
  });
  it("does not associate a recipient with a ticker", () => {
    expect(explicitTickerContractPairs(`send 10 $WSB to ${address}`)).toEqual([]);
    expect(explicitTickerContractPairs(`buy $10 of $WSB and send to ${address}`)).toEqual([]);
  });
  it("keeps multiple tickers ambiguous", () => {
    expect(groundedCanonicalCommand(`$WSB and $OTHER: burn 10 ${address}`)).toBeNull();
    expect(explicitTickerContractPairs(`$WSB and $OTHER: burn 10 ${address}`)).toEqual([]);
  });
});
