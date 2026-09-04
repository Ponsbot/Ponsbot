import { v } from "convex/values";
import { coinGeckoFetch } from "../lib/coingecko-client";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { isEmptyNativeGasBalanceError, noNativeGasMessage, requireWalletNativeGas } from "../lib/wallet-native-gas";

const CONFIRMATION_GUIDANCE_MS = 5 * 60_000,
  FAST_POLLS = 240,
  FAST_POLL_MS = 15_000,
  SLOW_POLL_MS = 300_000;
const HOUDINI_API = "https://api-partner.houdiniswap.com",
  DEPOSIT_MARGIN_MS = 60_000;

export function houdiniOrderUrl(houdiniId: string) {
  return `https://app.houdiniswap.com/order-details?houdiniId=${encodeURIComponent(houdiniId)}`;
}

export function withHoudiniOrderLink(text: string, houdiniId?: string) {
  return houdiniId
    ? `${text}\nYour Houdini Swap order: ${houdiniOrderUrl(houdiniId)}`
    : text;
}
export type XHoudiniCommand = {
  amount: string;
  unit: "eth" | "usd";
  destination: string;
  targetSymbol:
    "ETH" | "SOL" | "BTC" | "USDC" | "USDT" | "BNB" | "AVAX" | "POL";
  targetChain:
    | "Ethereum"
    | "Base"
    | "Robinhood Chain"
    | "Arbitrum"
    | "Optimism"
    | "Solana"
    | "Bitcoin"
    | "Tron"
    | "BNB Chain"
    | "Avalanche"
    | "Polygon";
  privateMode: boolean;
};
// A leading dollar sign controls the denomination. Accept optional source-ETH
// wording so "$50 ETH" and "$50 of ETH" both mean $50 worth of Robinhood ETH.
const AMOUNT = String.raw`(?:\$\s*(\d+(?:\.\d+)?)(?:\s+(?:of\s+)?(?:ETH|USD))?|(\d+(?:\.\d+)?)\s*(?:ETH|USD))`;
const DEST = String.raw`(0x[a-fA-F0-9]{40}|(?:bc1|[13])[a-zA-HJ-NP-Z0-9]{20,70}|[1-9A-HJ-NP-Za-km-z]{32,44})`;
const SYMBOLS = ["ETH", "SOL", "BTC", "USDC", "USDT", "BNB", "AVAX", "POL"],
  CHAINS = [
    "Ethereum",
    "Base",
    "Robinhood Chain",
    "Arbitrum",
    "Optimism",
    "Solana",
    "Bitcoin",
    "Tron",
    "BNB Chain",
    "Avalanche",
    "Polygon",
  ];

type HoudiniChain = XHoudiniCommand["targetChain"];
const HOUDINI_CHAIN_CATALOG: Record<
  HoudiniChain,
  { apiName: string; responseName: string; matches: RegExp }
> = {
  Ethereum: {
    apiName: "ethereum",
    responseName: "Ethereum",
    matches: /^ethereum$/i,
  },
  Base: { apiName: "base", responseName: "Base", matches: /^base$/i },
  "Robinhood Chain": {
    apiName: "Robinhood",
    responseName: "Robinhood Chain",
    matches: /^robinhood(?: chain)?$/i,
  },
  Arbitrum: {
    apiName: "arbitrum",
    responseName: "Arbitrum",
    matches: /^arbitrum$/i,
  },
  Optimism: {
    apiName: "optimism",
    responseName: "Optimism",
    matches: /^optimism$/i,
  },
  Solana: {
    apiName: "solana",
    responseName: "Solana",
    matches: /^solana$/i,
  },
  Bitcoin: {
    apiName: "bitcoin",
    responseName: "Bitcoin",
    matches: /^bitcoin$/i,
  },
  Tron: { apiName: "tron", responseName: "Tron", matches: /^tron$/i },
  "BNB Chain": {
    apiName: "bsc",
    responseName: "BNB Chain",
    matches: /^(?:bsc|bnb chain|binance smart chain)$/i,
  },
  Avalanche: {
    apiName: "avalanche",
    responseName: "Avalanche",
    matches: /^(?:avalanche|avax)$/i,
  },
  Polygon: {
    apiName: "polygon",
    responseName: "Polygon",
    matches: /^(?:polygon|matic)$/i,
  },
};

export function houdiniChainSelection(chain: HoudiniChain) {
  return HOUDINI_CHAIN_CATALOG[chain];
}

function target(
  value: string,
): Pick<XHoudiniCommand, "targetSymbol" | "targetChain"> | null {
  const text = value
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(?:sol|solana)(?: on solana)?$/.test(text))
    return { targetSymbol: "SOL", targetChain: "Solana" };
  if (/^(?:btc|bitcoin)(?: on bitcoin)?$/.test(text))
    return { targetSymbol: "BTC", targetChain: "Bitcoin" };
  for (const [pattern, chain] of [
    [/^(?:ethereum eth|eth (?:on|to|in) ethereum|eth ethereum)$/, "Ethereum"],
    [/^(?:base eth|eth (?:on|to|in) base|eth base)$/, "Base"],
    [/^(?:arbitrum eth|eth (?:on|to|in) arbitrum|eth arbitrum)$/, "Arbitrum"],
    [/^(?:optimism eth|eth (?:on|to|in) optimism|eth optimism)$/, "Optimism"],
    [
      /^(?:robinhood(?: chain)? eth|eth (?:on|to|in) robinhood(?: chain)?|eth robinhood(?: chain)?)$/,
      "Robinhood Chain",
    ],
  ] as const)
    if (pattern.test(text)) return { targetSymbol: "ETH", targetChain: chain };
  const stable = text.match(
    /^(usdc|usdt)\s+(?:(?:on|in)\s+)?(ethereum|base|arbitrum|solana|tron)$/,
  );
  if (stable) {
    const symbol = stable[1].toUpperCase() as "USDC" | "USDT",
      chain = stable[2].replace(/^./, (c) =>
        c.toUpperCase(),
      ) as XHoudiniCommand["targetChain"];
    if (
      (symbol === "USDC" &&
        ["Ethereum", "Base", "Arbitrum", "Solana"].includes(chain)) ||
      (symbol === "USDT" && ["Ethereum", "Tron"].includes(chain))
    )
      return { targetSymbol: symbol, targetChain: chain };
  }
  if (/^(?:bnb|bnb (?:on )?(?:bsc|bnb chain))$/.test(text))
    return { targetSymbol: "BNB", targetChain: "BNB Chain" };
  if (/^(?:avax|avax (?:on )?avalanche)$/.test(text))
    return { targetSymbol: "AVAX", targetChain: "Avalanche" };
  if (/^(?:pol|pol (?:on )?polygon)$/.test(text))
    return { targetSymbol: "POL", targetChain: "Polygon" };
  return null;
}

