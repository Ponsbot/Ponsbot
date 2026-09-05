import { parseFeeUpgradePhrase } from "../lib/fee-upgrade-command";
import { TOP_FIVE_SLIPPAGE_BPS } from "../lib/top-five-recovery";
import { stripDirectLaunchImageInstruction } from "../lib/x-launch-image-policy";

export type AmountUnit = "eth" | "usd" | "token" | "percent";

export type WalletCommand =
  | { kind: "create_wallet" }
  | { kind: "show_wallet" }
  | { kind: "show_balance"; token?: string }
  | { kind: "send"; amount: string; unit: AmountUnit; token?: string; recipient: string }
  | { kind: "burn"; amount: string; unit: AmountUnit; token: string }
  | { kind: "buy"; amount: string; unit: "eth" | "usd" | "pair" | "token"; token: string; pairAsset?: string; slippageBps: number }
  | { kind: "buy_and_send"; amount: string; unit: "eth" | "usd" | "pair" | "token"; token: string; pairAsset?: string; recipient: string; slippageBps: number }
  | { kind: "buy_and_burn"; amount: string; unit: "eth" | "usd" | "pair" | "token"; token: string; pairAsset?: string; slippageBps: number }
  | { kind: "buy_top_five"; amount: string; burn: boolean; slippageBps: number }
  | { kind: "swap_token_for_token"; amount: string; unit: "usd" | "percent"; fromToken: string; toToken: string; slippageBps: number }
  | { kind: "sell"; amount: string; unit: "eth" | "usd" | "token" | "percent"; token: string; slippageBps: number }
  | { kind: "claim_fees"; token?: string }
  | { kind: "reassign_fees"; token: string; recipient: string }
  | { kind: "upgrade_fees"; token: string }
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
      feeRecipient?: string;
      holderFeeSharing?: boolean;
      devBuy?: { amount: string; unit: "eth" | "usd" | "pair" };
    }
  | { kind: "unknown"; reason: string };

const ADDRESS = /0x[a-fA-F0-9]{40}/;
// Accept human-formatted quantities such as 1,000 or 1,234.56. Commas are
// removed before a command crosses the parser boundary.
const NUMBER = "((?:[0-9][0-9,]*(?:\\.[0-9]+)?|\\.[0-9]+))";
const NUMBER_NC = "(?:[0-9][0-9,]*(?:\\.[0-9]+)?|\\.[0-9]+)";
export const DEFAULT_SWAP_SLIPPAGE_BPS = 250;

// Human names accepted for the supported tokenized stocks/RWAs. Keep this
// mapping deterministic: the AI may recognize a company name, but execution
// still normalizes it to the exact indexed ticker before token resolution.
const RWA_NAME_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["United Parcel Service", "UPS"], ["UPS", "UPS"],
  ["Snap Inc", "SNAP"], ["Snap", "SNAP"], ["Snapchat", "SNAP"],
  ["Lululemon Athletica", "LULU"], ["Lululemon", "LULU"],
  ["Figma", "FIG"], ["Moderna", "MRNA"], ["Pfizer", "PFE"],
  ["Marvell Technology", "MRVL"], ["Marvell", "MRVL"],
  ["Johnson & Johnson", "JNJ"], ["Johnson and Johnson", "JNJ"],
  ["Rivian Automotive", "RIVN"], ["Rivian", "RIVN"],
  ["Hims & Hers Health", "HIMS"], ["Hims and Hers Health", "HIMS"],
  ["Hims & Hers", "HIMS"], ["Hims and Hers", "HIMS"], ["Hims", "HIMS"],
  ["SPDR Gold Trust", "GLD"], ["SPDR Gold", "GLD"], ["Gold", "GLD"],
  ["BlackBerry", "BB"],
  ["Dell Technologies", "DELL"], ["Dell", "DELL"],
  ["WhiteFiber", "WYFI"], ["White Fiber", "WYFI"],
  ["SK hynix", "SKHY"], ["SK Hynix", "SKHY"],
  ["Taiwan Semiconductor Manufacturing", "TSM"], ["Taiwan Semiconductor", "TSM"], ["TSMC", "TSM"],
  ["United States Oil Fund", "USO"], ["US Oil Fund", "USO"],
  ["Eli Lilly and Company", "LLY"], ["Eli Lilly", "LLY"],
  ["Roblox Corporation", "RBLX"], ["Roblox", "RBLX"],
  ["SPDR S&P 500 ETF Trust", "SPY"], ["S&P 500 ETF", "SPY"], ["S&P 500", "SPY"],
  ["Take-Two Interactive Software", "TTWO"], ["Take Two Interactive", "TTWO"], ["Take-Two", "TTWO"],
  ["Trump Media & Technology Group", "DJT"], ["Trump Media and Technology Group", "DJT"], ["Trump Media", "DJT"],
  ["Advanced Micro Devices", "AMD"], ["MicroStrategy", "MSTR"], ["Invesco QQQ", "QQQ"],
  ["Alphabet Class A", "GOOGL"], ["Global Dollar", "USDG"], ["Nasdaq 100", "QQQ"],
  ["NVIDIA", "NVDA"], ["SpaceX", "SPCX"], ["Alphabet", "GOOGL"], ["Google", "GOOGL"],
  ["Tesla", "TSLA"], ["GameStop", "GME"], ["Apple", "AAPL"], ["SanDisk", "SNDK"],
  ["Amazon", "AMZN"], ["Microsoft", "MSFT"], ["Meta Platforms", "META"], ["Facebook", "META"],
  ["Meta", "META"], ["Circle", "CRCL"], ["Coinbase", "COIN"], ["Micron", "MU"],
  ["Palantir", "PLTR"], ["Costco", "COST"], ["Strategy", "MSTR"], ["Reddit", "RDDT"],
  ["AMC Entertainment", "AMC"], ["AMC", "AMC"],
  ["iShares 0-3 Month Treasury Bond ETF", "SGOV"], ["Treasury Bond ETF", "SGOV"],
  ["Alibaba", "BABA"], ["iShares MSCI India ETF", "INDA"],
  ["IBM", "IBM"], ["International Business Machines", "IBM"], ["Netflix", "NFLX"],
  ["Webull", "BULL"], ["Nu Holdings", "NU"], ["Nubank", "NU"],
  ["iShares Silver Trust", "SLV"], ["Silver Trust", "SLV"],
  ["Shopify", "SHOP"], ["Bloom Energy", "BE"], ["Ford Motor", "F"], ["Ford", "F"],
] as const;

// Bitcoin terminology is pair-only so an ordinary buy can still target an
// actual Pons Bot-launched token whose ticker is BITCOIN.
const LAUNCH_PAIR_NAME_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ...RWA_NAME_ALIASES,
  ["cbBTC", "cbBTC"], ["Coinbase Wrapped Bitcoin", "cbBTC"], ["Coinbase Bitcoin", "cbBTC"],
  ["Wrapped Bitcoin", "cbBTC"], ["Bitcoin", "cbBTC"], ["BTC", "cbBTC"],
] as const;

function canonicalAliasKey(value: string) {
  return value.trim().replace(/^\$/, "").replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ").toLowerCase();
}

export function knownRwaTicker(value: string) {
  const key = canonicalAliasKey(value).replace(/\s+(?:company\s+)?stocks?$/, "");
  return RWA_NAME_ALIASES.find(([name]) => canonicalAliasKey(name) === key)?.[1];
}

export function knownLaunchPairTicker(value: string) {
  const key = canonicalAliasKey(value).replace(/\s+(?:company\s+)?stocks?$/, "");
  return LAUNCH_PAIR_NAME_ALIASES.find(([name]) => canonicalAliasKey(name) === key)?.[1];
}

