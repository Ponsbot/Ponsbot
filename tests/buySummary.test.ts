import { describe, expect, it } from "vitest";
import { commandSummary } from "../convex/wallets";

describe("buy summary units", () => {
  it("does not duplicate the asset for token-denominated buys", () => {
    expect(commandSummary({kind:"buy",amount:"1",unit:"token",token:"PONSBOT",slippageBps:250})).toBe("Bought 1 $PONSBOT!");
    expect(commandSummary({kind:"buy_and_burn",amount:"1",unit:"token",token:"PONSBOT",slippageBps:250})).toBe("Bought 1 $PONSBOT and burned the purchased tokens!");
  });
  it("retains spend units for dollar and ETH buys", () => {
    expect(commandSummary({kind:"buy",amount:"10",unit:"usd",token:"PONSBOT",slippageBps:250})).toBe("Bought $10 of $PONSBOT!");
    expect(commandSummary({kind:"buy",amount:"0.1",unit:"eth",token:"PONSBOT",slippageBps:250})).toBe("Bought 0.1 ETH of $PONSBOT!");
  });
});
