export type AmountUnit = "eth" | "usd" | "token" | "percent";

export type WalletCommand =
  | { kind: "create_wallet" }
  | { kind: "show_wallet" }
  | { kind: "show_balance"; token?: string }
  | { kind: "send"; amount: string; unit: AmountUnit; token?: string; recipient: string }
  | { kind: "burn"; amount: string; unit: AmountUnit; token: string }
  | { kind: "buy"; amount: string; unit: "eth" | "usd" | "pair"; token: string; pairAsset?: string; slippageBps: number }
  | { kind: "buy_and_send"; amount: string; unit: "eth" | "usd" | "pair"; token: string; pairAsset?: string; recipient: string; slippageBps: number }
  | { kind: "buy_and_burn"; amount: string; unit: "eth" | "usd" | "pair"; token: string; pairAsset?: string; slippageBps: number }
  | { kind: "swap_token_for_token"; amount: string; unit: "usd"; fromToken: string; toToken: string; slippageBps: number }
  | { kind: "sell"; amount: string; unit: "usd" | "token" | "percent"; token: string; slippageBps: number }
  | { kind: "claim_fees"; token?: string }
  | {
      kind: "launch";
      launchMode: "pons";
      name: string;
      symbol: string;
      description?: string;
      website?: string;
      twitter?: string;
      telegram?: string;
      pairToken?: string;
      devBuy?: { amount: string; unit: "eth" | "usd" | "pair" };
    }
  | { kind: "unknown"; reason: string };

const ADDRESS = /0x[a-fA-F0-9]{40}/;
// Accept human-formatted quantities such as 1,000 or 1,234.56. Commas are
// removed before a command crosses the parser boundary.
const NUMBER = "((?:[0-9][0-9,]*(?:\\.[0-9]+)?|\\.[0-9]+))";
const NUMBER_NC = "(?:[0-9][0-9,]*(?:\\.[0-9]+)?|\\.[0-9]+)";
export const DEFAULT_SWAP_SLIPPAGE_BPS = 250;

export function isTerminalCommand(command: WalletCommand) {
  return ["show_wallet", "show_balance", "buy", "buy_and_burn", "swap_token_for_token", "sell", "send", "burn", "claim_fees"].includes(command.kind);
}

function slippageBps(text: string) {
  const match = text.match(/\bslippage\s*(?:is|=|:|of|at)?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i)
    || text.match(/\b([0-9]+(?:\.[0-9]+)?)\s*%\s+slippage\b/i);
  if (!match) return DEFAULT_SWAP_SLIPPAGE_BPS;
  const bps = Math.round(Number(match[1]) * 100);
  return Number.isFinite(bps) && bps >= 10 && bps <= 2_000 ? bps : -1;
}