function targetAtStart(value: string) {
  const words = value
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[,;:()[\]{}]+|[,;:()[\]{}.!?]+$/g, ""))
    .filter(Boolean);
  // Target descriptions currently contain at most four words (for example,
  // "ETH on Robinhood Chain"). Try the longest valid prefix so unrelated
  // prose after a complete command does not become part of the target.
  for (let length = Math.min(4, words.length); length >= 1; length--) {
    const parsed = target(words.slice(0, length).join(" "));
    if (parsed) return parsed;
  }
  return null;
}
function validCommand(value: unknown): value is XHoudiniCommand {
  if (!value || typeof value !== "object") return false;
  const x = value as Record<string, unknown>;
  return (
    typeof x.amount === "string" &&
    /^\d+(?:\.\d{1,18})?$/.test(x.amount) &&
    Number(x.amount) > 0 &&
    (x.unit === "eth" || x.unit === "usd") &&
    typeof x.destination === "string" &&
    x.destination.length <= 150 &&
    SYMBOLS.includes(String(x.targetSymbol)) &&
    CHAINS.includes(String(x.targetChain)) &&
    typeof x.privateMode === "boolean"
  );
}
export function parseXHoudiniCommand(input: string): XHoudiniCommand | null {
  let text = input
    .replace(/@ponsbotfamily\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
  const privateMode = /\bprivat(?:e|ely)\b/i.test(text);
  text = text
    .replace(/\bprivat(?:e|ely)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/\b(?:send|swap)\b/i.test(text)) return null;
  const patterns = [
    new RegExp(
      `\\b(?:send|swap)\\s+${AMOUNT}\\s+(?:to|for)\\s+${DEST}\\s+(?:as|in|for)\\s+(.+)`,
      "i",
    ),
    new RegExp(
      `\\b(?:send|swap)\\s+${AMOUNT}\\s+(?:as|in|for|to)\\s+(.+?)\\s+(?:to|for)\\s+${DEST}(?:\\b|$)`,
      "i",
    ),
  ];
  for (const [index, pattern] of patterns.entries()) {
    const m = text.match(pattern);
    if (!m) continue;
    const numeric = m[1] || m[2],
      destination = index === 0 ? m[3] : m[4],
      parsed = index === 0 ? targetAtStart(m[4]) : target(m[3]);
    if (!numeric || !destination || !parsed || Number(numeric) <= 0)
      return null;
    const evm = [
      "Ethereum",
      "Base",
      "Robinhood Chain",
      "Arbitrum",
      "Optimism",
      "BNB Chain",
      "Avalanche",
      "Polygon",
    ].includes(parsed.targetChain);
    if (evm !== /^0x[a-fA-F0-9]{40}$/.test(destination)) return null;
    if (
      (parsed.targetChain === "Solana" &&
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(destination)) ||
      (parsed.targetChain === "Bitcoin" &&
        !/^(?:bc1|[13])[a-zA-HJ-NP-Z0-9]{20,70}$/i.test(destination)) ||
      (parsed.targetChain === "Tron" &&
        !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(destination))
    )
      return null;
    return {
      amount: numeric,
      unit: m[1] || /\bUSD\b/i.test(text) ? "usd" : "eth",
      destination,
      ...parsed,
      privateMode,
    };
  }
  return null;
}
export function looksLikeXHoudiniCommand(input: string) {
  const t = input.replace(/@ponsbotfamily\b/gi, " ");
  return (
    /\b(?:send|swap)\b/i.test(t) &&
    /(?:\$\s*\d|\d(?:\.\d+)?\s*(?:ETH|USD)\b)/i.test(t) &&
    /(?:0x[a-fA-F0-9]{40}|\bbc1[a-zA-Z0-9]{20,70}\b|\bT[1-9A-HJ-NP-Za-km-z]{33}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b)/.test(
      t,
    ) &&
    /\b(?:as|in|for|to)\b[\s\S]{0,35}\b(?:SOL|Solana|BTC|Bitcoin|ETH|Ethereum|Base|Arbitrum|Optimism|USDC|USDT|Tron|BNB|AVAX|POL|Polygon)\b/i.test(
      t,
    )
  );
}
export function parseXHoudiniDecision(input: string) {
  const t = input
    .replace(/@ponsbotfamily\b/gi, "")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim()
    .toLowerCase();
  return ["confirm", "yes", "approve"].includes(t)
    ? ("confirm" as const)
    : ["no", "cancel"].includes(t)
      ? ("cancel" as const)
      : null;
}

class HoudiniHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly prePaymentRejected = false,
  ) {
    super(message);
  }
}
function headers() {
  const id = process.env.HOUDINI_PARTNER_ID,
    secret = process.env.HOUDINI_API_SECRET;
  if (!id || !secret) throw new Error("Houdini API is not configured");
  return {
    Authorization: `${id}:${secret}`,
    "content-type": "application/json",
  };
}
async function json(path: string, init?: RequestInit, xUserId?: string) {
  let response = await fetch(`${HOUDINI_API}${path}`, {
      ...init,
      headers: { ...headers(), ...(init?.headers || {}) },
      signal: AbortSignal.timeout(25_000),
    }),
    payload = (await response.json().catch(() => ({}))) as Record<string, any>;
  const message = typeof payload.message === "string" ? payload.message : "";
  const exhausted =
    response.status === 402 ||
    response.status === 429 ||
    (response.status === 403 &&
      /(?:rate.?limit|quota|free.?tier|usage.?limit|request.?limit).*(?:exceed|exhaust|reached|limit)|(?:exceed|exhaust|reached).*(?:quota|limit)/i.test(
        message,
      ));
  if (
    exhausted &&
    xUserId &&
    process.env.HOUDINI_X402_ENABLED === "true" &&
    process.env.HOUDINI_X_RELAY_SECRET &&
    process.env.NEXT_PUBLIC_SITE_URL
  ) {
    response = await fetch(
      new URL("/api/internal/houdini-x402", process.env.NEXT_PUBLIC_SITE_URL),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pons-internal-secret": process.env.HOUDINI_X_RELAY_SECRET,
        },
        body: JSON.stringify({
          path,
          method: init?.method || "GET",
          body: typeof init?.body === "string" ? init.body : undefined,
          xUserId,
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );
    payload = (await response.json().catch(() => ({}))) as Record<string, any>;
    // Accept this marker only from our authenticated relay, never the provider.
    if (!response.ok && response.headers.get("x-pons-houdini-pre-payment") === "rejected" && payload.code === "houdini_pre_payment_rejected")
      throw new HoudiniHttpError("Houdini API payment validation failed before submission", response.status, true);
  }
  if (!response.ok)
    throw new HoudiniHttpError(
      typeof payload.message === "string"
        ? payload.message
        : `Houdini request failed (${response.status})`,
      response.status,
    );
  return payload;
}
async function ethUsd() {
  try {
    const response = await fetch(
        "https://api.exchange.coinbase.com/products/ETH-USD/ticker",
        { signal: AbortSignal.timeout(8_000) },
      ),
      payload = (await response.json()) as { price?: string; time?: string },
      price = Number(payload.price),
      timestamp = Date.parse(payload.time || "");
    if (
      response.ok &&
      Number.isFinite(price) &&
      price > 0 &&
      Number.isFinite(timestamp) &&
      Math.abs(Date.now() - timestamp) <= 300_000
    )
      return price;
  } catch {}
  const response = await coinGeckoFetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_last_updated_at=true",
      { signal: AbortSignal.timeout(8_000) },
    ),
    payload = (await response.json()) as {
      ethereum?: { usd?: number; last_updated_at?: number };
    },
    price = Number(payload.ethereum?.usd),
    timestamp = Number(payload.ethereum?.last_updated_at) * 1000;
  if (
    !response.ok ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() - timestamp) > 300_000
  )
    throw new Error("ETH price is unavailable or stale");
  return price;
}
function display(value: unknown) {
  const n = Number(value);
  return !Number.isFinite(n) || n <= 0
    ? ""
    : n >= 1000
      ? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
      : n >= 1
        ? n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")
        : n.toPrecision(5).replace(/0+$/, "").replace(/\.$/, "");
}

export function classifyHoudiniStatus(value: unknown) {
  const label = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (["FINISHED", "COMPLETED"].includes(label)) return "completed" as const;
  if (
    [
      "FAILED",
      "EXPIRED",
      "REFUNDED",
      "DELETED",
      "REJECTED",
      "CANCELLED",
    ].includes(label)
  )
    return "failed" as const;
  return "pending" as const;
}

export function leaseAvailable(
  now: number,
  nextAttemptAt?: number,
  leaseUntil?: number,
) {
  return (nextAttemptAt || 0) <= now && (leaseUntil || 0) <= now;
}

