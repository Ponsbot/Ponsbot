export type AmountUnit = "eth" | "usd" | "token" | "percent";

export type WalletCommand =
  | { kind: "create_wallet" }
  | { kind: "show_wallet" }
  | { kind: "show_balance"; token?: string }
  | { kind: "send"; amount: string; unit: AmountUnit; token?: string; recipient: string }
  | { kind: "burn"; amount: string; unit: AmountUnit; token: string }
  | { kind: "buy"; amount: string; unit: "eth" | "usd"; token: string; slippageBps: number }
  | { kind: "sell"; amount: string; unit: "token" | "percent"; token: string; slippageBps: number }
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
      devBuy?: { amount: string; unit: "eth" | "usd" };
    }
  | { kind: "unknown"; reason: string };

const ADDRESS = /0x[a-fA-F0-9]{40}/;
// Accept human-formatted quantities such as 1,000 or 1,234.56. Commas are
// removed before a command crosses the parser boundary.
const NUMBER = "([0-9][0-9,]*(?:\\.[0-9]+)?)";
const NUMBER_NC = "[0-9][0-9,]*(?:\\.[0-9]+)?";
export const DEFAULT_SWAP_SLIPPAGE_BPS = 250;
export const MAX_LAUNCH_DEV_BUY_ETH = 0.02627;

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
  const match = text.match(new RegExp(`\\b${verbPattern}\\s+(all|half|[0-9]+(?:\\.[0-9]{1,4})?\\s*%)\\s+(?:of\\s+)?(?:my\\s+)?\\$?(0x[a-fA-F0-9]{40}|[a-zA-Z][a-zA-Z0-9]{0,31})\\b`, "i"));
  if (!match) return undefined;
  const amount = /^all$/i.test(match[1]) ? "100" : /^half$/i.test(match[1]) ? "50" : match[1].replace(/\s*%$/, "");
  const numeric = Number(amount);
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 100 ? { amount, token: match[2] } : null;
}

function cleanSymbol(value: string) {
  return value.replace(/^\$/, "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 12);
}

function cleanToken(value: string) {
  const token = value.replace(/^\$/, "");
  return /^0x[a-fA-F0-9]{40}$/.test(token) ? token : cleanSymbol(token);
}

function cleanAmount(value: string) {
  return value.replaceAll(",", "");
}

function labeledUrl(text: string, labels: string) {
  return text.match(new RegExp(`\\b(?:${labels})\\s*(?:is|=|:)?\\s*(https:\\/\\/[^\\s,;]+)`, "i"))?.[1]
    ?.replace(/[.)]+$/, "");
}

