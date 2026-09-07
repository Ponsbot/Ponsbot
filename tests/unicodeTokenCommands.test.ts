import { describe, expect, it } from "vitest";
import { tokenPattern } from "../lib/token-pattern";
import { parseWalletCommand, validateStructuredWalletCommand, tickerFromLaunchName } from "../convex/walletCommands";
import { explicitTickerContractPairs } from "../convex/wallets";
import { liquidityFieldsSchema, liquidityStatusSelection, liquidityWithdrawalSelection, liquidityOpenInquirySelection, liquidityClaimSelection } from "../lib/liquidity-workflow";
import { advanceGuidedLaunch, createGuidedLaunchState } from "../lib/guided-launch-workflow";
import { resolveContextualBuyToken } from "../lib/contextual-buy";
import { groundedCanonicalCommand, canonicalCommandText } from "../convex/xWalletIntent";
import { guidedReassignTokenSelection } from "../lib/guided-help-workflow";
import { parseLiquidityClaimedFee } from "../lib/liquidity-claimed-fees";
import { feeQuestionToken } from "../lib/fee-assignment-question";
import { signerOperationSchema } from "../lib/wallet-signer/policy";

const address = "0xb128cAb0842d5725D1eAC657Acd2dDd023c86b07";
describe("Chinese and Japanese token identifiers", () => {
  it("rejects identity metadata over the onchain UTF-8 limits", () => {
    expect(parseWalletCommand("launch 猫猫猫猫猫猫 ticker 猫猫猫猫猫猫")).toMatchObject({ kind: "unknown", reason: expect.stringContaining("byte limit") });
    expect(validateStructuredWalletCommand({ kind: "launch", name: "猫".repeat(22), symbol: "CAT" })).toMatchObject({ kind: "unknown", reason: expect.stringContaining("byte limit") });
    expect(parseWalletCommand("launch 猫猫猫猫猫 ticker 猫猫猫猫猫")).toMatchObject({ kind: "launch", symbol: "猫猫猫猫猫" });
  });
  it.each(["中国龙", "招財貓", "ねこ", "ポンボット", "トークン", "猫PONS2", "𠮷野家"])("supports %s throughout token commands", async token => {
    const canonical = token.toUpperCase();
    for (const [text, result] of [
      [`buy $14 of $${token}`, { kind: "buy", token: canonical, amount: "14" }],
      [`buyback $14 of $${token}`, { kind: "buy", token: canonical }],
      [`sell all my $${token}`, { kind: "sell", token: canonical }],
      [`burn 10 $${token}`, { kind: "burn", token: canonical }],
      [`send 10 $${token} to ${address}`, { kind: "send", token: canonical }],
      [`swap $10 of $${token} to USDG`, { kind: "swap_token_for_token", fromToken: canonical, toToken: "USDG" }],
      [`claim my fees for $${token}`, { kind: "claim_fees", token: canonical }],
      [`Upgrade $${token}`, { kind: "upgrade_fees", token: canonical }],
      [`Reassign $${token} fees to @someone`, { kind: "reassign_fees", token: canonical }],
      [`launch ${token} ticker $${token}`, { kind: "launch", name: token, symbol: canonical }],
    ] as const) {
      expect(parseWalletCommand(text), text).toMatchObject(result);
      expect(groundedCanonicalCommand(text), `X grounding: ${text}`).toMatchObject(result);
    }
    expect(tickerFromLaunchName(token)).toBe(canonical);
    expect(validateStructuredWalletCommand({ kind: "buy", amount: "14", unit: "usd", token, slippageBps: 250 })).toMatchObject({ token: canonical });
    expect(explicitTickerContractPairs(`buy $14 of $${token} CA: ${address}`)).toEqual([{ ticker: canonical, address }]);
    expect(liquidityFieldsSchema.safeParse({ token }).success).toBe(true);
    expect(liquidityStatusSelection(`check my $${token} positions`)).toMatchObject({ token });
    expect(liquidityWithdrawalSelection(`withdraw my $${token} position`)).toMatchObject({ token });
    expect(liquidityClaimSelection(`claim LP fees for $${token}`)).toMatchObject({ token });
    expect(liquidityOpenInquirySelection(`what pools are there for $${token}`)).toMatchObject({ token });
    expect(await resolveContextualBuyToken(`launched $${token}`, async id => id === canonical ? address : id)).toBe(address.toLowerCase());
    expect(feeQuestionToken(`who gets fees for $${token}?`)).toBe(canonical);
    expect(guidedReassignTokenSelection(`$${token}`)).toBe(canonical);
    expect(parseLiquidityClaimedFee(`12.5 ${token} ($3.20)`)).toEqual({ amount: "12.5", symbol: token, usd: 3.2 });
    expect(parseWalletCommand(canonicalCommandText(`buyback $14 of $${token}`))).toMatchObject({ kind: "buy", token: canonical });
  });
  it("keeps Chinese names and Japanese tickers in guided launches", () => {
    const named = advanceGuidedLaunch(createGuidedLaunchState(true), "中国招財猫");
    expect(named.kind).toBe("prompt");
    if (named.kind !== "prompt") return;
    const ticker = advanceGuidedLaunch(named.state, "$ねこ");
    expect(ticker).toMatchObject({ kind: "prompt", state: { draft: { name: "中国招財猫", symbol: "ねこ" } } });
  });
  it("does not broaden handles, hexadecimal addresses, or transliterate lookalikes", () => {
    expect(validateStructuredWalletCommand({ kind: "send", amount: "1", unit: "token", token: "猫", recipient: "@ねこ" })).toBeNull();
    expect(tokenPattern(/^[A-Z0-9]{1,16}$/).test("РONS")).toBe(false);
    expect(tokenPattern(/^[A-Z0-9]{1,16}$/).test("猫".repeat(17))).toBe(false);
    expect(parseWalletCommand(`send 1 ETH to ${address}`)).toMatchObject({ kind: "send", unit: "eth" });
    expect(tokenPattern(/^(?:[A-Za-z][A-Za-z0-9]+) to @[A-Za-z0-9_]{1,15}$/).test("猫猫 to @ねこ")).toBe(false);
    expect(parseWalletCommand("buy $10 of $猫ETH")).toMatchObject({ kind: "buy", token: "猫ETH" });
  });
  it("preserves Unicode launch metadata across the signer boundary", () => {
    expect(signerOperationSchema.safeParse({
      type: "pons_v2_launch", launchMode: "pons", factoryAddress: address, launchAndBuyRouter: address,
      name: "中国の猫", symbol: "ねこ", imageUri: "", description: "", devBuy: null,
      socials: { website: "", twitter: "", telegram: "" }, feeWalletSource: "reply_wallet", launchConfigId: "1",
      creatorFeeRecipient: address, pairToken: address, quoterAddress: address, wethAddress: address, method: "launchToken",
    }).success).toBe(true);
    expect(tickerFromLaunchName("𠮷".repeat(17))).toBe("𠮷".repeat(16));
  });
});
