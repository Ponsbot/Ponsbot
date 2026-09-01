import { describe, expect, it } from "vitest";
import {
  classifyHoudiniStatus,
  fundingResultState,
  formatHoudiniDuration,
  houdiniMinimumAmountReply,
  houdiniChainSelection,
  houdiniOrderUrl,
  leaseAvailable,
  parseXHoudiniCommand,
  parseXHoudiniDecision,
  receivedAssetLabel,
  withHoudiniOrderLink,
} from "../convex/xHoudini";

describe("strict X Houdini commands", () => {
  it("builds public Houdini tracking links for submitted and final replies", () => {
    expect(houdiniOrderUrl("4Fxzmxn3ihMK9FdWMmBQxJ")).toBe(
      "https://app.houdiniswap.com/order-details?houdiniId=4Fxzmxn3ihMK9FdWMmBQxJ",
    );
    expect(withHoudiniOrderLink("✅ Swap complete!", "order id")).toBe(
      "✅ Swap complete!\nYour Houdini Swap order: https://app.houdiniswap.com/order-details?houdiniId=order%20id",
    );
    expect(withHoudiniOrderLink("❌ Swap failed.")).toBe("❌ Swap failed.");
  });

  it("qualifies received ETH with its destination network", () => {
    expect(receivedAssetLabel("ETH", "Base")).toBe("Base ETH");
    expect(receivedAssetLabel("ETH", "Robinhood Chain")).toBe("Robinhood ETH");
    expect(receivedAssetLabel("SOL", "Solana")).toBe("SOL");
  });

  it("adds minute units to numeric Houdini duration values", () => {
    expect(formatHoudiniDuration(10)).toBe("10 minutes");
    expect(formatHoudiniDuration("1")).toBe("1 minute");
    expect(formatHoudiniDuration("about 5 minutes")).toBe("about 5 minutes");
  });

  it("provides a specific response for Houdini minimum-amount errors", () => {
    expect(
      houdiniMinimumAmountReply(new Error("Minimum amount is 0.01 ETH")),
    ).toContain("minimum is 0.01 ETH");
    expect(
      houdiniMinimumAmountReply(new Error("Amount is too small for this route")),
    ).toBe(
      "⚠️ That amount is below Houdini's minimum for this route. Reply with the full request using a larger amount.",
    );
    expect(houdiniMinimumAmountReply(new Error("No route available"))).toBeNull();
  });

  it("maps canonical user-facing chains to a closed Houdini API catalog", () => {
    expect(houdiniChainSelection("Base").apiName).toBe("base");
    expect(houdiniChainSelection("Ethereum").apiName).toBe("ethereum");
    expect(houdiniChainSelection("Robinhood Chain").apiName).toBe("Robinhood");
    expect(houdiniChainSelection("BNB Chain").apiName).toBe("bsc");
    expect(houdiniChainSelection("Base").matches.test("base")).toBe(true);
  });

  it.each([
    [
      "@Ponsbotfamily Send $25 to 0x1111111111111111111111111111111111111111 as ETH on Base",
      "usd",
      "ETH",
      "Base",
      false,
    ],
    [
      "Private send 0.01 ETH as SOL to DA9gChrpYszBos2JHdg7hYh1fUjbbBvGPSGS3Gr8kQ5U @Ponsbotfamily",
      "eth",
      "SOL",
      "Solana",
      true,
    ],
    [
      "@Ponsbotfamily Swap $40 for BTC to bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
      "usd",
      "BTC",
      "Bitcoin",
      false,
    ],
    [
      "@Ponsbotfamily Swap 0.02 ETH to Ethereum ETH for 0x2222222222222222222222222222222222222222 privately",
      "eth",
      "ETH",
      "Ethereum",
      true,
    ],
    [
      "@Ponsbotfamily Send $20 to 0x3333333333333333333333333333333333333333 as USDC on Base",
      "usd",
      "USDC",
      "Base",
      false,
    ],
    [
      "@Ponsbotfamily Send 0.01 ETH as ETH on Arbitrum to 0x4444444444444444444444444444444444444444",
      "eth",
      "ETH",
      "Arbitrum",
      false,
    ],
    [
      "@Ponsbotfamily Send $25 to DA9gChrpYszBos2JHdg7hYh1fUjbbBvGPSGS3Gr8kQ5U in SOL",
      "usd",
      "SOL",
      "Solana",
      false,
    ],
    [
      "@Ponsbotfamily Private swap 0.01 ETH in ETH in Base to 0x5555555555555555555555555555555555555555",
      "eth",
      "ETH",
      "Base",
      true,
    ],
    [
      "Hey @Ponsbotfamily send $25 to 0x6666666666666666666666666666666666666666 as Base ETH",
      "usd",
      "ETH",
      "Base",
      false,
    ],
    [
      "I would like to do this now: @Ponsbotfamily send 0.01 ETH to 0x7777777777777777777777777777777777777777 as ETH on Base. Please process it when ready.",
      "eth",
      "ETH",
      "Base",
      false,
    ],
    [
      "Could you help? @Ponsbotfamily swap $30 as SOL to DA9gChrpYszBos2JHdg7hYh1fUjbbBvGPSGS3Gr8kQ5U. Thanks!",
      "usd",
      "SOL",
      "Solana",
      false,
    ],
    [
      "Privately send $50 ETH to 0x7382caA23D17F98b6BB82d45982d80d9CC05bB28 as Robinhood ETH",
      "usd",
      "ETH",
      "Robinhood Chain",
      true,
    ],
    [
      "Please @Ponsbotfamily send $50 of ETH to 0x8888888888888888888888888888888888888888 as Base ETH",
      "usd",
      "ETH",
      "Base",
      false,
    ],
  ])("parses %s", (text, unit, symbol, chain, privateMode) => {
    expect(parseXHoudiniCommand(text)).toMatchObject({
      unit,
      targetSymbol: symbol,
      targetChain: chain,
      privateMode,
    });
  });

  it.each([
    "send SOL to @alice",
    "send $20 to @alice as SOL",
    "swap my ETH for BTC",
    "send $20 to 0x1111111111111111111111111111111111111111 as ETH",
    "send $20 of PONSBOT to 0x1111111111111111111111111111111111111111",
  ])("rejects ambiguous or ordinary commands: %s", (text) =>
    expect(parseXHoudiniCommand(text)).toBeNull(),
  );

  it("accepts only exact decisions", () => {
    expect(parseXHoudiniDecision("@Ponsbotfamily Confirm!")).toBe("confirm");
    expect(parseXHoudiniDecision("yes")).toBe("confirm");
    expect(parseXHoudiniDecision("approve")).toBe("confirm");
    expect(parseXHoudiniDecision("no")).toBe("cancel");
    expect(parseXHoudiniDecision("cancel.")).toBe("cancel");
    expect(parseXHoudiniDecision("yes please")).toBeNull();
  });

  it("uses exact terminal status labels without treating refund success as delivery", () => {
    expect(classifyHoudiniStatus("COMPLETED")).toBe("completed");
    expect(classifyHoudiniStatus("FINISHED")).toBe("completed");
    expect(classifyHoudiniStatus("REFUNDED")).toBe("failed");
    expect(classifyHoudiniStatus("REFUND SUCCESS")).toBe("pending");
    expect(classifyHoudiniStatus("SENDING_TO_RECEIVER")).toBe("pending");
  });

  it("allows work only when both its due time and lease permit it", () => {
    expect(leaseAvailable(1_000, 900, 900)).toBe(true);
    expect(leaseAvailable(1_000, 1_001, 900)).toBe(false);
    expect(leaseAvailable(1_000, 900, 1_001)).toBe(false);
  });

  it("keeps an existing wallet request pending rather than failing it", () => {
    expect(fundingResultState({ ok: false, pending: true })).toBe("pending");
    expect(fundingResultState({ ok: true })).toBe("confirmed");
    expect(fundingResultState({ ok: false })).toBe("failed");
  });

});
