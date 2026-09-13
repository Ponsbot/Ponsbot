import { botAmount, botDollars } from "./display";

/** One global identity namespace, independent of owner and display capitalization. */
export function botNameKey(name: string) {
  const key = name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  if (!key || key.length > 80 || !/^[\p{L}\p{M}\p{N} _-]+$/u.test(key) || !/[\p{L}\p{N}]/u.test(key)) throw new Error("INVALID_BOT_NAME");
  return key;
}
export function parseCheckBotPost(text: string): string | null {
  const match = /^\s*@ponsbotfamily\s+check\s+on\s+(.+?)\s*[.!?]*\s*$/iu.exec(text);
  if (!match) return null;
  const name = match[1].replace(/^["“]|["”]$/gu, "").trim();
  try { return botNameKey(name); } catch { return null; }
}
const safeText = (text: string) => text.replace(/[@$#]/gu, "").replace(/[\r\n\t]+/gu, " ").trim();
export type BotStatusAsset = { token: string; amount: string; symbol?: string; decimals?: number; usdValue?: number };
function amount(asset: BotStatusAsset) {
  const label = asset.symbol ? safeText(asset.symbol).slice(0, 40) : `${asset.token.slice(0, 6)}...${asset.token.slice(-4)}`;
  if (asset.decimals === undefined || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255) return `${asset.amount} base units of ${label}`;
  return `${botAmount(asset.amount, asset.decimals)} ${label}${botDollars(asset.usdValue)}`;
}
export function formatBotStatus(input: {
  name: string; cashWei: string; holdings: BotStatusAsset[]; updatedAt: number;
  mode?: "paper" | "live"; holdingsAvailable?: boolean;
  cashUsd?: number; dayPnlUsd?: number | null;
  thought?: { text: string; at: number };
  trade?: { side: "buy" | "sell"; asset: BotStatusAsset; reason: string; at: number };
}) {
  return [
    `🤖 ${safeText(input.name)} — ${input.mode === "live" ? "live trading" : "paper trading"}`,
    `💭 Last thought: ${input.thought ? safeText(input.thought.text) : "No thoughts yet."}`,
    `🔄 Last trade: ${input.trade ? `${input.mode === "live" ? "" : "Paper "}${input.trade.side === "buy" ? "bought" : "sold"} ${amount(input.trade.asset)}. ${safeText(input.trade.reason)}` : "No completed trades yet."}`,
    input.holdingsAvailable === false ? "💰 I couldn't retrieve the wallet balances right now. Please check again shortly." : `💰 ${input.mode === "live" ? "Wallet" : "Paper"} holdings:\n${botAmount(input.cashWei)} ETH${botDollars(input.cashUsd)}${input.holdings.length ? `\n${input.holdings.map(amount).join("\n")}` : "\nNo tokens held."}`,
    `24h P&L: ${typeof input.dayPnlUsd === "number" && Number.isFinite(input.dayPnlUsd) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", signDisplay: "exceptZero", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(input.dayPnlUsd) : "Unavailable"}`,
  ].join("\n\n");
}
