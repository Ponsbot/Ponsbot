import { isPonsbotHalfTotal } from "./creator-burn-percentage";

export function creatorBurnSweepAcceptedMessage(symbol: string, configuration: {status:string;bps:number;executionBps:number;tokenAddress?:string}) {
  if (configuration.status !== "pending") return null;
  return creatorBurnConfiguredMessage(symbol, configuration.bps, configuration.tokenAddress, configuration.executionBps);
}


export function creatorBurnConfiguredMessage(symbol: string, bps: number, tokenAddress?: string, executionBps = bps) {
  if (isPonsbotHalfTotal(tokenAddress, executionBps)) return "✅ 50% of total creator fees from $PONSBOT buy back and burn $PONSBOT starting with the next Pons fee sweep.";
  return (bps === 0
    ? `✅ Creator self-buyback and burn is off for $${symbol} starting with the next Pons fee sweep. Your creator-fee share goes to the assigned wallet.`
    : `✅ ${bps / 100}% of your creator-fee share from $${symbol} buys back and burns $${symbol} starting with the next Pons fee sweep.`);
}

export function creatorBurnLaunchReply(configuration: { status: string; bps: number } | null, ageMs: number) {
  if (!configuration && ageMs < 30 * 60_000) return null;
  if (configuration?.status === "pending" || configuration?.status === "confirmed") return configuration.bps === 0
    ? "Creator self-buyback and burn is off starting with the next Pons fee sweep."
    : `${configuration.bps / 100}% of your creator-fee share buys back and burns this token starting with the next Pons fee sweep.`;
  return "⚠️ The token launched, but its requested creator-fee configuration is not confirmed. Do not launch it again.";
}
