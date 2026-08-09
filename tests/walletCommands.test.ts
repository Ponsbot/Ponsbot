import { describe, expect, it } from "vitest";
import { parseWalletCommand, validateStructuredWalletCommand } from "../convex/walletCommands";

describe("X wallet commands", () => {
  it("parses paired-asset developer buys and Telegram launch links", () => {
    expect(parseWalletCommand("launch Ponsbot ticker PONSBOT pair with MSFT dev buy 2 MSFT telegram https://t.me/ponsbotfamily")).toMatchObject({
      kind: "launch", pairToken: "MSFT", devBuy: { amount: "2", unit: "pair" }, telegram: "https://t.me/ponsbotfamily",
    });
  });
  it("parses buys with default and custom slippage", () => {
    expect(parseWalletCommand("@Ponsbot buy $25 of $ROOT")).toEqual({ kind: "buy", amount: "25", unit: "usd", token: "ROOT", slippageBps: 250 });
    expect(parseWalletCommand("buy $1,000 of ROOT")).toEqual({ kind: "buy", amount: "1000", unit: "usd", token: "ROOT", slippageBps: 250 });
    expect(parseWalletCommand("buy 0.02 eth of 0x1111111111111111111111111111111111111111 slippage 2.5%")).toEqual({
      kind: "buy", amount: "0.02", unit: "eth", token: "0x1111111111111111111111111111111111111111", slippageBps: 250,
    });
  });

  it("parses token sells and bounds slippage", () => {
    expect(parseWalletCommand("sell 1200 $ROOT")).toEqual({ kind: "sell", amount: "1200", unit: "token", token: "ROOT", slippageBps: 250 });
    expect(parseWalletCommand("sell 3.5 of ROOT with slippage 30%")).toEqual({ kind: "unknown", reason: "Slippage must be between 0.1% and 20%." });
  });
  it("defaults launches to Pons", () => {
    expect(parseWalletCommand('@Ponsbot launch "root static" ticker ROOT with a 0.02 eth dev buy')).toEqual({
      kind: "launch", launchMode: "pons", name: "root static", symbol: "ROOT",
      devBuy: { amount: "0.02", unit: "eth" },
    });
  });

  it("enforces the initial dev-buy maximum", () => {
    expect(parseWalletCommand('launch "cap test" ticker CAP with 0.02627 eth dev buy')).toMatchObject({
      kind: "launch", devBuy: { amount: "0.02627", unit: "eth" },
    });
    expect(parseWalletCommand('launch "cap test" ticker CAP with 0.02628 eth dev buy')).toEqual({
      kind: "unknown", reason: "The maximum initial dev buy is 0.02627 ETH.",
    });
  });

  it("keeps every launch on the Pons creation path", () => {
    expect(parseWalletCommand("launch a token called Small Root, ticker ROOT")).toMatchObject({
      kind: "launch", launchMode: "pons",
    });
  });

  it("parses optional Pons metadata", () => {
    expect(parseWalletCommand('launch "Ponsbot" ticker PONSBOT description "direct on X" website: https://ponsbot.family x: https://x.com/Ponsbotfamily')).toMatchObject({
      kind: "launch",
      name: "Ponsbot",
      symbol: "PONSBOT",
      description: "direct on X",
      website: "https://ponsbot.family",
      twitter: "https://x.com/Ponsbotfamily",
    });
    expect(parseWalletCommand('launch token named Ponsbot ticker PONSBOT description "direct on X"')).toMatchObject({
      kind: "launch",
      name: "Ponsbot",
      description: "direct on X",
    });
  });

  it("parses flexibly arranged launch names and tickers", () => {
    expect(parseWalletCommand("deploy Ponsbot (PONSBOT)")).toMatchObject({
      kind: "launch", name: "Ponsbot", symbol: "PONSBOT",
    });
    expect(parseWalletCommand("token name: Ponsbot / symbol: $PONSBOT / please launch it")).toMatchObject({
      kind: "launch", name: "Ponsbot", symbol: "PONSBOT",
    });
    expect(parseWalletCommand("launch Ponsbot with PONSBOT as the ticker")).toMatchObject({
      kind: "launch", name: "Ponsbot", symbol: "PONSBOT",
    });
    expect(parseWalletCommand("create a coin, ticker=$PONSBOT; call it Ponsbot")).toMatchObject({
      kind: "launch", name: "Ponsbot", symbol: "PONSBOT",
    });
  });

  it("accepts USD and ETH sends", () => {
    const recipient = "0x1111111111111111111111111111111111111111";
    expect(parseWalletCommand(`send $12 of eth to ${recipient}`)).toMatchObject({ kind: "send", amount: "12", unit: "usd", recipient });
    expect(parseWalletCommand(`transfer 0.03 eth to ${recipient}`)).toMatchObject({ kind: "send", amount: "0.03", unit: "eth", recipient });
  });

  it("distinguishes a token contract from a recipient address", () => {
    const token = "0x2222222222222222222222222222222222222222";
    const recipient = "0x1111111111111111111111111111111111111111";
    expect(parseWalletCommand(`send 100 ${token} to ${recipient}`)).toMatchObject({
      kind: "send", amount: "100", unit: "token", token, recipient,
    });
  });

  it("accepts an X handle as a transfer recipient", () => {
    expect(parseWalletCommand("@Ponsbot send 0.03 eth to @rootfriend")).toMatchObject({
      kind: "send", amount: "0.03", unit: "eth", recipient: "@rootfriend",
    });
    expect(parseWalletCommand("send @rootfriend 25 ROOT")).toMatchObject({
      kind: "send", amount: "25", unit: "token", token: "ROOT", recipient: "@rootfriend",
    });
    expect(parseWalletCommand("transfer @rootfriend 1,250 of $ROOT")).toMatchObject({
      kind: "send", amount: "1250", unit: "token", token: "ROOT", recipient: "@rootfriend",
    });
    expect(parseWalletCommand("send @rootfriend ROOT 2,500.5")).toMatchObject({
      kind: "send", amount: "2500.5", unit: "token", token: "ROOT", recipient: "@rootfriend",
    });
    expect(parseWalletCommand("send @rootfriend $25 of ROOT")).toMatchObject({
      kind: "send", amount: "25", unit: "usd", token: "ROOT", recipient: "@rootfriend",
    });
  });

  it("broadly recognizes requests for the caller's wallet", () => {
    expect(parseWalletCommand("what is my wallet?")).toEqual({ kind: "show_wallet" });
    expect(parseWalletCommand("where can I find my wallet address")).toEqual({ kind: "show_wallet" });
    expect(parseWalletCommand("give me the address for my wallet")).toEqual({ kind: "show_wallet" });
    expect(parseWalletCommand("wallet please")).toEqual({ kind: "show_wallet" });
    expect(parseWalletCommand("deposit address")).toEqual({ kind: "show_wallet" });
    expect(parseWalletCommand("where do I send ETH?")).toEqual({ kind: "show_wallet" });
  });

  it("never infers a burn without the exact word burn", () => {
    expect(parseWalletCommand("destroy 500 ROOT")).toEqual({ kind: "unknown", reason: "No supported wallet command was found." });
    expect(parseWalletCommand("send 500 ROOT to @rootfriend")).toMatchObject({ kind: "send" });
  });

  it("parses burns and creator fee claims", () => {
    expect(parseWalletCommand("burn 500 ROOT")).toEqual({ kind: "burn", amount: "500", unit: "token", token: "ROOT" });
    expect(parseWalletCommand("claim my fees for $ROOT")).toEqual({ kind: "claim_fees", token: "ROOT" });
  });

  it("accepts USD-denominated burns", () => {
    expect(parseWalletCommand("burn $25 of $ROOT")).toEqual({ kind: "burn", amount: "25", unit: "usd", token: "ROOT" });
    expect(parseWalletCommand("burn 10 usd worth of ROOT")).toEqual({ kind: "burn", amount: "10", unit: "usd", token: "ROOT" });
  });

  it("accepts all, half, and percentage balance amounts", () => {
    expect(parseWalletCommand("sell all of my $ROOT")).toEqual({ kind: "sell", amount: "100", unit: "percent", token: "ROOT", slippageBps: 250 });
    expect(parseWalletCommand("burn half of my ROOT")).toEqual({ kind: "burn", amount: "50", unit: "percent", token: "ROOT" });
    expect(parseWalletCommand("@Ponsbot send 12.5% of my ROOT to @recipient")).toEqual({
      kind: "send", amount: "12.5", unit: "percent", token: "ROOT", recipient: "@recipient",
    });
    expect(parseWalletCommand("transfer all ETH to @recipient")).toEqual({
      kind: "send", amount: "100", unit: "percent", token: "ETH", recipient: "@recipient",
    });
  });

  it("strictly validates AI-parsed commands before execution", () => {
    expect(validateStructuredWalletCommand({ kind: "send", amount: "25", unit: "token", token: "ROOT", recipient: "@friend" })).toEqual({
      kind: "send", amount: "25", unit: "token", token: "ROOT", recipient: "@friend",
    });
    expect(validateStructuredWalletCommand({ kind: "send", amount: "-25", unit: "token", token: "ROOT", recipient: "@friend" })).toBeNull();
    expect(validateStructuredWalletCommand({ kind: "burn", amount: "101", unit: "percent", token: "ROOT" })).toBeNull();
    expect(validateStructuredWalletCommand({ kind: "launch", name: "Root", symbol: "ROOT", launchMode: "other" })).toMatchObject({
      kind: "launch", launchMode: "pons", name: "Root", symbol: "ROOT",
    });
  });
});
