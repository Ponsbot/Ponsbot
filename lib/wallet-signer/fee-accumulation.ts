import { encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, zeroAddress, type Address, type PublicClient } from "viem";
import { netCreatorFees, FEE_ACCUMULATION_THRESHOLD_WEI } from "../automated-fee-scheduling";

const curveAbi = parseAbi([
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function buybackQuoteBalance() view returns (uint256)",
  "function protocolFeeShareBps() view returns (uint16)",
]);
const hookAbi = parseAbi([
  "function pendingFees(bytes32,address) view returns (uint256)",
  "function pendingCreatorTax(bytes32,address) view returns (uint256)",
  "function pendingBuyback(bytes32,address) view returns (uint256)",
]);
const factoryAbi = parseAbi([
  "function memeHook() view returns (address)",
  "function getLaunchFeePolicy(address) view returns ((address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps))",
]);

/** Read-only, block-pinned eligibility. Never infer fees from contract balances.
 * Source: verified PonsV2BondingCurve._sweepFees / PonsV2MemeHook._distribute.
 * Inventory requiring Pons's trusted operator is excluded until credited to escrow.
 */
export async function inspectFeeAccumulation(input: {
  client: PublicClient; blockNumber: bigint; factory: Address; escrow: bigint;
  launch: { token: Address; curve: Address; pairToken: Address; phase: number; poolFee: number; tickSpacing: number };
  quoteNative: (amount: bigint) => Promise<bigint>;
}) {
  const { client, blockNumber, factory, launch } = input;
  let unswept = 0n, operatorRequired = false;
  if (launch.phase === 0) {
    const read = (functionName: "quoteFeeBalance" | "creatorTaxBalance" | "buybackQuoteBalance" | "protocolFeeShareBps") =>
      client.readContract({ address: launch.curve, abi: curveAbi, functionName, blockNumber });
    const [fees, tax, buyback, protocol] = await Promise.all([
      read("quoteFeeBalance"), read("creatorTaxBalance"), read("buybackQuoteBalance"), read("protocolFeeShareBps"),
    ]);
    operatorRequired = BigInt(buyback) > 0n;
    if (!operatorRequired) unswept = netCreatorFees(BigInt(fees), BigInt(tax), BigInt(buyback), BigInt(protocol));
  } else if (launch.phase === 2) {
    const hook = await client.readContract({ address: factory, abi: factoryAbi, functionName: "memeHook", blockNumber });
    const [currency0, currency1] = BigInt(launch.token) < BigInt(launch.pairToken)
      ? [launch.token, launch.pairToken] : [launch.pairToken, launch.token];
    const pool = keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"),
      [currency0, currency1, launch.poolFee, launch.tickSpacing, hook]));
    const read = (functionName: "pendingFees" | "pendingCreatorTax" | "pendingBuyback", asset: Address) =>
      client.readContract({ address: hook, abi: hookAbi, functionName, args: [pool, asset], blockNumber });
    const [fees, tax, buyback, tokenFees, tokenTax, policy] = await Promise.all([
      read("pendingFees", launch.pairToken), read("pendingCreatorTax", launch.pairToken), read("pendingBuyback", launch.pairToken),
      read("pendingFees", launch.token), read("pendingCreatorTax", launch.token),
      client.readContract({ address: factory, abi: factoryAbi, functionName: "getLaunchFeePolicy", args: [launch.token], blockNumber }),
    ]);
    operatorRequired = buyback > 0n || tokenFees > 0n || tokenTax > 0n;
    if (!operatorRequired) unswept = netCreatorFees(fees, tax, buyback, BigInt(policy.protocolFeeShareBps));
  }
  const available = input.escrow + unswept;
  const value = available === 0n ? 0n : launch.pairToken === zeroAddress ? available : await input.quoteNative(available);
  if (available > 0n && value <= 0n) throw new Error("AUTOMATED_FEE_ACCUMULATION_QUOTE_UNAVAILABLE");
  return {
    availableCreatorFees: available.toString(), availableCreatorFeesEthWei: value.toString(),
    escrowCreatorFeesEthWei: input.escrow === 0n ? "0" : launch.pairToken === zeroAddress ? input.escrow.toString()
      : (input.escrow === available ? value : await input.quoteNative(input.escrow)).toString(),
    accumulationThresholdWei: FEE_ACCUMULATION_THRESHOLD_WEI.toString(),
    unsweptCreatorFees: unswept.toString(), operatorRequired,
  };
}
