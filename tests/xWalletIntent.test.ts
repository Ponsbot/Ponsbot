import { describe, expect, it } from "vitest";
import { canonicalCommandText, groundedCanonicalCommand, intentClassifierPrompt, parameterExtractorPrompt, requestedOperations, straightforwardCommandOperation, unknownWalletMessage, walletHelpMessage } from "../convex/xWalletIntent";
import { parseWalletCommand } from "../convex/walletCommands";

describe("deterministic X wallet replies", () => {
  it("routes claim all fees without inventing a token", () => {
    expect(groundedCanonicalCommand("claim all my fees")).toEqual({ kind: "claim_fees" });
    expect(groundedCanonicalCommand("Claim everything available for me")).toEqual({ kind: "claim_fees" });
    expect(straightforwardCommandOperation("Claim everything available for me")).toBe("claim_fees");
  });
  it("treats an entire named token balance as a 100 percent burn", () => {
    expect(groundedCanonicalCommand("Burn my entire PONSBOT balance")).toEqual({
      kind: "burn", amount: "100", unit: "percent", token: "PONSBOT",
    });
    expect(straightforwardCommandOperation("Burn my entire PONSBOT balance")).toBe("burn");
  });
  it("requires explicit buy and burn wording for the combined workflow", () => {
    expect(intentClassifierPrompt()).toContain('"buy_and_burn"');
    expect(parameterExtractorPrompt("buy_and_burn", false)).toContain('literal words "buy" and "burn"');
    expect(groundedCanonicalCommand("buy $20 of PONSBOT and burn it")).toMatchObject({ kind: "buy_and_burn", amount: "20", token: "PONSBOT" });
    expect(groundedCanonicalCommand("burn the PONSBOT I buy with 0.01 ETH")).toMatchObject({ kind: "buy_and_burn", amount: "0.01", token: "PONSBOT" });
  });
  it("detects unsupported multiple operations before execution", () => {
    expect(requestedOperations("send 2 ETH to @alice and burn 5 ROOT")).toEqual(["send", "burn"]);
    expect(requestedOperations("show my wallet and my balance")).toEqual(["show_wallet", "show_balance"]);
    expect(requestedOperations("launch Test ticker TEST and buy $10 of AMD")).toEqual(["buy", "launch"]);
    expect(requestedOperations("swap $25 into MSFT and launch Pons Bot ticker PONSBOT")).toEqual(["buy", "launch"]);
    expect(requestedOperations("buy $10 of PONSBOT and send it to @alice")).toEqual(["buy_and_send"]);
    expect(requestedOperations("buy $10 of PONSBOT and burn it")).toEqual(["buy_and_burn"]);
    expect(requestedOperations('launch Pons Bot ticker PONSBOT description "buy, send, burn" dev buy $10')).toEqual(["launch"]);
  });
  it("grounds flexible launch names and pair-asset syntax", () => {
    expect(parseWalletCommand("Launch a token named Aurora Signal with ticker AURA")).toMatchObject({ kind: "launch", name: "Aurora Signal", symbol: "AURA" });
    expect(parseWalletCommand("launch name: Green Candle; ticker: GC")).toMatchObject({ kind: "launch", name: "Green Candle", symbol: "GC" });
    expect(parseWalletCommand("launch a new token: name Solar Arcade, ticker SOLAR")).toMatchObject({ kind: "launch", name: "Solar Arcade", symbol: "SOLAR" });
    expect(parseWalletCommand("Deploy Coffee Break with symbol JAVA")).toMatchObject({ kind: "launch", name: "Coffee Break", symbol: "JAVA" });
    expect(parseWalletCommand("launch ticker ONLY")).toMatchObject({ kind: "unknown" });
    expect(parseWalletCommand("launch Market Dog ticker MDOG pair asset 0x1111111111111111111111111111111111111111")).toMatchObject({ kind: "launch", pairToken: "0x1111111111111111111111111111111111111111" });
    expect(parseWalletCommand("Launch Pons Bot ticker PONSBOT, pair asset TSLA")).toMatchObject({ kind: "launch", pairToken: "TSLA" });
    expect(groundedCanonicalCommand("Launch token, name is Velvet Rope and the symbol is VELVET")).toMatchObject({ kind: "launch", name: "Velvet Rope", symbol: "VELVET" });
    expect(groundedCanonicalCommand("Launch Pons Bot $PONSBOT pair ETH")).toMatchObject({ kind: "launch", name: "Pons Bot", symbol: "PONSBOT" });
    expect(groundedCanonicalCommand("Launch $RAIN — ‘Rain Check’ pair AAPL")).toMatchObject({ kind: "launch", name: "Rain Check", symbol: "RAIN" });
    expect(groundedCanonicalCommand("launch Plain Token ticker PLAIN no description needed")).toMatchObject({ kind: "launch", name: "Plain Token", symbol: "PLAIN" });
    expect(groundedCanonicalCommand("launch Plain Token ticker PLAIN no description needed")).not.toHaveProperty("description");
  });

  it("accepts a direct contract address as the buy target", () => {
    expect(parseWalletCommand("@Ponsbotfamily buy $20 of 0x1111111111111111111111111111111111111111")).toMatchObject({
      kind: "buy", amount: "20", unit: "usd", token: "0x1111111111111111111111111111111111111111",
    });
  });

  it("keeps amounts, assets, and recipients in their stated roles", () => {
    expect(groundedCanonicalCommand("buy $5 of ETH")).toMatchObject({ kind: "buy", amount: "5", unit: "usd", token: "ETH" });
    expect(groundedCanonicalCommand("buy and burn 3 MSFT of PONSBOT")).toMatchObject({ kind: "buy_and_burn", amount: "3", unit: "pair", pairAsset: "MSFT", token: "PONSBOT" });
    expect(groundedCanonicalCommand("transfer 1.25 SNDK -> @leo")).toMatchObject({ kind: "send", amount: "1.25", unit: "token", token: "SNDK", recipient: "@leo" });
    expect(groundedCanonicalCommand("move a quarter of my META to @orbit")).toMatchObject({ kind: "send", amount: "25", unit: "percent", token: "META", recipient: "@orbit" });
  });

  it("treats an explicit request for my wallet address as a command", () => {
    expect(requestedOperations("show me my wallet address")).toEqual(["show_wallet"]);
    expect(requestedOperations("Testing first. show me my wallet address")).toEqual(["show_wallet"]);
  });

  it("prioritizes complete ordinary commands over conversational framing", () => {
    expect(straightforwardCommandOperation("Before I log off, buy $5 of PONSBOT please")).toBe("buy");
    expect(straightforwardCommandOperation("Quick one: send 10 PONSBOT to @alice please")).toBe("send");
    expect(straightforwardCommandOperation("I was wondering, sell all my MSFT")).toBe("sell");
    expect(straightforwardCommandOperation("Hey bot, burn 4 PONSBOT")).toBe("burn");
    expect(straightforwardCommandOperation("Please launch Clear Signal ticker CLEAR pair ETH")).toBe("launch");
    expect(straightforwardCommandOperation("Can you explain how buying $5 of PONSBOT works?")).toBeNull();
    expect(straightforwardCommandOperation("Do not send 10 PONSBOT to @alice")).toBeNull();
    expect(straightforwardCommandOperation("buy PONSBOT")).toBeNull();
    expect(straightforwardCommandOperation("buy $5 PONSBOT and launch Other ticker OTHER")).toBeNull();
  });

  it("normalizes explicit creator-fee commands without inventing assets", () => {
    expect(groundedCanonicalCommand("collect creator revenue for PONSBOT")).toMatchObject({ kind: "claim_fees", token: "PONSBOT" });
    expect(groundedCanonicalCommand("withdraw my fees")).toEqual({ kind: "claim_fees" });
  });

  it("keeps every help and ambiguity response within X's limit", () => {
    const topics = ["capabilities", "wallet", "fund", "balance", "send", "buy_sell", "burn", "launch", "pairs", "fees"] as const;
    for (const topic of topics) expect(walletHelpMessage(topic).length).toBeLessThanOrEqual(280);
    expect(unknownWalletMessage().length).toBeLessThanOrEqual(280);
  });

  it("uses the approved launch instructions", () => {
    expect(walletHelpMessage("launch")).toContain("Pons");
  });

  it("keeps intent classification free of command parameters", () => {
    const prompt = intentClassifierPrompt();
    expect(prompt).toContain("Determine intent only");
    expect(prompt).not.toContain('"amount"');
    expect(prompt).not.toContain('"recipient"');
    expect(prompt).toContain("inside quotes as additional operations");
  });

  it("does not count command words inside quoted launch metadata", () => {
    const post = 'launch "Pons Bot" ticker $PONSBOT X: www.x.com/ponsbotfamily description "Swap, sell, and launch on Pons V2 with just one X post."';
    expect(parseWalletCommand(canonicalCommandText(post))).toMatchObject({ kind: "launch", name: "Pons Bot", symbol: "PONSBOT" });
    expect(groundedCanonicalCommand(post)).toMatchObject({
      kind: "launch", name: "Pons Bot", symbol: "PONSBOT", twitter: "https://x.com/ponsbotfamily", description: "Swap, sell, and launch on Pons V2 with just one X post.",
    });
  });

  it("accepts ticker labels with optional dollars and wrapping quotes", () => {
    const exactPost = 'Hey @ponsbotfamily, launch "Pons Bot", ticker "PONSBOT", X: www.x.com/ponsbotfamily, website: www.ponsbot.family, dev buy: $100, description "Swap, sell, and launch on Pons V2 with just one X post."';
    expect(groundedCanonicalCommand(exactPost)).toMatchObject({
      kind: "launch", name: "Pons Bot", symbol: "PONSBOT",
      description: "Swap, sell, and launch on Pons V2 with just one X post.",
      website: "https://www.ponsbot.family", twitter: "https://x.com/ponsbotfamily",
      devBuy: { amount: "100", unit: "usd" },
    });
    for (const ticker of ["PONSBOT", "$PONSBOT", "'PONSBOT'", "‘$PONSBOT’", "\"$PONSBOT\""]) {
      expect(groundedCanonicalCommand(`launch "Pons Bot" ticker ${ticker}`), ticker).toMatchObject({
        kind: "launch", name: "Pons Bot", symbol: "PONSBOT",
      });
    }
  });

  it("uses operation-specific parameter prompts", () => {
    expect(parameterExtractorPrompt("buy", false)).toContain('"slippageBps"');
    expect(parameterExtractorPrompt("buy", false)).toContain('"eth|usd|pair"');
    expect(parameterExtractorPrompt("buy", false)).toContain("buy 5 MSFT of PONSBOT");
    expect(parameterExtractorPrompt("buy_and_send", false)).toContain('"recipient"');
    expect(parameterExtractorPrompt("buy_and_send", false)).toContain("purchased tokens");
    expect(parameterExtractorPrompt("send", false)).toContain('"recipient"');
    expect(parameterExtractorPrompt("launch", true)).toContain('"symbol"');
    expect(parameterExtractorPrompt("launch", true)).toContain("quotation marks delimit a literal field value");
    expect(parameterExtractorPrompt("launch", true)).toContain("Connector words");
    expect(parameterExtractorPrompt("launch", true)).toContain("Attached image present: yes");
    expect(parameterExtractorPrompt("claim_fees", false)).toContain("native-pair fees");
  });

  it("explains live creator-fee claims and paired-asset trades", () => {
    expect(walletHelpMessage("fees")).toContain("claim my fees");
    expect(walletHelpMessage("fees")).not.toContain("not currently supported");
    expect(walletHelpMessage("buy_sell")).toContain("buy $5 of PONSBOT");
    expect(walletHelpMessage("buy_sell")).toContain("sell 100 MSFT");
    expect(walletHelpMessage("buy_sell")).toContain("swap $25 of SNDK for PONSBOT");
  });

  it("recognizes the one supported combined operation", () => {
    expect(intentClassifierPrompt()).toContain('"buy_and_send"');
    expect(groundedCanonicalCommand("Buy $100 $PONSBOT and send it to @USER")).toMatchObject({
      kind: "buy_and_send", amount: "100", unit: "usd", token: "PONSBOT", recipient: "@USER",
    });
  });

  it("distinguishes the bot invocation from an explicit bot recipient", () => {
    expect(groundedCanonicalCommand("@Ponsbotfamily send 10 SNDK")).toBeNull();
    expect(groundedCanonicalCommand("Hey @Ponsbotfamily send @Ponsbotfamily 10 SNDK")).toMatchObject({
      kind: "send", amount: "10", unit: "token", token: "SNDK", recipient: "@Ponsbotfamily",
    });
    expect(groundedCanonicalCommand("@Ponsbotfamily send @charlie 0.01 ETH please")).toMatchObject({
      kind: "send", amount: "0.01", unit: "eth", recipient: "@charlie",
    });
  });

  it("tells both AI stages to isolate the operative request and ignore politeness", () => {
    expect(intentClassifierPrompt()).toContain("operative clause");
    expect(parameterExtractorPrompt("buy", false)).toContain('trailing "please"');
  });

  it("normalizes approved trading slang into grounded commands", () => {
    const examples = [
      ["put $100 into SNDK @Ponsbotfamily", "buy"],
      ["@Ponsbotfamily gimme $5 of SNDK", "buy"],
      ["@Ponsbotfamily I want twenty dollars worth of SNDK", "buy"],
      ["send it: $200 into SNDK @Ponsbotfamily", "buy"],
      ["dump all my SNDK @Ponsbotfamily", "sell"],
      ["@Ponsbotfamily get rid of 5.5 SNDK", "sell"],
      ["Buy me 50 bucks of SNDK @Ponsbotfamily", "buy"],
      ["market buy $75 SNDK @Ponsbotfamily", "buy"],
      ["@Ponsbotfamily swap $35 for SNDK", "buy"],
      ["swap .025 ETH for SNDK @Ponsbotfamily", "buy"],
    ] as const;
    for (const [text, kind] of examples) {
      expect(parseWalletCommand(canonicalCommandText(text)).kind, text).toBe(kind);
      expect(groundedCanonicalCommand(text)?.kind, `grounding: ${text}`).toBe(kind);
    }
  });

  it("grounds normalized launch links from labeled bare values", () => {
    const post = `Hey @ponsbot launch Ponsbot ticker $PONSBOT
Website: ponsbot.family X: @Ponsbotfamily Dev buy $100`;
    expect(groundedCanonicalCommand(post)).toEqual({
      kind: "launch",
      launchMode: "pons",
      name: "Ponsbot",
      symbol: "PONSBOT",
      website: "https://ponsbot.family",
      twitter: "https://x.com/Ponsbotfamily",
      devBuy: { amount: "100", unit: "usd" },
    });
  });

  it("supports explicit make-token wording and rejects unsafe ambiguities", () => {
    expect(groundedCanonicalCommand("@Ponsbotfamily make a token named Robot Juice symbol BOT")).toMatchObject({
      kind: "launch", name: "Robot Juice", symbol: "BOT",
    });
    expect(groundedCanonicalCommand("launch Secret Name ticker")).toBeNull();
    expect(groundedCanonicalCommand("@Ponsbotfamily buy $25 of $SNDK CA 0xA11CE000000000000000000000000000000000499")).toBeNull();
  });

  it("normalizes varied launch pair labels and leading decimals", () => {
    expect(groundedCanonicalCommand("launch Infinite Shrimp ticker SHRMP pairing asset: GME dev buy $35")).toMatchObject({
      kind: "launch", pairToken: "GME",
    });
    expect(groundedCanonicalCommand("launch Deep Fried Data ticker DFD with NVDA pairing and a 0.02 ETH developer buy")).toMatchObject({
      kind: "launch", pairToken: "NVDA",
    });
    expect(groundedCanonicalCommand("create Definitely Alpha ticker ALPHA pair ETH dev buy .05 ETH")).toMatchObject({
      kind: "launch", pairToken: "ETH", devBuy: { amount: "0.05", unit: "eth" },
    });
    expect(groundedCanonicalCommand('launch Dog With Laptop ticker DWL description "he is working" pair ETH')).toMatchObject({
      kind: "launch", name: "Dog With Laptop", symbol: "DWL", description: "he is working", pairToken: "ETH",
    });
  });

  it("grounds high-confidence historical launch formats", () => {
    const launches = [
      ["Launch a token called Neon Frog with ticker $NFROG. Pair it with USDG and dev buy $20.", "Neon Frog", "NFROG", "USDG"],
      ["Create $GLASS. Name “Glass Brain.” Pair it with META and buy $40 worth at launch.", "Glass Brain", "GLASS", "META"],
      ["Make token “Green Button” $BUTTON. Pair SPY. $25 developer buy.", "Green Button", "BUTTON", "SPY"],
      ["Need a launch for “One More Trade” ($OMT). Pair COIN, initial buy $50 USD.", "One More Trade", "OMT", "COIN"],
      ["Launch $YAP. Full name: Professional Yapper. Pair META, dev buy $45.", "Professional Yapper", "YAP", "META"],
      ["Pons launch my token “Red Candle Enjoyer” ticker $RCE. Pair SPY. Dev buy $69.", "Red Candle Enjoyer", "RCE", "SPY"],
      ["I need a coin: name = Screenshot This, ticker = $SS, pair = ETH, dev buy = 0.015 ETH.", "Screenshot This", "SS", "ETH"],
      ["make $REFRESH, token name “Refresh Again,” pairing asset GOOGL, initial buy $45 USD", "Refresh Again", "REFRESH", "GOOGL"],
      ["New token with the attached art: Name “Market Creature”, ticker $CREATURE, pair SPY, dev buy $50.", "Market Creature", "CREATURE", "SPY"],
      ["Make “Paper Hands Anonymous” ($PHA). Pair with SPY. Developer buy 1 SPY.", "Paper Hands Anonymous", "PHA", "SPY"],
      ["Can Pons launch “Stonk Engine” ticker $ENGINE paired with GME? Buy 4 GME for dev.", "Stonk Engine", "ENGINE", "GME"],
      ["Need token deployed: “Prime Delivery” $PRIMEDEL, description “Arrives before you ordered it.” Pair AMZN.", "Prime Delivery", "PRIMEDEL", "AMZN"],
      ["token request: “Coin About Coins” $COINS — COIN pair — dev buys 0.5 COIN", "Coin About Coins", "COINS", "COIN"],
    ] as const;
    for (const [post, name, symbol, pairToken] of launches) {
      expect.soft(groundedCanonicalCommand(post), post).toMatchObject({ kind: "launch", name, symbol, pairToken });
    }
  });

  it("rejects posts containing two different launch specifications", () => {
    const post = "launch Autonomous Toaster ticker TOAST. Name Meeting Could Be Email, ticker EMAIL. Launch please.";
    expect(groundedCanonicalCommand(post)).toBeNull();
  });
});
