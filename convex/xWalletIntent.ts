import { openRouter } from "./llm";
import { parseWalletCommand, validateStructuredWalletCommand, type WalletCommand } from "./walletCommands";

export type WalletHelpTopic = "capabilities" | "wallet" | "fund" | "balance" | "send" | "buy_sell" | "burn" | "launch" | "pairs" | "fees";
export type XWalletIntent =
  | { kind: "irrelevant" }
  | { kind: "unknown_wallet" }
  | { kind: "help"; topic: WalletHelpTopic }
  | { kind: "command"; command: WalletCommand };

const WALLET_WORDS = /\b(?:wallet|address|balance|fund|deposit|send|transfer|give|buy|sell|swap|burn|claim|fees?|launch|plant|deploy|token|coin|ticker|slippage|pairs?|assets?|dev\s*buy)\b/i;

export function walletHelpMessage(topic: WalletHelpTopic) {
  const messages: Record<WalletHelpTopic, string> = {
    capabilities: "✨ I can create your Robinhood Chain wallet, check balances, buy, sell, send, burn, and launch tokens through Pons! Tell me what you'd like to do and I'll take it from there.",
    wallet: "👛 Just ask for your wallet! I'll return its Robinhood Chain explorer link. It's connected to your X account and ready to receive ETH or supported tokens.",
    fund: "💰 Ask for your wallet, open the link, and send Robinhood Chain ETH or supported tokens to it. Keep a little ETH available for gas!",
    balance: "📊 Ask “what's my balance?” to see your nonzero ETH and known tokens. You can also name a ticker or contract to check one asset.",
    send: "📤 Tell me the amount, asset, and destination wallet or X handle. Example: send 25 ROOT to @user. You can also send half, all, or a percentage!",
    buy_sell: "🔄 Tell me buy or sell, the amount, and the ticker or contract. Example: buy $20 of ROOT or sell half my ROOT. You can also choose your slippage.",
    burn: "🔥 Say burn, the amount, and the ticker or contract. Example: burn 25 ROOT, burn $10 of ROOT, or burn half my ROOT.",
    launch: "🚀 Ready to launch on Pons? Fund your wallet with ETH, then send the token name and ticker. Artwork, description, links, pair asset, and developer buy can be included too!",
    pairs: "🔗 Ask “what assets can I pair with?” and I'll check the Pons V2 factory for a fresh, verified list!",
    fees: "🛠️ Creator-fee claims aren't enabled in this local build yet, but they're on the workflow checklist.",
  };
  return messages[topic];
}

export function unknownWalletMessage() {
  return "🤔 I couldn't quite make that out. Try “show my wallet,” “show my balance,” or “launch Garden, ticker GDN.”";
}

function explicitAuthority(text: string, command: WalletCommand) {
  if (command.kind === "send") return /\b(?:send|transfer|give)\b/i.test(text);
  if (command.kind === "burn") return /\bburn\b/i.test(text);
  if (command.kind === "buy") return /\bbuy\b/i.test(text);
  if (command.kind === "sell") return /\bsell\b/i.test(text);
  if (command.kind === "claim_fees") return /\bclaim\b/i.test(text);
  if (command.kind === "launch") return /\b(?:launch|plant|deploy|create|sprout)\b/i.test(text);
  return true;
}

function includesLoose(text: string, value: string) {
  const canonical = (input: string) => input.toLowerCase().replace(/^\$/, "").replace(/[^a-z0-9]+/g, " ").trim();
  return canonical(text).includes(canonical(value));
}

