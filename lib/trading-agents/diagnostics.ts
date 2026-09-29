// Persist only known codes, never provider messages, URLs, credentials or model output.
const safeCodes = new Set([
  "LIVE_PAYLOAD_INVALID", "LIVE_REQUEST_TIMEOUT", "LIVE_UNCLASSIFIED_FAILURE",
  "LIVE_CHECK_FAILED", "LIVE_MARKETS_UNAVAILABLE", "LIVE_HOLDINGS_INCOMPLETE",
  "LIVE_BALANCE_REFRESH_FAILED", "LIVE_BALANCES_UNAVAILABLE", "SIGNER_NOT_CONFIGURED",
  "MODEL_LIMIT", "INSUFFICIENT_GAS_RESERVE", "LIVE_DAILY_LIMIT", "LIVE_BUY_LIMIT",
  "POSITION_LIMIT", "INSUFFICIENT_TOKEN_BALANCE", "CLOCK_ROLLBACK", "NOT_PLATFORM_TOKEN",
  "SECONDARY_TRADE_QUOTA", "WALLET_BUSY", "WALLET_NOT_READY",
]);
export function agentFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (safeCodes.has(message)) return message;
  if (error instanceof Error && error.name === "ZodError") return "LIVE_PAYLOAD_INVALID";
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) return "LIVE_REQUEST_TIMEOUT";
  return "LIVE_UNCLASSIFIED_FAILURE";
}
