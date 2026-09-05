import { describe, expect, it } from "vitest";
import { canonicalCommandText, conversationalWalletMessage, decodePersistedXWalletIntent, explicitInformationalTopic, groundedCanonicalCommand, intentClassifierPrompt, isDirectLaunchHelpRequest, isPromotionalLaunchReference, parameterExtractorPrompt, parseXWalletIntent, requestedOperations, straightforwardCommandOperation, unknownWalletMessage, walletHelpMessage } from "../convex/xWalletIntent";
import { parseWalletCommand } from "../convex/walletCommands";

describe("deterministic X wallet replies", () => {
  it("grounds every supported cbBTC launch-pair synonym", () => {
    for (const alias of ["cbBTC", "$cbBTC", "BTC", "$BTC", "Bitcoin", "Coinbase Bitcoin", "Coinbase Wrapped Bitcoin", "Wrapped Bitcoin"]) {
      expect(groundedCanonicalCommand(`launch Bitcoin Cat ticker BCAT pair with ${alias}`), alias).toMatchObject({
        kind: "launch", name: "Bitcoin Cat", symbol: "BCAT", pairToken: "cbBTC",
      });
    }
    expect(groundedCanonicalCommand("buy $1 of BITCOIN")).toMatchObject({ kind: "buy", token: "BITCOIN" });
  });

  it("grounds supported pair aliases", () => {
    for (const [alias, pairToken] of [["Hims & Hers", "HIMS"], ["BlackBerry", "BB"], ["Gold", "GLD"], ["SPDR Gold Trust", "GLD"], ["Dell", "DELL"], ["WhiteFiber", "WYFI"], ["SK hynix", "SKHY"], ["TSMC", "TSM"], ["United States Oil Fund", "USO"], ["Eli Lilly", "LLY"], ["Roblox", "RBLX"]] as const) {
      expect(groundedCanonicalCommand(`launch Market Test ticker PTEST pair with ${alias}`), alias).toMatchObject({
        kind: "launch", name: "Market Test", symbol: "PTEST", pairToken,
      });
    }
  });

  it("deterministically gates fee reassignment to exact syntax", async () => {
    await expect(parseXWalletIntent("@Ponsbotfamily Reassign $PONSBOT fees to @alice", false)).resolves.toEqual({
      kind: "command", command: { kind: "reassign_fees", token: "PONSBOT", recipient: "@alice" },
    });
    await expect(parseXWalletIntent("@Ponsbotfamily Reassign $PONSBOT fees to holders", false)).resolves.toEqual({
      kind: "command", command: { kind: "reassign_fees", token: "PONSBOT", recipient: "holders" },
    });
    expect(straightforwardCommandOperation("Reassign $PONSBOT fees to @alice")).toBe("reassign_fees");
    expect(walletHelpMessage("fees")).toContain("Reassign $TICKER fees to @user");
    expect(walletHelpMessage("fees")).toContain("Reassign $TICKER fees to holders");
  });
  it("deterministically recognizes the contained upgrade phrase", async () => {
    await expect(parseXWalletIntent("@Ponsbotfamily Upgrade $PONSBOT to automated fees", false)).resolves.toEqual({
      kind: "command", command: { kind: "upgrade_fees", token: "PONSBOT" },
    });
    expect(straightforwardCommandOperation("Upgrade $PONSBOT to automated fees")).toBe("upgrade_fees");
    expect(parseWalletCommand("Hey, upgrade PONSBOT please").kind).toBe("upgrade_fees");
  });
  it("validates and restores immutable persisted command intents", () => {
    expect(decodePersistedXWalletIntent(JSON.stringify({ kind: "command", command: {
      kind: "buy", amount: "5", unit: "usd", token: "PONS", slippageBps: 250,
    } }))).toMatchObject({ kind: "command", command: { kind: "buy", token: "PONS" } });
    expect(() => decodePersistedXWalletIntent(JSON.stringify({ kind: "command", command: { kind: "send", amount: "5" } }))).toThrow();
    expect(() => decodePersistedXWalletIntent(JSON.stringify({ kind: "help", topic: "private_keys" }))).toThrow();
  });
  it("routes claim all fees without inventing a token", () => {
    expect(groundedCanonicalCommand("claim all my fees")).toEqual({ kind: "claim_fees" });
    expect(groundedCanonicalCommand("claim my fees for my launch")).toEqual({ kind: "claim_fees" });
    expect(groundedCanonicalCommand("Claim everything available for me")).toEqual({ kind: "claim_fees" });
    expect(straightforwardCommandOperation("create my wallet")).toBe("create_wallet");
    expect(straightforwardCommandOperation("wallet")).toBe("show_wallet");
    expect(straightforwardCommandOperation("balance")).toBe("show_balance");
    expect(groundedCanonicalCommand('launch "PONSCAT", ticker "PONSCAT", dev buy: $0')).toEqual({
      kind: "launch", launchMode: "pons", name: "PONSCAT", symbol: "PONSCAT",
    });
    expect(groundedCanonicalCommand('deploy this, ticker "botnetworking", Name "botnetworking"')).toMatchObject({
      kind: "launch", name: "botnetworking", symbol: "BOTNETWORKING",
    });
    expect(groundedCanonicalCommand("launch token called ANDROID and pair it with google stocks")).toMatchObject({
      kind: "launch", name: "ANDROID", symbol: "ANDROID", pairToken: "GOOGL",
    });
    expect(straightforwardCommandOperation("Claim everything available for me")).toBe("claim_fees");
  });
  it("executes wallet creation, wallet lookup, and an unspecified balance directly", async () => {
    await expect(parseXWalletIntent("create my wallet", false)).resolves.toEqual({
      kind: "command", command: { kind: "create_wallet" },
    });
    await expect(parseXWalletIntent("show my wallet", false)).resolves.toEqual({
      kind: "command", command: { kind: "show_wallet" },
    });
    await expect(parseXWalletIntent("balance", false)).resolves.toEqual({
      kind: "command", command: { kind: "show_balance" },
    });
  });
  it("treats an entire named token balance as a 100 percent burn", () => {
    expect(groundedCanonicalCommand("Burn my entire PONSBOT balance")).toEqual({
      kind: "burn", amount: "100", unit: "percent", token: "PONSBOT",
    });
    expect(straightforwardCommandOperation("Burn my entire PONSBOT balance")).toBe("burn");
  });
  it("requires buy or purchase together with burn for the combined workflow", () => {
    expect(intentClassifierPrompt()).toContain('"buy_and_burn"');
    expect(parameterExtractorPrompt("buy_and_burn", false)).toContain('either "buy" or "purchase"');
    expect(groundedCanonicalCommand("buy $20 of PONSBOT and burn it")).toMatchObject({ kind: "buy_and_burn", amount: "20", token: "PONSBOT" });
    expect(groundedCanonicalCommand("burn the PONSBOT I buy with 0.01 ETH")).toMatchObject({ kind: "buy_and_burn", amount: "0.01", token: "PONSBOT" });
    expect(groundedCanonicalCommand("purchase $25 of PONSBOT and burn it")).toMatchObject({ kind: "buy_and_burn", amount: "25", token: "PONSBOT" });
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
    expect(groundedCanonicalCommand("launch a token named Tesladog")).toMatchObject({ kind: "launch", name: "Tesladog", symbol: "TESLADOG" });
    expect(groundedCanonicalCommand("launch a token called Tesladog ticker TDOG")).toMatchObject({ kind: "launch", name: "Tesladog", symbol: "TDOG" });
    expect(parseWalletCommand("Launch a token named Aurora Signal with ticker AURA")).toMatchObject({ kind: "launch", name: "Aurora Signal", symbol: "AURA" });
    expect(parseWalletCommand("launch name: Green Candle; ticker: GC")).toMatchObject({ kind: "launch", name: "Green Candle", symbol: "GC" });
    expect(parseWalletCommand("launch a new token: name Solar Arcade, ticker SOLAR")).toMatchObject({ kind: "launch", name: "Solar Arcade", symbol: "SOLAR" });
    expect(parseWalletCommand("Deploy Coffee Break with symbol JAVA")).toMatchObject({ kind: "launch", name: "Coffee Break", symbol: "JAVA" });
    expect(groundedCanonicalCommand("launch ticker ONLY")).toMatchObject({ kind: "launch", name: "ONLY", symbol: "ONLY" });
    expect(groundedCanonicalCommand("launch PLANETCAT with same ticker")).toMatchObject({ kind: "launch", name: "PLANETCAT", symbol: "PLANETCAT" });
    expect(groundedCanonicalCommand("launch token name ticker wowo")).toMatchObject({ kind: "launch", name: "wowo", symbol: "WOWO" });
    expect(groundedCanonicalCommand("launch token name ticker DEGAN")).toMatchObject({ kind: "launch", name: "DEGAN", symbol: "DEGAN" });
    expect(parseWalletCommand("launch Market Dog ticker MDOG pair asset 0x1111111111111111111111111111111111111111")).toMatchObject({ kind: "launch", pairToken: "0x1111111111111111111111111111111111111111" });
    expect(parseWalletCommand("Launch Pons Bot ticker PONSBOT, pair asset TSLA")).toMatchObject({ kind: "launch", pairToken: "TSLA" });
    expect(groundedCanonicalCommand("Launch token, name is Velvet Rope and the symbol is VELVET")).toMatchObject({ kind: "launch", name: "Velvet Rope", symbol: "VELVET" });
    expect(groundedCanonicalCommand("Launch Pons Bot $PONSBOT pair ETH")).toMatchObject({ kind: "launch", name: "Pons Bot", symbol: "PONSBOT" });
    expect(groundedCanonicalCommand("Launch $RAIN — ‘Rain Check’ pair AAPL")).toMatchObject({ kind: "launch", name: "Rain Check", symbol: "RAIN" });
    expect(groundedCanonicalCommand("launch Plain Token ticker PLAIN no description needed")).toMatchObject({ kind: "launch", name: "Plain Token", symbol: "PLAIN" });
    expect(groundedCanonicalCommand("launch Plain Token ticker PLAIN no description needed")).not.toHaveProperty("description");
    expect(groundedCanonicalCommand("deploy Moon Potato ticker SPUD with AAPL as the pair")).toMatchObject({ kind: "launch", pairToken: "AAPL" });
    expect(groundedCanonicalCommand("deploy Moon Potato ticker SPUD AAPL as the pair")).toMatchObject({ kind: "launch", pairToken: "AAPL" });
    expect(groundedCanonicalCommand("create Green Market ticker GREEN with GOOGL pair")).toMatchObject({ kind: "launch", pairToken: "GOOGL" });
    expect(groundedCanonicalCommand("deploy Market Test ticker MTEST with ETH pair and 0.02 ETH dev buy")).toMatchObject({ kind: "launch", pairToken: "ETH" });
    for (const connector of ["THE", "AND", "WITH", "TO"]) {
      expect(groundedCanonicalCommand(`launch Safe Pair ticker SAFE pair ${connector}`)).toBeNull();
    }
  });

  it("keeps launch fee instructions out of names and grounds the bot recipient", () => {
    expect(groundedCanonicalCommand("@Ponsbotfamily launch SeptemberBullRun ticker $SBR assign fees to @Ponsbotfamily"))
      .toMatchObject({ kind: "launch", name: "SeptemberBullRun", symbol: "SBR", feeRecipient: "@Ponsbotfamily" });
    expect(groundedCanonicalCommand("@Ponsbotfamily launch token named Aurora Signal assign fees to @Ponsbotfamily"))
      .toMatchObject({ kind: "launch", name: "Aurora Signal", symbol: "AURORASIGNAL", feeRecipient: "@Ponsbotfamily" });
    expect(groundedCanonicalCommand("@Ponsbotfamily launch $SBR assign fees to @Ponsbotfamily"))
      .toMatchObject({ kind: "launch", name: "SBR", symbol: "SBR", feeRecipient: "@Ponsbotfamily" });
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
    expect(requestedOperations("give me my wallet")).toEqual(["show_wallet"]);
    expect(straightforwardCommandOperation("give me my wallet")).toBe("show_wallet");
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
    expect(groundedCanonicalCommand("claim everything I can claim")).toEqual({ kind: "claim_fees" });
    expect(groundedCanonicalCommand("collect everything")).toEqual({ kind: "claim_fees" });
  });

  it("treats explicit requests for everything in my wallet as holdings", () => {
    expect(straightforwardCommandOperation("Show everything in my wallet")).toBe("show_balance");
    expect(straightforwardCommandOperation("List all tokens in my wallet")).toBe("show_balance");
    expect(straightforwardCommandOperation("Show me my wallet holdings please")).toBe("show_balance");
    expect(straightforwardCommandOperation("what's my wallet balance")).toBe("show_balance");
    expect(straightforwardCommandOperation("check my wallet fund")).toBe("show_balance");
    expect(requestedOperations("what's my wallet balance")).toEqual(["show_balance"]);
  });

  it("routes narrow educational questions to their specific help topics", () => {
    expect(explicitInformationalTopic("how do I burn tokens?")).toBe("burn");
    expect(explicitInformationalTopic("Which assets can I use as launch pairs?")).toBe("pairs");
  });

  it("returns launch help for natural launch questions and incomplete requests", async () => {
    for (const text of [
      "@Ponsbotfamily how do I launch?",
      "How can I launch a token?",
      "how to launch on Pons",
      "@Ponsbotfamily I want to launch",
      "I'd like to launch a token",
      "Can you show me how to launch a coin?",
    ]) {
      await expect(parseXWalletIntent(text, false), text).resolves.toEqual({ kind: "help", topic: "launch" });
    }
    await expect(parseXWalletIntent("@Ponsbotfamily I want to launch Clawpump ticker CLAWPUMP", false))
      .resolves.toMatchObject({ kind: "command", command: { kind: "launch", name: "Clawpump", symbol: "CLAWPUMP" } });
  });

  it.each([
    "@ponsbotfamily how do I launch?",
    "@ponsbotfamily how do I launch",
  ])("deterministically recognizes the public guided-launch entry phrase: %s", async text => {
    expect(isDirectLaunchHelpRequest(text)).toBe(true);
    await expect(parseXWalletIntent(text, false)).resolves.toEqual({ kind: "help", topic: "launch" });
    expect(walletHelpMessage("launch")).toContain("reply “get started”");
  });

  it("documents worth-of buy syntax", () => {
    expect(parameterExtractorPrompt("buy", false)).toContain("buy $25 worth of TOKEN");
    expect(groundedCanonicalCommand("buy $25 worth of PONSBOT")).toMatchObject({ kind: "buy", amount: "25", token: "PONSBOT" });
  });

  it("keeps a worth-of buy executable when a copied ticker is followed by its contract", () => {
    const text = "now buy $40 worth of $PONSBOT 0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07";
    expect(requestedOperations(text)).toEqual(["buy"]);
    expect(groundedCanonicalCommand(text)).toMatchObject({
      kind: "buy", amount: "40", unit: "usd", token: "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07",
    });
  });

  it("keeps every help and ambiguity response within X's limit", () => {
    const topics = ["capabilities", "wallet", "fund", "gas", "balance", "send", "buy_sell", "cross_chain", "cross_chain_assets", "burn", "launch", "pairs", "fees"] as const;
    for (const topic of topics) expect(walletHelpMessage(topic).length).toBeLessThanOrEqual(280);
    expect(unknownWalletMessage().length).toBeLessThanOrEqual(280);
    expect(conversationalWalletMessage()).toContain("Hi there, I'm Pons Bot!");
    expect(conversationalWalletMessage()).not.toContain("couldn't quite make that out");
    expect(conversationalWalletMessage().length).toBeLessThanOrEqual(280);
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
    expect(prompt).toContain("Use unknown_wallet only for a genuine present-tense command attempt");
    expect(prompt).toContain("Greetings, thanks, compliments, jokes, reactions, casual conversation");
  });

  it("does not count command words inside quoted launch metadata", () => {
    const post = 'launch "Pons Bot" ticker $PONSBOT X: www.x.com/ponsbotfamily description "Swap, sell, and launch on Pons V2 with just one X post."';
    expect(parseWalletCommand(canonicalCommandText(post))).toMatchObject({ kind: "launch", name: "Pons Bot", symbol: "PONSBOT" });
    expect(groundedCanonicalCommand(post)).toMatchObject({
      kind: "launch", name: "Pons Bot", symbol: "PONSBOT", twitter: "https://x.com/ponsbotfamily", description: "Swap, sell, and launch on Pons V2 with just one X post.",
    });
  });

  it("does not execute launch examples, corrections, translations, or explicit negations", async () => {
    await expect(parseXWalletIntent("@Ponsbotfamily I only translated the Morse, not trying to launch anything", false)).resolves.toEqual({ kind: "irrelevant" });
    await expect(parseXWalletIntent("@Ponsbotfamily can you correct this: launch Bankr ticker BANKR", false)).resolves.toEqual({ kind: "irrelevant" });
    await expect(parseXWalletIntent("@Ponsbotfamily this supports natural language such as: deploy Cedar ticker CDR", false)).resolves.toEqual({ kind: "irrelevant" });
    await expect(parseXWalletIntent("@Ponsbotfamily Your an idiot lol I didn't want you to launch another one", false)).resolves.toEqual({ kind: "irrelevant" });
  });

  it("does not treat promotional launch announcements as launch authority", async () => {
    const featureComparison = "Soft reminder for anyone sleeping: ATH $BNKR = 120M MC And that was in a bear market. Same type of infra: AI bot + trade in natural language + launch tokens straight from the timeline. Now look at @Ponsbotfamily $PONSBOT sitting at ~400K. One difference: BNKR had to walk alone.";
    for (const text of [featureComparison, "Check this out: @Ponsbotfamily platform features trade + launch coins from the timeline."]) {
      expect(isPromotionalLaunchReference(text)).toBe(true);
      expect(straightforwardCommandOperation(text)).toBeNull();
      await expect(parseXWalletIntent(text, false)).resolves.toEqual({ kind: "irrelevant" });
      await expect(parseXWalletIntent(text, true)).resolves.toEqual({ kind: "irrelevant" });
    }
    for (const text of [
      `${featureComparison}\n@Ponsbotfamily launch Fresh Dog ticker $FDOG`,
      `@Ponsbotfamily launch Fresh Dog ticker $FDOG. ${featureComparison}`,
    ]) {
      expect(isPromotionalLaunchReference(text)).toBe(false);
      expect(straightforwardCommandOperation(text)).toBe("launch");
    }
    const pdog = "$Pdog fresh launch from the $PonsBot @Ponsbotfamily @MEADGod Dex is paid sitting around 25k Bonding is inevitable!!!!! $pons #pons @ponsdotfamily Ca : 0x75074C8ca03CC2afB855A4DAbCa33f15031B9B07 Tg : https://t.me/ponsdoghood";
    expect(isPromotionalLaunchReference(pdog)).toBe(true);
    expect(straightforwardCommandOperation(pdog)).toBeNull();
    await expect(parseXWalletIntent(pdog, true)).resolves.toEqual({ kind: "irrelevant" });

    const capabilityPromotion = "unipcs! check out @Ponsbotfamily, basically bankrbot for Pons/RH. houdini integration for cross chain swaps and can launch stock backed token assets with the bot as well!";
    expect(isPromotionalLaunchReference(capabilityPromotion)).toBe(true);
    expect(straightforwardCommandOperation(capabilityPromotion)).toBeNull();
    await expect(parseXWalletIntent(capabilityPromotion, false)).resolves.toEqual({ kind: "irrelevant" });

    expect(isPromotionalLaunchReference("@Ponsbotfamily launch stock backed token named Equity Dog ticker EDOG")).toBe(false);
    expect(isPromotionalLaunchReference("@Ponsbotfamily can you launch Equity Dog ticker EDOG?")).toBe(false);

    const legitimate = "@Ponsbotfamily launch Market Dog ticker MDOG pair with 0x1111111111111111111111111111111111111111 description market launch with strong liquidity";
    expect(isPromotionalLaunchReference(legitimate)).toBe(false);
    expect(straightforwardCommandOperation(legitimate)).toBe("launch");

    const clawpump = "Backed by the community, yet Examplecoin decided to launch the meme $EXAMPLE via @Ponsbotfamily Reprice is imminent https://x.com/exampleproject/status/1234567890123456789";
    expect(isPromotionalLaunchReference(clawpump)).toBe(true);
    await expect(parseXWalletIntent(clawpump, false)).resolves.toEqual({ kind: "irrelevant" });

    const directLaunch = "Hey @Ponsbotfamily launch Clawpump ticker CLAWPUMP, backed by the community";
    expect(isPromotionalLaunchReference(directLaunch)).toBe(false);
    expect(straightforwardCommandOperation(directLaunch)).toBe("launch");

    const firstPersonLaunch = "@Ponsbotfamily I want to launch Clawpump ticker CLAWPUMP";
    expect(isPromotionalLaunchReference(firstPersonLaunch)).toBe(false);
    expect(straightforwardCommandOperation(firstPersonLaunch)).toBe("launch");

    const promotionalDiscussion = "Pons is doing $900k a day revenue and the best way to launch a project using a bot is with $PONSBOT, now near 400k mcap. Hold with conviction; its ATH can be much higher. @Ponsbotfamily";
    expect(isPromotionalLaunchReference(promotionalDiscussion)).toBe(true);
    expect(straightforwardCommandOperation(promotionalDiscussion)).toBeNull();

    const storyThenCommand = "I have been building this community for months and wanted to explain why it matters. There is a long story behind the art and the people supporting it. @Ponsbotfamily launch Story Dog ticker $STORY description \"A community token\"";
    expect(isPromotionalLaunchReference(storyThenCommand)).toBe(false);
    expect(groundedCanonicalCommand("launch Story Dog ticker $STORY description \"A community token\"")).toMatchObject({ kind: "launch", name: "Story Dog", symbol: "STORY" });
    expect(straightforwardCommandOperation(storyThenCommand)).toBe("launch");

    const commandThenStory = "@Ponsbotfamily launch Story Dog ticker $STORY. I have been building this community for months, and here is the long story of why it matters to us.";
    expect(isPromotionalLaunchReference(commandThenStory)).toBe(false);
    expect(straightforwardCommandOperation(commandThenStory)).toBe("launch");

    const embeddedExampleQuestion = "Can you explain whether @Ponsbotfamily launch Story Dog ticker $STORY would work?";
    expect(straightforwardCommandOperation(embeddedExampleQuestion)).toBeNull();
  });

  it("rejects targetless buyback-and-burn wording instead of treating ETH as a burn token", async () => {
    await expect(parseXWalletIntent("@Ponsbotfamily Can you now buyback 0.05 ETH and burn it?", false)).resolves.toEqual({ kind: "unknown_wallet" });
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
    expect(parameterExtractorPrompt("buy_and_send", false)).toContain("pairAsset AAPL");
    expect(parameterExtractorPrompt("send", false)).toContain('"recipient"');
    expect(parameterExtractorPrompt("launch", true)).toContain('"symbol"');
    expect(parameterExtractorPrompt("launch", true)).toContain("quotation marks delimit a literal field value");
    expect(parameterExtractorPrompt("launch", true)).toContain("connector words");
    expect(parameterExtractorPrompt("launch", true)).toContain("Attached image present: yes");
    expect(parameterExtractorPrompt("claim_fees", false)).toContain("native-pair fees");
  });

  it("explains live creator-fee claims and paired-asset trades", () => {
    expect(walletHelpMessage("fees")).toContain("claim my fees");
    expect(walletHelpMessage("fees")).not.toContain("not currently supported");
    expect(walletHelpMessage("buy_sell")).toContain("buy $5 of PONSBOT");
    expect(walletHelpMessage("buy_sell")).toContain("sell 0.001 ETH of PONSBOT");
    expect(walletHelpMessage("buy_sell")).toContain("swap $25 of ETH to USDG");
    expect(walletHelpMessage("buy_sell")).not.toContain("Cross-chain");
    expect(walletHelpMessage("cross_chain")).toContain("WALLET ADDRESS");
    expect(walletHelpMessage("cross_chain")).toContain("Ask me for available chains and assets");
    expect(walletHelpMessage("cross_chain_assets")).toContain("ETH on Ethereum, Base");
    expect(explicitInformationalTopic("hey tell me how to cross chain")).toBe("cross_chain");
    expect(explicitInformationalTopic("how do private swaps work?")).toBe("cross_chain");
    expect(explicitInformationalTopic("explain Houdini Swap")).toBe("cross_chain");
    expect(explicitInformationalTopic("what cross-chain assets and chains are available?")).toBe("cross_chain_assets");
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

  it("requires explicit compound action words and ignores a lone bot invocation as recipient", () => {
    expect(requestedOperations("@Ponsbotfamily spend 3 GME on GOBLIN.")).toEqual(["buy"]);
    expect(groundedCanonicalCommand("@Ponsbotfamily spend 3 GME on GOBLIN.")).toMatchObject({
      kind: "buy", amount: "3", unit: "pair", pairAsset: "GME", token: "GOBLIN",
    });
    expect(requestedOperations("Buy 2 AAPL worth of TCAT @Ponsbotfamily")).toEqual(["buy"]);
    expect(parseWalletCommand("Buy 2 AAPL worth of TCAT")).toMatchObject({
      kind: "buy", amount: "2", unit: "pair", pairAsset: "AAPL", token: "TCAT",
    });
    expect(groundedCanonicalCommand("Buy 2 AAPL worth of TCAT @Ponsbotfamily")).toMatchObject({
      kind: "buy", amount: "2", unit: "pair", pairAsset: "AAPL", token: "TCAT",
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
