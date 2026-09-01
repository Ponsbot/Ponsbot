import { describe, expect, it } from "vitest";
import { parseWalletCommand, validateStructuredWalletCommand } from "../convex/walletCommands";
import { groundedCanonicalCommand } from "../convex/xWalletIntent";
import { safeFailure } from "../convex/wallets";
import { nativeTokenOperationError } from "../lib/native-token-operation";

describe("launch mention boundaries", () => {
  it.each(["danfo", "ICKER", "TORINOTE"])("does not include the repeated bot mention in %s metadata", name => {
    const text = `@Ponsbotfamily Launch token ${name} @Ponsbotfamily`;
    const ai = { kind: "launch", name: `${name} @Ponsbotfamily`, symbol: name.toUpperCase() };
    expect(validateStructuredWalletCommand(ai)).toMatchObject({ name, symbol: name.toUpperCase() });
    expect(parseWalletCommand(text)).toMatchObject({ kind: "launch", name, symbol: name.toUpperCase() });
    expect(groundedCanonicalCommand(text)).toMatchObject({ name, symbol: name.toUpperCase() });
  });
  it("strips complete mentions before truncation while preserving project socials and description", () => {
    const name = "A".repeat(42);
    expect(validateStructuredWalletCommand({ kind: "launch", name: `${name} @Ponsbotfamily!`, symbol: "TEST",
      twitter: "@Ponsbotfamily", description: "Join @Ponsbotfamily" })).toMatchObject({ name, twitter: "https://x.com/Ponsbotfamily", description: "Join @Ponsbotfamily" });
  });
  it("does not strip a different handle with the same prefix", () => {
    expect(validateStructuredWalletCommand({ kind: "launch", name: "Test @ponsbotfamily2", symbol: "TEST" })).toMatchObject({ name: "Test @ponsbotfamily2" });
  });
});

describe("native ETH versus ETH-denominated token requests", () => {
  it.each(["ETH", "$eth", "Ethereum", `0x${"0".repeat(40)}`])("gives precise native-target errors for %s", token => {
    for (const [kind, code] of [["sell", "SELL_TARGET_NATIVE_ETH"], ["burn", "BURN_TARGET_NATIVE_ETH"]]) {
      expect(nativeTokenOperationError(kind, token)).toBe(code);
      expect(safeFailure(new Error(code))).not.toMatch(/couldn't find|couldn't complete|liquidity/);
    }
  });
  it("does not change transfers, WETH, or ETH-denominated ERC-20 sells/burns", () => {
    expect(nativeTokenOperationError("send", "ETH")).toBeUndefined();
    for (const kind of ["sell", "burn"]) for (const token of ["PONSBOT", "WETH", `0x${"1".repeat(40)}`]) {
      expect(nativeTokenOperationError(kind, token)).toBeUndefined();
      expect(validateStructuredWalletCommand({ kind, token, amount: "0.001", unit: "eth", slippageBps: 250 })).toMatchObject({ kind, token, unit: "eth" });
    }
  });
  it("also protects the signer operation boundary", () => {
    expect(nativeTokenOperationError("uniswap_v3_sell", "ETH")).toBe("SELL_TARGET_NATIVE_ETH");
    expect(nativeTokenOperationError("erc20_burn_to_dead", "ETH")).toBe("BURN_TARGET_NATIVE_ETH");
  });
});
