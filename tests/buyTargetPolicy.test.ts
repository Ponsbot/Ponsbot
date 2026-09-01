import { describe, expect, it } from "vitest";
import { assertBuyTarget } from "../lib/buy-target-policy";
import { safeFailure } from "../convex/wallets";

describe("buy target validation", () => {
  it.each(["ETH", "$eth", "Ethereum", "0x" + "0".repeat(40)])("rejects native target %s", (target) => {
    expect(() => assertBuyTarget(target)).toThrow("BUY_TARGET_NATIVE_ETH");
  });
  it.each([undefined, "", "ONY", "1", "0x1234"])("rejects unresolved target %s", (target) => {
    expect(() => assertBuyTarget(target)).toThrow("BUY_TARGET_UNRESOLVED");
  });
  it("accepts resolved and mixed-case contracts without checksum rejection", () => {
    expect(() => assertBuyTarget("0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07")).not.toThrow();
  });
  it("provides specific messages instead of signer errors", () => {
    expect(safeFailure(new Error("BUY_TARGET_NATIVE_ETH"), "buy")).toContain("already uses Robinhood Chain ETH");
    expect(safeFailure(new Error("BUY_TARGET_UNRESOLVED"), "buy_and_send")).toContain("Reply with the full request using its contract address");
  });
});