function quotedField(text: string, label: string, maxLength: number) {
  const quoted = text.match(new RegExp(`\\b(?:${label})\\s*(?:is|=|:)?\\s*["“]([^"”]+)["”]`, "i"))?.[1];
  const plain = text.match(new RegExp(`\\b(?:${label})\\s*(?:is|=|:)+\\s*([^;]+?)(?=\\s+\\b(?:website|site|x|twitter|telegram|tg)\\b\\s*(?:is|=|:)|\\s+\\bdev\\s*buy\\b|$)`, "i"))?.[1];
  const value = (quoted || plain || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return value ? value.slice(0, maxLength) : undefined;
}

function parseLaunch(text: string): WalletCommand | null {
  if (!/\b(?:plant|launch|create|deploy|sprout)\b/i.test(text)
    || !/\b(?:token|coin|ticker|symbol|plant)\b|\$[a-zA-Z][a-zA-Z0-9]{0,11}\b|\(\s*\$?[A-Z][A-Z0-9]{0,11}\s*\)/i.test(text)) return null;
  const symbolMatch = text.match(/\b(?:ticker|symbol)\s*(?:is|=|:)?\s*\$?([a-zA-Z0-9]{1,12})\b/i)
    || text.match(/\$?([a-zA-Z][a-zA-Z0-9]{0,11})\s+(?:as|for)\s+(?:the\s+)?(?:ticker|symbol)\b/i)
    || text.match(/\(\s*\$?([a-zA-Z][a-zA-Z0-9]{0,11})\s*\)/)
    || text.match(/\$([a-zA-Z][a-zA-Z0-9]{0,11})\b/)
    || text.match(/\b(?:token|coin)\s+([a-zA-Z][a-zA-Z0-9]{0,11})\s+(?:called|named)\b/i);
  const quotedName = text.match(/\b(?:called|named|name)\s*(?:is|=|:)?\s*["“]([^"”]{1,48})["”]/i)?.[1]
    || text.match(/\b(?:plant|launch|create|deploy|sprout)\s+(?:a\s+)?(?:token|coin)?\s*["“]([^"”]{1,48})["”]/i)?.[1];
  const namedName = text.match(/\b(?:called|named|name|call\s+it)\s*(?:is|=|:)?\s*([^,;|/]+?)(?=\s+(?:with|ticker|symbol|using|and\b|dev\s*buy|website|site|description|desc)|\s*[,;|/]|$)/i)?.[1];
  const nameBeforeTicker = text.match(/\b(?:plant|launch|create|deploy|sprout)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:token|coin)?\s+(.{1,48}?)\s+(?:ticker|symbol)\s*(?:is|=|:)?\s*\$?[a-zA-Z0-9]{1,12}\b/i)?.[1];
  const plantName = text.match(/\b(?:plant|launch|create|deploy|sprout)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:token|coin)?\s*(?:called|named)?\s*([^,;|/$()]+?)(?=\s+(?:with|ticker|symbol|using|and\b|dev\s*buy|website|site|description|desc)|\s*\$[a-zA-Z]|\s*\(|\s*[,;|/]|$)/i)?.[1];
  const name = (quotedName || namedName || nameBeforeTicker || plantName || "").trim().replace(/^(?:a|the)\s+/i, "").slice(0, 48);
  const symbol = cleanSymbol(symbolMatch?.[1] || "");
  if (!name || !symbol) return { kind: "unknown", reason: "A launch needs both a name and a ticker." };

  const description = quotedField(text, "description|desc", 280);
  const website = labeledUrl(text, "website|site");
  const twitter = labeledUrl(text, "x|twitter");
  const telegram = labeledUrl(text, "telegram|tg");

  const usdBuy = text.match(new RegExp(`(?:dev\\s*buy|buy)[^$0-9]{0,16}\\$${NUMBER}`, "i"));
  const ethBuy = text.match(new RegExp(`(?:dev\\s*buy|buy)[^0-9]{0,16}${NUMBER}\\s*(?:eth|weth)\\b`, "i"));
  const leadingUsdBuy = text.match(new RegExp(`\\$${NUMBER}[^,.;]{0,16}(?:dev\\s*buy|buy)`, "i"));
  const leadingEthBuy = text.match(new RegExp(`${NUMBER}\\s*(?:eth|weth)[^,.;]{0,16}(?:dev\\s*buy|buy)`, "i"));
  const parsedEthBuy = ethBuy || leadingEthBuy;
  if (parsedEthBuy && Number(parsedEthBuy[1]) > MAX_LAUNCH_DEV_BUY_ETH) {
    return { kind: "unknown", reason: "The maximum initial dev buy is 0.02627 ETH." };
  }
  return {
    kind: "launch",
    launchMode: "pons",
    name,
    symbol,
    ...(description ? { description } : {}),
    ...(website ? { website } : {}),
    ...(twitter ? { twitter } : {}),
    ...(telegram ? { telegram } : {}),
    ...(usdBuy || leadingUsdBuy ? { devBuy: { amount: cleanAmount((usdBuy || leadingUsdBuy)![1]), unit: "usd" as const } }
      : parsedEthBuy ? { devBuy: { amount: cleanAmount(parsedEthBuy[1]), unit: "eth" as const } } : {}),
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
  if (/\bbuy\b/i.test(text)) {
    const token = tradeToken(text, "buy");
    const usd = text.match(new RegExp(`\\$${NUMBER}|${NUMBER}\\s*(?:usd|dollars?)\\b`, "i"));
    const eth = text.match(new RegExp(`${NUMBER}\\s*(?:eth|weth)\\b`, "i"));
    const slippage = slippageBps(text);
    if (slippage < 0) return { kind: "unknown", reason: "Slippage must be between 0.1% and 20%." };
    if (!token || (!usd && !eth)) return { kind: "unknown", reason: "A buy needs an ETH or USD amount and a token ticker or contract address." };
    return { kind: "buy", amount: cleanAmount(usd ? usd[1] || usd[2] : eth![1]), unit: usd ? "usd" : "eth", token, slippageBps: slippage };
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
  if (/\bwallet\b|\b(?:deposit|funding|receiving|receive)\s+address\b|\bmy\s+address\b|\baddress\s+(?:to|for)\s+(?:fund|deposit|receive)\b|\bwhere\b[\s\S]{0,40}\bsend\b[\s\S]{0,20}\beth\b/i.test(text)) {
    return { kind: "show_wallet" };
  }
  if (/\b(?:balance|how much.*(?:eth|token|coin)|funds)\b/i.test(text)) {
    const token = text.match(/\b(?:of|for)\s+\$?([a-zA-Z0-9]{1,42})\b/i)?.[1];
    return { kind: "show_balance", ...(token ? { token } : {}) };
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
  if (/\bclaim\b.*\b(?:fee|fees|revenue|rewards)\b/i.test(text)) {
    const address = text.match(ADDRESS)?.[0];
    const symbol = text.match(/\$([a-zA-Z][a-zA-Z0-9]{0,11})/)?.[1];
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
  return command.kind === "send" || command.kind === "burn" || command.kind === "buy" || command.kind === "sell" || command.kind === "launch" || command.kind === "claim_fees";
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
    const slippageBps = Number.isInteger(item.slippageBps) ? Number(item.slippageBps) : DEFAULT_SWAP_SLIPPAGE_BPS;
    if (!amount || !token || slippageBps < 10 || slippageBps > 2_000) return null;
    if (kind === "buy" && (item.unit === "eth" || item.unit === "usd")) return { kind, amount, unit: item.unit, token, slippageBps };
    if (kind === "sell" && (item.unit === "token" || item.unit === "percent") && (item.unit !== "percent" || Number(amount) <= 100)) return { kind, amount, unit: item.unit, token, slippageBps };
    return null;
  }
  if (kind === "claim_fees") {
    const token = item.token === undefined ? undefined : tokenIdentifier(item.token);
    if (item.token !== undefined && !token) return null;
    return { kind, ...(token ? { token } : {}) };
  }
  if (kind === "launch") {
    const name = typeof item.name === "string" ? item.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) : "";
    const symbol = typeof item.symbol === "string" ? cleanSymbol(item.symbol) : "";
    if (!name || !symbol) return null;
    const optionalText = (key: string, max: number) => typeof item[key] === "string" && item[key] ? String(item[key]).slice(0, max) : undefined;
    const optionalUrl = (key: string) => {
      const candidate = optionalText(key, 300);
      return candidate && /^https:\/\//i.test(candidate) ? candidate : undefined;
    };
    let devBuy: { amount: string; unit: "eth" | "usd" } | undefined;
    if (item.devBuy && typeof item.devBuy === "object") {
      const raw = item.devBuy as Record<string, unknown>;
      const amount = finitePositiveString(raw.amount);
      if (!amount || (raw.unit !== "eth" && raw.unit !== "usd") || (raw.unit === "eth" && Number(amount) > MAX_LAUNCH_DEV_BUY_ETH)) return null;
      devBuy = { amount, unit: raw.unit };
    }
    return {
      kind, launchMode: "pons", name, symbol,
      ...(optionalText("description", 280) ? { description: optionalText("description", 280) } : {}),
      ...(optionalUrl("website") ? { website: optionalUrl("website") } : {}),
      ...(optionalUrl("twitter") ? { twitter: optionalUrl("twitter") } : {}),
      ...(optionalUrl("telegram") ? { telegram: optionalUrl("telegram") } : {}),
      ...(devBuy ? { devBuy } : {}),
    };
  }
  return null;
}
