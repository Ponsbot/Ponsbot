/** Independent opt-in runtime gates. No mode is enabled by default. */
export function tradingAgentCapabilities(env: Record<string, string | undefined> = process.env) {
  const enabled = env.TRADING_AGENTS_ENABLED === "true";
  return {
    enabled,
    paperTrading: enabled && env.TRADING_AGENTS_PAPER_ENABLED === "true",
    liveTrading: enabled && env.TRADING_AGENTS_LIVE_ENABLED === "true",
    publicCommands: enabled && env.TRADING_AGENTS_X_ENABLED === "true",
    walletProvisioning: enabled && env.TRADING_AGENTS_WALLETS_ENABLED === "true",
    website: enabled && env.TRADING_AGENTS_WEBSITE_ENABLED === "true",
    scheduler: enabled && env.TRADING_AGENTS_SCHEDULER_ENABLED === "true",
  };
}

export const TRADING_AGENT_CHAIN_ID = 4663;
export const BOT_BUY_RESERVE_BPS = 2000;
/** Local preview only; this does not open navigation or enable production access. */
export function botYardPreviewAllowed(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV === "development" && env.BOT_YARD_PREVIEW_ENABLED === "true";
}
