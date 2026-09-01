import { parseAbi, type Address, type PublicClient } from "viem";

const abi = parseAbi([
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function buybackQuoteBalance() view returns (uint256)",
]);

/** Only skip a provably empty curve sweep, never the subsequent escrow claim.
 * Use the curve's fee buckets, not its liquidity/native balance or escrow.
 * Unsupported getters or unavailable RPC data retain the normal simulation.
 * All buckets are observed at one block; these mutable values are not cached.
 */
export async function curveSweepIsEmpty(client: PublicClient, curve: Address, blockNumber?: bigint) {
  try {
    const block = blockNumber ?? await client.getBlockNumber({ cacheTime: 0 });
    const balances = await Promise.all(([
      "quoteFeeBalance", "creatorTaxBalance", "buybackQuoteBalance",
    ] as const).map(functionName => client.readContract({ address: curve, abi, functionName, blockNumber: block })));
    return balances.every(value => value === 0n);
  } catch {
    return false;
  }
}
