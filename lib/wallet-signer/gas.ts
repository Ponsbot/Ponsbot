const TOTAL_COST_PERCENT = 110n;
// Split a SINGLE cost budget between gas units and gas price. 4% gas-unit
// headroom leaves approximately 5.77% fee-price headroom (1.10 / 1.04).
// Applying 10% independently to both would silently become 21%.
const GAS_UNITS_PERCENT = 104n;

type ActualFeeClient = {
  getBlock: () => Promise<{ baseFeePerGas?: bigint | null }>;
  estimateMaxPriorityFeePerGas: () => Promise<bigint>;
};

/** Current base fee + suggested priority fee, with NO implicit viem 1.2x. */
export async function estimateActualFees(client: ActualFeeClient) {
  const [block, priorityFee] = await Promise.all([
    client.getBlock(),
    client.estimateMaxPriorityFeePerGas(),
  ]);
  if (typeof block.baseFeePerGas !== "bigint" || block.baseFeePerGas < 0n || priorityFee < 0n) {
    throw new Error("current EIP-1559 fees are unavailable");
  }
  return {
    maxFeePerGas: block.baseFeePerGas + priorityFee,
    maxPriorityFeePerGas: priorityFee,
  };
}

/** EIP-1559 envelope for delayed automated jobs. A two-block base-fee cushion
 * prevents a valid keeper transaction becoming unbroadcastable between CDP
 * signing and the following RPC submission. The chain still charges only the
 * actual base fee plus priority fee. */
export async function estimateResilientAutomationFees(client: ActualFeeClient) {
  const [block, priorityFee] = await Promise.all([
    client.getBlock(),
    client.estimateMaxPriorityFeePerGas(),
  ]);
  if (typeof block.baseFeePerGas !== "bigint" || block.baseFeePerGas < 0n || priorityFee < 0n) {
    throw new Error("current EIP-1559 fees are unavailable");
  }
  return {
    maxFeePerGas: block.baseFeePerGas * 2n + priorityFee,
    maxPriorityFeePerGas: priorityFee,
  };
}

/** One rounded-up 10% margin. Input must be an UNBUFFERED actual-cost estimate. */
export function bufferedActualCost(estimatedCost: bigint) {
  if (estimatedCost < 0n) throw new Error("estimated cost must not be negative");
  return (estimatedCost * TOTAL_COST_PERCENT + 99n) / 100n;
}

function estimatedGasCost(estimatedGas: bigint, actualFeePerGas: bigint) {
  if (estimatedGas <= 0n || actualFeePerGas < 0n) throw new Error("invalid gas estimate");
  return estimatedGas * actualFeePerGas;
}

export function transactionGasEnvelope(estimatedGas: bigint, actualFeePerGas: bigint) {
  const budget = bufferedActualCost(estimatedGasCost(estimatedGas, actualFeePerGas));
  const gas = estimatedGas * GAS_UNITS_PERCENT / 100n;
  return {
    gas,
    // Floor to keep the signed maximum liability inside the single budget.
    // Integer rounding can leave a few Wei unused, never add another margin.
    maxFeePerGas: budget / gas,
  };
}

export function transactionMaximumCost(value: bigint, estimatedGas: bigint, actualFeePerGas: bigint) {
  if (value < 0n) throw new Error("transaction value must not be negative");
  // Transfer/purchase principal is not a network fee and is never inflated.
  return value + bufferedActualCost(estimatedGasCost(estimatedGas, actualFeePerGas));
}

export function sendAllGasReserve(estimatedGas: bigint, actualFeePerGas: bigint) {
  return transactionMaximumCost(0n, estimatedGas, actualFeePerGas);
}

/** Pons launch fee is a cost, unlike a user's developer buy or transfer. */
export function sponsoredLaunchCost(launchFee: bigint, estimatedGas: bigint, actualFeePerGas: bigint) {
  if (launchFee < 0n) throw new Error("launch fee must not be negative");
  return bufferedActualCost(launchFee + estimatedGasCost(estimatedGas, actualFeePerGas));
}

export function spendableEthAfterGas(
  balance: bigint,
  reservedGasUnits: bigint,
  actualFeePerGas: bigint,
  requestedValue?: bigint,
) {
  const reserve = sendAllGasReserve(reservedGasUnits, actualFeePerGas);
  if (balance <= reserve) throw new Error("insufficient ETH for gas");
  const maximum = balance - reserve;
  const value = requestedValue === undefined || requestedValue > maximum
    ? maximum
    : requestedValue;
  if (value <= 0n) throw new Error("ETH amount resolves to zero after reserving gas");
  return { value, reserve };
}
