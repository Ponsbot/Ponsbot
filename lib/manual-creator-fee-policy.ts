export const MANUAL_CREATOR_FEE_MINIMUM_USD = 1;
export function manualCreatorFeesEligible(valueUsd: number | undefined) {
  return valueUsd !== undefined && Number.isFinite(valueUsd) && valueUsd >= MANUAL_CREATOR_FEE_MINIMUM_USD;
}