function tradeToken(text: string, verb: "buy" | "sell") {
  const afterOf = text.match(new RegExp(`\\b${verb}\\b[\\s\\S]*?\\bof\\s+\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"))?.[1];
  const address = text.match(ADDRESS)?.[0];
  const ticker = text.match(new RegExp(`\\b${verb}\\s+(?:\\$?${NUMBER_NC}\\s*(?:usd|dollars?|eth|weth)?\\s+(?:of\\s+)?)?\\$([a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"))?.[1];
  const direct = text.match(new RegExp(`\\b${verb}\\s+${NUMBER_NC}\\s+(?:of\\s+)?\\$?([a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"))?.[1];
  return afterOf || address || ticker || direct;
}

function percentageAsset(text: string, verb: "send" | "sell" | "burn") {
  const verbPattern = verb === "send" ? "(?:send|transfer|give)" : verb;
  const match = text.match(new RegExp(`\\b${verbPattern}\\s+(all|half|entire|[0-9]+(?:\\.[0-9]{1,4})?\\s*%)\\s+(?:of\\s+)?(?:my\\s+)?\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})(?:\\s+balance)?\\b`, "i"))
    || text.match(new RegExp(`\\b${verbPattern}\\s+my\\s+(all|half|entire)\\s+\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})(?:\\s+balance)?\\b`, "i"));
  if (!match) return undefined;
  const amount = /^(?:all|entire)$/i.test(match[1]) ? "100" : /^half$/i.test(match[1]) ? "50" : match[1].replace(/\s*%$/, "");
  const numeric = Number(amount);
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 100 ? { amount, token: match[2] } : null;
}

function stripWrappingQuotes(value: string) {
  return value.trim().replace(/^["'\u2018\u2019\u201c\u201d]+|["'\u2018\u2019\u201c\u201d]+$/g, "").trim();
}

function cleanSymbol(value: string) {
  return stripWrappingQuotes(value).replace(/^\$/, "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 12);
}

function cleanToken(value: string) {
  const token = value.replace(/^\$/, "");
  return /^0x[a-fA-F0-9]{40}$/.test(token) ? token : cleanSymbol(token);
}

function cleanAmount(value: string) {
  const cleaned = value.replaceAll(",", "");
  return cleaned.startsWith(".") ? `0${cleaned}` : cleaned;
}

function cleanLabeledLink(value: string) {
  return stripWrappingQuotes(value.trim()).replace(/[.,;!?)}\]]+$/, "");
}

function labeledWebsiteValue(text: string) {
  return text.match(/\b(?:website|site)\s*(?:is|=|:)?\s*((?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(?:\/[^\s,;]*)?)/i)?.[1];
}

function labeledXValue(text: string) {
  const valueShape = "(@[a-zA-Z0-9_]{1,15}|(?:https?:\\/\\/)?(?:www\\.)?[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}(?:\\/[^\\s,;]*)?)";
  return text.match(new RegExp(`\\b(?:x|twitter)(?:\\s+link)?\\s*(?:is|=|:)\\s*${valueShape}`, "i"))?.[1]
    || text.match(/\b(?:x|twitter)(?:\s+link)?\s+(@[a-zA-Z0-9_]{1,15}|(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/[^\s,;]+)/i)?.[1];
}

function textOutsideQuotedContent(text: string) {
  return text.replace(/"[^"\r\n]*"|“[^”\r\n]*”|'[^'\r\n]*'|‘[^’\r\n]*’/g, (value) => " ".repeat(value.length));
}

export function normalizeXUrl(value: string) {
  const cleaned = cleanLabeledLink(value);
  const handle = cleaned.match(/^@([a-zA-Z0-9_]{1,15})$/)?.[1];
  const candidate = handle ? `https://x.com/${handle}`
    : /^https?:\/\//i.test(cleaned) ? cleaned
      : `https://${cleaned}`;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new Error("x link must use x.com/username"); }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if ((host !== "x.com" && host !== "twitter.com") || parts.length !== 1
    || !/^[a-zA-Z0-9_]{1,15}$/.test(parts[0]) || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("x link must use x.com/username");
  }
  return `https://x.com/${parts[0]}`;
}

function unsafeWebsiteHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal") || host.endsWith(".lan") || host.includes(":")) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

export function normalizeWebsiteUrl(value: string) {
  const cleaned = cleanLabeledLink(value);
  const candidate = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new Error("website link is invalid"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("website link is invalid");
  if (!url.hostname || url.username || url.password || url.port || unsafeWebsiteHost(url.hostname)) throw new Error("website link is invalid or unsafe");
  if (!/^[a-z0-9.-]+$/i.test(url.hostname) || url.hostname.startsWith(".") || url.hostname.endsWith(".")
    || url.hostname.includes("..") || (!url.hostname.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname))) {
    throw new Error("website link is invalid");
  }
  url.protocol = "https:";
  return url.pathname === "/" && !url.search && !url.hash ? url.origin : url.toString();
}

export function normalizeTelegramUrl(value: string) {
  const cleaned = stripWrappingQuotes(value.trim()).replace(/[.,;!?)}\]]+$/, "");
  const candidate = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new Error("telegram link must use t.me/XXXXX"); }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if ((host !== "t.me" && host !== "telegram.me") || parts.length !== 1
    || !/^[a-zA-Z0-9_]{1,32}$/.test(parts[0]) || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("telegram link must use t.me/XXXXX");
  }
  return `https://t.me/${parts[0]}`;
}

export function normalizeLaunchTelegram(command: WalletCommand, text?: string): WalletCommand {
  if (command.kind !== "launch") return command;
  const labeled = text?.match(/\b(?:telegram|tg)\s*(?:is|=|:)?\s*([^\s,;]+)/i)?.[1];
  const supplied = labeled || command.telegram;
  if (!supplied) return command;
  return { ...command, telegram: normalizeTelegramUrl(supplied) };
}

export function normalizeLaunchLinks(command: WalletCommand, text?: string): WalletCommand {
  if (command.kind !== "launch") return command;
  const operativeText = text ? textOutsideQuotedContent(text) : undefined;
  const explicitWebsite = operativeText?.match(/\b(?:website|site)\s*(?:is|=|:)\s*([^\s,;]+)/i)?.[1];
  const explicitX = operativeText?.match(/\b(?:x|twitter)(?:\s+link)?\s*(?:is|=|:)\s*([^\s,;]+)/i)?.[1];
  const website = (operativeText ? labeledWebsiteValue(operativeText) : undefined) || explicitWebsite || command.website;
  const twitter = (operativeText ? labeledXValue(operativeText) : undefined) || explicitX || command.twitter;
  return {
    ...command,
    ...(website ? { website: normalizeWebsiteUrl(website) } : {}),
    ...(twitter ? { twitter: normalizeXUrl(twitter) } : {}),
  };
}

function normalizedTelegramOrRaw(value: string) {
  try { return normalizeTelegramUrl(value); } catch { return value; }
}


function normalizedWebsiteOrRaw(value: string) {
  try { return normalizeWebsiteUrl(value); } catch { return value; }
}

function normalizedXOrRaw(value: string) {
  try { return normalizeXUrl(value); } catch { return value; }
}

