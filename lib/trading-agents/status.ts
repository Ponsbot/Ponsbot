import { formatUnits } from "viem";

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
export type BotStatusAsset = { token: string; amount: string; symbol?: string; decimals?: number };
function amount(asset: BotStatusAsset) {
  const label = asset.symbol ? safeText(asset.symbol).slice(0, 40) : `${asset.token.slice(0, 6)}...${asset.token.slice(-4)}`;
  if (asset.decimals === undefined || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255) return `${asset.amount} base units of ${label}`;
  return `${formatUnits(BigInt(asset.amount), asset.decimals)} ${label}`;
}
export function formatBotStatus(input: {
  name: string; cashWei: string; holdings: BotStatusAsset[]; updatedAt: number;
  mode?: "paper" | "live"; holdingsAvailable?: boolean;
  thought?: { text: string; at: number };
  trade?: { side: "buy" | "sell"; asset: BotStatusAsset; reason: string; at: number };
}) {
  const time = (at: number) => new Date(at).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  return [
    `🤖 ${safeText(input.name)} — ${input.mode === "live" ? "live trading" : "paper trading"}`,
    `💭 Last thought: ${input.thought ? `${safeText(input.thought.text)} (${time(input.thought.at)})` : "No thoughts yet."}`,
    `🔄 Last trade: ${input.trade ? `${input.mode === "live" ? "" : "Paper "}${input.trade.side === "buy" ? "bought" : "sold"} ${amount(input.trade.asset)} (${time(input.trade.at)}). ${safeText(input.trade.reason)}` : "No completed trades yet."}`,
    input.holdingsAvailable === false ? "💰 Wallet balances have not been verified yet." : `💰 Current ${input.mode === "live" ? "wallet" : "paper"} holdings (saved ${time(input.updatedAt)}):\n${formatUnits(BigInt(input.cashWei), 18)} ETH${input.holdings.length ? `\n${input.holdings.map(amount).join("\n")}` : "\nNo tokens held."}`,
  ].join("\n\n");
}