export function identifierAppearsAsKnownRwa(text: string, ticker: string) {
  return RWA_NAME_ALIASES.some(([name, symbol]) => symbol.toLowerCase() === ticker.replace(/^\$/, "").toLowerCase()
    && new RegExp(`(?:^|[^a-zA-Z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+")}(?=$|[^a-zA-Z0-9])`, "i").test(text));
}

export function identifierAppearsAsKnownLaunchPair(text: string, ticker: string) {
  return LAUNCH_PAIR_NAME_ALIASES.some(([name, symbol]) => symbol.toLowerCase() === ticker.replace(/^\$/, "").toLowerCase()
    && new RegExp(`(?:^|[^a-zA-Z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+")}(?=$|[^a-zA-Z0-9])`, "i").test(text));
}

export function isTerminalCommand(command: WalletCommand) {
  return ["show_wallet", "show_balance", "buy", "buy_and_send", "buy_and_burn", "buy_top_five", "swap_token_for_token", "sell", "send", "burn", "claim_fees"].includes(command.kind);
}

/** A deliberately narrow, anchored command that is never advertised. */
export function parseTopFiveBuyCommand(raw: string): Extract<WalletCommand, { kind: "buy_top_five" }> | null {
  const text = raw.replace(/(?:^|\s)@ponsbotfamily\b/gi, " ").replace(/\s+/g, " ").trim();
  const match = text.match(/^buy(?:\s*back)?(\s+and\s+burn)?\s+\$((?:[0-9][0-9,]*(?:\.[0-9]+)?|\.[0-9]+))\s+(?:of\s+)?each\s+of\s+the\s+top\s+5\s+pons\s+bot\s+tokens[.!?]*$/i);
  if (!match) return null;
  const amount = cleanAmount(match[2]);
  if (!finitePositiveString(amount)) return null;
  return { kind: "buy_top_five", amount, burn: Boolean(match[1]), slippageBps: TOP_FIVE_SLIPPAGE_BPS };
}

function slippageBps(text: string) {
  const match = text.match(/\bslippage\s*(?:is|=|:|of|at)?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i)
    || text.match(/\b([0-9]+(?:\.[0-9]+)?)\s*%\s+slippage\b/i);
  if (!match) return DEFAULT_SWAP_SLIPPAGE_BPS;
  const bps = Math.round(Number(match[1]) * 100);
  return Number.isFinite(bps) && bps >= 10 && bps <= 2_000 ? bps : -1;
}

