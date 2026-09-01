import { describe, expect, it } from "vitest";
import { isTerminalCommand, parseTopFiveBuyCommand, parseWalletCommand, validateStructuredWalletCommand } from "../convex/walletCommands";
import { parseXWalletIntent } from "../convex/xWalletIntent";

describe("private top-five Pons Bot buy command", () => {
  it("accepts only the two narrow command forms with harmless case and punctuation changes", async () => {
    const buy = { kind: "buy_top_five", amount: "25", burn: false, slippageBps: 250 } as const;
    const burn = { kind: "buy_top_five", amount: "12.50", burn: true, slippageBps: 250 } as const;
    expect(parseWalletCommand("Buy $25 each of the top 5 Pons Bot tokens.")).toEqual(buy);
    expect(parseWalletCommand("@Ponsbotfamily BUY AND BURN $12.50 OF EACH OF THE TOP 5 PONS BOT TOKENS!!!")).toEqual(burn);
    await expect(parseXWalletIntent("@Ponsbotfamily buy and burn $12.50 each of the top 5 Pons Bot tokens", false))
      .resolves.toEqual({ kind: "command", command: burn });
    expect(isTerminalCommand(buy)).toBe(true);
    expect(validateStructuredWalletCommand(burn)).toEqual(burn);
  });

  it.each([
    "buy and burn $10 of PONSBOT",
    "please buy $10 each of the top 5 Pons Bot tokens",
    "buy $10 of the top 5 Pons Bot tokens",
    "buy $10 each of five Pons Bot tokens",
    "buy and destroy $10 each of the top 5 Pons Bot tokens",
    "buy and burn 0.01 ETH each of the top 5 Pons Bot tokens",
    "buy and burn $10 each of the top 10 Pons Bot tokens",
    "if you can, buy $10 each of the top 5 Pons Bot tokens",
  ])("does not activate for %s", (text) => {
    expect(parseTopFiveBuyCommand(text)).toBeNull();
    expect(parseWalletCommand(text).kind).not.toBe("buy_top_five");
  });
});