function identifierIsGrounded(text: string, value: string) {
  const escaped = value.replace(/^\$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-zA-Z0-9])\\$?${escaped}(?=$|[^a-zA-Z0-9])`, "i").test(text);
}

function fieldsAreGrounded(text: string, command: WalletCommand) {
  if (command.kind === "send") {
    const amountGrounded = includesLoose(text, command.amount)
      || (command.unit === "percent" && command.amount === "100" && /\ball(?:\s+of)?\b/i.test(text))
      || (command.unit === "percent" && command.amount === "50" && /\bhalf(?:\s+of)?\b/i.test(text));
    return amountGrounded && includesLoose(text, command.recipient) && (!command.token || identifierIsGrounded(text, command.token));
  }
  if (command.kind === "burn" || command.kind === "buy" || command.kind === "sell") {
    const amountGrounded = includesLoose(text, command.amount)
      || (command.unit === "percent" && command.amount === "100" && /\ball(?:\s+of)?\b/i.test(text))
      || (command.unit === "percent" && command.amount === "50" && /\bhalf(?:\s+of)?\b/i.test(text));
    return amountGrounded && identifierIsGrounded(text, command.token);
  }
  if (command.kind === "claim_fees") return !command.token || identifierIsGrounded(text, command.token);
  if (command.kind === "show_balance") return !command.token || identifierIsGrounded(text, command.token);
  if (command.kind === "launch") {
    return includesLoose(text, command.name) && identifierIsGrounded(text, command.symbol)
      && (!command.description || includesLoose(text, command.description))
      && (!command.website || text.includes(command.website))
      && (!command.twitter || text.includes(command.twitter))
      && (!command.telegram || text.includes(command.telegram))
      && (!command.devBuy || includesLoose(text, command.devBuy.amount));
  }
  return true;
}

function extractJson(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced || raw;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)) as unknown; } catch { return null; }
}

export type WalletOperation = "create_wallet" | "show_wallet" | "show_balance" | "send" | "burn" | "buy" | "sell" | "claim_fees" | "launch";
type ClassifiedIntent =
  | { kind: "irrelevant" }
  | { kind: "unknown_wallet" }
  | { kind: "question"; topic: WalletHelpTopic }
  | { kind: "command"; operation: WalletOperation };

const HELP_TOPICS: WalletHelpTopic[] = ["capabilities", "wallet", "fund", "balance", "send", "buy_sell", "burn", "launch", "pairs", "fees"];
const OPERATIONS: WalletOperation[] = ["create_wallet", "show_wallet", "show_balance", "send", "burn", "buy", "sell", "claim_fees", "launch"];

function validateClassification(value: unknown): ClassifiedIntent | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.kind === "irrelevant") return { kind: "irrelevant" };
  if (item.kind === "unknown_wallet") return { kind: "unknown_wallet" };
  if (item.kind === "question" && HELP_TOPICS.includes(item.topic as WalletHelpTopic)) return { kind: "question", topic: item.topic as WalletHelpTopic };
  if (item.kind === "command" && OPERATIONS.includes(item.operation as WalletOperation)) return { kind: "command", operation: item.operation as WalletOperation };
  return null;
}

export function intentClassifierPrompt() {
  return `Classify one direct X post for a Robinhood Chain wallet and Pons V2 launch bot. Determine intent only. Do not extract amounts, assets, recipients, names, tickers, links, or any other parameters. Return exactly one JSON object and no prose.

Allowed outputs:
{"kind":"irrelevant"}
{"kind":"unknown_wallet"}
{"kind":"question","topic":"capabilities|wallet|fund|balance|send|buy_sell|burn|launch|pairs|fees"}
{"kind":"command","operation":"create_wallet|show_wallet|show_balance|send|burn|buy|sell|claim_fees|launch"}

A question asks how something works, what is supported, what pairs are allowed, or what the bot can do. A command asks the bot to perform or prepare one specific operation. “What is my wallet?”, “show my wallet”, “deposit address”, and “where do I send ETH?” are show_wallet commands, not general questions. If the post requests multiple operations, is wallet-related but ambiguous, or lacks a discernible operation, return unknown_wallet. If it has no wallet, trading, transfer, burn, fee, or launch purpose, return irrelevant. The direct post is the only authority.`;
}

const extractionInstructions: Record<WalletOperation, string> = {
  create_wallet: `Return {"kind":"create_wallet"}. Return null if the user did not explicitly ask to create, open, or set up a wallet.`,
  show_wallet: `Return {"kind":"show_wallet"}. Requests for the user's wallet, deposit address, receiving address, or where to send ETH qualify.`,
  show_balance: `Return {"kind":"show_balance"} with optional "token". Never invent a ticker or address.`,
  send: `Return {"kind":"send","amount":"decimal","unit":"eth|usd|token|percent","recipient":"@handle or 0x address"} with "token" when required. Convert all to 100 percent and half to 50 percent. Preserve addresses exactly. A token unit or percent requires a token.`,
  burn: `Return {"kind":"burn","amount":"decimal","unit":"usd|token|percent","token":"ticker or address"}. The exact word burn must appear. Convert all/half to 100/50 percent.`,
  buy: `Return {"kind":"buy","amount":"decimal","unit":"eth|usd","token":"ticker or address","slippageBps":250}. Convert an explicit slippage percent to basis points; allowed range is 10 through 2000.`,
  sell: `Return {"kind":"sell","amount":"decimal","unit":"token|percent","token":"ticker or address","slippageBps":250}. Convert all/half to 100/50 percent and explicit slippage percent to basis points.`,
  claim_fees: `Return {"kind":"claim_fees"} with optional "token" only when the user names it.`,
  launch: `Return {"kind":"launch","launchMode":"pons","name":"token name","symbol":"TICKER"} plus only explicitly supplied optional description, website, twitter, telegram, and devBuy {"amount":"decimal","unit":"eth|usd"}. Name and symbol must be separately grounded. Remove a leading $ and uppercase the symbol. An attachment is optional and is handled separately; never invent an image URL.`,
};