function tradeToken(text: string, verb: "buy" | "sell") {
  // X replies and copied token links can naturally contain both a ticker and
  // its contract address. Treat the adjacent address as authoritative.
  const redundantAddress = text.match(/\$(?!\d)[a-zA-Z][a-zA-Z0-9]{0,31}\s+(0x[a-fA-F0-9]{40})\b/i)?.[1];
  const denominated = text.match(new RegExp(`\\b${verb}\\s+${NUMBER_NC}\\s*(?:usd|dollars?|eth|weth)\\s+(?:worth\\s+)?(?:of\\s+)?\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"))?.[1];
  const afterOf = text.match(new RegExp(`\\b${verb}\\b[\\s\\S]*?\\bof\\s+\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"))?.[1];
  const address = text.match(ADDRESS)?.[0];
  const ticker = text.match(new RegExp(`\\b${verb}\\s+(?:\\$?${NUMBER_NC}\\s*(?:usd|dollars?|eth|weth)?\\s+(?:of\\s+)?)?\\$([a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"))?.[1];
  const direct = text.match(new RegExp(`\\b${verb}\\s+${NUMBER_NC}\\s+(?:of\\s+)?\\$?([a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"))?.[1];
  return redundantAddress || denominated || afterOf || address || ticker || direct;
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

function cleanLaunchNameEdges(value: string) {
  // Connectors belong to launch syntax, never to either edge of a token name.
  // Apply repeatedly so malformed AI output such as "with FWUB and" safely
  // becomes "FWUB" before it reaches launch validation.
  let cleaned = stripWrappingQuotes(value).trim();
  // A repeated invocation at the name boundary is routing text, not metadata.
  // Match the complete handle only; never alter project socials/descriptions.
  cleaned = cleaned.replace(/(?:[\s,;:]+@ponsbotfamily\b[\s,;:.!]*)+$/i, "").trim();
  // A lone cashtag is common shorthand for both the launch name and ticker.
  // The contract name is human-readable metadata and should never retain the
  // ticker marker itself.
  if (/^\$[a-zA-Z][a-zA-Z0-9]{0,15}$/.test(cleaned)) cleaned = cleaned.slice(1);
  let previous = "";
  while (cleaned !== previous) {
    previous = cleaned;
    cleaned = cleaned
      .replace(/(?:[\s,;:]+@ponsbotfamily\b[\s,;:.!]*)+$/i, "")
      .replace(/^(?:(?:and|with)\b[\s,;:\-]*)+/i, "")
      // These words commonly leak across the boundary before ticker, pair,
      // link, or description syntax. They may occur inside a real name, but
      // never retain them as a dangling final word supplied by the parser.
      .replace(/(?:[\s,;:\-]+\b(?:and|with|the|to|for|as|it|of|pair|paired|pairing|ticker|symbol))+[\s,;:\-]*$/i, "")
      .trim();
  }
  return cleaned;
}

function cleanSymbol(value: string) {
  let cleaned = stripWrappingQuotes(value).replace(/^\$/, "").trim();
  // Preserve legitimate single-word tickers, including uncommon words, while
  // removing a connector that the AI appended as a separate trailing token.
  cleaned = cleaned.replace(/(?:[\s,;:\-]+\b(?:and|with|the|to|for|as|it|of|pair|paired|pairing|ticker|symbol))+[\s,;:\-]*$/i, "").trim();
  return cleaned.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 16);
}

export function tickerFromLaunchName(value: string) {
  return cleanSymbol(value);
}

function cleanToken(value: string) {
  const token = value.replace(/^\$/, "");
  return /^0x[a-fA-F0-9]{40}$/.test(token) ? token : (knownRwaTicker(token) || cleanSymbol(token));
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

function isXAttachmentOrPostUrl(value: string) {
  const candidate = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (["pbs.twimg.com", "video.twimg.com", "abs.twimg.com"].includes(host)) return true;
    return (host === "x.com" || host === "twitter.com")
      && /^\/[^/]+\/status\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/i.test(url.pathname);
  } catch { return false; }
}

function textOutsideQuotedContent(text: string) {
  return text.replace(/"[^"\r\n]*"|“[^”\r\n]*”|'[^'\r\n]*'|‘[^’\r\n]*’/g, (value) => " ".repeat(value.length));
}

/** An unqualified final spend in a launch refers to that launch, not another asset. */
export function trailingLaunchBuy(text: string) {
  const operative = textOutsideQuotedContent(text);
  const match = /\b(?:and\s+)?(?:please\s+)?(?:buy(?:\s*back)?|purchase)\s+(?:\$([0-9][0-9,]*(?:\.[0-9]+)?|\.[0-9]+)(?:\s+USD)?|([0-9][0-9,]*(?:\.[0-9]+)?|\.[0-9]+)\s+ETH)(?:\s+worth)?(?:\s+please)?[\s.!?,;]*(?:@ponsbotfamily[\s.!?,;]*)?$/i.exec(operative);
  if (!match || /\b(?:dev|developer|initial)\s*$/i.test(operative.slice(0, match.index))) return undefined;
  return { index: match.index, amount: cleanAmount(match[1] || match[2]), unit: match[1] ? "usd" as const : "eth" as const };
}

export function launchFeeOptionsFromText(text: string) {
  const operative = textOutsideQuotedContent(text);
  const assigned = operative.match(/\bassign fees to\s+(@[a-zA-Z0-9_]{1,15}|0x[a-fA-F0-9]{40})\b/i)?.[1];
  const holderFeeSharing = /\b(?:holder fee sharing|share with holders)\b/i.test(operative);
  if (assigned && holderFeeSharing) throw new Error("Choose either an assigned fee recipient or holder fee sharing, not both.");
  return { ...(assigned ? { feeRecipient: assigned } : {}), ...(holderFeeSharing ? { holderFeeSharing: true } : {}) };
}

export function normalizeLaunchFeeOptions(command: WalletCommand, text: string): WalletCommand {
  if (command.kind !== "launch") return command;
  const options = launchFeeOptionsFromText(text);
  // These security-sensitive fields are always grounded deterministically in
  // the original post. Structured AI output cannot invent or broaden them.
  return { ...command, feeRecipient: options.feeRecipient, holderFeeSharing: options.holderFeeSharing };
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
  const { telegram: _untrustedTelegram, ...withoutTelegram } = command;
  const telegram = normalizeOptionalTelegramUrl(supplied);
  return { ...withoutTelegram, ...(telegram ? { telegram } : {}) };
}

export function normalizeLaunchLinks(command: WalletCommand, text?: string): WalletCommand {
  if (command.kind !== "launch") return command;
  const {
    twitter: _untrustedTwitter,
    website: _untrustedWebsite,
    ...commandWithoutUntrustedLinks
  } = command;
  const operativeText = text ? textOutsideQuotedContent(text) : undefined;
  const explicitWebsite = operativeText?.match(/\b(?:website|site)\s*(?:is|=|:)\s*([^\s,;]+)/i)?.[1];
  const explicitX = operativeText?.match(/\b(?:x|twitter)(?:\s+link)?\s*(?:is|=|:)\s*([^\s,;]+)/i)?.[1];
  // Original post text is authoritative. Never accept an AI-inferred launcher
  // profile or default website as token metadata.
  const website = text ? ((operativeText ? labeledWebsiteValue(operativeText) : undefined) || explicitWebsite) : command.website;
  const twitterCandidate = text ? ((operativeText ? labeledXValue(operativeText) : undefined) || explicitX) : command.twitter;
  const twitter = twitterCandidate && !isXAttachmentOrPostUrl(twitterCandidate) ? twitterCandidate : undefined;
  return {
    ...commandWithoutUntrustedLinks,
    ...(website ? { website: normalizeWebsiteUrl(website) } : {}),
    ...(twitter ? { twitter: normalizeXUrl(twitter) } : {}),
  };
}

export function normalizeOptionalTelegramUrl(value: unknown) {
  // Telegram is optional launch metadata. Discard malformed values instead of
  // rejecting the launch or trying to invent/repair a destination from a handle.
  if (typeof value !== "string" || !value.trim() || value.length > 300) return undefined;
  try { return normalizeTelegramUrl(value); } catch { return undefined; }
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
  const trailingBuy = trailingLaunchBuy(text);
  if (trailingBuy) text = text.slice(0, trailingBuy.index).trim().replace(/[,;]+$/, "");
  const quoted = text.match(/\b(?:(?:full|token)\s+name|name|called|named)\s*(?:is|=|:)?\s*["\u201c]([^"\u201d]{1,48})["\u201d]/i)?.[1]
    || text.match(/\b(?:(?:full|token)\s+name|name|called|named)\s*(?:is|=|:)?\s*['\u2018]([^'\u2019]{1,48})['\u2019]/i)?.[1]
    || text.match(/\b(?:launch|create|deploy)\s*["\u201c]([^"\u201d]{1,48})["\u201d]/i)?.[1]
    || text.match(/\b(?:launch|create|deploy)\s*['\u2018]([^'\u2019]{1,48})['\u2019]/i)?.[1]
    || text.match(/["\u201c]([^"\u201d]{1,48})["\u201d]\s*(?:[,;:|/\-\u2014]\s*)?\(?\s*\$[A-Z][A-Z0-9]{0,11}\b/)?.[1]
    || text.match(/['\u2018]([^'\u2019]{1,48})['\u2019]\s*(?:[,;:|/\-\u2014]\s*)?\(?\s*\$[A-Z][A-Z0-9]{0,11}\b/)?.[1]
    || text.match(/\$[A-Z][A-Z0-9]{0,11}\s*(?:[-—|/]\s*)?["\u201c]([^"\u201d]{1,48})["\u201d]/)?.[1]
    || text.match(/\$[A-Z][A-Z0-9]{0,11}\s*(?:[-—|/]\s*)?['\u2018]([^'\u2019]{1,48})['\u2019]/)?.[1];
  // The boundary after `name` is essential: without it, the `name` branch can
  // consume only the first four letters of `named`, leaving the trailing `d`
  // attached to the actual value (for example, `d Tesladog`).
  const labeled = text.match(/\b(?:(?:full|token)\s+name|name)\b\s*(?:is|=|:)?\s+([^,;|/]{1,48}?)(?=\s*(?:[.,;|/]|(?:and\s+the\s+)?(?:with\s+)?(?:ticker|symbol|pair)\b|assign\s+fees\s+to\b|holder\s+fee\s+sharing\b|share\s+with\s+holders\b|$))/i)?.[1];
  const named = text.match(/\b(?:called|named|call\s+it)\s+([^,;|/]{1,48}?)(?=\s*(?:[,;|/]|(?:with\s+)?(?:ticker|symbol)\b|using\b|dev\s*buy\b|website\b|site\b|description\b|desc\b|assign\s+fees\s+to\b|holder\s+fee\s+sharing\b|share\s+with\s+holders\b|$))/i)?.[1];
  // A ticker immediately after launch syntax is also the name when no name
  // was supplied. Anchor to the launch clause, never a pair or social field.
  const tickerOnlyPrefix = text.match(/\b(?:launch|create|deploy|make)\s+(?:(?:me|my)\s+)?(?:(?:a|the)\s+)?(?:new\s+)?(?:(?:token|coin)\b[\s,:]*)?(?:with\s+)?(?:ticker|symbol)\b\s*(?:(?:should|will)\s+be\b|is\b|=|:)?\s*/i);
  if (tickerOnlyPrefix && !quoted && !labeled && !named) {
    const rest = text.slice(tickerOnlyPrefix.index! + tickerOnlyPrefix[0].length);
    const value = rest.match(/^["'\u2018\u2019\u201c\u201d]?\s*\$?([a-zA-Z0-9]{1,16})(?=["'\u2018\u2019\u201c\u201d\s,;.!?]|$)/)?.[1];
    return value && !/^(?:name|ticker|symbol|token|coin|pair|paired|website|description|dev|https?|the|and|with|to)$/i.test(value)
      ? cleanSymbol(value) : undefined;
  }
  const cashtagOnly = text.match(/\b(?:launch|create|deploy)\s+(?:(?:me|my)\s+)?(?:(?:a|the)\s+)?(?:new\s+)?(?:(?:token|coin)\b[\s,:]*)?\$([a-zA-Z][a-zA-Z0-9]{0,15})\b/i)?.[1];
  if (cashtagOnly && !quoted && !labeled && !named && !/\b(?:ticker|symbol)\b/i.test(text)) return cleanSymbol(cashtagOnly);
  const prefixed = text.match(/\b(?:launch|create|deploy)\s+(?:(?:me|my)\s+)?(?:a\s+)?(?:new\s+)?(?:(?:token|coin)\s*:?)?\s*([^,;|]{1,48}?)(?=\s+\$[A-Z][A-Z0-9]{0,11}\b|\s+(?:with\s+)?(?:ticker|symbol)\b|\s+(?:and\s+)?paired?\s+(?:(?:it\s+)?with|against)\b|\s+(?:and\s+)?pair\s+(?:it\s+)?with\b|\s+with\s+\$?[A-Z][A-Z0-9]{0,11}\s+as\s+(?:the\s+)?(?:ticker|symbol)\b|\s+assign\s+fees\s+to\b|\s+holder\s+fee\s+sharing\b|\s+share\s+with\s+holders\b|\s*\(\s*\$?[A-Z][A-Z0-9]{0,11}\s*\)|\s*[,;|]|$)/i)?.[1];
  // A trailing bracketed ticker is a separate field, not part of an unquoted
  // name. Preserve explicitly quoted names, including their parentheses.
  const nameValue = quoted || (labeled || named || prefixed || "")
    .replace(/\s*(?:\(\s*\$?[a-zA-Z][a-zA-Z0-9]{0,15}\s*\)|\[\s*\$?[a-zA-Z][a-zA-Z0-9]{0,15}\s*\])\s*[.,!]?\s*$/, "");
  const candidate = cleanLaunchNameEdges(nameValue)
    .replace(/^name\s*(?:is|=|:)?\s*/i, "")
    .replace(/\s+(?:and\s+the\s+)?(?:ticker|symbol)\b[\s\S]*$/i, "")
    .replace(/\s+\$[A-Z][A-Z0-9]{0,15}\b[\s\S]*$/i, "")
    .replace(/\s+(?:and\s+)?(?:pair|paired)\s+(?:it\s+)?(?:with|against)\b[\s\S]*$/i, "")
    .replace(/[.,:;\s]+$/, "").replace(/\s+https?$/i, "").replace(/^for\s+/i, "").trim();
  return candidate && !/^(?:name|ticker|symbol|token|coin)$/i.test(candidate) ? candidate.slice(0, 48) : undefined;
}

export function extractGroundedPairToken(text: string) {
  const namedPair = text.match(/\b(?:pair(?:ing)?\s+asset\s*(?:is|=|:)?|with\s+(?:the\s+)?asset\s+pair|paired?\s+(?:with|to|against)|pair\s+(?:it\s+)?(?:with|to)|pair\s+against|against|pair\s*(?:is|=|:))\s+([^,;.\n]{2,48})/i)?.[1]
    ?.replace(/\s+(?:dev(?:eloper)?\s*buy|initial\s+buy|website|site|x|twitter|telegram|tg)\b[\s\S]*$/i, "").trim();
  const namedPairTicker = namedPair ? knownLaunchPairTicker(namedPair) : undefined;
  const candidate = text.match(/\bpair(?:ing)?\s+asset\s*(?:is|=|:)?\s*\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\b/i)?.[1]
    || text.match(/\bpair\s*(?:is|=|:)\s*\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\b/i)?.[1]
    || text.match(/\bpair\s+\$?(?!(?:the|and|with|to|as|it|asset|pair|paired|pairing|against|ticker|symbol|name|token|coin)\b)(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\b/i)?.[1]
    || text.match(/\b(?:paired?\s+(?:with|to|against)|pair\s+(?:it\s+)?(?:with|to)|pair\s+against|against|with\s+(?:the\s+)?asset\s+pair)\s*\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\b/i)?.[1]
    || text.match(/\b\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\s+as\s+the\s+pair\b/i)?.[1]
    || text.match(/\bwith\s+\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\s+as\s+the\s+pair\b/i)?.[1]
    || text.match(/\bwith\s+\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,11})\s+(?:as\s+the\s+)?pair(?:ing)?\b/i)?.[1];
  return namedPairTicker || (candidate && !/^(?:the|and|with|to|as|it|asset|pair|paired|pairing|against|ticker|symbol|name|token|coin)$/i.test(candidate) ? candidate : undefined);
}

function hasInvalidExplicitPairToken(text: string) {
  if (extractGroundedPairToken(text)) return false;
  const stopWord = "(?:the|and|with|to|as|it|asset|pair|paired|pairing|against)";
  return new RegExp(`\\b(?:pair(?:ing)?\\s+asset\\s*(?:is|=|:)?|pair\\s*(?:is|=|:)?|paired?\\s+with|pair\\s+(?:it\\s+)?with|pair\\s+against|against)\\s*\\$?${stopWord}\\b`, "i").test(text)
    || new RegExp(`\\bwith\\s+\\$?${stopWord}\\s+(?:as\\s+the\\s+)?pair(?:ing)?\\b`, "i").test(text);
}

export const LAUNCH_TICKER_TOO_LONG = "⚠️ That ticker is too long. Pons supports a maximum of 16 letters or numbers, excluding the $. No token was launched. Submit a new launch request with a shorter ticker.";

export function oversizedLaunchTicker(text: string) {
  if (!/\b(?:launch|deploy|create|make)\b/i.test(text)) return false;
  // Inspect the launch clause only, not optional description, socials or pair.
  const clause = text.split(/\b(?:description|desc|website|telegram|twitter|paired|pair|dev\s*buy|initial\s+buy)\b/i)[0];
  const labeled = clause.match(/\b(?:ticker|symbol)\s*(?:(?:should|will)\s+be\b|is\b|=|:)?\s*["'“”‘’]?\s*\$?([a-zA-Z0-9]+)/i)?.[1];
  if (labeled) return labeled.length > 16;
  return [...clause.matchAll(/\$([a-zA-Z][a-zA-Z0-9]*)\b/g)].some(m => m[1].length > 16)
    || /[([]\s*\$?[a-zA-Z][a-zA-Z0-9]{16,}\s*[)\]]/.test(clause);
}

function parseLaunch(text: string): WalletCommand | null {
  text = stripDirectLaunchImageInstruction(text);
  if (/\b(?:claim|collect|withdraw)\b[\s\S]*\b(?:fees?|revenue|rewards?)\b/i.test(text)) return null;
  // Wallet provisioning language must never be promoted into a token launch
  // merely because "create" is also a valid launch verb.
  if (/\b(?:create|open|set\s*up|make)\b[\s\S]{0,20}\b(?:my\s+)?wallet\b/i.test(text)
    && !/\b(?:token|coin|ticker|symbol)\b|\$[a-zA-Z][a-zA-Z0-9]{0,11}\b/i.test(text)) return null;
  if (!/\b(?:launch|create|deploy|make|new\s+token|token\s+request|need\s+(?:a\s+)?(?:coin|launch|token\s+deployed))\b/i.test(text)) return null;
  if (oversizedLaunchTicker(text)) return { kind: "unknown", reason: LAUNCH_TICKER_TOO_LONG };
  if (/\bon\s+base\b/i.test(text) && !/\b(?:ticker|symbol)\b|\$[a-zA-Z][a-zA-Z0-9]{0,15}\b/i.test(text)) {
    return { kind: "unknown", reason: "Pons Bot launches only on Pons V2." };
  }
  if (hasInvalidExplicitPairToken(text)) {
    return { kind: "unknown", reason: "A launch pair must be an explicit ticker or contract address." };
  }
  const explicitPairToken = extractGroundedPairToken(text);
  const genericCashtag = [...text.matchAll(/\$([a-zA-Z][a-zA-Z0-9]{0,15})\b/g)]
    .map((match) => match[1]).find((symbol) => symbol.toLowerCase() !== explicitPairToken?.toLowerCase());
  const symbolMatch = text.match(/\b(?:ticker|symbol)\s*(?:(?:should|will)\s+be\b|is\b|=|:)?\s*["'\u2018\u2019\u201c\u201d]?\s*\$?([a-zA-Z0-9]{1,16})\s*["'\u2018\u2019\u201c\u201d]?/i)
    || text.match(/\$?([a-zA-Z][a-zA-Z0-9]{0,15})\s+(?:as|for)\s+(?:the\s+)?(?:ticker|symbol)\b/i)
    || text.match(/\(\s*\$?([a-zA-Z][a-zA-Z0-9]{0,15})\s*\)/)
    || text.match(/\[\s*\$?([a-zA-Z][a-zA-Z0-9]{0,15})\s*\]/)
    || (genericCashtag ? [genericCashtag, genericCashtag] : null)
    || text.match(/\b(?:token|coin)\s+([a-zA-Z][a-zA-Z0-9]{0,15})\s+(?:called|named)\b/i);
  const tickerOnlyLaunch = text.match(/\b(?:launch|create|deploy)\s+(?:(?:a|the)\s+)?(?:new\s+)?(?:token|coin)?\s*\$([a-zA-Z][a-zA-Z0-9]{0,15})\b/i)?.[1];
  const hasExplicitName = /\b(?:(?:full|token)\s+name|name|called|named|call\s+it)\b/i.test(text);
  const sharedNameAndTicker = text.match(/\b(?:with\s+)?name\s+and\s+ticker\s+["'\u2018\u2019\u201c\u201d]?\s*\$?([a-zA-Z][a-zA-Z0-9]{0,15})\b/i)?.[1];
  const name = sharedNameAndTicker
    ? stripWrappingQuotes(sharedNameAndTicker)
    : !hasExplicitName && tickerOnlyLaunch ? cleanSymbol(tickerOnlyLaunch) : (extractGroundedLaunchName(text) || "");
  const symbol = cleanSymbol(sharedNameAndTicker || symbolMatch?.[1] || name);
  if (!name || !symbol) return { kind: "unknown", reason: "A launch needs both a name and a ticker." };

  const description = quotedField(text, "description|desc", 280);
  const websiteRaw = labeledWebsiteValue(text);
  const website = websiteRaw ? normalizedWebsiteOrRaw(websiteRaw) : undefined;
  const twitterRaw = labeledXValue(text);
  const twitter = twitterRaw ? normalizedXOrRaw(twitterRaw) : undefined;
  const telegramRaw = text.match(/\b(?:telegram|tg)\s*(?:is|=|:)?\s*([^\s,;]+)/i)?.[1];
  const telegram = normalizeOptionalTelegramUrl(telegramRaw);
  const pairToken = explicitPairToken
    ? (knownLaunchPairTicker(explicitPairToken) || explicitPairToken)
    : undefined;
  let feeOptions: ReturnType<typeof launchFeeOptionsFromText>;
  try { feeOptions = launchFeeOptionsFromText(text); } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : "Invalid creator fee options." };
  }

  const usdBuy = text.match(new RegExp(`(?:dev\\s*buy|buy(?:\\s*back)?)[^$0-9]{0,16}\\$${NUMBER}`, "i"));
  const ethBuy = text.match(new RegExp(`(?:dev\\s*buy|buy(?:\\s*back)?)[^0-9]{0,16}${NUMBER}\\s*(?:eth|weth)\\b`, "i"));
  const leadingUsdBuy = text.match(new RegExp(`\\$${NUMBER}[^,.;]{0,16}(?:dev\\s*buy|buy(?:\\s*back)?)`, "i"));
  const leadingEthBuy = text.match(new RegExp(`${NUMBER}\\s*(?:eth|weth)[^,.;]{0,16}(?:dev\\s*buy|buy(?:\\s*back)?)`, "i"));
  const pairBuy = text.match(new RegExp(`(?:dev\\s*buys?|buy(?:\\s*back)?)[^0-9]{0,16}${NUMBER}\\s+(?!eth\\b|weth\\b|usd\\b|dollars?\\b)([A-Za-z][A-Za-z0-9]{0,11})\\b`, "i"));
  const leadingPairBuy = text.match(new RegExp(`${NUMBER}\\s+((?!eth\\b|weth\\b|usd\\b|dollars?\\b)[A-Za-z][A-Za-z0-9]{0,11})[^,.;]{0,20}(?:developer\\s*buy|dev\\s*buys?|buy(?:\\s*back)?|for\\s+dev)`, "i"));
  const parsedEthBuy = ethBuy || leadingEthBuy;
  const finalBuy = trailingLaunchBuy(text);
  const parsedDevBuy = finalBuy ? { amount: finalBuy.amount, unit: finalBuy.unit } : usdBuy || leadingUsdBuy
    ? { amount: cleanAmount((usdBuy || leadingUsdBuy)![1]), unit: "usd" as const }
    : parsedEthBuy ? { amount: cleanAmount(parsedEthBuy[1]), unit: "eth" as const }
      : pairBuy || leadingPairBuy ? { amount: cleanAmount((pairBuy || leadingPairBuy)![1]), unit: "pair" as const } : undefined;
  // A literal zero dev buy means launch without an opening purchase. It is not
  // an intent or parameter-extraction failure.
  const devBuy = parsedDevBuy && Number(parsedDevBuy.amount) > 0 ? parsedDevBuy : undefined;
  return {
    kind: "launch",
    launchMode: "pons",
    name,
    symbol,
    ...(description ? { description } : {}),
    ...(website ? { website } : {}),
    ...(twitter ? { twitter } : {}),
    ...(telegram ? { telegram } : {}),
    ...(pairToken ? { pairToken: launchPairIdentifier(pairToken) } : {}),
    ...feeOptions,
    ...(devBuy ? { devBuy } : {}),
  };
}

export function parseWalletCommand(raw: string): WalletCommand {
  const topFive = parseTopFiveBuyCommand(raw);
  if (topFive) return topFive;
  const reassignmentText = raw.replace(/(?:^|\s)@ponsbotfamily\b/gi, " ").trim();
  const upgrade = parseFeeUpgradePhrase(raw);
  if (upgrade) return upgrade;
  const exactReassignment = reassignmentText.match(/^reassign\s+(?:\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\s+fees|fees\s+for\s+\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31}))\s+to\s+(@[a-zA-Z0-9_]{1,15}|0x[a-fA-F0-9]{40}|holders)[.!]?$/i);
  if (exactReassignment) return { kind: "reassign_fees", token: cleanToken(exactReassignment[1] || exactReassignment[2]), recipient: exactReassignment[3] };
  let rawLaunchFeeOptions: ReturnType<typeof launchFeeOptionsFromText> = {};
  try { rawLaunchFeeOptions = launchFeeOptionsFromText(raw); } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : "Invalid creator fee options." };
  }
  const recipientAddress = /\b(?:send|transfer|give)\b/i.test(raw)
    ? raw.match(/\b(?:to|for)\s+["'“”]?(0x[a-fA-F0-9]{40})\b["'“”]?/i)?.[1]
      || raw.match(/\b(?:send|transfer|give)\s+(0x[a-fA-F0-9]{40})\b/i)?.[1]
    : undefined;
  const recipientHandle = /\b(?:send|transfer|give)\b/i.test(raw)
    ? raw.match(/\bto\s+(@[a-zA-Z0-9_]{1,15})\b/i)?.[1]
      || raw.match(/\b(?:send|transfer|give)\s+(@[a-zA-Z0-9_]{1,15})\b/i)?.[1]
    : undefined;
  let text = raw.replace(/@[a-zA-Z0-9_]{1,15}/g, " ").replace(/\s+/g, " ").trim();
  const launch = parseLaunch(text);
  if (launch) return launch.kind === "launch" ? { ...launch, ...rawLaunchFeeOptions } : launch;
  text = text.replace(/\bbuy\s*back\b/gi, "buy");
  const swapMatch = text.match(new RegExp(`\\bswap\\s+\\$${NUMBER}\\s+(?:worth\\s+)?of\\s+\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\s+(?:for|to)\\s+\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"));
  if (swapMatch) {
    const slippage = slippageBps(text);
    if (slippage < 0) return { kind: "unknown", reason: "Slippage must be between 0.1% and 20%." };
    const fromToken = cleanToken(swapMatch[2]);
    const toToken = cleanToken(swapMatch[3]);
    if (fromToken.toLowerCase() === toToken.toLowerCase()) return { kind: "unknown", reason: "A swap needs two different assets." };
    return { kind: "swap_token_for_token", amount: cleanAmount(swapMatch[1]), unit: "usd", fromToken, toToken, slippageBps: slippage };
  }
  const allSwapMatch = text.match(/\bswap\s+all(?:\s+of)?\s+(?:my\s+)?\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\s+(?:for|to)\s+\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\b/i);
  if (allSwapMatch) {
    const slippage = slippageBps(text);
    if (slippage < 0) return { kind: "unknown", reason: "Slippage must be between 0.1% and 20%." };
    const fromToken = cleanToken(allSwapMatch[1]);
    const toToken = cleanToken(allSwapMatch[2]);
    if (fromToken.toLowerCase() === toToken.toLowerCase()) return { kind: "unknown", reason: "A swap needs two different assets." };
    return { kind: "swap_token_for_token", amount: "100", unit: "percent", fromToken, toToken, slippageBps: slippage };
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
    const tokenAmount = token ? text.match(new RegExp(`\\b(?:buy|purchase)\\s+${NUMBER}\\s+(?:of\\s+)?\\$?${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")) : null;
    const slippage = slippageBps(text);
    if (slippage < 0) return { kind: "unknown", reason: "Slippage must be between 0.1% and 20%." };
    if (!token || (!usd && !eth && !pair && !tokenAmount)) return { kind: "unknown", reason: "Buy and burn needs an amount and one token." };
    return { kind: "buy_and_burn", amount: cleanAmount(usd ? usd[1] || usd[2] : eth ? eth[1] : pair ? pair[1] : tokenAmount![1]), unit: usd ? "usd" : eth ? "eth" : pair ? "pair" : "token", token, ...(pair ? { pairAsset: pair[2] } : {}), slippageBps: slippage };
  }
  if (/\b(?:buy|purchase)\b/i.test(text) && /\b(?:send|transfer|give)\b/i.test(raw)) {
    const buyText = text.replace(/\bpurchase\b/gi, "buy");
    const recipient = recipientAddress || recipientHandle;
    const token = tradeToken(buyText, "buy");
    const usd = text.match(new RegExp(`\\$${NUMBER}|${NUMBER}\\s*(?:usd|dollars?)\\b`, "i"));
    const eth = text.match(new RegExp(`${NUMBER}\\s*(?:eth|weth)\\b`, "i"));
    const pair = token ? text.match(new RegExp(`${NUMBER}\\s+((?!of\\b|worth\\b|usd\\b|dollars?\\b|eth\\b|weth\\b)[a-zA-Z][a-zA-Z0-9]{0,31})\\s+(?:(?:worth\\s+of|of)\\s+)?\\$?${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")) : null;
    const tokenAmount = token ? text.match(new RegExp(`\\b(?:buy|purchase)\\s+${NUMBER}\\s+(?:of\\s+)?\\$?${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")) : null;
    const slippage = slippageBps(text);
    if (slippage < 0) return { kind: "unknown", reason: "Slippage must be between 0.1% and 20%." };
    if (!recipient || !token || (!usd && !eth && !pair && !tokenAmount)) return { kind: "unknown", reason: "Buy and send needs an amount, one token, and a destination." };
    return {
      kind: "buy_and_send", amount: cleanAmount(usd ? usd[1] || usd[2] : eth ? eth[1] : pair ? pair[1] : tokenAmount![1]),
      unit: usd ? "usd" : eth ? "eth" : pair ? "pair" : "token", token, ...(pair ? { pairAsset: cleanToken(pair[2]) } : {}), recipient, slippageBps: slippage,
    };
  }
  if (/\bbuy\b/i.test(text)) {
    const token = tradeToken(text, "buy");
    const usd = text.match(new RegExp(`\\$${NUMBER}|${NUMBER}\\s*(?:usd|dollars?)\\b`, "i"));
    const eth = text.match(new RegExp(`${NUMBER}\\s*(?:eth|weth)\\b`, "i"));
    const pair = token ? text.match(new RegExp(`${NUMBER}\\s+((?!of\\b|worth\\b|usd\\b|dollars?\\b|eth\\b|weth\\b)[a-zA-Z][a-zA-Z0-9]{0,31})\\s+(?:(?:worth\\s+of|of)\\s+)?\\$?${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")) : null;
    const tokenAmount = token ? text.match(new RegExp(`\\bbuy\\s+${NUMBER}\\s+(?:of\\s+)?\\$?${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")) : null;
    const slippage = slippageBps(text);
    if (slippage < 0) return { kind: "unknown", reason: "Slippage must be between 0.1% and 20%." };
    if (!token || (!usd && !eth && !pair && !tokenAmount)) return { kind: "unknown", reason: "A buy needs an amount and a token ticker or contract address." };
    return {
      kind: "buy", amount: cleanAmount(usd ? usd[1] || usd[2] : eth ? eth[1] : pair ? pair[1] : tokenAmount![1]),
      unit: usd ? "usd" : eth ? "eth" : pair ? "pair" : "token", token, ...(pair ? { pairAsset: cleanToken(pair[2]) } : {}), slippageBps: slippage,
    };
  }
  if (/\bsell\b/i.test(text)) {
    const percentage = percentageAsset(text, "sell");
    if (percentage === null) return { kind: "unknown", reason: "A percentage must be greater than 0% and no more than 100%." };
    const token = tradeToken(text, "sell");
    const amount = text.match(new RegExp(`\\bsell\\s+${NUMBER}`, "i"))?.[1];
    const usdAmount = text.match(new RegExp(`\\bsell\\s+\\$${NUMBER}\\s+(?:worth\\s+)?(?:of\\s+)?`, "i"))?.[1]
      || text.match(new RegExp(`\\bsell\\s+${NUMBER}\\s*(?:usd|dollars?)\\s+(?:worth\\s+)?(?:of\\s+)?`, "i"))?.[1];
    const ethAmount = text.match(new RegExp(`\\bsell\\s+${NUMBER}\\s+(?:eth|weth)\\s+(?:worth\\s+)?(?:of\\s+)?`, "i"))?.[1];
    const slippage = slippageBps(text);
    if (slippage < 0) return { kind: "unknown", reason: "Slippage must be between 0.1% and 20%." };
    if (percentage) return { kind: "sell", amount: percentage.amount, unit: "percent", token: percentage.token, slippageBps: slippage };
    const selectedAmount = usdAmount || ethAmount || amount;
    if (!token || !selectedAmount) return { kind: "unknown", reason: "A sell needs a token amount and a token ticker or contract address." };
    return { kind: "sell", amount: cleanAmount(selectedAmount), unit: usdAmount ? "usd" : ethAmount ? "eth" : "token", token, slippageBps: slippage };
  }
  if ((recipientAddress || recipientHandle) && /\b(?:send|transfer|give)\s+(?:my\s+)?(?:all|entire)\s+(?:wallet\s+)?balance\b/i.test(text)) {
    return { kind: "send", amount: "100", unit: "percent", token: "ETH", recipient: recipientAddress || recipientHandle! };
  }
  if (/\b(?:make|create|open|set\s*up|start)\b[\s\S]*\bwallet\b|\bnew wallet\b/i.test(text)) return { kind: "create_wallet" };
  if (/\b(?:balance|holdings?|portfolio|what\s+tokens|what(?:'s|\s+is)\s+in\s+(?:the|my)\s+wallet|(?:show|check|view|see)\s+(?:my\s+)?wallet\s+funds?|how\s+much.*(?:eth|token|coin|wallet)|do\s+i\s+have\s+any|combien\s+j['’]?ai)\b/i.test(text)) {
    const token = text.match(/\b(?:of|for|much|any)\s+\$?([a-zA-Z0-9]{1,42})\b/i)?.[1];
    return { kind: "show_balance", ...(token ? { token } : {}) };
  }
  if (/\bwallet\b|\b(?:deposit|funding|receiving|receive)\s+address\b|\bmy\s+address\b|\baddress\s+(?:to|for)\s+(?:fund|deposit|receive)\b|\bwhere\b[\s\S]{0,40}\bsend\b[\s\S]{0,20}\beth\b/i.test(text)) {
    return { kind: "show_wallet" };
  }
  const recipient = /\b(?:send|transfer|give)\b/i.test(text) ? recipientAddress || recipientHandle : undefined;
  if (recipient) {
    if (/\b(?:send|transfer|give)\s+(?:my\s+)?(?:all|entire)\s+(?:wallet\s+)?balance\b/i.test(text)) {
      return { kind: "send", amount: "100", unit: "percent", token: "ETH", recipient };
    }
    const percentage = percentageAsset(text, "send");
    if (percentage === null) return { kind: "unknown", reason: "A percentage must be greater than 0% and no more than 100%." };
    if (percentage) return { kind: "send", amount: percentage.amount, unit: "percent", token: percentage.token, recipient };
    const ethToken = ethDenominatedTokenAmount(text);
    if (ethToken === null) return { kind: "unknown", reason: "An ETH-denominated token send needs a token ticker or contract." };
    if (ethToken) return { kind: "send", ...ethToken, recipient };
    const usd = text.match(new RegExp(`\\$${NUMBER}|${NUMBER}\\s*(?:usd|dollars?)\\b`, "i"));
    const eth = text.match(new RegExp(`${NUMBER}\\s*(?:eth|weth)\\b`, "i"));
    const token = text.match(new RegExp(`${NUMBER}\\s+(?:of\\s+)?\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"))
      || text.match(new RegExp(`\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\s+${NUMBER}\\b`, "i"));
    const tokenAfterUsd = text.match(new RegExp(`\\$${NUMBER}\\s+(?:worth\\s+)?(?:of\\s+)?\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"))
      || text.match(new RegExp(`${NUMBER}\\s*(?:usd|dollars?)\\b\\s+(?:worth\\s+)?(?:of\\s+)?\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"));
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
    const genericLaunchClaim = /\b(?:fees?|revenue|rewards)\s+(?:for|from)\s+(?:(?:all|any|my|the)\s+)?(?:launch|launches|tokens?)\b/i.test(text);
    const address = genericLaunchClaim ? undefined : text.match(ADDRESS)?.[0];
    const symbol = genericLaunchClaim ? undefined : text.match(/\$([a-zA-Z][a-zA-Z0-9]{0,11})/)?.[1]
      || (!genericLaunchClaim ? text.match(/\b(?:fees?|revenue|rewards)\s+(?:for|from)\s+([a-zA-Z][a-zA-Z0-9]{0,11})\b/i)?.[1] : undefined);
    return { kind: "claim_fees", ...(address || symbol ? { token: address || symbol } : {}) };
  }
  // Burn is intentionally exact-word only. No synonym or inferred intent can
  // route funds to the dead address.
  if (!/\bburn\b/i.test(text)) return { kind: "unknown", reason: "No supported wallet command was found." };
  const percentageBurn = percentageAsset(text, "burn");
  if (percentageBurn === null) return { kind: "unknown", reason: "A percentage must be greater than 0% and no more than 100%." };
  if (percentageBurn) return { kind: "burn", amount: percentageBurn.amount, unit: "percent", token: percentageBurn.token };
  const ethBurn = ethDenominatedTokenAmount(text);
  if (ethBurn === null) return { kind: "unknown", reason: "An ETH-denominated token burn needs a token ticker or contract." };
  if (ethBurn) return { kind: "burn", ...ethBurn };
  const usdBurn = text.match(new RegExp(`\\bburn\\s+\\$${NUMBER}\\s+(?:worth\\s+)?(?:of\\s+)?\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"))
    || text.match(new RegExp(`\\bburn\\s+${NUMBER}\\s*(?:usd|dollars?)\\s+(?:worth\\s+)?(?:of\\s+)?\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"));
  if (usdBurn) return { kind: "burn", amount: cleanAmount(usdBurn[1]), unit: "usd", token: usdBurn[2] };
  const burn = text.match(new RegExp(`\\bburn\\s+${NUMBER}\\s*\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"));
  if (burn) return { kind: "burn", amount: cleanAmount(burn[1]), unit: "token", token: burn[2] };
  return { kind: "unknown", reason: "A burn needs an amount and a token ticker or contract." };
}

// ETH is the valuation unit here, not the token to transfer/burn. Requiring
// "of" keeps ordinary native-ETH sends and their destination separate.
export function ethDenominatedTokenAmount(text: string) {
  const prefix = `(?<![$0-9.,])${NUMBER}\\s*ETH\\s+(?:worth\\s+)?of\\b`;
  if (!new RegExp(prefix, "i").test(text)) return undefined;
  const match = text.match(new RegExp(`${prefix}\\s+\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"));
  if (!match || /^(?:the|and|with|to|for|of|worth)$/i.test(match[2])) return null;
  return { amount: cleanAmount(match[1]), unit: "eth" as const, token: cleanToken(match[2]) };
}

export function isValueMovingCommand(command: WalletCommand) {
  return command.kind === "send" || command.kind === "burn" || command.kind === "buy" || command.kind === "buy_and_send" || command.kind === "buy_and_burn" || command.kind === "buy_top_five" || command.kind === "swap_token_for_token" || command.kind === "sell" || command.kind === "launch" || command.kind === "claim_fees" || command.kind === "reassign_fees" || command.kind === "upgrade_fees";
}

function finitePositiveString(value: unknown) {
  if (typeof value !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? value : undefined;
}

function tokenIdentifier(value: unknown) {
  if (typeof value !== "string") return undefined;
  const cleaned = cleanToken(value.trim());
  return /^0x[a-fA-F0-9]{40}$/.test(cleaned) || /^[a-zA-Z0-9]{1,32}$/.test(cleaned) ? cleaned : undefined;
}

function launchPairIdentifier(value: unknown) {
  const token = typeof value === "string" ? (knownLaunchPairTicker(value) || tokenIdentifier(value)) : undefined;
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
    const requestedUnit = item.unit;
    const recipient = typeof item.recipient === "string" && (/^@[a-zA-Z0-9_]{1,15}$/.test(item.recipient) || /^0x[a-fA-F0-9]{40}$/.test(item.recipient)) ? item.recipient : undefined;
    const token = item.token === undefined ? undefined : tokenIdentifier(item.token);
    if (!amount || !recipient || !["eth", "usd", "token", "percent"].includes(String(requestedUnit))) return null;
    // Direct terminal forms can describe ETH as the selected token while leaving
    // the amount unit as `token`. Execution expects native ETH amounts to use the
    // dedicated `eth` unit, so normalize this at the shared trust boundary.
    const unit = requestedUnit === "token" && /^eth$/i.test(token || "") ? "eth" : requestedUnit;
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
    if (!amount || !token || !recipient || !["eth", "usd", "pair", "token"].includes(String(item.unit)) || slippageBps === undefined) return null;
    if (item.unit === "pair" && (!pairAsset || /^eth$/i.test(pairAsset))) return null;
    if (item.unit !== "pair" && item.pairAsset !== undefined) return null;
    return { kind, amount, unit: item.unit as "eth" | "usd" | "pair" | "token", token, ...(pairAsset ? { pairAsset } : {}), recipient, slippageBps };
  }
  if (kind === "buy_and_burn") {
    const amount = finitePositiveString(item.amount);
    const token = tokenIdentifier(item.token);
    const pairAsset = item.pairAsset === undefined ? undefined : tokenIdentifier(item.pairAsset);
    const slippageBps = structuredSlippageBps(item.slippageBps);
    if (!amount || !token || !["eth", "usd", "pair", "token"].includes(String(item.unit)) || slippageBps === undefined) return null;
    if (item.unit === "pair" && !pairAsset) return null;
    if (item.unit === "pair" && /^eth$/i.test(pairAsset || "")) return null;
    return { kind, amount, unit: item.unit as "eth" | "usd" | "pair" | "token", token, ...(pairAsset ? { pairAsset } : {}), slippageBps };
  }
  if (kind === "buy_top_five") {
    const amount = finitePositiveString(item.amount);
    const slippageBps = structuredSlippageBps(item.slippageBps);
    if (!amount || typeof item.burn !== "boolean" || slippageBps === undefined) return null;
    return { kind, amount, burn: item.burn, slippageBps };
  }
  if (kind === "swap_token_for_token") {
    const amount = finitePositiveString(item.amount);
    const fromToken = tokenIdentifier(item.fromToken);
    const toToken = tokenIdentifier(item.toToken);
    const slippageBps = structuredSlippageBps(item.slippageBps);
    if (!amount || !["usd", "percent"].includes(String(item.unit)) || (item.unit === "percent" && Number(amount) !== 100) || !fromToken || !toToken || fromToken.toLowerCase() === toToken.toLowerCase() || slippageBps === undefined) return null;
    return { kind, amount, unit: item.unit as "usd" | "percent", fromToken, toToken, slippageBps };
  }
  if (kind === "burn") {
    const amount = finitePositiveString(item.amount);
    const unit = item.unit;
    const token = tokenIdentifier(item.token);
    if (!amount || !token || !["eth", "usd", "token", "percent"].includes(String(unit))) return null;
    if (unit === "percent" && Number(amount) > 100) return null;
    return { kind, amount, unit: unit as AmountUnit, token };
  }
  if (kind === "buy" || kind === "sell") {
    const amount = finitePositiveString(item.amount);
    const token = tokenIdentifier(item.token);
    const slippageBps = structuredSlippageBps(item.slippageBps);
    if (!amount || !token || slippageBps === undefined) return null;
    if (kind === "buy" && (item.unit === "eth" || item.unit === "usd" || item.unit === "pair" || item.unit === "token")) {
      const pairAsset = item.pairAsset === undefined ? undefined : tokenIdentifier(item.pairAsset);
      if (item.unit === "pair" && !pairAsset) return null;
      if (item.unit === "pair" && /^eth$/i.test(pairAsset || "")) return null;
      if (item.pairAsset !== undefined && !pairAsset) return null;
      if (item.unit !== "pair" && item.pairAsset !== undefined) return null;
      return { kind, amount, unit: item.unit, token, ...(pairAsset ? { pairAsset } : {}), slippageBps };
    }
    if (kind === "sell" && (item.unit === "eth" || item.unit === "usd" || item.unit === "token" || item.unit === "percent") && (item.unit !== "percent" || Number(amount) <= 100)) return { kind, amount, unit: item.unit, token, slippageBps };
    return null;
  }
  if (kind === "claim_fees") {
    const token = item.token === undefined ? undefined : tokenIdentifier(item.token);
    if (item.token !== undefined && !token) return null;
    return { kind, ...(token ? { token } : {}) };
  }
  if (kind === "reassign_fees") {
    const token = tokenIdentifier(item.token);
    const recipient = typeof item.recipient === "string" && (/^@[a-zA-Z0-9_]{1,15}$/.test(item.recipient) || /^0x[a-fA-F0-9]{40}$/.test(item.recipient) || /^holders$/i.test(item.recipient))
      ? item.recipient.toLowerCase() === "holders" ? "holders" : item.recipient
      : undefined;
    if (!token || !recipient) return null;
    return { kind, token, recipient };
  }
  if (kind === "upgrade_fees") {
    const token = tokenIdentifier(item.token);
    return token ? { kind, token } : null;
  }
  if (kind === "launch") {
    if (typeof item.symbol === "string" && stripWrappingQuotes(item.symbol).replace(/^\$/, "").trim().length > 16)
      return { kind: "unknown", reason: LAUNCH_TICKER_TOO_LONG };
    const name = typeof item.name === "string" ? item.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”,;:]+$/g, "").trim().replace(/\s+https?$/i, "").trim() : "";
    const normalizedName = cleanLaunchNameEdges(name).slice(0, 48);
    const symbol = typeof item.symbol === "string" ? cleanSymbol(item.symbol) : "";
    if (!normalizedName || !symbol) return null;
    const optionalText = (key: string, max: number) => typeof item[key] === "string" && item[key] ? stripWrappingQuotes(String(item[key])).slice(0, max) : undefined;
    const website = optionalText("website", 300);
    const twitter = optionalText("twitter", 300);
    const telegram = normalizeOptionalTelegramUrl(item.telegram);
    let devBuy: { amount: string; unit: "eth" | "usd" | "pair" } | undefined;
    const pairToken = item.pairToken === undefined ? undefined : launchPairIdentifier(item.pairToken);
    if (item.pairToken !== undefined && !pairToken) return null;
    if (item.devBuy && typeof item.devBuy === "object") {
      const raw = item.devBuy as Record<string, unknown>;
      const amount = finitePositiveString(raw.amount);
      const zeroAmount = typeof raw.amount === "string" || typeof raw.amount === "number"
        ? Number(String(raw.amount).replace(/,/g, "")) === 0 : false;
      if (!amount && !zeroAmount) return null;
      if (!["eth", "usd", "pair"].includes(String(raw.unit))) return null;
      if (amount) devBuy = { amount, unit: raw.unit as "eth" | "usd" | "pair" };
    }
    return {
      kind, launchMode: "pons", name: normalizedName, symbol,
      ...(optionalText("description", 280) ? { description: optionalText("description", 280) } : {}),
      ...(website ? { website: normalizedWebsiteOrRaw(website) } : {}),
      ...(twitter ? { twitter: normalizedXOrRaw(twitter) } : {}),
      ...(telegram ? { telegram } : {}),
      ...(pairToken ? { pairToken } : {}),
      ...(typeof item.feeRecipient === "string" && (/^@[a-zA-Z0-9_]{1,15}$/.test(item.feeRecipient) || /^0x[a-fA-F0-9]{40}$/.test(item.feeRecipient)) ? { feeRecipient: item.feeRecipient } : {}),
      ...(item.holderFeeSharing === true ? { holderFeeSharing: true } : {}),
      ...(devBuy ? { devBuy } : {}),
    };
  }
  return null;
}
