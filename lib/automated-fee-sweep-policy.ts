// The contract requires a prior sweep only while the launch is on its curve.
// Graduated hooks can require Pons's operator for internal conversions; fees
// already credited to escrow remain independently claimable by the vault.
export type FeeSweepRun = {
  transactionHash?: string;
  sweepTransactionHash?: string;
  sweepSignedTransaction?: string;
  sweepBroadcastAt?: number;
  sweepBlockNumber?: string;
  processingTransactionHash?: string;
  processingSignedTransaction?: string;
  deliveryTransactionHash?: string;
  deliverySignedTransaction?: string;
  graduatedEscrowReadyBlock?: string;
};

export function feeRunHasTransaction(run: FeeSweepRun) {
  return Boolean(run.transactionHash || run.sweepTransactionHash || run.sweepSignedTransaction
    || run.sweepBroadcastAt || run.sweepBlockNumber || run.processingTransactionHash
    || run.processingSignedTransaction || run.deliveryTransactionHash || run.deliverySignedTransaction);
}

export function canUseGraduatedEscrow(phase: number, escrowBalance: string, run: FeeSweepRun) {
  return phase === 2 && /^\d+$/.test(escrowBalance) && BigInt(escrowBalance) >= 10_000n
    && !feeRunHasTransaction(run);
}

export function feeSweepPrerequisiteSatisfied(run: FeeSweepRun) {
  return Boolean(run.sweepBlockNumber || (run.graduatedEscrowReadyBlock
    && !run.sweepTransactionHash && !run.sweepSignedTransaction));
}

export function isGraduatedSweepPreflightFailure(phase: number, detail: string, run: FeeSweepRun) {
  // Never downgrade a broadcast failure, an actual reverted transaction,
  // an authorization failure, or an unrelated invalid request to a retry.
  return phase === 2 && !feeRunHasTransaction(run)
    && detail.includes("[/v1/automated-fees/prepare-sweep]")
    && /SIMULATION_OR_REVERT|InternalSwapRequiresOperator|0x31cdb504/i.test(detail);
}
