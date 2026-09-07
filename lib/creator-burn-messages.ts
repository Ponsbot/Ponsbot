import { isPonsbotHalfTotal } from "./creator-burn-percentage";

export function creatorBurnConfiguredMessage(symbol: string, bps: number, tokenAddress?: string, executionBps = bps) {
  if (isPonsbotHalfTotal(tokenAddress, executionBps)) return "✅ 50% of total creator fees from $PONSBOT now buys back and burns $PONSBOT.";
  return (bps === 0
    ? `✅ Creator self-buyback and burn is off for $${symbol}. Your creator-fee share goes to the assigned wallet.`
    : `✅ ${bps / 100}% of your creator-fee share from $${symbol} now buys back and burns $${symbol}.`);
}

export function creatorBurnLaunchReply(configuration: { status: string; bps: number } | null, ageMs: number) {
  if ((!configuration || configuration.status === "pending") && ageMs < 30 * 60_000) return null;
  if (configuration?.status === "confirmed") return configuration.bps === 0
    ? "Creator self-buyback and burn is off."
    : `${configuration.bps / 100}% of your creator-fee share now buys back and burns this token.`;
  return "⚠️ The token launched, but its requested creator-fee configuration is not confirmed. Do not launch it again.";
}