export function parameterExtractorPrompt(operation: WalletOperation, hasImage: boolean) {
  return `Extract parameters for exactly one ${operation} command. The intent classifier has already selected this operation. Do not change the operation, answer the user, or infer missing values. Return one JSON object only. If any required parameter is missing or ambiguous, return {"kind":"invalid"}.

${extractionInstructions[operation]}

Remove commas from numeric strings. Preserve contract and recipient addresses exactly. Tickers may lose only a leading $. Do not use context outside the direct post. Attached image present: ${hasImage ? "yes" : "no"}.`;
}

function validateExtractedCommand(value: unknown, operation: WalletOperation, text: string): WalletCommand | null {
  const command = validateStructuredWalletCommand(value);
  if (!command || command.kind === "unknown" || command.kind !== operation || !explicitAuthority(text, command) || !fieldsAreGrounded(text, command)) {
    return null;
  }
  return command;
}

function deterministicFallback(text: string): XWalletIntent {
  const parsed = parseWalletCommand(text);
  if (parsed.kind !== "unknown") return { kind: "command", command: parsed };
  if (!WALLET_WORDS.test(text)) return { kind: "irrelevant" };
  if (/\bwhat\s+can\s+you\s+do|\bcommands?|\bfeatures?\b/i.test(text)) return { kind: "help", topic: "capabilities" };
  if (/\b(?:what|which|list|supported|allowed|available)\b[\s\S]{0,50}\b(?:pair|pairs|paired|pairing|assets?)\b|\b(?:pair|pairs|paired|pairing)\b[\s\S]{0,50}\b(?:with|supported|allowed|available)\b/i.test(text)) return { kind: "help", topic: "pairs" };
  if (/\bhow\b|\bwhat\b|\bexplain\b|\bhelp\b/i.test(text)) {
    if (/\blaunch|plant|deploy|dev\s*buy\b/i.test(text)) return { kind: "help", topic: "launch" };
    if (/\bburn\b/i.test(text)) return { kind: "help", topic: "burn" };
    if (/\bbuy|sell|swap|slippage\b/i.test(text)) return { kind: "help", topic: "buy_sell" };
    if (/\bsend|transfer|give\b/i.test(text)) return { kind: "help", topic: "send" };
    if (/\bbalance\b/i.test(text)) return { kind: "help", topic: "balance" };
    if (/\bfund|deposit\b/i.test(text)) return { kind: "help", topic: "fund" };
    if (/\bclaim|fees?\b/i.test(text)) return { kind: "help", topic: "fees" };
    return { kind: "help", topic: "wallet" };
  }
  return { kind: "unknown_wallet" };
}

export async function parseXWalletIntent(text: string, hasImage: boolean): Promise<XWalletIntent> {
  let classification: ClassifiedIntent | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await openRouter([{ role: "system", content: intentClassifierPrompt() }, { role: "user", content: text }], 80, {
        reasoningEffort: "medium", minimumCompletionTokens: 256, timeoutMs: 20_000, providerSort: "latency", temperature: 0,
      });
      classification = validateClassification(extractJson(raw));
      if (classification) break;
    } catch (error) {
      console.error("x_intent_classification_failed", { attempt: attempt + 1, message: error instanceof Error ? error.message : "unknown" });
    }
  }
  if (!classification) return deterministicFallback(text);
  if (classification.kind === "irrelevant" || classification.kind === "unknown_wallet") return classification;
  if (classification.kind === "question") return { kind: "help", topic: classification.topic };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await openRouter([{ role: "system", content: parameterExtractorPrompt(classification.operation, hasImage) }, { role: "user", content: text }], 240, {
        reasoningEffort: classification.operation === "launch" ? "high" : "medium",
        minimumCompletionTokens: 512, timeoutMs: 25_000, providerSort: "latency", temperature: 0,
      });
      const parsed = extractJson(raw);
      const command = parsed ? validateExtractedCommand(parsed, classification.operation, text) : null;
      if (command) return { kind: "command", command };
      console.error("x_command_parameter_validation_failed", { operation: classification.operation, attempt: attempt + 1 });
    } catch (error) {
      console.error("x_command_parameter_extraction_failed", { operation: classification.operation, attempt: attempt + 1, message: error instanceof Error ? error.message : "unknown" });
    }
  }

  // A deterministic parser is a safe availability fallback, but it may not
  // override the operation selected by stage one.
  const fallback = parseWalletCommand(text);
  const command = fallback.kind === classification.operation
    ? validateExtractedCommand(fallback, classification.operation, text)
    : null;
  return command ? { kind: "command", command } : { kind: "unknown_wallet" };
}
