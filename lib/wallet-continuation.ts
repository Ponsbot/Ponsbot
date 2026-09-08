import type { WalletCommand } from "../convex/walletCommands";
import { isGasResumePrompt } from "./x-temporary-reply-policy";
import { NON_INDEXED_BUY_TARGET_MESSAGE } from "./buy-target-policy";

export type TokenField = "token" | "fromToken" | "toToken" | "pairAsset";
export function walletContinuation(message: string, command: WalletCommand) {
  if (isGasResumePrompt(message)) return { kind: "gas" as const };
  const mismatch = message.match(/^⚠️ That contract address's onchain ticker does not match \$(.+?)\. Double-check/u)?.[1];
  if (!mismatch && message !== NON_INDEXED_BUY_TARGET_MESSAGE
    && !/^⚠️ More than one (?:indexed token|token in your wallet) uses that ticker\./.test(message)) return null;
  const fields: TokenField[] = ["token", "fromToken", "toToken", "pairAsset"];
  const candidates = fields.filter(field => field in command && typeof (command as unknown as Record<string, unknown>)[field] === "string");
  const normalized = (value: string) => value.replace(/^\$/, "").toUpperCase();
  const field = mismatch ? candidates.find(field => normalized(String((command as unknown as Record<string, unknown>)[field]).split(/\s+/)[0]) === normalized(mismatch)) : candidates[0];
  if (!field) return null;
  const value = String((command as unknown as Record<string, unknown>)[field]);
  const ticker = mismatch || value.replace(/^\$/, "");
  if (/^0x[\da-f]{40}$/i.test(ticker)) return null;
  return { kind: "contract" as const, field, ticker };
}
