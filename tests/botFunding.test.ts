import { describe, expect, it } from "vitest";
import { parseBotFundingPost } from "../lib/trading-agents/funding";

describe("staged bot funding syntax", () => {
  it.each([
    ["Send 0.01 ETH to the bot Moss", "0.01", "eth", "ETH"],
    ["@ponsbotfamily SEND $20 ETH TO BOT MOSS!", "20", "usd", "ETH"],
    ["Send $20 of ETH to bot Moss", "20", "usd", "ETH"],
    ["Send $20 to bot Moss", "20", "usd", "ETH"],
    ["Send 20 dollars of PONSBOT to bot Moss", "20", "usd", "PONSBOT"],
    ["Send 1,000 $PONSBOT to the bot Moss", "1000", "token", "PONSBOT"],
    ["Send 25% ETH to bot Moss", "25", "percent", "ETH"],
    ["Send all my PONSBOT to bot Moss", "100", "percent", "PONSBOT"],
    ["Send .1 ETH to bot Moss", "0.1", "eth", "ETH"],
    ["Send 10 パペット to bot Moss", "10", "token", "パペット"],
  ])("accepts %s", (text, amount, unit, asset) => {
    expect(parseBotFundingPost(text)).toEqual({ ok: true, amount, unit, asset, botNameKey: "moss" });
  });
  it("supports quoted and unquoted multiword bot names", () => {
    for (const name of ['"Captain Moss"', "Captain Moss", "“Captain Moss”"]) {
      expect(parseBotFundingPost(`Send 1 ETH to bot ${name}?`)).toMatchObject({ ok: true, botNameKey: "captain moss" });
    }
  });
  it.each(["Please send 1 ETH to bot Moss", "Send 1 ETH to @Moss", "Buy 1 ETH to bot Moss", "A story: Send 1 ETH to bot Moss"])("does not capture %s", text => {
    expect(parseBotFundingPost(text)).toBeNull();
  });
  it.each(["0 ETH", "-1 ETH", "1e3 ETH", "1,00 ETH", "10", "$20% ETH", "101% ETH", "1 ETH and burn 2 ETH", "2 0x123"])("rejects %s", size => {
    expect(parseBotFundingPost(`Send ${size} to bot Moss`)).toMatchObject({ ok: false });
  });
  it("retains contract targets for the existing resolver, without guessing a ticker", () => {
    const ca = `0x${"a".repeat(40)}`;
    expect(parseBotFundingPost(`Send $10 of ${ca} to bot Moss`)).toMatchObject({ ok: true, asset: ca, unit: "usd" });
  });
});
