/** Native ETH is a funding currency, not an ERC-20 sell/burn target. */
export function nativeTokenOperationError(kind: string, token?: string): string | undefined {
  if (!token || !/^(?:\$?eth|ethereum|0x0{40})$/i.test(token.trim())) return undefined;
  if (kind === "sell" || kind === "uniswap_v3_sell") return "SELL_TARGET_NATIVE_ETH";
  if (kind === "burn" || kind === "erc20_burn_to_dead") return "BURN_TARGET_NATIVE_ETH";
  return undefined;
}
