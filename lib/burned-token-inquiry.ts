import { tokenPattern } from "./token-pattern";
import { directPostCommandText } from "./x-direct-post-policy";
export function burnedTokenMessage(token: string, result: { raw: string; decimals: number; symbol?: string; totalSupplyRaw: string; usdValue?: number }) {
  const raw = BigInt(result.raw);
  const supply = BigInt(result.totalSupplyRaw);
  const unit = 10n ** BigInt(result.decimals);
  const amount = ((raw + unit / 2n) / unit).toLocaleString("en-US");
  const tenths = supply > 0n ? (raw * 1000n + supply / 2n) / supply : undefined;
  const percent = tenths === undefined ? "N/A" : `${tenths / 10n}.${tenths % 10n}%`;
  const value = result.usdValue !== undefined && Number.isFinite(result.usdValue)
    ? `$${result.usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} at current MCap`
    : "USD value unavailable";
  return `🔥 $${result.symbol || "TOKEN"} (${token.slice(0, 6)}...${token.slice(-4)})\nBurned: ${amount} ${result.symbol || "TOKEN"} (${percent}) (${value})`;
}
export const BURNED_TOKEN_CA_MESSAGE = "⚠️ I couldn't identify that token in the index or your wallet. Reply with its contract address to check how much has been burned.";
export function parseBurnedTokenInquiry(text: string) {
  const clean = directPostCommandText(text).replace(/@ponsbotfamily\b/gi, " ").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim()
    .replace(/^(?:hey|hi|hello)[,!\s]+/i, "")
    .replace(/^(?:(?:please|(?:can|could|would) you|I'd like to know|I want to know)\s+)+/i, "")
    .replace(/^(?:tell|show) me\s+(?=how\b|what\b)/i, "")
    .replace(/[?!.]+$/, "").replace(/[,\s]+(?:please|thanks|thank you)$/i, "").trim()
    .replace(/\s+(?:so far|in total|altogether|to date|right now)$/i, "");
  const patterns = [
    /^how\s+(?:much|many)\s+(.+?)\s+(?:(?:has|have)\s+(?:been\s+)?|(?:is|are)\s+)?burn(?:ed|t)$/i,
    /^how\s+(?:much|many)\s+(?:of\s+)?(.+?)\s+(?:is|are)\s+(?:in|at)\s+(?:the\s+)?(?:dead|burn)\s+(?:address|wallet)$/i,
    /^(?:what(?:'s| is)|show(?: me)?|check|tell me)\s+(?:the\s+)?(?:total\s+)?(?:amount|number)\s+of\s+(.+?)\s+burn(?:ed|t)$/i,
    /^(?:what(?:'s| is)|show(?: me)?|check|tell me)\s+(?:the\s+)?(?:total\s+)?(?:burn(?:ed|t)?\s+(?:total|amount|balance|supply)|burns)\s+(?:of|for)\s+(.+)$/i,
    /^(?:what(?:'s| is)|show(?: me)?|check|tell me)\s+(?:the\s+)?(.+?)\s+(?:total\s+)?(?:burn(?:ed|t)?\s+(?:total|amount|balance|supply)|burns)$/i,
    /^(.+?)\s+(?:total\s+)?(?:burn(?:ed|t)?\s+(?:total|amount|balance|supply)|burns)$/i,
    /^(?:total\s+)?burn(?:ed|t)\s+(?:amount|supply|balance)\s+(?:of|for)\s+(.+)$/i,
  ];
  const match = patterns.map(pattern => pattern.exec(clean)).find(Boolean);
  if (!match) return null;
  const target = match[1].replace(/^of\s+/i, "").replace(/\s+(?:tokens|coins)$/i, "")
    .replace(/\b(?:ca|contract(?:\s+address)?|address)\s*[:=]?\s*(?=0x[a-fA-F0-9]{40}\b)/gi, " ").trim();
  const addresses = [...target.matchAll(/\b0x[a-fA-F0-9]{40}\b/g)];
  const tickers = [...target.replace(/\b0x[a-fA-F0-9]{40}\b/g, " ").matchAll(tokenPattern(/\$?([A-Za-z][A-Za-z0-9]{0,31})\b/g))];
  const residue = target.replace(/\b0x[a-fA-F0-9]{40}\b/g, " ")
    .replace(tokenPattern(/\$?[A-Za-z][A-Za-z0-9]{0,31}\b/g), " ");
  if (!/^[\s,():=-]*$/.test(residue)) return null;
  if (addresses.length > 1 || tickers.length > 1 || (!addresses.length && !tickers.length)) return null;
  return { kind: "show_burned" as const, token: addresses[0]?.[0] || tickers[0][1], ...(addresses.length && tickers.length ? { expectedTicker: tickers[0][1] } : {}) };
}