function quotedField(text: string, label: string, maxLength: number) {
  const quoted = text.match(new RegExp(`\\b(?:${label})\\s*(?:is|=|:)?\\s*["“]([^"”]+)["”]`, "i"))?.[1];
  const plain = text.match(new RegExp(`\\b(?:${label})\\s*(?:is|=|:)+\\s*([^;]+?)(?=\\s+\\b(?:website|site|x|twitter)\\b\\s*(?:is|=|:)|\\s+\\bdev\\s*buy\\b|$)`, "i"))?.[1];
  const value = (quoted || plain || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return value ? value.slice(0, maxLength) : undefined;
}

export function extractGroundedLaunchName(text: string) {
  const quoted = text.match(/\b(?:(?:full|token)\s+name|name|called|named)\s*(?:is|=|:)?\s*["\u201c]([^"\u201d]{1,48})["\u201d]/i)?.[1]
    || text.match(/\b(?:(?:full|token)\s+name|name|called|named)\s*(?:is|=|:)?\s*['\u2018]([^'\u2019]{1,48})['\u2019]/i)?.[1]
    || text.match(/\b(?:launch|create|deploy)\s*["\u201c]([^"\u201d]{1,48})["\u201d]/i)?.[1]
    || text.match(/\b(?:launch|create|deploy)\s*['\u2018]([^'\u2019]{1,48})['\u2019]/i)?.[1]
    || text.match(/["\u201c]([^"\u201d]{1,48})["\u201d]\s*(?:[,;:|/\-\u2014]\s*)?\(?\s*\$[A-Z][A-Z0-9]{0,11}\b/)?.[1]
    || text.match(/['\u2018]([^'\u2019]{1,48})['\u2019]\s*(?:[,;:|/\-\u2014]\s*)?\(?\s*\$[A-Z][A-Z0-9]{0,11}\b/)?.[1]
    || text.match(/\$[A-Z][A-Z0-9]{0,11}\s*(?:[-—|/]\s*)?["\u201c]([^"\u201d]{1,48})["\u201d]/)?.[1]
    || text.match(/\$[A-Z][A-Z0-9]{0,11}\s*(?:[-—|/]\s*)?['\u2018]([^'\u2019]{1,48})['\u2019]/)?.[1];
  const labeled = text.match(/\b(?:(?:full|token)\s+name|name)\s*(?:is|=|:)?\s+([^,;|/]{1,48}?)(?=\s*(?:[.,;|/]|(?:and\s+the\s+)?(?:with\s+)?(?:ticker|symbol|pair)\b|$))/i)?.[1];
  const named = text.match(/\b(?:called|named|call\s+it)\s+([^,;|/]{1,48}?)(?=\s*(?:[,;|/]|(?:with\s+)?(?:ticker|symbol)\b|using\b|dev\s*buy\b|website\b|site\b|description\b|desc\b|$))/i)?.[1];
  const prefixed = text.match(/\b(?:launch|create|deploy)\s+(?:(?:me|my)\s+)?(?:a\s+)?(?:new\s+)?(?:(?:token|coin)\s*:?)?\s*([^,;|]{1,48}?)(?=\s+(?:with\s+)?(?:ticker|symbol)\b|\s+with\s+\$?[A-Z][A-Z0-9]{0,11}\s+as\s+(?:the\s+)?(?:ticker|symbol)\b|\s*\(\s*\$?[A-Z][A-Z0-9]{0,11}\s*\)|\s*[,;|]|$)/i)?.[1];
  const candidate = stripWrappingQuotes(quoted || labeled || named || prefixed || "")
    .replace(/^name\s*(?:is|=|:)?\s*/i, "")
    .replace(/\s+(?:and\s+the\s+)?(?:ticker|symbol)\b[\s\S]*$/i, "")
    .replace(/\s+\$[A-Z][A-Z0-9]{0,11}\b[\s\S]*$/i, "")
    .replace(/[.,:;\s]+$/, "").replace(/\s+with$/i, "").replace(/^for\s+/i, "").trim();
  return candidate && !/^(?:name|ticker|symbol|token|coin)$/i.test(candidate) ? candidate.slice(0, 48) : undefined;
}

export function extractGroundedPairToken(text: string) {
  const candidate = text.match(/\bpair(?:ing)?\s+asset\s*(?:is|=|:)?\s*\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\b/i)?.[1]
    || text.match(/\bpair\s*(?:is|=|:)\s*\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\b/i)?.[1]
    || text.match(/\bpair\s+\$?(?!(?:the|and|with|to|as|it|asset|pair|paired|pairing|against|ticker|symbol|name|token|coin)\b)(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\b/i)?.[1]
    || text.match(/\b(?:paired?\s+with|pair\s+(?:it\s+)?with|pair\s+against|against)\s*\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\b/i)?.[1]
    || text.match(/\b\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\s+as\s+the\s+pair\b/i)?.[1]
    || text.match(/\bwith\s+\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\s+as\s+the\s+pair\b/i)?.[1]
    || text.match(/\bwith\s+\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\s+(?:as\s+the\s+)?pair(?:ing)?\b/i)?.[1];
  return candidate && !/^(?:the|and|with|to|as|it|asset|pair|paired|pairing|against|ticker|symbol|name|token|coin)$/i.test(candidate) ? candidate : undefined;
}

function hasInvalidExplicitPairToken(text: string) {
  if (extractGroundedPairToken(text)) return false;
  const stopWord = "(?:the|and|with|to|as|it|asset|pair|paired|pairing|against)";
  return new RegExp(`\\b(?:pair(?:ing)?\\s+asset\\s*(?:is|=|:)?|pair\\s*(?:is|=|:)?|paired?\\s+with|pair\\s+(?:it\\s+)?with|pair\\s+against|against)\\s*\\$?${stopWord}\\b`, "i").test(text)
    || new RegExp(`\\bwith\\s+\\$?${stopWord}\\s+(?:as\\s+the\\s+)?pair(?:ing)?\\b`, "i").test(text);
}

function parseLaunch(text: string): WalletCommand | null {
  if (!/\b(?:launch|create|deploy|make|new\s+token|token\s+request|need\s+(?:a\s+)?(?:coin|launch|token\s+deployed))\b/i.test(text)
    || !/\b(?:token|coin|ticker|symbol)\b|\$[a-zA-Z][a-zA-Z0-9]{0,11}\b|\(\s*\$?[A-Z][A-Z0-9]{0,11}\s*\)/i.test(text)) return null;
  if (/\b(?:launch|create|deploy)\s+(?:ticker|symbol)\b/i.test(text)) {
    return { kind: "unknown", reason: "A launch needs both a name and a ticker." };
  }
  if (hasInvalidExplicitPairToken(text)) {
    return { kind: "unknown", reason: "A launch pair must be an explicit ticker or contract address." };
  }
  const symbolMatch = text.match(/\b(?:ticker|symbol)\s*(?:is|=|:)?\s*["'\u2018\u2019\u201c\u201d]?\s*\$?([a-zA-Z0-9]{1,12})\s*["'\u2018\u2019\u201c\u201d]?/i)
    || text.match(/\$?([a-zA-Z][a-zA-Z0-9]{0,11})\s+(?:as|for)\s+(?:the\s+)?(?:ticker|symbol)\b/i)
    || text.match(/\(\s*\$?([a-zA-Z][a-zA-Z0-9]{0,11})\s*\)/)
    || text.match(/\$([a-zA-Z][a-zA-Z0-9]{0,11})\b/)
    || text.match(/\b(?:token|coin)\s+([a-zA-Z][a-zA-Z0-9]{0,11})\s+(?:called|named)\b/i);
  const quotedName = text.match(/\b(?:called|named|(?:(?:full|token)\s+)?name)\s*(?:is|=|:)?\s*["“]([^"”]{1,48})["”]/i)?.[1]
    || text.match(/\b(?:launch|create|deploy)\s+(?:a\s+)?(?:token|coin)?\s*["“]([^"”]{1,48})["”]/i)?.[1];
  const namedName = text.match(/\b(?:called|named|name|call\s+it)\s*(?:is|=|:)?\s*([^,;|/]+?)(?=\s+(?:with|ticker|symbol|using|and\b|dev\s*buy|website|site|description|desc)|\s*[,;|/]|$)/i)?.[1];
  const nameBeforeTicker = text.match(/\b(?:launch|create|deploy)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:token|coin)?\s+(.{1,48}?)\s+(?:ticker|symbol)\s*(?:is|=|:)?\s*\$?[a-zA-Z0-9]{1,12}\b/i)?.[1];
  const launchName = text.match(/\b(?:launch|create|deploy)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:token|coin)?\s*(?:called|named)?\s*([^,;|/$()]+?)(?=\s+(?:with|ticker|symbol|using|and\b|dev\s*buy|website|site|description|desc)|\s*\$[a-zA-Z]|\s*\(|\s*[,;|/]|$)/i)?.[1];
  const name = extractGroundedLaunchName(text) || "";
  const symbol = cleanSymbol(symbolMatch?.[1] || "");
  if (!name || !symbol) return { kind: "unknown", reason: "A launch needs both a name and a ticker." };

  const description = quotedField(text, "description|desc", 280);
  const websiteRaw = labeledWebsiteValue(text);
  const website = websiteRaw ? normalizedWebsiteOrRaw(websiteRaw) : undefined;
  const twitterRaw = labeledXValue(text);
  const twitter = twitterRaw ? normalizedXOrRaw(twitterRaw) : undefined;
  const telegramRaw = text.match(/\b(?:telegram|tg)\s*(?:is|=|:)?\s*([^\s,;]+)/i)?.[1];
  const telegram = telegramRaw ? normalizedTelegramOrRaw(telegramRaw) : undefined;
  const pairToken = extractGroundedPairToken(text);

  const usdBuy = text.match(new RegExp(`(?:dev\\s*buy|buy)[^$0-9]{0,16}\\$${NUMBER}`, "i"));
  const ethBuy = text.match(new RegExp(`(?:dev\\s*buy|buy)[^0-9]{0,16}${NUMBER}\\s*(?:eth|weth)\\b`, "i"));
  const leadingUsdBuy = text.match(new RegExp(`\\$${NUMBER}[^,.;]{0,16}(?:dev\\s*buy|buy)`, "i"));
  const leadingEthBuy = text.match(new RegExp(`${NUMBER}\\s*(?:eth|weth)[^,.;]{0,16}(?:dev\\s*buy|buy)`, "i"));
  const pairBuy = text.match(new RegExp(`(?:dev\\s*buys?|buy)[^0-9]{0,16}${NUMBER}\\s+(?!eth\\b|weth\\b|usd\\b|dollars?\\b)([A-Za-z][A-Za-z0-9]{0,11})\\b`, "i"));
  const leadingPairBuy = text.match(new RegExp(`${NUMBER}\\s+((?!eth\\b|weth\\b|usd\\b|dollars?\\b)[A-Za-z][A-Za-z0-9]{0,11})[^,.;]{0,20}(?:developer\\s*buy|dev\\s*buys?|buy|for\\s+dev)`, "i"));
  const parsedEthBuy = ethBuy || leadingEthBuy;
  return {
    kind: "launch",
    launchMode: "pons",
    name,
    symbol,
    ...(description ? { description } : {}),
    ...(website ? { website } : {}),
    ...(twitter ? { twitter } : {}),
    ...(telegram ? { telegram } : {}),
    ...(pairToken ? { pairToken: tokenIdentifier(pairToken) } : {}),
    ...(usdBuy || leadingUsdBuy ? { devBuy: { amount: cleanAmount((usdBuy || leadingUsdBuy)![1]), unit: "usd" as const } }
      : parsedEthBuy ? { devBuy: { amount: cleanAmount(parsedEthBuy[1]), unit: "eth" as const } }
        : pairBuy || leadingPairBuy ? { devBuy: { amount: cleanAmount((pairBuy || leadingPairBuy)![1]), unit: "pair" as const } } : {}),
  };
}

export function parseWalletCommand(raw: string): WalletCommand {
  const recipientAddress = /\b(?:send|transfer|give)\b/i.test(raw)
    ? raw.match(/\bto\s+(0x[a-fA-F0-9]{40})\b/i)?.[1]
      || raw.match(/\b(?:send|transfer|give)\s+(0x[a-fA-F0-9]{40})\b/i)?.[1]
    : undefined;
  const recipientHandle = /\b(?:send|transfer|give)\b/i.test(raw)
    ? raw.match(/\bto\s+(@[a-zA-Z0-9_]{1,15})\b/i)?.[1]
      || raw.match(/\b(?:send|transfer|give)\s+(@[a-zA-Z0-9_]{1,15})\b/i)?.[1]
    : undefined;
  const text = raw.replace(/@[a-zA-Z0-9_]{1,15}/g, " ").replace(/\s+/g, " ").trim();
  const launch = parseLaunch(text);
  if (launch) return launch;
  const swapMatch = text.match(new RegExp(`\\bswap\\s+\\$${NUMBER}\\s+(?:worth\\s+)?of\\s+\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\s+for\\s+\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"));
  if (swapMatch) {
    const slippage = slippageBps(text);
    if (slippage < 0) return { kind: "unknown", reason: "Slippage must be between 0.1% and 20%." };
    const fromToken = cleanToken(swapMatch[2]);
    const toToken = cleanToken(swapMatch[3]);
    if (fromToken.toLowerCase() === toToken.toLowerCase()) return { kind: "unknown", reason: "A swap needs two different assets." };
    return { kind: "swap_token_for_token", amount: cleanAmount(swapMatch[1]), unit: "usd", fromToken, toToken, slippageBps: slippage };
  }
  if (/\b(?:buy|purchase)\b/i.test(text) && /\b(?:destroy|incinerate)\b/i.test(text) && !/\bburn\b/i.test(text)) {
    return { kind: "unknown", reason: "Buy and burn requires burn plus buy or purchase." };
  }
  if (/\b(?:buy|purchase)\b/i.test(text) && /\bburn\b/i.test(text)) {
    const buyText = text.replace(/\bpurchase\b/gi, "buy");
    const token = tradeToken(buyText, "buy")
      || text.match(/\bburn\s+(?:all\s+(?:of\s+)?|the\s+)?\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\b/i)?.[1]
      || text.match(/\$(?![0-9])([a-zA-Z][a-zA-Z0-9]{0,31})\b/)?.[1];
    const usd = text.match(new RegExp(`\\$${NUMBER}|${NUMBER}\\s*(?:usd|dollars?)\\b`, "i"));
    const eth = text.match(new RegExp(`${NUMBER}\\s*(?:eth|weth)\\b`, "i"));
    const pair = text.match(new RegExp(`${NUMBER}\\s+((?!of\\b|worth\\b|usd\\b|dollars?\\b|eth\\b|weth\\b)[a-zA-Z][a-zA-Z0-9]{0,31})\\s+(?:of\\s+)?\\$?(?:${token || "(?!)"})`, "i"));
    const slippage = slippageBps(text);
    if (slippage < 0) return { kind: "unknown", reason: "Slippage must be between 0.1% and 20%." };
    if (!token || (!usd && !eth && !pair)) return { kind: "unknown", reason: "Buy and burn needs a spend amount and one token." };
    return { kind: "buy_and_burn", amount: cleanAmount(usd ? usd[1] || usd[2] : eth ? eth[1] : pair![1]), unit: usd ? "usd" : eth ? "eth" : "pair", token, ...(pair ? { pairAsset: pair[2] } : {}), slippageBps: slippage };
  }
  if (/\b(?:buy|purchase)\b/i.test(text) && /\b(?:send|transfer|give)\b/i.test(raw)) {
    const buyText = text.replace(/\bpurchase\b/gi, "buy");
    const recipient = recipientAddress || recipientHandle;
    const token = tradeToken(buyText, "buy");
    const usd = text.match(new RegExp(`\\$${NUMBER}|${NUMBER}\\s*(?:usd|dollars?)\\b`, "i"));
    const eth = text.match(new RegExp(`${NUMBER}\\s*(?:eth|weth)\\b`, "i"));
    const pair = token ? text.match(new RegExp(`${NUMBER}\\s+((?!of\\b|worth\\b|usd\\b|dollars?\\b|eth\\b|weth\\b)[a-zA-Z][a-zA-Z0-9]{0,31})\\s+(?:(?:worth\\s+of|of)\\s+)?\\$?${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")) : null;
    const slippage = slippageBps(text);
    if (slippage < 0) return { kind: "unknown", reason: "Slippage must be between 0.1% and 20%." };
    if (!recipient || !token || (!usd && !eth && !pair)) return { kind: "unknown", reason: "Buy and send needs a spend amount, one token, and a destination." };
    return {
      kind: "buy_and_send", amount: cleanAmount(usd ? usd[1] || usd[2] : eth ? eth[1] : pair![1]),
      unit: usd ? "usd" : eth ? "eth" : "pair", token, ...(pair ? { pairAsset: cleanToken(pair[2]) } : {}), recipient, slippageBps: slippage,
    };
  }
  if (/\bbuy\b/i.test(text)) {
    const token = tradeToken(text, "buy");
    const usd = text.match(new RegExp(`\\$${NUMBER}|${NUMBER}\\s*(?:usd|dollars?)\\b`, "i"));
    const eth = text.match(new RegExp(`${NUMBER}\\s*(?:eth|weth)\\b`, "i"));
    const pair = token ? text.match(new RegExp(`${NUMBER}\\s+((?!of\\b|worth\\b|usd\\b|dollars?\\b|eth\\b|weth\\b)[a-zA-Z][a-zA-Z0-9]{0,31})\\s+(?:(?:worth\\s+of|of)\\s+)?\\$?${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")) : null;
    const slippage = slippageBps(text);
    if (slippage < 0) return { kind: "unknown", reason: "Slippage must be between 0.1% and 20%." };
    if (!token || (!usd && !eth && !pair)) return { kind: "unknown", reason: "A buy needs a spend amount and a token ticker or contract address." };
    return {
      kind: "buy", amount: cleanAmount(usd ? usd[1] || usd[2] : eth ? eth[1] : pair![1]),
      unit: usd ? "usd" : eth ? "eth" : "pair", token, ...(pair ? { pairAsset: cleanToken(pair[2]) } : {}), slippageBps: slippage,
    };
  }
  if (/\bsell\b/i.test(text)) {
    const percentage = percentageAsset(text, "sell");
    if (percentage === null) return { kind: "unknown", reason: "A percentage must be greater than 0% and no more than 100%." };
    const token = tradeToken(text, "sell");
    const amount = text.match(new RegExp(`\\bsell\\s+${NUMBER}`, "i"))?.[1];
    const slippage = slippageBps(text);
    if (slippage < 0) return { kind: "unknown", reason: "Slippage must be between 0.1% and 20%." };
    if (percentage) return { kind: "sell", amount: percentage.amount, unit: "percent", token: percentage.token, slippageBps: slippage };
    if (!token || !amount) return { kind: "unknown", reason: "A sell needs a token amount and a token ticker or contract address." };
    return { kind: "sell", amount: cleanAmount(amount), unit: "token", token, slippageBps: slippage };
  }
  if (/\b(?:make|create|open|set\s*up|start)\b[\s\S]*\bwallet\b|\bnew wallet\b/i.test(text)) return { kind: "create_wallet" };
  if (/\b(?:balance|holdings?|portfolio|what\s+tokens|what(?:'s|\s+is)\s+in\s+(?:the|my)\s+wallet|how\s+much.*(?:eth|token|coin|wallet)|do\s+i\s+have\s+any|combien\s+j['’]?ai)\b/i.test(text)) {
    const token = text.match(/\b(?:of|for|much|any)\s+\$?([a-zA-Z0-9]{1,42})\b/i)?.[1];
    return { kind: "show_balance", ...(token ? { token } : {}) };
  }
  if (/\bwallet\b|\b(?:deposit|funding|receiving|receive)\s+address\b|\bmy\s+address\b|\baddress\s+(?:to|for)\s+(?:fund|deposit|receive)\b|\bwhere\b[\s\S]{0,40}\bsend\b[\s\S]{0,20}\beth\b/i.test(text)) {
    return { kind: "show_wallet" };
  }
  const recipient = /\b(?:send|transfer|give)\b/i.test(text) ? recipientAddress || recipientHandle : undefined;
  if (recipient) {
    const percentage = percentageAsset(text, "send");
    if (percentage === null) return { kind: "unknown", reason: "A percentage must be greater than 0% and no more than 100%." };
    if (percentage) return { kind: "send", amount: percentage.amount, unit: "percent", token: percentage.token, recipient };
    const usd = text.match(new RegExp(`\\$${NUMBER}|${NUMBER}\\s*(?:usd|dollars?)\\b`, "i"));
    const eth = text.match(new RegExp(`${NUMBER}\\s*(?:eth|weth)\\b`, "i"));
    const token = text.match(new RegExp(`${NUMBER}\\s+(?:of\\s+)?\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"))
      || text.match(new RegExp(`\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\s+${NUMBER}\\b`, "i"));
    const tokenAfterUsd = text.match(new RegExp(`\\$${NUMBER}\\s+(?:worth\\s+)?(?:of\\s+)?\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"));
    if (tokenAfterUsd && !/^(?:eth|weth)$/i.test(tokenAfterUsd[2])) {
      return { kind: "send", amount: cleanAmount(tokenAfterUsd[1]), unit: "usd", token: cleanToken(tokenAfterUsd[2]), recipient };
    }
    if (usd) return { kind: "send", amount: cleanAmount(usd[1] || usd[2]), unit: "usd", recipient };
    if (eth) return { kind: "send", amount: cleanAmount(eth[1]), unit: "eth", recipient };
    if (token) {
      const tokenFirst = !/^\d/.test(token[1]);
      return {
        kind: "send",
        amount: cleanAmount(tokenFirst ? token[2] : token[1]),
        unit: "token",
        token: cleanToken(tokenFirst ? token[1] : token[2]),
        recipient,
      };
    }
    return { kind: "unknown", reason: "A send needs a recipient, an amount, and ETH or a token ticker/contract." };
  }
  if (/\b(?:claim|collect)\b.*\b(?:fee|fees|revenue|rewards)\b/i.test(text)
    || /\b(?:claim|collect)\s+everything(?:\s+(?:available|i\s+can\s+claim))?\b/i.test(text)) {
    const address = text.match(ADDRESS)?.[0];
    const symbol = text.match(/\$([a-zA-Z][a-zA-Z0-9]{0,11})/)?.[1]
      || text.match(/\b(?:fees?|revenue|rewards)\s+for\s+([a-zA-Z][a-zA-Z0-9]{0,11})\b/i)?.[1];
    return { kind: "claim_fees", ...(address || symbol ? { token: address || symbol } : {}) };
  }
  // Burn is intentionally exact-word only. No synonym or inferred intent can
  // route funds to the dead address.
  if (!/\bburn\b/i.test(text)) return { kind: "unknown", reason: "No supported wallet command was found." };
  const percentageBurn = percentageAsset(text, "burn");
  if (percentageBurn === null) return { kind: "unknown", reason: "A percentage must be greater than 0% and no more than 100%." };
  if (percentageBurn) return { kind: "burn", amount: percentageBurn.amount, unit: "percent", token: percentageBurn.token };
  const usdBurn = text.match(new RegExp(`\\bburn\\s+\\$${NUMBER}\\s+(?:worth\\s+)?(?:of\\s+)?\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"))
    || text.match(new RegExp(`\\bburn\\s+${NUMBER}\\s*(?:usd|dollars?)\\s+(?:worth\\s+)?(?:of\\s+)?\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"));
  if (usdBurn) return { kind: "burn", amount: cleanAmount(usdBurn[1]), unit: "usd", token: usdBurn[2] };
  const burn = text.match(new RegExp(`\\bburn\\s+${NUMBER}\\s*\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"));
  if (burn) return { kind: "burn", amount: cleanAmount(burn[1]), unit: "token", token: burn[2] };
  return { kind: "unknown", reason: "A burn needs an amount and a token ticker or contract." };
}

export function isValueMovingCommand(command: WalletCommand) {
  return command.kind === "send" || command.kind === "burn" || command.kind === "buy" || command.kind === "buy_and_send" || command.kind === "buy_and_burn" || command.kind === "swap_token_for_token" || command.kind === "sell" || command.kind === "launch" || command.kind === "claim_fees";
}

function finitePositiveString(value: unknown) {
  if (typeof value !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? value : undefined;
}

function tokenIdentifier(value: unknown) {
  if (typeof value !== "string") return undefined;
  const cleaned = cleanToken(value.trim());
  return /^0x[a-fA-F0-9]{40}$/.test(cleaned) || /^[A-Z0-9]{1,32}$/.test(cleaned) ? cleaned : undefined;
}

function launchPairIdentifier(value: unknown) {
  const token = tokenIdentifier(value);
  return token && !/^(?:THE|AND|WITH|TO|AS|IT|ASSET|PAIR|PAIRED|PAIRING|AGAINST)$/.test(token) ? token : undefined;
}

function structuredSlippageBps(value: unknown) {
  if (value === undefined) return DEFAULT_SWAP_SLIPPAGE_BPS;
  const numeric = Number(value);
  return Number.isInteger(value) && numeric >= 10 && numeric <= 2_000 ? numeric : undefined;
}

/** Strictly validates untrusted structured output before it can reach execution. */
export function validateStructuredWalletCommand(value: unknown): WalletCommand | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const kind = item.kind;
  if (kind === "create_wallet" || kind === "show_wallet") return { kind };
  if (kind === "show_balance") {
    const token = item.token === undefined ? undefined : tokenIdentifier(item.token);
    if (item.token !== undefined && !token) return null;
    return { kind, ...(token ? { token } : {}) };
  }
  if (kind === "send") {
    const amount = finitePositiveString(item.amount);
    const unit = item.unit;
    const recipient = typeof item.recipient === "string" && (/^@[a-zA-Z0-9_]{1,15}$/.test(item.recipient) || /^0x[a-fA-F0-9]{40}$/.test(item.recipient)) ? item.recipient : undefined;
    const token = item.token === undefined ? undefined : tokenIdentifier(item.token);
    if (!amount || !recipient || !["eth", "usd", "token", "percent"].includes(String(unit))) return null;
    if ((unit === "token" || unit === "percent") && !token) return null;
    if (unit === "percent" && Number(amount) > 100) return null;
    return { kind, amount, unit: unit as AmountUnit, ...(token ? { token } : {}), recipient };
  }
  if (kind === "buy_and_send") {
    const amount = finitePositiveString(item.amount);
    const token = tokenIdentifier(item.token);
    const pairAsset = item.pairAsset === undefined ? undefined : tokenIdentifier(item.pairAsset);
    const recipient = typeof item.recipient === "string" && (/^@[a-zA-Z0-9_]{1,15}$/.test(item.recipient) || /^0x[a-fA-F0-9]{40}$/.test(item.recipient)) ? item.recipient : undefined;
    const slippageBps = structuredSlippageBps(item.slippageBps);
    if (!amount || !token || !recipient || !["eth", "usd", "pair"].includes(String(item.unit)) || slippageBps === undefined) return null;
    if (item.unit === "pair" && (!pairAsset || /^eth$/i.test(pairAsset))) return null;
    if (item.unit !== "pair" && item.pairAsset !== undefined) return null;
    return { kind, amount, unit: item.unit as "eth" | "usd" | "pair", token, ...(pairAsset ? { pairAsset } : {}), recipient, slippageBps };
  }
  if (kind === "buy_and_burn") {
    const amount = finitePositiveString(item.amount);
    const token = tokenIdentifier(item.token);
    const pairAsset = item.pairAsset === undefined ? undefined : tokenIdentifier(item.pairAsset);
    const slippageBps = structuredSlippageBps(item.slippageBps);
    if (!amount || !token || !["eth", "usd", "pair"].includes(String(item.unit)) || slippageBps === undefined) return null;
    if (item.unit === "pair" && !pairAsset) return null;
    if (item.unit === "pair" && /^eth$/i.test(pairAsset || "")) return null;
    return { kind, amount, unit: item.unit as "eth" | "usd" | "pair", token, ...(pairAsset ? { pairAsset } : {}), slippageBps };
  }
  if (kind === "swap_token_for_token") {
    const amount = finitePositiveString(item.amount);
    const fromToken = tokenIdentifier(item.fromToken);
    const toToken = tokenIdentifier(item.toToken);
    const slippageBps = structuredSlippageBps(item.slippageBps);
    if (!amount || item.unit !== "usd" || !fromToken || !toToken || fromToken.toLowerCase() === toToken.toLowerCase() || slippageBps === undefined) return null;
    return { kind, amount, unit: "usd", fromToken, toToken, slippageBps };
  }
  if (kind === "burn") {
    const amount = finitePositiveString(item.amount);
    const unit = item.unit;
    const token = tokenIdentifier(item.token);
    if (!amount || !token || !["usd", "token", "percent"].includes(String(unit))) return null;
    if (unit === "percent" && Number(amount) > 100) return null;
    return { kind, amount, unit: unit as AmountUnit, token };
  }
  if (kind === "buy" || kind === "sell") {
    const amount = finitePositiveString(item.amount);
    const token = tokenIdentifier(item.token);
    const slippageBps = structuredSlippageBps(item.slippageBps);
    if (!amount || !token || slippageBps === undefined) return null;
    if (kind === "buy" && (item.unit === "eth" || item.unit === "usd" || item.unit === "pair")) {
      const pairAsset = item.pairAsset === undefined ? undefined : tokenIdentifier(item.pairAsset);
      if (item.unit === "pair" && !pairAsset) return null;
      if (item.unit === "pair" && /^eth$/i.test(pairAsset || "")) return null;
      if (item.pairAsset !== undefined && !pairAsset) return null;
      return { kind, amount, unit: item.unit, token, ...(pairAsset ? { pairAsset } : {}), slippageBps };
    }
    if (kind === "sell" && (item.unit === "usd" || item.unit === "token" || item.unit === "percent") && (item.unit !== "percent" || Number(amount) <= 100)) return { kind, amount, unit: item.unit, token, slippageBps };
    return null;
  }
  if (kind === "claim_fees") {
    const token = item.token === undefined ? undefined : tokenIdentifier(item.token);
    if (item.token !== undefined && !token) return null;
    return { kind, ...(token ? { token } : {}) };
  }
  if (kind === "launch") {
    const name = typeof item.name === "string" ? item.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”,;:]+$/g, "").trim().slice(0, 48) : "";
    const normalizedName = stripWrappingQuotes(name);
    const symbol = typeof item.symbol === "string" ? cleanSymbol(item.symbol) : "";
    if (!normalizedName || !symbol) return null;
    const optionalText = (key: string, max: number) => typeof item[key] === "string" && item[key] ? stripWrappingQuotes(String(item[key])).slice(0, max) : undefined;
    const website = optionalText("website", 300);
    const twitter = optionalText("twitter", 300);
    let devBuy: { amount: string; unit: "eth" | "usd" | "pair" } | undefined;
    const pairToken = item.pairToken === undefined ? undefined : launchPairIdentifier(item.pairToken);
    if (item.pairToken !== undefined && !pairToken) return null;
    if (item.devBuy && typeof item.devBuy === "object") {
      const raw = item.devBuy as Record<string, unknown>;
      const amount = finitePositiveString(raw.amount);
      if (!amount || !["eth", "usd", "pair"].includes(String(raw.unit))) return null;
      devBuy = { amount, unit: raw.unit as "eth" | "usd" | "pair" };
    }
    return {
      kind, launchMode: "pons", name: normalizedName, symbol,
      ...(optionalText("description", 280) ? { description: optionalText("description", 280) } : {}),
      ...(website ? { website: normalizedWebsiteOrRaw(website) } : {}),
      ...(twitter ? { twitter: normalizedXOrRaw(twitter) } : {}),
      ...(optionalText("telegram", 300) ? { telegram: normalizedTelegramOrRaw(optionalText("telegram", 300)!) } : {}),
      ...(pairToken ? { pairToken } : {}),
      ...(devBuy ? { devBuy } : {}),
    };
  }
  return null;
}
