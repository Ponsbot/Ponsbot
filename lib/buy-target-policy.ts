import { isAddressLiteral } from "./address-normalization";

export const NON_INDEXED_BUY_TARGET_MESSAGE = "⚠️ This is not a Pons Bot token. Reply with a CA to buy this token.";

/** Accept a contract-only clarification while allowing the labels users
 * naturally put before an address. No other command text is admitted. */
export function buyTargetContractReply(text: string) {
  const direct = text.replace(/@ponsbotfamily\b/gi, " ").trim();
  return direct.match(/^(?:(?:ca|contract(?:\s+address)?|address)\s*(?:is|=|:)?\s*)?(0x[a-fA-F0-9]{40})[.!?]*$/i)?.[1];
}

/** Reject unresolved/native purchase targets before balance, pair or funding calls. */
export function assertBuyTarget(token: string | undefined): asserts token is string {
  if (/^(?:\$?eth|ethereum|0x0{40})$/i.test(token?.trim() || "")) {
    throw new Error("BUY_TARGET_NATIVE_ETH");
  }
  if (!token || !isAddressLiteral(token)) throw new Error("BUY_TARGET_UNRESOLVED");
}