export function fundingResultState(result: {
  ok?: boolean;
  pending?: boolean;
}) {
  return result.pending
    ? ("pending" as const)
    : result.ok
      ? ("confirmed" as const)
      : ("failed" as const);
}

export function receivedAssetLabel(symbol: string, chain: string) {
  if (symbol.trim().toUpperCase() !== "ETH") return symbol.trim().toUpperCase();
  const network = chain.trim().replace(/\s+Chain$/i, "");
  return `${network || "Ethereum"} ETH`;
}

export function formatHoudiniDuration(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const minutes = Number(text);
    return `${text} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return text;
}

export function houdiniMinimumAmountReply(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (
    !/below(?:\s+the)?\s+minimum|minimum(?:\s+(?:swap|quote|order|deposit))?\s+amount|amount\s+(?:is\s+)?(?:too\s+(?:low|small)|less\s+than)|min(?:imum)?\.?\s*amount/i.test(
      message,
    )
  )
    return null;
  const stated = message.match(
    /(?:minimum(?:\s+(?:swap|quote|order|deposit))?\s+amount|min(?:imum)?\.?\s*amount)(?:\s+(?:is|of|:))?\s*\$?\s*(\d+(?:[.,]\d+)?)\s*(ETH|USD|USDC|USDT)?/i,
  );
  if (stated) {
    const amount = stated[1].replace(",", ".");
    const unit = stated[2]?.toUpperCase();
    return `⚠️ That amount is below Houdini's minimum for this route. The minimum is ${unit === "USD" ? "$" : ""}${amount}${unit && unit !== "USD" ? ` ${unit}` : ""}. Reply with the full request using a larger amount.`;
  }
  return "⚠️ That amount is below Houdini's minimum for this route. Reply with the full request using a larger amount.";
}
type Token = {
  id: string;
  symbol: string;
  chain: string;
  addressValidation?: string;
  memoNeeded?: boolean;
  chainKind?: string;
};
async function findToken(
  symbol: XHoudiniCommand["targetSymbol"],
  chain: HoudiniChain,
  xUserId: string,
) {
  const selection = houdiniChainSelection(chain);
  const params = new URLSearchParams({
      hasCex: "true",
      pageSize: "50",
      page: "1",
      term: symbol,
      chain: selection.apiName,
    }),
    payload = await json(`/v2/tokens?${params}`, undefined, xUserId),
    raw = (Array.isArray(payload.tokens) ? payload.tokens : []).find(
      (x: any) =>
        typeof x?.id === "string" &&
        x.symbol?.toUpperCase() === symbol &&
        selection.matches.test(x.chain || "") &&
        x.hasCex === true &&
        x.enabled !== false,
    ) as any;
  if (!raw) return undefined;
  return {
    id: raw.id,
    symbol: raw.symbol,
    chain: raw.chain,
    addressValidation:
      typeof raw.chainData?.addressValidation === "string"
        ? raw.chainData.addressValidation
        : undefined,
    memoNeeded: raw.chainData?.memoNeeded === true,
    chainKind:
      typeof raw.chainData?.kind === "string" ? raw.chainData.kind : undefined,
  } as Token;
}
function validDestination(token: Token, destination: string) {
  if (token.memoNeeded) return false;
  if (token.chainKind?.toLowerCase() === "evm" || /^0x/.test(destination))
    return /^0x[a-fA-F0-9]{40}$/.test(destination);
  if (!token.addressValidation) return false;
  try {
    const m = destination.match(new RegExp(token.addressValidation));
    return !!m && m[0] === destination;
  } catch {
    return false;
  }
}
async function requestQuote(
  command: XHoudiniCommand,
  senderAddress: string,
  xUserId: string,
) {
  const [source, to, price] = await Promise.all([
    findToken("ETH", "Robinhood Chain", xUserId),
    findToken(command.targetSymbol, command.targetChain, xUserId),
    command.unit === "usd" ? ethUsd() : Promise.resolve(undefined),
  ]);
  if (!source)
    throw new Error("Houdini Robinhood ETH source is not currently available");
  if (!to)
    throw new Error("That Houdini destination is not currently available");
  if (!validDestination(to, command.destination))
    throw new Error(
      "That destination address is not valid for the selected network",
    );
  const sourceEthAmount =
      command.unit === "usd"
        ? (Number(command.amount) / price!)
            .toFixed(18)
            .replace(/0+$/, "")
            .replace(/\.$/, "")
        : command.amount,
    params = new URLSearchParams({
      from: source.id,
      to: to.id,
      amount: sourceEthAmount,
      types: command.privateMode ? "private" : "standard",
      senderAddress,
      receiverAddress: command.destination,
      refundAddress: senderAddress,
    }),
    payload = await json(`/v2/quotes?${params}`, undefined, xUserId),
    quote = (Array.isArray(payload.quotes) ? payload.quotes : []).find(
      (x: any) =>
        x &&
        x.filtered !== true &&
        typeof x.quoteId === "string" &&
        Number(x.amountOut ?? x.netAmountOut) > 0,
    );
  if (!quote) throw new Error("Houdini did not return a usable quote");
  return {
    quoteId: quote.quoteId as string,
    fromTokenId: source.id,
    toTokenId: to.id,
    sourceEthAmount,
    quotedAmountOut: display(quote.amountOut ?? quote.netAmountOut),
    quotedAmountOutUsd:
      display(quote.amountOutUsd ?? quote.estimatedAmountOutUsd) || undefined,
    duration: formatHoudiniDuration(
      quote.duration ?? quote.estimatedTime ?? quote.eta,
    ),
  };
}
function decodeCommand(raw: string) {
  if (raw.trim().startsWith("{"))
    try {
      const x = JSON.parse(raw);
      return validCommand(x) ? x : null;
    } catch {
      return null;
    }
  return parseXHoudiniCommand(raw);
}

