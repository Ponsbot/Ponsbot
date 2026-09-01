import { isAddressLiteral } from "./address-normalization";

/** Reject unresolved/native purchase targets before balance, pair or funding calls. */
export function assertBuyTarget(token: string | undefined): asserts token is string {
  if (/^(?:\$?eth|ethereum|0x0{40})$/i.test(token?.trim() || "")) {
    throw new Error("BUY_TARGET_NATIVE_ETH");
  }
  if (!token || !isAddressLiteral(token)) throw new Error("BUY_TARGET_UNRESOLVED");
}
