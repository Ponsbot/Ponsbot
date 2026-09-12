import { botNameKey } from "./status";

export type BotFundingRequest = {
  ok: true; botNameKey: string; amount: string; unit: "usd" | "eth" | "token" | "percent"; asset: string;
} | { ok: false; message: string };
const invalid = (): BotFundingRequest => ({ ok: false, message: 'Use "Send 0.01 ETH to bot BOTNAME" or "Send $20 of ETH to the bot BOTNAME".' });

/** Explicit command prefix only. This is not registered in the live wallet parser. */
export function parseBotFundingPost(text: string): BotFundingRequest | null {
  const command = text.trim().replace(/^@ponsbotfamily\s+/iu, "");
  if (!/^send\s/iu.test(command) || !/\s+to\s+(?:the\s+)?bot\b/iu.test(command)) return null;
  const match = /^send\s+(.+?)\s+to\s+(?:the\s+)?bot\s+(.+?)\s*[.!?]*$/iu.exec(command);
  if (!match) return invalid();
  let nameKey: string;
  try { nameKey = botNameKey(match[2].replace(/^["“]|["”]$/gu, "")); } catch { return invalid(); }
  // No exponent notation, negative values, malformed separators or multiple instructions.
  const size = /^(\$)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:\s*(USD|dollars?|%))?(?:\s+(?:of\s+)?(\$?[\p{L}\p{M}\p{N}_-]+|0x[0-9a-fA-F]{40}))?$/iu.exec(match[1]);
  const all = /^all\s+(?:of\s+)?(?:my\s+)?(\$?[\p{L}\p{M}\p{N}_-]+)$/iu.exec(match[1]);
  if (!size && !all) return invalid();
  const raw = size?.[2]?.replaceAll(",", "") ?? "100";
  if (raw.length > 78 || !/[1-9]/.test(raw)) return invalid();
  const amount = raw.startsWith(".") ? `0${raw}` : raw;
  const usd = Boolean(size?.[1] || (size?.[3] && size[3] !== "%"));
  const percent = Boolean(all || size?.[3] === "%");
  if (usd && percent || percent && Number(amount) > 100) return invalid();
  const reference = (size?.[4] ?? all?.[1] ?? (usd ? "ETH" : "")).replace(/^\$/, "");
  if (!reference || reference.length > 80 || /^0x/iu.test(reference) && !/^0x[0-9a-fA-F]{40}$/u.test(reference)) return invalid();
  const asset = /^0x/i.test(reference) ? reference.toLowerCase() : reference.toUpperCase();
  return { ok: true, botNameKey: nameKey, amount, asset, unit: percent ? "percent" : usd ? "usd" : asset === "ETH" ? "eth" : "token" };
}
