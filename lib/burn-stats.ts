export const PONSBOT_BURN_TOKEN = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07";
export const PONSBOT_BURN_ADDRESS = "0x000000000000000000000000000000000000dead";
export const PONSBOT_DECIMALS = 18;

/** Keep base-unit totals as strings/BigInt until formatting, never floating point. */
export function formatPonsbotBurned(raw?: string | null): string {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return "—";
  const base = 10n ** BigInt(PONSBOT_DECIMALS);
  const amount = BigInt(raw);
  if (amount > 0n && amount < base) return "<1";
  // Display whole tokens without rounding up or changing the underlying totals.
  return (amount / base).toLocaleString("en-US");
}

export function hasPublicFeeBuyback(program: {
  status: string; buybackBps: number; distributionMode: string;
  privateTest?: boolean; flywheelExemptionReason?: string;
} | null, holderFeeSharing?: boolean): boolean {
  return !!program && program.status === "enrolled" && !program.privateTest
    && program.buybackBps === 500 && program.distributionMode === "wallet"
    && !program.flywheelExemptionReason && !holderFeeSharing;
}
