import { formatEther, formatUnits, zeroAddress, type Address } from "viem";
import { DELTA_LIQUIDITY as A } from "./liquidity-workflow";
import type { LiquidityTransaction } from "./liquidity-contracts";

export type LiquidityAssetRequirement = { asset: Address; required: bigint; held: bigint; decimals: number; symbol: string };
export type LiquidityFundingDependencies = {
  buy: (asset: Address, minimumOutput: bigint) => Promise<{ nativeInput: bigint; calls: LiquidityTransaction[] }>;
  convertUsdg: (minimumEth: bigint, maximumUsdg: bigint) => Promise<{ usdgInput: bigint; calls: LiquidityTransaction[] }>;
  // Sequential, read-only simulation; one gas-liability estimate per call.
  gasCosts: (calls: LiquidityTransaction[]) => Promise<bigint[]>;
};
const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);

/** Funding assets are intentionally NOT inferred from the user's holdings.
 * Only native ETH and unreserved USDG may pay for missing LP assets. The
 * position token is never a funding source, even when that token is USDG.
 */
export async function planLiquidityFunding(input: {
  protectedToken: Address; ethBalance: bigint; usdgBalance: bigint;
  requirements: LiquidityAssetRequirement[]; positionCalls: LiquidityTransaction[];
}, deps: LiquidityFundingDependencies) {
  const buys: LiquidityTransaction[] = [], summary: string[] = [];
  for (const asset of input.requirements) {
    if (asset.asset === zeroAddress || asset.held >= asset.required) continue;
    const deficit = asset.required - asset.held;
    let purchase: Awaited<ReturnType<LiquidityFundingDependencies["buy"]>>;
    try {
      purchase = await deps.buy(asset.asset, deficit);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`LP_INSUFFICIENT_FUNDING:unable to source missing ${asset.symbol}: ${detail}`);
    }
    if (purchase.nativeInput !== sum(purchase.calls.map(call => BigInt(call.value)))) throw new Error("Invalid LP funding value");
    buys.push(...purchase.calls);
    summary.push(`${asset.asset.toLowerCase() === A.weth ? "Wrap ETH for" : "Buy missing"} ${formatUnits(deficit, asset.decimals)} ${asset.symbol}: ${formatEther(purchase.nativeInput)} ETH maximum.`);
  }
  const baseCalls = [...buys, ...input.positionCalls];
  const nativeValue = sum(baseCalls.map(call => BigInt(call.value)));
  const baseGas = sum(await deps.gasCosts(baseCalls));
  const shortfall = nativeValue + baseGas - input.ethBalance;
  if (shortfall <= 0n) return { calls: baseCalls, summary, gasReserve: baseGas };

  const reservedUsdg = sum(input.requirements.filter(asset => asset.asset.toLowerCase() === A.usdg).map(asset => asset.required));
  const spareUsdg = input.usdgBalance > reservedUsdg ? input.usdgBalance - reservedUsdg : 0n;
  if (input.protectedToken.toLowerCase() === A.usdg || spareUsdg === 0n) {
    throw new Error("LP_INSUFFICIENT_FUNDING:not enough ETH or spare USDG; position tokens are never sold");
  }
  let minimumEth = shortfall;
  for (let attempt = 0; attempt < 4; attempt++) {
    const conversion = await deps.convertUsdg(minimumEth, spareUsdg);
    if (conversion.usdgInput <= 0n || conversion.usdgInput > spareUsdg || conversion.calls.some(call => BigInt(call.value) !== 0n)) throw new Error("Invalid LP funding conversion");
    const calls = [...conversion.calls, ...baseCalls];
    const gas = await deps.gasCosts(calls), totalGas = sum(gas);
    // A token cannot pay for its own first approval/swap gas on this chain.
    if (input.ethBalance < sum(gas.slice(0, conversion.calls.length))) throw new Error("LP_INSUFFICIENT_GAS:ETH is needed to start the USDG conversion");
    const needed = nativeValue + totalGas - input.ethBalance;
    if (minimumEth >= needed) {
      return { calls, gasReserve: totalGas, summary: [
        `Convert up to ${formatUnits(conversion.usdgInput, 6)} spare USDG to at least ${formatEther(minimumEth)} ETH.`, ...summary,
      ] };
    }
    minimumEth = needed;
  }
  throw new Error("LP_INSUFFICIENT_FUNDING:funding quote changed; refresh before proceeding");
}
