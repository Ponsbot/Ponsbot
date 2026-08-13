import { describe, expect, it } from "vitest";
import { canonicalCommandText, groundedCanonicalCommand, intentClassifierPrompt, parameterExtractorPrompt, unknownWalletMessage, walletHelpMessage } from "../convex/xWalletIntent";
import { parseWalletCommand } from "../convex/walletCommands";

describe("deterministic X wallet replies", () => {
  it("grounds flexible launch names and pair-asset syntax", () => {
    expect(parseWalletCommand("Launch a token named Aurora Signal with ticker AURA")).toMatchObject({ kind: "launch", name: "Aurora Signal", symbol: "AURA" });
    expect(parseWalletCommand("launch name: Green Candle; ticker: GC")).toMatchObject({ kind: "launch", name: "Green Candle", symbol: "GC" });
    expect(parseWalletCommand("launch a new token: name Solar Arcade, ticker SOLAR")).toMatchObject({ kind: "launch", name: "Solar Arcade", symbol: "SOLAR" });
    expect(parseWalletCommand("Deploy Coffee Break with symbol JAVA")).toMatchObject({ kind: "launch", name: "Coffee Break", symbol: "JAVA" });
    expect(parseWalletCommand("launch ticker ONLY")).toMatchObject({ kind: "unknown" });
    expect(parseWalletCommand("launch Market Dog ticker MDOG pair asset 0x1111111111111111111111111111111111111111")).toMatchObject({ kind: "launch", pairToken: "0x1111111111111111111111111111111111111111" });
    expect(parseWalletCommand("Launch Pons Bot ticker PONSBOT, pair asset TSLA")).toMatchObject({ kind: "launch", pairToken: "TSLA" });
  });

  it("accepts a direct contract address as the buy target", () => {
    expect(parseWalletCommand("@Ponsbotfamily buy $20 of 0x1111111111111111111111111111111111111111")).toMatchObject({
      kind: "buy", amount: "20", unit: "usd", token: "0x1111111111111111111111111111111111111111",
    });
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
    expect(walletHelpMessage("buy_sell")).toContain("buy 5 MSFT of PONSBOT");
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
});
