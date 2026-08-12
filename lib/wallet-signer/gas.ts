const GAS_LIMIT_BUFFER_PERCENT = 120n;
const MAX_FEE_MULTIPLIER = 2n;
const SEND_ALL_RESERVE_BUFFER_PERCENT = 105n;

export function transactionGasEnvelope(estimatedGas: bigint, estimatedMaxFeePerGas: bigint) {
  return {
    gas: estimatedGas * GAS_LIMIT_BUFFER_PERCENT / 100n,
    maxFeePerGas: estimatedMaxFeePerGas * MAX_FEE_MULTIPLIER,
  };
}

export function sendAllGasReserve(estimatedGas: bigint, estimatedMaxFeePerGas: bigint) {
  const envelope = transactionGasEnvelope(estimatedGas, estimatedMaxFeePerGas);
  return envelope.gas * envelope.maxFeePerGas * SEND_ALL_RESERVE_BUFFER_PERCENT / 100n;
}
