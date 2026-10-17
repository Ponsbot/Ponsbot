import type { WalletCommand } from "../convex/walletCommands";

const NUMBER = String.raw`(?:\d[\d,]*(?:\.\d+)?|\.\d+)`;
function decimal(value: string) {
  const [whole, fraction = ""] = value.replaceAll(",", "").split(".");
  return `${whole.replace(/^0+/, "") || "0"}.${fraction.replace(/0+$/, "")}`;
}

/** A cashtag is not a currency marker. Models cannot invent USD denomination. */
export function hasDirectUsdAmount(text: string, amount: string) {
  const operative = text.replace(/https?:\/\/\S+/gi, " ");
  return [...operative.matchAll(new RegExp(`\\$(${NUMBER})(?![\\p{L}\\p{N}_]|\\.\\d)`, "gu"))]
    .some(match => decimal(match[1]) === decimal(amount));
}

function hasTokenQuantity(text: string, amount: string, token: string) {
  const asset = token.replace(/^\$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = String.raw`(?![\p{L}\p{N}_])`;
  const after = new RegExp(`(?<![$\\d.,])(${NUMBER})\\s+(?:of\\s+)?\\$?${asset}${boundary}`, "giu");
  const before = new RegExp(`(?:^|[^\\p{L}\\p{N}_])\\$?${asset}\\s+(${NUMBER})(?![\\d.])`, "giu");
  return [...text.matchAll(after), ...text.matchAll(before)].some(match => decimal(match[1]) === decimal(amount));
}

export function walletAmountUnitsMatchText(text: string, command: WalletCommand) {
  if (command.kind === "launch") return command.devBuy?.unit !== "usd" || hasDirectUsdAmount(text, command.devBuy.amount);
  if (!("amount" in command) || !("unit" in command)) return true;
  const usd = hasDirectUsdAmount(text, command.amount);
  const quantity = "token" in command && typeof command.token === "string"
    && hasTokenQuantity(text, command.amount, command.token);
  if (quantity && "token" in command && /^(?:ETH|WETH)$/i.test(command.token ?? "") && command.unit === "eth") return !usd;
  if (quantity && ["send", "sell", "burn", "buy", "buy_and_send", "buy_and_burn"].includes(command.kind))
    return command.unit === "token" || command.unit === "pair";
  if (command.unit === "usd") return usd;
  return !usd || command.unit === "percent";
}

export const EXPLICIT_USD_MESSAGE = "Use $ directly before a number for a dollar amount, for example $666. Write 666 $TOKEN for 666 tokens.";
