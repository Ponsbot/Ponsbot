import { describe, expect, it } from "vitest";
import { isTerminalCommand, normalizeLaunchFeeOptions, normalizeLaunchLinks, normalizeLaunchTelegram, normalizeTelegramUrl, normalizeWebsiteUrl, normalizeXUrl, parseWalletCommand, validateStructuredWalletCommand } from "../convex/walletCommands";
import { explicitTickerContractPairs, safeFailure, significantAmount } from "../convex/wallets";
import { requestedOperations } from "../convex/xWalletIntent";

describe("X wallet commands", () => {
  it("recognizes an explicit ticker and contract as one token identity", () => {
    const address = "0xb128cAb0842d5725D1eAC657Acd2dDd023c86b07";
    expect(explicitTickerContractPairs(`Buy $14 of $GIGAPONS ${address}`)).toEqual([
      { ticker: "GIGAPONS", address },
    ]);
    expect(explicitTickerContractPairs(`${address}, token address $gigapons`)).toEqual([
      { ticker: "GIGAPONS", address },
    ]);
    for (const label of ["CA:", "ca", "contract:", "contract address:", "address:"]) {
      expect(explicitTickerContractPairs(`buy $14 of $GIGAPONS ${label} ${address}`), label).toEqual([
        { ticker: "GIGAPONS", address },
      ]);
    }
  });

  it("does not mistake a send recipient for a token contract", () => {
    expect(explicitTickerContractPairs(
      "send 10 PONS to 0xb128cAb0842d5725D1eAC657Acd2dDd023c86b07",
    )).toEqual([]);
  });

  it("parses a buy containing both an ambiguous ticker and its contract", () => {
    expect(parseWalletCommand(
      "Buy $14 of $GIGAPONS 0xb128cAb0842d5725D1eAC657Acd2dDd023c86b07",
    )).toMatchObject({
      kind: "buy",
      amount: "14",
      unit: "usd",
      token: "0xb128cAb0842d5725D1eAC657Acd2dDd023c86b07",
    });
  });

  it("normalizes cbBTC launch-pair synonyms to cbBTC", () => {
    for (const alias of ["cbBTC", "$cbBTC", "BTC", "$BTC", "Bitcoin", "Coinbase Bitcoin", "Coinbase Wrapped Bitcoin", "Wrapped Bitcoin"]) {
      expect(parseWalletCommand(`launch Bitcoin Cat ticker BCAT pair with ${alias}`), alias).toMatchObject({
        kind: "launch", name: "Bitcoin Cat", symbol: "BCAT", pairToken: "cbBTC",
      });
    }
    expect(parseWalletCommand("buy $1 of BITCOIN")).toMatchObject({ kind: "buy", token: "BITCOIN" });
  });

  it("normalizes the new Pons pair tickers and names", () => {
    const cases = [
      ["HIMS", "HIMS"], ["$HIMS", "HIMS"], ["Hims", "HIMS"], ["Hims & Hers", "HIMS"], ["Hims and Hers Health", "HIMS"],
      ["BB", "BB"], ["$BB", "BB"], ["BlackBerry", "BB"], ["blackberry", "BB"],
      ["GLD", "GLD"], ["$GLD", "GLD"], ["Gold", "GLD"], ["SPDR Gold", "GLD"], ["SPDR Gold Trust", "GLD"],
      ["Dell", "DELL"], ["WhiteFiber", "WYFI"], ["SK hynix", "SKHY"], ["TSMC", "TSM"],
      ["United States Oil Fund", "USO"], ["Eli Lilly", "LLY"], ["Roblox", "RBLX"],
      ["United Parcel Service", "UPS"], ["Snapchat", "SNAP"], ["Lululemon", "LULU"],
      ["Figma", "FIG"], ["Moderna", "MRNA"], ["Pfizer", "PFE"], ["Rivian", "RIVN"],
      ["Marvell Technology", "MRVL"], ["Johnson & Johnson", "JNJ"],
    ] as const;
    for (const [alias, pairToken] of cases) {
      expect(parseWalletCommand(`launch Market Test ticker PTEST pair with ${alias}`), alias).toMatchObject({
        kind: "launch", name: "Market Test", symbol: "PTEST", pairToken,
      });
    }
  });

  it("treats trailing buy-worth language as a launch developer buy", () => {
    const launch = 'Hey @ponsbotfamily, launch "Degen Labz", ticker "DLABZ", buy $20 worth';
    expect(requestedOperations(launch)).toEqual(["launch"]);
    expect(parseWalletCommand(launch)).toMatchObject({
      kind: "launch", name: "Degen Labz", symbol: "DLABZ", devBuy: { amount: "20", unit: "usd" },
    });
    expect(requestedOperations("buy $20 worth of PONSBOT")).toEqual(["buy"]);
    expect(parseWalletCommand("buy $20 worth of PONSBOT")).toEqual({
      kind: "buy", amount: "20", unit: "usd", token: "PONSBOT", slippageBps: 250,
    });
  });

  it("accepts only the two exact fee-reassignment forms", () => {
    expect(parseWalletCommand("@Ponsbotfamily Reassign $PONSBOT fees to @alice")).toEqual({ kind: "reassign_fees", token: "PONSBOT", recipient: "@alice" });
    expect(parseWalletCommand("Reassign fees for 0x1111111111111111111111111111111111111111 to 0x2222222222222222222222222222222222222222")).toEqual({
      kind: "reassign_fees", token: "0x1111111111111111111111111111111111111111", recipient: "0x2222222222222222222222222222222222222222",
    });
    expect(parseWalletCommand("Reassign $PONSBOT fees to holders")).toEqual({ kind: "reassign_fees", token: "PONSBOT", recipient: "holders" });
    expect(parseWalletCommand("Reassign fees for $PONSBOT to holders.")).toEqual({ kind: "reassign_fees", token: "PONSBOT", recipient: "holders" });
    expect(parseWalletCommand("transfer PONSBOT fees to @alice").kind).toBe("unknown");
    expect(parseWalletCommand("reassign PONSBOT fees @alice").kind).toBe("unknown");
    expect(parseWalletCommand("reassign PONSBOT fees to @alice and claim them").kind).toBe("unknown");
  });
  it("keeps creator-fee reassignment out of the terminal allow-list", () => {
    expect(isTerminalCommand({ kind: "reassign_fees", token: "PONSBOT", recipient: "@alice" })).toBe(false);
    expect(isTerminalCommand({ kind: "reassign_fees", token: "PONSBOT", recipient: "holders" })).toBe(false);
  });
  it("accepts the short X-only upgrade phrase inside surrounding conversation", () => {
    expect(parseWalletCommand("@Ponsbotfamily Upgrade $PONSBOT to automated fees")).toEqual({
      kind: "upgrade_fees", token: "PONSBOT",
    });
    expect(parseWalletCommand("Upgrade 0x1111111111111111111111111111111111111111 to automated fees.")).toEqual({
      kind: "upgrade_fees", token: "0x1111111111111111111111111111111111111111",
    });
    expect(parseWalletCommand("please upgrade PONSBOT to automated fees")).toEqual({ kind: "upgrade_fees", token: "PONSBOT" });
    expect(parseWalletCommand("Hey, upgrade PONSBOT please. Thanks!")).toEqual({ kind: "upgrade_fees", token: "PONSBOT" });
    expect(isTerminalCommand({ kind: "upgrade_fees", token: "PONSBOT" })).toBe(false);
    expect(requestedOperations("@Ponsbotfamily Upgrade $PONSBOT to automated fees")).toEqual(["upgrade_fees"]);
  });
  it("accepts clear ETH sends using for and all-balance wording", () => {
    const recipient = "0x1111111111111111111111111111111111111111";
    expect(parseWalletCommand(`send 0.001 ETH for "${recipient}"`)).toEqual({ kind: "send", amount: "0.001", unit: "eth", recipient });
    expect(parseWalletCommand(`send my all balance for ${recipient}`)).toEqual({ kind: "send", amount: "100", unit: "percent", token: "ETH", recipient });
  });
  it("returns the specific rights response for an onchain fee-owner mismatch", () => {
    expect(safeFailure(new Error("wallet is not the current creator fee recipient"))).toContain("don't have the rights to reassign fees");
  });
  it("never includes an expanded attachment URL scheme in a launch name", () => {
    expect(parseWalletCommand("launch PonsBoarding $PONSBOARDING https://x.com/user/status/123/photo/1")).toMatchObject({
      kind: "launch", name: "PonsBoarding", symbol: "PONSBOARDING",
    });
    expect(validateStructuredWalletCommand({ kind: "launch", launchMode: "pons", name: "PonsBoarding https", symbol: "PONSBOARDING" })).toMatchObject({
      kind: "launch", name: "PonsBoarding", symbol: "PONSBOARDING",
    });
  });

  it("grounds creator-fee launch options only in exact unquoted phrases", () => {
    expect(parseWalletCommand("launch Cedar ticker CDR assign fees to @alice")).toMatchObject({ kind: "launch", feeRecipient: "@alice" });
    expect(parseWalletCommand("launch Cedar ticker CDR assign fees to 0x1111111111111111111111111111111111111111")).toMatchObject({ kind: "launch", feeRecipient: "0x1111111111111111111111111111111111111111" });
    expect(parseWalletCommand("launch Cedar ticker CDR holder fee sharing")).toMatchObject({ kind: "launch", holderFeeSharing: true });
    expect(parseWalletCommand("launch Cedar ticker CDR share with holders")).toMatchObject({ kind: "launch", holderFeeSharing: true });
    expect(parseWalletCommand('launch Cedar ticker CDR description "holder fee sharing"')).not.toHaveProperty("holderFeeSharing");
    expect(parseWalletCommand('launch Cedar ticker CDR description "share with holders"')).not.toHaveProperty("holderFeeSharing");
    expect(parseWalletCommand("launch Cedar ticker CDR assign fees to @alice holder fee sharing")).toMatchObject({ kind: "unknown" });
    expect(parseWalletCommand("launch Cedar ticker CDR assign fees to @alice share with holders")).toMatchObject({ kind: "unknown" });
    expect(normalizeLaunchFeeOptions({ kind: "launch", launchMode: "pons", name: "Cedar", symbol: "CDR", feeRecipient: "@invented" }, "launch Cedar ticker CDR"))
      .toEqual({ kind: "launch", launchMode: "pons", name: "Cedar", symbol: "CDR", feeRecipient: undefined, holderFeeSharing: undefined });
  });
  it("parses only the explicit dollar token-for-token swap shape", () => {
    expect(parseWalletCommand("Swap $25 of SNDK for PONSBOT")).toEqual({
      kind: "swap_token_for_token", amount: "25", unit: "usd", fromToken: "SNDK", toToken: "PONSBOT", slippageBps: 250,
    });
    expect(parseWalletCommand("swap $12.50 worth of 0x1111111111111111111111111111111111111111 for $MSFT at 1% slippage")).toEqual({
      kind: "swap_token_for_token", amount: "12.50", unit: "usd", fromToken: "0x1111111111111111111111111111111111111111", toToken: "MSFT", slippageBps: 100,
    });
    expect(parseWalletCommand("swap SNDK into PONSBOT").kind).toBe("unknown");
    expect(parseWalletCommand("swap $25 of ETH to USDG")).toEqual({
      kind: "swap_token_for_token", amount: "25", unit: "usd", fromToken: "ETH", toToken: "USDG", slippageBps: 250,
    });
    expect(parseWalletCommand("Swap all NVDA for PONSBOT")).toEqual({
      kind: "swap_token_for_token", amount: "100", unit: "percent", fromToken: "NVDA", toToken: "PONSBOT", slippageBps: 250,
    });
    expect(parseWalletCommand("swap all my ETH to PONSBOT")).toEqual({
      kind: "swap_token_for_token", amount: "100", unit: "percent", fromToken: "ETH", toToken: "PONSBOT", slippageBps: 250,
    });
  });

  it("strictly validates structured token-for-token swaps", () => {
    expect(validateStructuredWalletCommand({ kind: "swap_token_for_token", amount: "25", unit: "usd", fromToken: "SNDK", toToken: "PONSBOT", slippageBps: 250 })).toEqual({
      kind: "swap_token_for_token", amount: "25", unit: "usd", fromToken: "SNDK", toToken: "PONSBOT", slippageBps: 250,
    });
    expect(validateStructuredWalletCommand({ kind: "swap_token_for_token", amount: "25", unit: "usd", fromToken: "SNDK", toToken: "SNDK", slippageBps: 250 })).toBeNull();
    expect(validateStructuredWalletCommand({ kind: "swap_token_for_token", amount: "100", unit: "percent", fromToken: "NVDA", toToken: "PONSBOT", slippageBps: 250 })).toEqual({
      kind: "swap_token_for_token", amount: "100", unit: "percent", fromToken: "NVDA", toToken: "PONSBOT", slippageBps: 250,
    });
    expect(validateStructuredWalletCommand({ kind: "swap_token_for_token", amount: "50", unit: "percent", fromToken: "SNDK", toToken: "PONSBOT", slippageBps: 250 })).toBeNull();
  });

  it("uses the paired-asset guidance for an ETH-paired token mismatch", () => {
    expect(safeFailure(new Error("this Pons V2 token is paired with ETH; specify an ETH or dollar amount"))).toContain("spend asset doesn't match");
  });

  it("parses buy-or-purchase-and-burn only when an approved purchase word and burn are present", () => {
    expect(parseWalletCommand("buy $25 of PONSBOT and burn it")).toEqual({ kind: "buy_and_burn", amount: "25", unit: "usd", token: "PONSBOT", slippageBps: 250 });
    expect(parseWalletCommand("burn the PONSBOT I buy with 0.01 ETH")).toEqual({ kind: "buy_and_burn", amount: "0.01", unit: "eth", token: "PONSBOT", slippageBps: 250 });
    expect(parseWalletCommand("buy 5 MSFT of PONSBOT then burn the purchase")).toEqual({ kind: "buy_and_burn", amount: "5", unit: "pair", token: "PONSBOT", pairAsset: "MSFT", slippageBps: 250 });
    expect(parseWalletCommand("purchase $25 of PONSBOT and burn it")).toEqual({ kind: "buy_and_burn", amount: "25", unit: "usd", token: "PONSBOT", slippageBps: 250 });
    expect(parseWalletCommand("buy $25 of PONSBOT and destroy it").kind).not.toBe("buy_and_burn");
  });

  it("strictly validates structured buy-and-burn commands", () => {
    expect(validateStructuredWalletCommand({ kind: "buy_and_burn", amount: "20", unit: "usd", token: "$PONSBOT", slippageBps: 250 })).toEqual({ kind: "buy_and_burn", amount: "20", unit: "usd", token: "PONSBOT", slippageBps: 250 });
    expect(validateStructuredWalletCommand({ kind: "buy_and_burn", amount: "5", unit: "pair", token: "PONSBOT" })).toBeNull();
  });
  it("parses paired-asset developer buys and Telegram launch links", () => {
    expect(parseWalletCommand("launch Ponsbot ticker PONSBOT pair with MSFT dev buy 2 MSFT telegram https://t.me/ponsbotfamily")).toMatchObject({
      kind: "launch", pairToken: "MSFT", devBuy: { amount: "2", unit: "pair" }, telegram: "https://t.me/ponsbotfamily",
    });
  });
  it("normalizes Telegram launch links to canonical HTTPS t.me URLs", () => {
    expect(normalizeTelegramUrl("t.me/ponsbotfamily")).toBe("https://t.me/ponsbotfamily");
    expect(normalizeTelegramUrl("http://telegram.me/ponsbotfamily/")).toBe("https://t.me/ponsbotfamily");
    expect(() => normalizeTelegramUrl("@ponsbotfamily")).toThrow("telegram link must use t.me/XXXXX");
    expect(parseWalletCommand("launch Test ticker TEST tg t.me/test")).toMatchObject({ telegram: "https://t.me/test" });
    expect(validateStructuredWalletCommand({ kind: "launch", name: "Test", symbol: "TEST", telegram: "http://t.me/test" })).toMatchObject({ telegram: "https://t.me/test" });
  });
  it("omits malformed Telegram metadata without rejecting the launch", () => {
    expect(() => normalizeTelegramUrl("https://example.com/test")).toThrow("telegram link must use t.me/XXXXX");
    expect(() => normalizeTelegramUrl("https://t.me/one/two")).toThrow("telegram link must use t.me/XXXXX");
    expect(normalizeLaunchTelegram({ kind: "launch", launchMode: "pons", name: "Test", symbol: "TEST" }, "launch Test ticker TEST tg example.com/test")).toEqual({ kind: "launch", launchMode: "pons", name: "Test", symbol: "TEST" });
    const parsed = parseWalletCommand("launch Test ticker TEST tg example.com/test");
    expect(parsed).toMatchObject({ kind: "launch", name: "Test", symbol: "TEST" });
    expect(parsed).not.toHaveProperty("telegram");
    expect(normalizeLaunchTelegram(parsed)).toEqual(parsed);
  });
  it("normalizes X handles and legacy links to canonical x.com URLs", () => {
    expect(normalizeXUrl("@Ponsbotfamily")).toBe("https://x.com/Ponsbotfamily");
    expect(normalizeXUrl("www.x.com/Ponsbotfamily")).toBe("https://x.com/Ponsbotfamily");
    expect(normalizeXUrl("http://twitter.com/Ponsbotfamily")).toBe("https://x.com/Ponsbotfamily");
    expect(validateStructuredWalletCommand({ kind: "launch", name: "Test", symbol: "TEST", twitter: "twitter.com/test" })).toMatchObject({ twitter: "https://x.com/test" });
  });
  it("rejects malformed X links instead of silently dropping them", () => {
    expect(() => normalizeXUrl("https://example.com/user")).toThrow("x link must use x.com/username");
    expect(() => normalizeXUrl("https://x.com/user/status/1")).toThrow("x link must use x.com/username");
    expect(() => normalizeXUrl("https://x.com/user?ref=test")).toThrow("x link must use x.com/username");
    expect(() => normalizeLaunchLinks({ kind: "launch", launchMode: "pons", name: "Test", symbol: "TEST" }, "launch Test ticker TEST X: example.com/user")).toThrow("x link must use x.com/username");
    expect(normalizeLaunchLinks({ kind: "launch", launchMode: "pons", name: "Test", symbol: "TEST" }, 'launch Test ticker TEST description "mentions X: example.com/user"')).not.toHaveProperty("twitter");
  });
  it("normalizes public websites to HTTPS while preserving paths", () => {
    expect(normalizeWebsiteUrl("example.com")).toBe("https://example.com");
    expect(normalizeWebsiteUrl("http://www.example.com/project")).toBe("https://www.example.com/project");
    expect(validateStructuredWalletCommand({ kind: "launch", name: "Test", symbol: "TEST", website: "http://example.com/token" })).toMatchObject({ website: "https://example.com/token" });
  });
  it("rejects malformed, credentialed, and private website destinations", () => {
    expect(() => normalizeWebsiteUrl("localhost/test")).toThrow(/website link is invalid/);
    expect(() => normalizeWebsiteUrl("http://127.0.0.1/test")).toThrow(/website link is invalid/);
    expect(() => normalizeWebsiteUrl("https://user:pass@example.com")).toThrow(/website link is invalid/);
    expect(() => normalizeLaunchLinks({ kind: "launch", launchMode: "pons", name: "Test", symbol: "TEST" }, "launch Test ticker TEST website: localhost/test")).toThrow(/website link is invalid/);
  });
  it("parses buys with default and custom slippage", () => {
    expect(parseWalletCommand("@Ponsbot buy $25 of $ROOT")).toEqual({ kind: "buy", amount: "25", unit: "usd", token: "ROOT", slippageBps: 250 });
    expect(parseWalletCommand("buy $1,000 of ROOT")).toEqual({ kind: "buy", amount: "1000", unit: "usd", token: "ROOT", slippageBps: 250 });
    expect(parseWalletCommand("buy 0.02 eth of 0x1111111111111111111111111111111111111111 slippage 2.5%")).toEqual({
      kind: "buy", amount: "0.02", unit: "eth", token: "0x1111111111111111111111111111111111111111", slippageBps: 250,
    });
    expect(parseWalletCommand("buy 2 MSFT worth of PONSBOT")).toEqual({
      kind: "buy", amount: "2", unit: "pair", pairAsset: "MSFT", token: "PONSBOT", slippageBps: 250,
    });
  });

  it("accepts buyback and buy back as buy transaction commands", () => {
    expect(parseWalletCommand("buyback $25 of PONSBOT")).toEqual({
      kind: "buy", amount: "25", unit: "usd", token: "PONSBOT", slippageBps: 250,
    });
    expect(parseWalletCommand("buy back 0.001 ETH of PONS")).toEqual({
      kind: "buy", amount: "0.001", unit: "eth", token: "PONS", slippageBps: 250,
    });
    expect(parseWalletCommand("buyback $25 of PONSBOT and send to @alice")).toEqual({
      kind: "buy_and_send", amount: "25", unit: "usd", token: "PONSBOT", recipient: "@alice", slippageBps: 250,
    });
    expect(parseWalletCommand("buy back $25 of PONSBOT and burn it")).toEqual({
      kind: "buy_and_burn", amount: "25", unit: "usd", token: "PONSBOT", slippageBps: 250,
    });
  });

  it("asks only for a contract address when a ticker is ambiguous", () => {
    expect(safeFailure(new Error("that ticker matches more than one token; use the contract address"), "buy"))
      .toBe("⚠️ More than one indexed token uses that ticker. Reply with the contract address so I choose the right one!");
  });

  it("accepts USD written as a unit for buys and token sends", () => {
    expect(parseWalletCommand("buy 25 USD of PONS")).toMatchObject({ kind: "buy", amount: "25", unit: "usd", token: "PONS" });
    expect(parseWalletCommand("buy 25 USD PONS")).toMatchObject({ kind: "buy", amount: "25", unit: "usd", token: "PONS" });
    expect(parseWalletCommand("send 25 USD of PONS to 0x1111111111111111111111111111111111111111")).toEqual({
      kind: "send", amount: "25", unit: "usd", token: "PONS", recipient: "0x1111111111111111111111111111111111111111",
    });
  });

  it("parses token sells and bounds slippage", () => {
    expect(parseWalletCommand("sell 1200 $ROOT")).toEqual({ kind: "sell", amount: "1200", unit: "token", token: "ROOT", slippageBps: 250 });
    expect(parseWalletCommand("Sell 0.001 ETH of PONS")).toEqual({ kind: "sell", amount: "0.001", unit: "eth", token: "PONS", slippageBps: 250 });
    expect(parseWalletCommand("sell 3.5 of ROOT with slippage 30%")).toEqual({ kind: "unknown", reason: "Slippage must be between 0.1% and 20%." });
  });
  it("defaults launches to Pons", () => {
    expect(parseWalletCommand('@Ponsbot launch "root static" ticker ROOT with a 0.02 eth dev buy')).toEqual({
      kind: "launch", launchMode: "pons", name: "root static", symbol: "ROOT",
      devBuy: { amount: "0.02", unit: "eth" },
    });
  });

  it("accepts developer buys without a hard-coded launch cap", () => {
    expect(parseWalletCommand('launch "cap test" ticker CAP with 0.1 eth dev buy')).toMatchObject({
      kind: "launch", devBuy: { amount: "0.1", unit: "eth" },
    });
    expect(parseWalletCommand('launch Ponsbot ticker PONSBOT pair with MSFT dev buy $100 of MSFT')).toMatchObject({
      kind: "launch", pairToken: "MSFT", devBuy: { amount: "100", unit: "usd" },
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

  it("derives a ticker when a launch supplies only a token name", () => {
    expect(parseWalletCommand("launch Pons Boy")).toMatchObject({ kind: "launch", name: "Pons Boy", symbol: "PONSBOY" });
    expect(parseWalletCommand('deploy "Moon-Rock!"')).toMatchObject({ kind: "launch", name: "Moon-Rock!", symbol: "MOONROCK" });
    expect(parseWalletCommand("launch a token named Tesladog")).toMatchObject({ kind: "launch", name: "Tesladog", symbol: "TESLADOG" });
    expect(parseWalletCommand("create a token called Tesladog")).toMatchObject({ kind: "launch", name: "Tesladog", symbol: "TESLADOG" });
    expect(validateStructuredWalletCommand({ kind: "launch", launchMode: "pons", name: "Green Candle", symbol: "GREENCANDLE" })).toMatchObject({
      kind: "launch", name: "Green Candle", symbol: "GREENCANDLE",
    });
  });

  it("accepts bare tickers without a dollar sign for wallet actions", () => {
    expect(parseWalletCommand("buy $5 of PONS")).toMatchObject({ kind: "buy", token: "PONS" });
    expect(parseWalletCommand("sell 10 PONS")).toMatchObject({ kind: "sell", token: "PONS" });
    expect(parseWalletCommand("send 10 PONS to 0x1111111111111111111111111111111111111111")).toMatchObject({ kind: "send", token: "PONS" });
    expect(parseWalletCommand("burn 10 PONS")).toMatchObject({ kind: "burn", token: "PONS" });
  });

  it("uses a ticker-only cashtag as both launch name and ticker", () => {
    expect(parseWalletCommand("Launch token $MUMU on robinhood pair with NVDA")).toMatchObject({
      kind: "launch", name: "MUMU", symbol: "MUMU", pairToken: "NVDA",
    });
    expect(validateStructuredWalletCommand({ kind: "launch", launchMode: "pons", name: "$robidy", symbol: "$rbdy" })).toMatchObject({
      kind: "launch", name: "robidy", symbol: "RBDY",
    });
  });

  it("parses a buy followed by sending exactly the purchase", () => {
    expect(parseWalletCommand("buy 1 PONSBOT and send to @MikeyMoonPay")).toEqual({
      kind: "buy_and_send", amount: "1", unit: "token", token: "PONSBOT",
      recipient: "@MikeyMoonPay", slippageBps: 250,
    });
    expect(parseWalletCommand("buy 3 PONSBOT")).toEqual({
      kind: "buy", amount: "3", unit: "token", token: "PONSBOT", slippageBps: 250,
    });
    expect(parseWalletCommand("Buy $100 $PONSBOT and send it to @USER")).toEqual({
      kind: "buy_and_send", amount: "100", unit: "usd", token: "PONSBOT",
      recipient: "@USER", slippageBps: 250,
    });
    expect(parseWalletCommand("buy 0.02 ETH of PONSBOT then transfer it to 0x1111111111111111111111111111111111111111 slippage 1%")).toEqual({
      kind: "buy_and_send", amount: "0.02", unit: "eth", token: "PONSBOT",
      recipient: "0x1111111111111111111111111111111111111111", slippageBps: 100,
    });
    expect(parseWalletCommand("buy $100 of PONSBOT and send it")).toMatchObject({ kind: "unknown" });
    expect(parseWalletCommand("buy 2 AAPL of GOBLIN and send the result to @alice")).toEqual({
      kind: "buy_and_send", amount: "2", unit: "pair", pairAsset: "AAPL", token: "GOBLIN",
      recipient: "@alice", slippageBps: 250,
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
    expect(parseWalletCommand("check my wallet fund")).toEqual({ kind: "show_balance" });
    expect(parseWalletCommand("check my wallet funds")).toEqual({ kind: "show_balance" });
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
    expect(parseWalletCommand("claim all my fees")).toEqual({ kind: "claim_fees" });
    expect(parseWalletCommand("create my wallet")).toMatchObject({ kind: "create_wallet" });
    expect(parseWalletCommand('launch "PONSCAT", ticker "PONSCAT", dev buy: $0')).toEqual({
      kind: "launch", launchMode: "pons", name: "PONSCAT", symbol: "PONSCAT",
    });
    expect(parseWalletCommand('deploy this, ticker "botnetworking", Name "botnetworking"')).toMatchObject({
      kind: "launch", name: "botnetworking", symbol: "BOTNETWORKING",
    });
    expect(parseWalletCommand("launch token called ANDROID and pair it with google stocks")).toMatchObject({
      kind: "launch", name: "ANDROID", symbol: "ANDROID", pairToken: "GOOGL",
    });
  });

  it("validates AI-extracted paired-asset buys", () => {
    expect(validateStructuredWalletCommand({
      kind: "buy", amount: "5", unit: "pair", token: "PONSBOT", pairAsset: "MSFT", slippageBps: 250,
    })).toEqual({ kind: "buy", amount: "5", unit: "pair", token: "PONSBOT", pairAsset: "MSFT", slippageBps: 250 });
    expect(validateStructuredWalletCommand({
      kind: "buy", amount: "5", unit: "pair", token: "PONSBOT", slippageBps: 250,
    })).toBeNull();
  });

  it("accepts company and stock names for indexed RWAs and launch pairs", () => {
    expect(parseWalletCommand("launch Market Bell ticker BELL paired with Microsoft")).toMatchObject({
      kind: "launch", pairToken: "MSFT",
    });
    expect(parseWalletCommand("launch Orbit Bell ticker ORBIT pair it with SpaceX")).toMatchObject({
      kind: "launch", pairToken: "SPCX",
    });
    expect(validateStructuredWalletCommand({
      kind: "buy", amount: "2", unit: "pair", token: "PONSBOT", pairAsset: "Microsoft", slippageBps: 250,
    })).toMatchObject({ kind: "buy", pairAsset: "MSFT", token: "PONSBOT" });
    expect(validateStructuredWalletCommand({
      kind: "launch", name: "Index Bell", symbol: "BELL", pairToken: "S&P 500",
    })).toMatchObject({ kind: "launch", pairToken: "SPY" });
    for (const text of [
      "launch River Light ticker RLGHT paired to Microsoft",
      "launch River Light ticker RLGHT pair it to MSFT",
      "launch River Light ticker RLGHT with asset pair MSFT",
    ]) expect(parseWalletCommand(text)).toMatchObject({
      kind: "launch", name: "River Light", symbol: "RLGHT", pairToken: "MSFT",
    });
  });

  it("treats paired as pair syntax without corrupting launch name or ticker", () => {
    expect(parseWalletCommand("launch juggernaut paired with $HOOD stock")).toMatchObject({
      kind: "launch", name: "juggernaut", symbol: "JUGGERNAUT", pairToken: "HOOD",
    });
  });

  it("removes launch syntax connectors from both edges of AI-extracted names", () => {
    expect(validateStructuredWalletCommand({
      kind: "launch", name: "with FWUB and", symbol: "FWUB", launchMode: "pons",
    })).toMatchObject({ kind: "launch", name: "FWUB", symbol: "FWUB" });
    expect(validateStructuredWalletCommand({
      kind: "launch", name: "and Signal Bell with", symbol: "BELL", launchMode: "pons",
    })).toMatchObject({ kind: "launch", name: "Signal Bell", symbol: "BELL" });
    expect(parseWalletCommand("launch token called ANDROID and pair it with google stocks")).toMatchObject({
      kind: "launch", name: "ANDROID", symbol: "ANDROID", pairToken: "GOOGL",
    });
    expect(parseWalletCommand("launch vorena the ticker vorena")).toMatchObject({
      kind: "launch", name: "vorena", symbol: "VORENA",
    });
    for (const connector of ["the", "with", "to", "for", "as", "of", "pair", "ticker"]) {
      expect(validateStructuredWalletCommand({
        kind: "launch", name: `Vorena ${connector}`, symbol: `VORENA ${connector}`, launchMode: "pons",
      })).toMatchObject({ kind: "launch", name: "Vorena", symbol: "VORENA" });
    }
    expect(validateStructuredWalletCommand({
      kind: "launch", name: "Breathe", symbol: "BREATHE", launchMode: "pons",
    })).toMatchObject({ kind: "launch", name: "Breathe", symbol: "BREATHE" });
  });

  it("uses one explicit value for both name and ticker without capturing connectors", () => {
    expect(parseWalletCommand("deploy token with name and ticker keyplay")).toMatchObject({
      kind: "launch", name: "keyplay", symbol: "KEYPLAY",
    });
  });

  it("treats generic references to my launches as claim-all", () => {
    expect(parseWalletCommand("claim my fees for my launch")).toEqual({ kind: "claim_fees" });
    expect(parseWalletCommand("collect the fees from my launches")).toEqual({ kind: "claim_fees" });
  });

  it("accepts worth-of trades and an adjacent redundant ticker plus contract", () => {
    expect(parseWalletCommand("now buy $40 worth of $PONSBOT 0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07")).toMatchObject({
      kind: "buy", amount: "40", unit: "usd", token: "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07",
    });
    expect(parseWalletCommand("sell $40 worth of PONSBOT")).toMatchObject({
      kind: "sell", amount: "40", unit: "usd", token: "PONSBOT",
    });
  });

  it("never promotes an X post or media URL to launch social metadata", () => {
    const media = "https://x.com/alice/status/123456789/photo/1";
    expect(normalizeLaunchLinks({ kind: "launch", launchMode: "pons", name: "Art", symbol: "ART", twitter: media }, "launch Art ticker ART")).not.toHaveProperty("twitter");
  });

  it("does not infer the launcher's X profile or a default website", () => {
    const command = { kind: "launch", launchMode: "pons", name: "Art", symbol: "ART", twitter: "https://x.com/launcher", website: "https://www.ponsbot.family" } as const;
    expect(normalizeLaunchLinks(command, "launch Art ticker ART with this picture")).not.toHaveProperty("twitter");
    expect(normalizeLaunchLinks(command, "launch Art ticker ART with this picture")).not.toHaveProperty("website");
    expect(normalizeLaunchLinks(command, "launch Art ticker ART X: @arttoken website art.example")).toMatchObject({ twitter: "https://x.com/arttoken", website: "https://art.example" });
  });

  it("formats response quantities with scale-aware significant digits", () => {
    expect(significantAmount("234234234234")).toBe("234234000000");
    expect(significantAmount("0.0001")).toBe("0.0001");
    expect(significantAmount("0.000123456789")).toBe("0.000123457");
    expect(significantAmount("123.456789")).toBe("123.457");
  });

  it("returns a specific response for an unsupported launch pair", () => {
    expect(safeFailure(new Error("requested Pons V2 pair was not found in the registry"))).toBe("⚠️ Pons doesn’t currently support that pairing asset. Reply with a different pairing asset to continue your launch.");
    expect(safeFailure(new Error("requested Pons V2 pair is not currently approved"))).toBe("⚠️ Pons doesn’t currently support that pairing asset. Reply with a different pairing asset to continue your launch.");
  });

  it("accepts USD-denominated burns", () => {
    expect(parseWalletCommand("burn $25 of $ROOT")).toEqual({ kind: "burn", amount: "25", unit: "usd", token: "ROOT" });
    expect(parseWalletCommand("burn 10 usd worth of ROOT")).toEqual({ kind: "burn", amount: "10", unit: "usd", token: "ROOT" });
  });

  it("accepts all, half, and percentage balance amounts", () => {
    expect(parseWalletCommand("sell all of my $ROOT")).toEqual({ kind: "sell", amount: "100", unit: "percent", token: "ROOT", slippageBps: 250 });
    expect(parseWalletCommand("burn half of my ROOT")).toEqual({ kind: "burn", amount: "50", unit: "percent", token: "ROOT" });
    expect(parseWalletCommand("sell my entire ROOT balance")).toEqual({ kind: "sell", amount: "100", unit: "percent", token: "ROOT", slippageBps: 250 });
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
    expect(validateStructuredWalletCommand({ kind: "send", amount: "0.001", unit: "token", token: "ETH", recipient: "@friend" })).toEqual({
      kind: "send", amount: "0.001", unit: "eth", token: "ETH", recipient: "@friend",
    });
    expect(validateStructuredWalletCommand({ kind: "send", amount: "-25", unit: "token", token: "ROOT", recipient: "@friend" })).toBeNull();
    expect(validateStructuredWalletCommand({ kind: "burn", amount: "101", unit: "percent", token: "ROOT" })).toBeNull();
    expect(validateStructuredWalletCommand({ kind: "buy_and_send", amount: "100", unit: "usd", token: "PONSBOT", recipient: "@friend", slippageBps: 250 })).toEqual({
      kind: "buy_and_send", amount: "100", unit: "usd", token: "PONSBOT", recipient: "@friend", slippageBps: 250,
    });
    expect(validateStructuredWalletCommand({ kind: "buy_and_send", amount: "100", unit: "usd", token: "PONSBOT", recipient: "friend" })).toBeNull();
    expect(validateStructuredWalletCommand({ kind: "buy_and_send", amount: "2", unit: "pair", pairAsset: "AAPL", token: "GOBLIN", recipient: "@friend", slippageBps: 250 })).toEqual({
      kind: "buy_and_send", amount: "2", unit: "pair", pairAsset: "AAPL", token: "GOBLIN", recipient: "@friend", slippageBps: 250,
    });
    expect(validateStructuredWalletCommand({ kind: "buy", amount: "1", unit: "pair", token: "PONSBOT", pairAsset: "ETH", slippageBps: 250 })).toBeNull();
    expect(validateStructuredWalletCommand({ kind: "buy_and_burn", amount: "1", unit: "pair", token: "PONSBOT", pairAsset: "ETH", slippageBps: 250 })).toBeNull();
    expect(validateStructuredWalletCommand({ kind: "buy", amount: "1", unit: "eth", token: "PONSBOT", slippageBps: 12.5 })).toBeNull();
    expect(validateStructuredWalletCommand({ kind: "sell", amount: "25", unit: "usd", token: "PONSBOT" })).toEqual({
      kind: "sell", amount: "25", unit: "usd", token: "PONSBOT", slippageBps: 250,
    });
    expect(validateStructuredWalletCommand({ kind: "sell", amount: "0.001", unit: "eth", token: "PONS" })).toEqual({
      kind: "sell", amount: "0.001", unit: "eth", token: "PONS", slippageBps: 250,
    });
    expect(validateStructuredWalletCommand({ kind: "launch", name: "Root", symbol: "ROOT", launchMode: "other" })).toMatchObject({
      kind: "launch", launchMode: "pons", name: "Root", symbol: "ROOT",
    });
  });
});
