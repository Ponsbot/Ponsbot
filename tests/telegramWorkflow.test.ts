import { describe, expect, it } from "vitest";
import { telegramCommandText, telegramGuideOperation, telegramLiquidityText, telegramMenuGuideOperation, telegramRecipientAllowed } from "../convex/telegram";

describe("Telegram command routing", () => {
  it.each([
    ["/wallet", "show my wallet"],
    ["/balance", "show my balance"],
    ["/balance PONSBOT", "show my PONSBOT balance"],
    ["/buy $20 of PONSBOT", "buy $20 of PONSBOT"],
    ["/sell all PONS", "sell all PONS"],
    ["/swap $20 of ETH to USDG", "swap $20 of ETH to USDG"],
    ["/send 1 PONSBOT to 0x0000000000000000000000000000000000000001", "send 1 PONSBOT to 0x0000000000000000000000000000000000000001"],
    ["/burn 10 PONSBOT", "burn 10 PONSBOT"],
    ["/fees PONSBOT", "claim fees for PONSBOT"],
    ["/positions", "check my positions"],
    ["/liquidity $100 for PONSBOT", "create liquidity $100 for PONSBOT"],
  ])("normalizes %s", (input, expected) => expect(telegramCommandText(input)).toBe(expected));

  it.each([
    ["/buy", "buy"], ["/sell", "sell"], ["/fees", "claim"],
    ["/liquidity", "liquidity"], ["/crosschain", "cross_chain"],
    ["/private", "private_swap"], ["guide:send", "send"],
  ])("starts guided operation %s", (input, expected) => expect(telegramGuideOperation(input)).toBe(expected));

  it("does not interpret arbitrary callback data as an operation", () => {
    expect(telegramGuideOperation("confirm:untrusted-payload")).toBeNull();
  });

  it("accepts natural operation choices only while the root help menu is active", () => {
    expect(telegramMenuGuideOperation("I want to buy", true)).toBe("buy");
    expect(telegramMenuGuideOperation("please help me claim fees", true)).toBe("claim");
    expect(telegramMenuGuideOperation("I want to buy", false)).toBeNull();
  });

  it("requires wallet addresses for Telegram sends", () => {
    expect(telegramRecipientAllowed({ kind: "send", amount: "1", unit: "eth", recipient: "@alice" })).toBe(false);
    expect(telegramRecipientAllowed({ kind: "send", amount: "1", unit: "eth", recipient: "0x1111111111111111111111111111111111111111" })).toBe(true);
    expect(telegramRecipientAllowed({ kind: "buy_and_send", amount: "5", unit: "usd", token: "PONSBOT", recipient: "@alice", slippageBps: 250 })).toBe(false);
    expect(telegramRecipientAllowed({ kind: "buy", amount: "5", unit: "usd", token: "PONSBOT", slippageBps: 250 })).toBe(true);
  });

  it("bridges a bare first liquidity answer into the shared workflow without rewriting later answers", () => {
    expect(telegramLiquidityText("PONSBOT", false)).toBe("create liquidity PONSBOT");
    expect(telegramLiquidityText("$100", true)).toBe("$100");
    expect(telegramLiquidityText("check my positions", false)).toBe("check my positions");
  });
});