export const createQuote = internalAction({
  args: {
    telegramUpdateId: v.optional(v.string()),
    requestPostId: v.string(),
    ownerXUserId: v.string(),
    walletAddress: v.string(),
    commandJson: v.string(),
    deliverySource: v.optional(v.union(v.literal("x"), v.literal("telegram"))),
    telegramUserId: v.optional(v.string()),
    telegramChatId: v.optional(v.string()),
    previousQuoteId: v.optional(v.id("xHoudiniQuotes")),
  },
  handler: async (ctx, args): Promise<{ quoteId: string; message: string }> => {
    const command = decodeCommand(args.commandJson);
    if (!command) throw new Error("invalid cross-chain command");
    if (args.deliverySource === "telegram" && (!/^\d{1,30}$/.test(args.telegramUserId || "") || !/^-?\d{1,30}$/.test(args.telegramChatId || "")))
      throw new Error("invalid Telegram delivery binding");
    await requireWalletNativeGas(args.walletAddress);
    const quote = await requestQuote(
        command,
        args.walletAddress,
        args.ownerXUserId,
      ),
      id = await ctx.runMutation(internal.xHoudini.storeQuote, {
        ...args,
        ...command,
        ...quote,
      }),
      usd = quote.quotedAmountOutUsd ? ` ($${quote.quotedAmountOutUsd})` : "";
    return {
      quoteId: id,
      message: `🔄 ${command.privateMode ? "Private swap" : "Multi-chain swap"} route\n\nYou send: ${quote.sourceEthAmount} ETH${command.unit === "usd" ? ` ($${command.amount})` : ""}\nYou receive: approximately ${quote.quotedAmountOut} ${command.targetSymbol}${usd}\nNetwork: ${command.targetChain}\nTo: ${command.destination.slice(0, 8)}...${command.destination.slice(-6)}${quote.duration ? `\nEstimated time: ${quote.duration}` : ""}`,
    };
  },
});
export const storeQuote = internalMutation({
  args: {
    telegramUpdateId: v.optional(v.string()),
    requestPostId: v.string(),
    ownerXUserId: v.string(),
    amount: v.string(),
    unit: v.union(v.literal("eth"), v.literal("usd")),
    destination: v.string(),
    targetSymbol: v.string(),
    targetChain: v.string(),
    privateMode: v.boolean(),
    quoteId: v.string(),
    fromTokenId: v.string(),
    toTokenId: v.string(),
    sourceEthAmount: v.string(),
    quotedAmountOut: v.string(),
    quotedAmountOutUsd: v.optional(v.string()),
    duration: v.optional(v.string()),
    walletAddress: v.string(),
    commandJson: v.string(),
    deliverySource: v.optional(v.union(v.literal("x"), v.literal("telegram"))),
    telegramUserId: v.optional(v.string()),
    telegramChatId: v.optional(v.string()),
    previousQuoteId: v.optional(v.id("xHoudiniQuotes")),
  },
  handler: async (ctx, args) =>
    await ctx.db.insert("xHoudiniQuotes", {
      requestPostId: args.requestPostId,
      ...(args.telegramUpdateId ? { telegramUpdateId: args.telegramUpdateId } : {}),
      deliverySource: args.deliverySource ?? "x",
      ...(args.telegramUserId ? { telegramUserId: args.telegramUserId } : {}),
      ...(args.telegramChatId ? { telegramChatId: args.telegramChatId } : {}),
      ownerXUserId: args.ownerXUserId,
      sourceAmount: args.amount,
      sourceUnit: args.unit,
      sourceEthAmount: args.sourceEthAmount,
      destination: args.destination,
      targetSymbol: args.targetSymbol,
      targetChain: args.targetChain,
      fromTokenId: args.fromTokenId,
      toTokenId: args.toTokenId,
      privateMode: args.privateMode,
      quoteId: args.quoteId,
      quotedAmountOut: args.quotedAmountOut,
      ...(args.quotedAmountOutUsd
        ? { quotedAmountOutUsd: args.quotedAmountOutUsd }
        : {}),
      ...(args.duration ? { duration: args.duration } : {}),
      ...(args.previousQuoteId
        ? { previousQuoteId: args.previousQuoteId }
        : {}),
      status: "pending_publication",
      expiresAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
});
export const bindQuoteResponse = internalMutation({
  args: { quoteId: v.id("xHoudiniQuotes"), responsePostId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId);
    if (!row || row.quoteResponsePostId || row.status !== "pending_publication")
      return false;
    const now = Date.now(),
      active = await ctx.db
        .query("xHoudiniQuotes")
        .withIndex("by_owner_created_at", (q) =>
          q.eq("ownerXUserId", row.ownerXUserId),
        )
        .order("desc")
        .take(25);
    for (const quote of active)
      if (quote._id !== row._id && quote.status === "awaiting_confirmation")
        await ctx.db.patch(quote._id, { status: "superseded", updatedAt: now });
    if (row.previousQuoteId) {
      const previous = await ctx.db.get(row.previousQuoteId);
      if (
        previous &&
        !["completed", "failed", "uncertain"].includes(previous.status)
      )
        await ctx.db.patch(previous._id, {
          status: "superseded",
          updatedAt: now,
        });
    }
    await ctx.db.patch(row._id, {
      status: "awaiting_confirmation",
      quoteResponsePostId: args.responsePostId,
      // Guidance only. Houdini remains authoritative for quote validity.
      expiresAt: now + CONFIRMATION_GUIDANCE_MS,
      updatedAt: now,
    });
    return true;
  },
});
export const startImmediateExecution = internalMutation({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    ownerXUserId: v.string(),
    sourcePostId: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId);
    if (
      !row ||
      row.ownerXUserId !== args.ownerXUserId ||
      row.requestPostId !== args.sourcePostId ||
      row.status !== "pending_publication"
    )
      return false;
    await ctx.db.patch(row._id, {
      status: "confirmed",
      confirmationRequired: false,
      confirmationPostId: args.sourcePostId,
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const supersedeQuote = internalMutation({
  args: { quoteId: v.id("xHoudiniQuotes") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId);
    if (!row || ["completed", "failed", "uncertain"].includes(row.status))
      return false;
    await ctx.db.patch(row._id, {
      status: "superseded",
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const quoteForDecision = internalQuery({
  args: { responsePostId: v.string(), ownerXUserId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("xHoudiniQuotes")
      .withIndex("by_quote_response", (q) =>
        q.eq("quoteResponsePostId", args.responsePostId),
      )
      .unique();
    return row?.ownerXUserId === args.ownerXUserId &&
      ["awaiting_confirmation", "superseded"].includes(row.status)
      ? row
      : null;
  },
});
export const decideQuote = internalMutation({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    ownerXUserId: v.string(),
    confirmationPostId: v.string(),
    decision: v.union(v.literal("confirm"), v.literal("cancel")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId);
    if (
      !row ||
      row.ownerXUserId !== args.ownerXUserId ||
      row.status !== "awaiting_confirmation"
    )
      return { accepted: false };
    if (args.decision === "cancel") {
      await ctx.db.patch(row._id, {
        status: "cancelled",
        confirmationPostId: args.confirmationPostId,
        updatedAt: Date.now(),
      });
      return { accepted: true, cancelled: true };
    }
    if (!row.quoteResponsePostId) return { accepted: false };
    await ctx.db.patch(row._id, {
      status: "confirmed",
      confirmationPostId: args.confirmationPostId,
      updatedAt: Date.now(),
    });
    return { accepted: true, row };
  },
});
export const getQuote = internalQuery({
  args: { quoteId: v.id("xHoudiniQuotes") },
  handler: async (ctx, args) => await ctx.db.get(args.quoteId),
});

export const consumeQuoteLimit = internalMutation({
  args: { ownerXUserId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const key = `user:${args.ownerXUserId}`;
    const row = await ctx.db
      .query("xHoudiniRateLimits")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    const dailyCount = row?.utcDay === day ? row.dailyCount : 0;
    const inWindow = Boolean(row && now - row.windowStartedAt < 10 * 60_000);
    const windowCount = inWindow ? row!.windowCount : 0;
    if (dailyCount >= 50 || windowCount >= 10) return { allowed: false };
    const value = {
      utcDay: day,
      dailyCount: dailyCount + 1,
      windowStartedAt: inWindow ? row!.windowStartedAt : now,
      windowCount: windowCount + 1,
      updatedAt: now,
    };
    if (row) await ctx.db.patch(row._id, value);
    else await ctx.db.insert("xHoudiniRateLimits", { key, ...value });
    return { allowed: true };
  },
});

export const reserveExecution = internalMutation({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    ownerXUserId: v.string(),
    attemptId: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId);
    if (!row || row.ownerXUserId !== args.ownerXUserId) return null;
    if (row.status === "confirmed") {
      await ctx.db.patch(row._id, {
        status: "executing",
        executionStage: "creating_order",
        executionAttemptId: args.attemptId,
        updatedAt: Date.now(),
      });
      return {
        ...row,
        status: "executing" as const,
        executionStage: "creating_order" as const,
        executionAttemptId: args.attemptId,
      };
    }
    return row.status === "executing" ? row : null;
  },
});
export const saveOrder = internalMutation({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    attemptId: v.string(),
    houdiniId: v.string(),
    depositAddress: v.string(),
    orderExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId);
    if (
      !row ||
      row.status !== "executing" ||
      row.executionStage !== "creating_order" ||
      row.executionAttemptId !== args.attemptId ||
      row.houdiniId
    )
      return false;
    await ctx.db.patch(row._id, {
      houdiniId: args.houdiniId,
      depositAddress: args.depositAddress,
      orderExpiresAt: args.orderExpiresAt,
      executionStage: "order_created",
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const reserveFunding = internalMutation({
  args: { quoteId: v.id("xHoudiniQuotes"), leaseId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId),
      now = Date.now();
    if (
      !row ||
      row.status !== "executing" ||
      !row.houdiniId ||
      !row.depositAddress
    )
      return null;
    if (row.executionStage === "monitoring")
      return { state: "monitoring" as const, row };
    if (
      !["order_created", "funding"].includes(row.executionStage || "") ||
      !leaseAvailable(now, row.nextFundingAttemptAt, row.fundingLeaseUntil)
    )
      return { state: "busy" as const, row };
    const fundingRequestId =
      row.fundingRequestId || `x-houdini:${row._id}:funding`;
    await ctx.db.patch(row._id, {
      executionStage: "funding",
      fundingRequestId,
      fundingLeaseId: args.leaseId,
      fundingLeaseUntil: now + 120_000,
      nextFundingAttemptAt: undefined,
      updatedAt: now,
    });
    return {
      state: "reserved" as const,
      row: {
        ...row,
        executionStage: "funding" as const,
        fundingRequestId,
        fundingLeaseId: args.leaseId,
        fundingLeaseUntil: now + 120_000,
      },
    };
  },
});
export const deferFunding = internalMutation({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    leaseId: v.string(),
    delayMs: v.number(),
    safeError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId);
    if (
      !row ||
      row.fundingLeaseId !== args.leaseId ||
      row.executionStage !== "funding"
    )
      return false;
    await ctx.db.patch(row._id, {
      fundingLeaseId: undefined,
      fundingLeaseUntil: undefined,
      nextFundingAttemptAt: Date.now() + Math.max(5_000, args.delayMs),
      ...(args.safeError ? { safeError: args.safeError } : {}),
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const markFunded = internalMutation({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    fundingRequestId: v.string(),
    leaseId: v.string(),
    transactionHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId);
    if (
      !row ||
      row.status !== "executing" ||
      row.fundingRequestId !== args.fundingRequestId ||
      row.fundingLeaseId !== args.leaseId
    )
      return false;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      executionStage: "monitoring",
      fundingLeaseId: undefined,
      fundingLeaseUntil: undefined,
      nextFundingAttemptAt: undefined,
      nextStatusCheckAt: now + FAST_POLL_MS,
      ...(args.transactionHash
        ? { fundingTransactionHash: args.transactionHash }
        : {}),
      updatedAt: now,
    });
    return true;
  },
});
export const recordSubmissionPublication = internalMutation({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    status: v.union(
      v.literal("published"),
      v.literal("uncertain"),
      v.literal("failed"),
    ),
    responsePostId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId);
    if (!row || row.submissionPublicationStatus) return false;
    await ctx.db.patch(row._id, {
      submissionPublicationStatus: args.status,
      ...(args.responsePostId
        ? { submissionResponsePostId: args.responsePostId }
        : {}),
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const setFinalOutcome = internalMutation({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    status: v.union(
      v.literal("completed"),
      v.literal("failed"),
      v.literal("uncertain"),
    ),
    text: v.string(),
    ok: v.boolean(),
    safeError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId);
    if (
      !row ||
      (["completed", "failed", "uncertain"].includes(row.status) &&
        row.finalReplyText)
    )
      return false;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: args.status,
      executionStage: "finished",
      finalReplyText: args.text,
      finalReplyOk: args.ok,
      finalPublicationStatus: "pending",
      finalPublicationAttempts: 0,
      nextPublicationAttemptAt: now,
      finalPublicationLeaseId: undefined,
      finalPublicationLeaseUntil: undefined,
      ...(args.safeError ? { safeError: args.safeError } : {}),
      updatedAt: now,
    });
    return true;
  },
});
export const reserveFinalPublication = internalMutation({
  args: { quoteId: v.id("xHoudiniQuotes"), leaseId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId),
      now = Date.now();
    if (
      !row ||
      row.finalPublicationStatus !== "pending" ||
      !leaseAvailable(
        now,
        row.nextPublicationAttemptAt,
        row.finalPublicationLeaseUntil,
      )
    )
      return null;
    await ctx.db.patch(row._id, {
      finalPublicationLeaseId: args.leaseId,
      finalPublicationLeaseUntil: now + 60_000,
      updatedAt: now,
    });
    return {
      ...row,
      finalPublicationLeaseId: args.leaseId,
      finalPublicationLeaseUntil: now + 60_000,
    };
  },
});
export const finishFinalPublication = internalMutation({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    leaseId: v.string(),
    status: v.union(
      v.literal("published"),
      v.literal("uncertain"),
      v.literal("failed"),
      v.literal("retry"),
    ),
    responsePostId: v.optional(v.string()),
    safeError: v.optional(v.string()),
    delayMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId);
    if (
      !row ||
      row.finalPublicationLeaseId !== args.leaseId ||
      row.finalPublicationStatus !== "pending"
    )
      return false;
    const attempts = (row.finalPublicationAttempts || 0) + 1,
      now = Date.now();
    await ctx.db.patch(row._id, {
      finalPublicationStatus: args.status === "retry" ? "pending" : args.status,
      finalPublicationAttempts: attempts,
      finalPublicationLeaseId: undefined,
      finalPublicationLeaseUntil: undefined,
      nextPublicationAttemptAt:
        args.status === "retry"
          ? now + Math.max(60_000, args.delayMs || 60_000)
          : undefined,
      ...(args.responsePostId
        ? { finalResponsePostId: args.responsePostId }
        : {}),
      ...(args.safeError ? { safeError: args.safeError } : {}),
      updatedAt: now,
    });
    return true;
  },
});
export const reserveStatusPoll = internalMutation({
  args: { quoteId: v.id("xHoudiniQuotes"), leaseId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId),
      now = Date.now();
    if (
      !row ||
      !["executing", "monitoring_timeout"].includes(row.status) ||
      row.executionStage !== "monitoring" ||
      !leaseAvailable(now, row.nextStatusCheckAt, row.statusPollLeaseUntil)
    )
      return null;
    await ctx.db.patch(row._id, {
      statusPollLeaseId: args.leaseId,
      statusPollLeaseUntil: now + 60_000,
      updatedAt: now,
    });
    return {
      ...row,
      statusPollLeaseId: args.leaseId,
      statusPollLeaseUntil: now + 60_000,
    };
  },
});
export const finishStatusPoll = internalMutation({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    leaseId: v.string(),
    delayMs: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.quoteId);
    if (
      !row ||
      row.statusPollLeaseId !== args.leaseId ||
      row.executionStage !== "monitoring"
    )
      return null;
    const attempts = (row.statusPollAttempts || 0) + 1,
      timeout = attempts >= FAST_POLLS,
      now = Date.now();
    await ctx.db.patch(row._id, {
      status: timeout ? "monitoring_timeout" : row.status,
      statusPollAttempts: attempts,
      statusPollLeaseId: undefined,
      statusPollLeaseUntil: undefined,
      nextStatusCheckAt: now + args.delayMs,
      ...(timeout ? { safeError: "fast status monitoring timed out" } : {}),
      updatedAt: now,
    });
    return { attempts, status: timeout ? "monitoring_timeout" : row.status };
  },
});
async function final(
  ctx: ActionCtx,
  quoteId: any,
  status: "completed" | "failed" | "uncertain",
  text: string,
  ok: boolean,
  safeError?: string,
) {
  if (
    await ctx.runMutation(internal.xHoudini.setFinalOutcome, {
      quoteId,
      status,
      text,
      ok,
      ...(safeError ? { safeError } : {}),
    })
  )
    await ctx.scheduler.runAfter(0, internal.xHoudini.publishFinalOutcome, {
      quoteId,
    });
}
function expiredQuote(error: unknown) {
  return (
    error instanceof HoudiniHttpError &&
    [400, 404, 409, 410, 422].includes(error.status) &&
    /\bquote\b[\s\S]{0,80}\b(?:expired|invalid|stale|no longer valid)\b|\b(?:expired|invalid|stale)\b[\s\S]{0,80}\bquote\b/i.test(
      error.message,
    )
  );
}

