import { describe, expect, it } from "vitest";
import { countAgentTrade, isSecondaryAgentToken, secondaryAgentTokens, secondaryTradeAvailable } from "../lib/trading-agents/universe";

describe("agent secondary trade quota", () => {
  it("requires four primary fills for each secondary fill", () => {
    expect(secondaryTradeAvailable()).toBe(false);
    expect(secondaryTradeAvailable({ platform: 3, secondary: 0 })).toBe(false);
    expect(secondaryTradeAvailable({ platform: 4, secondary: 0 })).toBe(true);
    expect(secondaryTradeAvailable({ platform: 4, secondary: 1 })).toBe(false);
    expect(secondaryTradeAvailable({ platform: 8, secondary: 1 })).toBe(true);
  });
  it("uses canonical addresses, not symbols", () => {
    expect(isSecondaryAgentToken("0x39dBED3a2bd333467115dE45665cC57F813C4571")).toBe(true);
    expect(isSecondaryAgentToken("0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07")).toBe(false);
    expect(isSecondaryAgentToken("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(secondaryAgentTokens.length).toBeGreaterThan(10);
  });
  it("counts persistently without mutating the previous snapshot", () => {
    const mix = { platform: 4, secondary: 0 };
    expect(countAgentTrade(mix, "secondary")).toEqual({ platform: 4, secondary: 1 });
    expect(mix.secondary).toBe(0);
  });
});
