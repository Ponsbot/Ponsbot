/** Percentage is of the creator allocation AFTER the existing 5% PONSBOT split.
 * Only populate this public state from a verified, active creator-burn layer.
 */
export type CreatorSelfBurnDisplay = { active: boolean; percentageBps: number };

export function creatorFeeBurnDisplay(symbol: string, policy?: CreatorSelfBurnDisplay, holderFeeSharing = false) {
  const bps = policy?.percentageBps;
  if (holderFeeSharing || !policy?.active || bps === undefined || !Number.isInteger(bps) || bps <= 0 || bps > 10_000) {
    return { fullAllocation: null, suffix: null };
  }
  const ticker = `$${symbol.replace(/^\$+/, "")}`;
  return bps === 10_000
    ? { fullAllocation: `Buyback and burn ${ticker}`, suffix: null }
    : { fullAllocation: null, suffix: `(${bps / 100}% buyback and burn ${ticker})` };
}