function exchangeValidationMeansRefresh(error: unknown) {
  return (
    error instanceof HoudiniHttpError &&
    [400, 404, 409, 410, 422].includes(error.status) &&
    /^validation failed\.?$/i.test(error.message.trim())
  );
}

async function publishSubmitted(
  ctx: ActionCtx,
  quoteId: any,
  confirmationPostId: string,
  privateMode: boolean,
  duration?: string,
  houdiniId?: string,
) {
  const text = withHoudiniOrderLink(
    `⏳ ${privateMode ? "Private" : "Cross-chain"} swap submitted to Houdini Swap.${duration ? `\nEstimated wait: ${duration}.` : ""}\nPlease stand by for the result.`,
    houdiniId,
  );
  const row = await ctx.runQuery(internal.xHoudini.getQuote, { quoteId });
  if (row?.deliverySource === "telegram" && row.telegramUserId && row.telegramChatId) {
    let delivered = false;
    try {
      delivered = await ctx.runAction(internal.telegram.deliverHoudiniMessage, {
        telegramUserId: row.telegramUserId, telegramChatId: row.telegramChatId, ownerXUserId: row.ownerXUserId,
        text, requestId: `houdini-submitted:${row._id}`,
      });
    } catch { /* Order monitoring must continue even if its progress message is unavailable. */ }
    await ctx.runMutation(internal.xHoudini.recordSubmissionPublication, { quoteId, status: delivered ? "published" : "failed" });
    return;
  }
  const result = await ctx.runAction(internal.xReplies.publishHoudiniProgress, { postId: confirmationPostId, text, houdiniQuoteId: quoteId });
  if (result.status === "queued") return;
  await ctx.runMutation(internal.xHoudini.recordSubmissionPublication, {
    quoteId,
    status:
      result.status === "published"
        ? "published"
        : result.status === "uncertain"
          ? "uncertain"
          : "failed",
    ...(result.responsePostId ? { responsePostId: result.responsePostId } : {}),
  });
}

async function fund(
  ctx: ActionCtx,
  quoteId: any,
  confirmationPostId: string,
  ownerXUserId: string,
  walletAddress: string,
) {
  const leaseId = crypto.randomUUID(),
    reserved = await ctx.runMutation(internal.xHoudini.reserveFunding, {
      quoteId,
      leaseId,
    });
  if (!reserved || reserved.state === "busy") return;
  if (reserved.state === "monitoring") {
    await ctx.scheduler.runAfter(FAST_POLL_MS, internal.xHoudini.pollOrder, {
      quoteId,
      confirmationPostId,
    });
    return;
  }
  const row = reserved.row;
  if (!row.fundingRequestId || !row.depositAddress) return;
  if (
    !row.orderExpiresAt ||
    row.orderExpiresAt <= Date.now() + DEPOSIT_MARGIN_MS
  ) {
    await final(
      ctx,
      quoteId,
      "failed",
      "❌ The Houdini deposit window expired before funds were sent. Reply with the full request again.",
      false,
      "deposit window expired before funding",
    );
    return;
  }
  let result;
  try {
    result = await ctx.runAction(internal.wallets.executeCommand, {
      sourcePostId: confirmationPostId,
      xUserId: ownerXUserId,
      requestId: row.fundingRequestId,
      text: `send ${row.sourceEthAmount} ETH to ${row.depositAddress}`,
      parsedCommandJson: JSON.stringify({
        kind: "send",
        amount: row.sourceEthAmount,
        unit: "eth",
        recipient: row.depositAddress,
      }),
      source: row.deliverySource === "telegram" ? "telegram" : "x",
      ...(row.telegramUpdateId ? { telegramUpdateId: row.telegramUpdateId } : {}),
      channel: row.deliverySource === "telegram" ? "telegram_chat" : "x_reply",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "wallet funding interrupted";
    console.error("x_houdini_funding_interrupted", { quoteId, message });
    await ctx.runMutation(internal.xHoudini.deferFunding, {
      quoteId,
      leaseId,
      delayMs: 60_000,
      safeError: message.slice(0, 240),
    });
    await ctx.scheduler.runAfter(60_000, internal.xHoudini.executeConfirmed, {
      quoteId,
      confirmationPostId,
      walletAddress,
      ownerXUserId,
    });
    return;
  }
  if (fundingResultState(result) === "pending") {
    await ctx.runMutation(internal.xHoudini.deferFunding, {
      quoteId,
      leaseId,
      delayMs: 15_000,
      safeError: "wallet funding is still processing",
    });
    await ctx.scheduler.runAfter(15_000, internal.xHoudini.executeConfirmed, {
      quoteId,
      confirmationPostId,
      walletAddress,
      ownerXUserId,
    });
    return;
  }
  if (fundingResultState(result) === "failed") {
    const m = result.message || "The wallet could not fund the Houdini order";
    await final(
      ctx,
      quoteId,
      "failed",
      /^[\p{Extended_Pictographic}⚠️❌⛽🌐]/u.test(m) && m.length <= 240
        ? m
        : "❌ The swap couldn't be completed. No funds were moved.",
      false,
      m.slice(0, 240),
    );
    return;
  }
  if (
    await ctx.runMutation(internal.xHoudini.markFunded, {
      quoteId,
      fundingRequestId: row.fundingRequestId,
      leaseId,
      ...(result.transactionHash
        ? { transactionHash: result.transactionHash }
        : {}),
    })
  ) {
    await publishSubmitted(
      ctx,
      quoteId,
      confirmationPostId,
      row.privateMode,
      row.duration,
      row.houdiniId,
    );
    await ctx.scheduler.runAfter(FAST_POLL_MS, internal.xHoudini.pollOrder, {
      quoteId,
      confirmationPostId,
    });
  }
}
export const executeConfirmed = internalAction({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    confirmationPostId: v.string(),
    walletAddress: v.string(),
    ownerXUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const attemptId = crypto.randomUUID(),
      row = await ctx.runMutation(internal.xHoudini.reserveExecution, {
        quoteId: args.quoteId,
        ownerXUserId: args.ownerXUserId,
        attemptId,
      });
    if (!row) return;
    if (row.executionStage !== "creating_order") {
      await fund(
        ctx,
        args.quoteId,
        args.confirmationPostId,
        args.ownerXUserId,
        args.walletAddress,
      );
      return;
    }
    if (row.deliverySource === "telegram" && !await ctx.runQuery(internal.telegram.executionAuthorized, { updateId: row.telegramUpdateId, ownerXUserId: row.ownerXUserId })) {
      await final(ctx, args.quoteId, "failed", "Telegram wallet access changed. Start a new request from your linked account.", false, "TELEGRAM_LINK_REVOKED");
      return;
    }
    // A failed precheck is definitive: no exchange POST or funding took place.
    try { await requireWalletNativeGas(args.walletAddress); }
    catch (error) {
      await final(ctx, args.quoteId, "failed", isEmptyNativeGasBalanceError(error)
        ? noNativeGasMessage(args.walletAddress)
        : "⚠️ I couldn't check your ETH balance right now. Reply with the request again shortly.",
        false, "native gas precheck failed before exchange creation");
      return;
    }
    try {
      const payload = await json(
          "/v2/exchanges",
          {
            method: "POST",
            body: JSON.stringify({
              quoteId: row.quoteId,
              addressTo: row.destination,
              addressFrom: args.walletAddress,
              refundAddress: args.walletAddress,
            }),
          },
          args.ownerXUserId,
        ),
        order =
          payload.order && typeof payload.order === "object"
            ? payload.order
            : payload,
        houdiniId = String(order.houdiniId || order.id || ""),
        depositAddress = String(order.depositAddress || ""),
        orderExpiresAt = Date.parse(
          typeof order.expires === "string" ? order.expires : "",
        );
      if (!houdiniId || !/^0x[a-fA-F0-9]{40}$/.test(depositAddress))
        throw new Error(
          "Houdini returned an invalid Robinhood Chain deposit destination",
        );
      if (
        !Number.isFinite(orderExpiresAt) ||
        orderExpiresAt <= Date.now() + DEPOSIT_MARGIN_MS
      )
        throw new Error(
          "Houdini returned an invalid or insufficient deposit window",
        );
      if (
        !(await ctx.runMutation(internal.xHoudini.saveOrder, {
          quoteId: args.quoteId,
          attemptId,
          houdiniId,
          depositAddress,
          orderExpiresAt,
        }))
      )
        throw new Error("Houdini order state could not be reserved safely");
      await fund(
        ctx,
        args.quoteId,
        args.confirmationPostId,
        args.ownerXUserId,
        args.walletAddress,
      );
    } catch (error) {
      if (expiredQuote(error) || exchangeValidationMeansRefresh(error)) {
        if (row.confirmationRequired === false)
          await ctx.runAction(internal.xHoudini.refreshImmediate, {
            quoteId: args.quoteId,
            sourcePostId: args.confirmationPostId,
            walletAddress: args.walletAddress,
            ownerXUserId: args.ownerXUserId,
          });
        else
          await final(
            ctx,
            args.quoteId,
            "failed",
            "❌ That earlier cross-chain request can no longer be processed. No funds were moved. Reply with the full request again.",
            false,
            "legacy approval-based route was rejected by Houdini",
          );
        return;
      }
      const m =
        error instanceof Error
          ? error.message
          : "Houdini exchange submission was interrupted";
      await final(
        ctx,
        args.quoteId,
        error instanceof HoudiniHttpError && error.prePaymentRejected ? "failed" : "uncertain",
        error instanceof HoudiniHttpError && error.prePaymentRejected
          ? "❌ Houdini API payment validation failed before submission. No swap funds were sent. Reply with the full request again."
          : "❌ The exchange submission could not be confirmed. No automatic retry or wallet transfer was made.",
        false,
        m.slice(0, 240),
      );
    }
  },
});
export const refreshExpired = internalAction({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    confirmationPostId: v.string(),
    walletAddress: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.xHoudini.getQuote, {
      quoteId: args.quoteId,
    });
    if (!row || row.houdiniId || row.fundingTransactionHash) return;
    const command: XHoudiniCommand = {
      amount: row.sourceAmount,
      unit: row.sourceUnit,
      destination: row.destination,
      targetSymbol: row.targetSymbol as XHoudiniCommand["targetSymbol"],
      targetChain: row.targetChain as XHoudiniCommand["targetChain"],
      privateMode: row.privateMode,
    };
    try {
      const fresh = await ctx.runAction(internal.xHoudini.createQuote, {
          requestPostId: args.confirmationPostId,
          ownerXUserId: row.ownerXUserId,
          walletAddress: args.walletAddress,
          commandJson: JSON.stringify(command),
          previousQuoteId: args.quoteId,
          deliverySource: row.deliverySource,
          ...(row.telegramUserId ? { telegramUserId: row.telegramUserId } : {}),
          ...(row.telegramChatId ? { telegramChatId: row.telegramChatId } : {}),
          ...(row.telegramUpdateId ? { telegramUpdateId: row.telegramUpdateId } : {}),
        }),
        publication = await ctx.runAction(
          internal.xReplies.publishHoudiniOutcome,
          {
            postId: args.confirmationPostId,
            text: `⏱️ That quote expired. Here is an updated quote:\n\n${fresh.message}`,
            ok: true,
          },
        );
      if (publication.status === "published" && publication.responsePostId)
        await ctx.runMutation(internal.xHoudini.bindQuoteResponse, {
          quoteId: fresh.quoteId as any,
          responsePostId: publication.responsePostId,
        });
      else
        await final(
          ctx,
          args.quoteId,
          "failed",
          "❌ That quote expired, and I couldn't publish an updated quote. Reply with the full request again.",
          false,
          publication.error || "quote refresh publication failed",
        );
    } catch {
      await final(
        ctx,
        args.quoteId,
        "failed",
        "❌ That quote expired, and I couldn't prepare an updated quote. Reply with the full request again.",
        false,
        "quote refresh failed",
      );
    }
  },
});
export const refreshImmediate = internalAction({
  args: {
    quoteId: v.id("xHoudiniQuotes"),
    sourcePostId: v.string(),
    walletAddress: v.string(),
    ownerXUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.xHoudini.getQuote, {
      quoteId: args.quoteId,
    });
    if (!row || row.houdiniId || row.fundingTransactionHash) return;
    // One automatic refresh is enough to cover a stale provider quote without
    // creating an unbounded retry loop for a structurally invalid route.
    if (row.previousQuoteId) {
      await final(
        ctx,
        args.quoteId,
        "failed",
        "❌ The swap couldn't be submitted to the route provider. No funds were moved.",
        false,
        "Houdini rejected both the initial and refreshed quote",
      );
      return;
    }
    const command: XHoudiniCommand = {
      amount: row.sourceAmount,
      unit: row.sourceUnit,
      destination: row.destination,
      targetSymbol: row.targetSymbol as XHoudiniCommand["targetSymbol"],
      targetChain: row.targetChain as XHoudiniCommand["targetChain"],
      privateMode: row.privateMode,
    };
    try {
      const fresh = await ctx.runAction(internal.xHoudini.createQuote, {
        requestPostId: args.sourcePostId,
        ownerXUserId: args.ownerXUserId,
        walletAddress: args.walletAddress,
        commandJson: JSON.stringify(command),
        previousQuoteId: args.quoteId,
        deliverySource: row.deliverySource,
        ...(row.telegramUserId ? { telegramUserId: row.telegramUserId } : {}),
        ...(row.telegramChatId ? { telegramChatId: row.telegramChatId } : {}),
        ...(row.telegramUpdateId ? { telegramUpdateId: row.telegramUpdateId } : {}),
      });
      const activated = await ctx.runMutation(
        internal.xHoudini.startImmediateExecution,
        {
          quoteId: fresh.quoteId as any,
          ownerXUserId: args.ownerXUserId,
          sourcePostId: args.sourcePostId,
        },
      );
      if (!activated) throw new Error("refreshed quote could not be reserved");
      await ctx.runMutation(internal.xHoudini.supersedeQuote, {
        quoteId: args.quoteId,
      });
      await ctx.scheduler.runAfter(0, internal.xHoudini.executeConfirmed, {
        quoteId: fresh.quoteId as any,
        confirmationPostId: args.sourcePostId,
        walletAddress: args.walletAddress,
        ownerXUserId: args.ownerXUserId,
      });
    } catch (error) {
      await final(
        ctx,
        args.quoteId,
        "failed",
        "❌ The swap couldn't be submitted to the route provider. No funds were moved.",
        false,
        error instanceof Error ? error.message.slice(0, 240) : "quote refresh failed",
      );
    }
  },
});
export const pollOrder = internalAction({
  args: { quoteId: v.id("xHoudiniQuotes"), confirmationPostId: v.string() },
  handler: async (ctx, args) => {
    const leaseId = crypto.randomUUID(),
      row = await ctx.runMutation(internal.xHoudini.reserveStatusPoll, {
        quoteId: args.quoteId,
        leaseId,
      });
    if (!row?.houdiniId) return;
    let delay =
      (row.statusPollAttempts || 0) + 1 >= FAST_POLLS
        ? SLOW_POLL_MS
        : FAST_POLL_MS;
    try {
      const order = await json(
          `/v2/orders/${encodeURIComponent(row.houdiniId)}`,
          undefined,
          row.ownerXUserId,
        ),
        label = String(
          order.statusLabel || order.status || order.displayStatus || "",
        )
          .trim()
          .toUpperCase()
          .replace(/[\s-]+/g, "_");
      const outcome = classifyHoudiniStatus(label);
      if (outcome === "completed") {
        const received =
          display(
            order.amountOut ??
              order.netAmountOut ??
              order.toAmount ??
              order.receivedAmount,
          ) || row.quotedAmountOut;
        await final(
          ctx,
          args.quoteId,
          "completed",
          `✅ Swap complete! ${received} ${receivedAssetLabel(row.targetSymbol, row.targetChain)} was sent to the destination wallet.`,
          true,
        );
        return;
      }
      if (outcome === "failed") {
        await final(
          ctx,
          args.quoteId,
          "failed",
          "❌ The swap failed during processing. Check your wallet for any refund from the route provider.",
          false,
          label.slice(0, 120),
        );
        return;
      }
    } catch (error) {
      console.error("x_houdini_status_failed", {
        quoteId: args.quoteId,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
    const next = await ctx.runMutation(internal.xHoudini.finishStatusPoll, {
      quoteId: args.quoteId,
      leaseId,
      delayMs: delay,
    });
    if (next)
      await ctx.scheduler.runAfter(delay, internal.xHoudini.pollOrder, {
        quoteId: args.quoteId,
        confirmationPostId: args.confirmationPostId,
      });
  },
});
export const publishFinalOutcome = internalAction({
  args: { quoteId: v.id("xHoudiniQuotes") },
  handler: async (ctx, args) => {
    const leaseId = crypto.randomUUID(),
      row = await ctx.runMutation(internal.xHoudini.reserveFinalPublication, {
        quoteId: args.quoteId,
        leaseId,
      });
    if (
      !row?.confirmationPostId ||
      !row.finalReplyText ||
      row.finalReplyOk === undefined
    )
      return;
    if (row.deliverySource === "telegram") {
      if (!row.telegramUserId || !row.telegramChatId) {
        await ctx.runMutation(internal.xHoudini.finishFinalPublication, {
          quoteId: args.quoteId, leaseId, status: "failed", safeError: "Telegram final delivery binding missing",
        });
        return;
      }
      const delivered = await ctx.runAction(internal.telegram.deliverHoudiniMessage, {
        telegramUserId: row.telegramUserId, telegramChatId: row.telegramChatId, ownerXUserId: row.ownerXUserId,
        text: withHoudiniOrderLink(row.finalReplyText, row.houdiniId), requestId: `houdini-final:${row._id}`,
      });
      await ctx.runMutation(internal.xHoudini.finishFinalPublication, {
        quoteId: args.quoteId, leaseId, status: delivered ? "published" : "failed",
        ...(!delivered ? { safeError: "Telegram final delivery failed" } : {}),
      });
      return;
    }
    const result = await ctx.runAction(internal.xReplies.publishHoudiniOutcome, {
      // Final outcomes belong on the user's original command, not under
      // the bot's intermediate "submitted" response.
      postId: row.requestPostId,
      text: withHoudiniOrderLink(row.finalReplyText, row.houdiniId),
      ok: row.finalReplyOk,
      publicationKey: `houdini-final:${row._id}`,
      houdiniQuoteId: row._id,
    }), attempts = (row.finalPublicationAttempts || 0) + 1;
    if (result.status === "queued") return;
    if (result.status === "published" && result.responsePostId) {
      await ctx.runMutation(internal.xHoudini.finishFinalPublication, {
        quoteId: args.quoteId,
        leaseId,
        status: "published",
        responsePostId: result.responsePostId,
      });
      await ctx.runMutation(internal.xReplies.updateInteraction, {
        postId: row.requestPostId,
        status: row.finalReplyOk ? "completed" : "rejected",
        commandKind: "houdini_result",
        responsePostId: result.responsePostId,
        ...(!row.finalReplyOk ? { safeError: row.finalReplyText } : {}),
      });
      return;
    }
    if (result.status === "uncertain") {
      await ctx.runMutation(internal.xHoudini.finishFinalPublication, {
        quoteId: args.quoteId,
        leaseId,
        status: "uncertain",
        safeError: result.error?.slice(0, 240),
      });
      return;
    }
    if ((result.status === "rejected" && !result.retryable) || attempts >= 8) {
      await ctx.runMutation(internal.xHoudini.finishFinalPublication, {
        quoteId: args.quoteId,
        leaseId,
        status: "failed",
        safeError: (result.error || "final X publication failed").slice(0, 240),
      });
      return;
    }
    const delay = Math.max(
      60_000,
      Math.min(
        600_000,
        result.waitMs || 60_000 * 2 ** Math.max(0, attempts - 1),
      ),
    );
    if (
      await ctx.runMutation(internal.xHoudini.finishFinalPublication, {
        quoteId: args.quoteId,
        leaseId,
        status: "retry",
        delayMs: delay,
        safeError: result.error?.slice(0, 240),
      })
    )
      await ctx.scheduler.runAfter(
        delay,
        internal.xHoudini.publishFinalOutcome,
        { quoteId: args.quoteId },
      );
  },
});
export const listRecoverable = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now(),
      [creating, funding, polling, publications] = await Promise.all([
        ctx.db
          .query("xHoudiniQuotes")
          .withIndex("by_stage_updated", (q) =>
            q
              .eq("executionStage", "creating_order")
              .lte("updatedAt", now - 60_000),
          )
          .take(50),
        ctx.db
          .query("xHoudiniQuotes")
          .withIndex("by_stage_updated", (q) =>
            q.eq("executionStage", "funding"),
          )
          .take(100),
        ctx.db
          .query("xHoudiniQuotes")
          .withIndex("by_stage_next_check", (q) =>
            q.eq("executionStage", "monitoring").lte("nextStatusCheckAt", now),
          )
          .take(200),
        ctx.db
          .query("xHoudiniQuotes")
          .withIndex("by_final_publication_due", (q) =>
            q
              .eq("finalPublicationStatus", "pending")
              .lte("nextPublicationAttemptAt", now),
          )
          .take(100),
      ]);
    return {
      creating,
      funding: funding.filter(
        (row) =>
          (row.nextFundingAttemptAt || 0) <= now &&
          (row.fundingLeaseUntil || 0) <= now,
      ),
      polling: polling.filter((row) => (row.statusPollLeaseUntil || 0) <= now),
      publications: publications.filter(
        (row) => (row.finalPublicationLeaseUntil || 0) <= now,
      ),
    };
  },
});
export const reconcileInterrupted = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.runQuery(internal.xHoudini.listRecoverable, {});
    for (const row of rows.creating)
      if (
        row.confirmationPostId &&
        row.status === "executing" &&
        !row.houdiniId
      )
        await final(
          ctx,
          row._id,
          "uncertain",
          "❌ The exchange submission could not be confirmed. No automatic retry or wallet transfer was made.",
          false,
          "interrupted while creating Houdini order",
        );
    for (const row of rows.funding)
      if (row.confirmationPostId) {
        const wallet = await ctx.runAction(internal.wallets.ensureWallet, {
          xUserId: row.ownerXUserId,
        });
        if (wallet?.address)
          await ctx.scheduler.runAfter(0, internal.xHoudini.executeConfirmed, {
            quoteId: row._id,
            confirmationPostId: row.confirmationPostId,
            walletAddress: wallet.address,
            ownerXUserId: row.ownerXUserId,
          });
      }
    for (const row of rows.polling)
      if (row.confirmationPostId)
        await ctx.scheduler.runAfter(0, internal.xHoudini.pollOrder, {
          quoteId: row._id,
          confirmationPostId: row.confirmationPostId,
        });
    for (const row of rows.publications)
      await ctx.scheduler.runAfter(0, internal.xHoudini.publishFinalOutcome, {
        quoteId: row._id,
      });
  },
});
