import { ConvexHttpClient } from "convex/browser";
import { unstable_cache } from "next/cache";
import { createPublicClient, parseAbi } from "viem";
import { api } from "../convex/_generated/api";
import { reliableHttp } from "./rpc-http";
import { PONSBOT_BURN_ADDRESS, PONSBOT_BURN_TOKEN } from "./burn-stats";

const balanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

// Independent caches/failures: a slow RPC must not hide confirmed fee-cycle totals.
const cachedAutomaticBurns = unstable_cache(async () => {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("Public site data is not configured");
  const client = new ConvexHttpClient(url, { fetch: (input, init) => fetch(input, {
    ...init, signal: AbortSignal.timeout(8_000),
  }) });
  const total = await client.query(api.site.automatedFeeBurnStats, {});
  if (!/^\d+$/.test(total.ponsbotBurned)) throw new Error("Invalid automatic burn total");
  return total.ponsbotBurned;
}, ["public-automatic-ponsbot-burns-v1"], { revalidate: 300 });

const cachedTotalBurns = unstable_cache(async () => {
  const client = createPublicClient({ transport: reliableHttp(
    process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    { timeout: 8_000, fetchOptions: { signal: AbortSignal.timeout(8_000) } },
  ) });
  // This includes every transfer to dead (manual and automated), not just bot actions.
  const amount = await client.readContract({
    address: PONSBOT_BURN_TOKEN, abi: balanceAbi, functionName: "balanceOf", args: [PONSBOT_BURN_ADDRESS],
  });
  return amount.toString();
}, ["public-total-ponsbot-burns-v1"], { revalidate: 300 });

export async function getAutomaticPonsbotBurned(): Promise<string | null> {
  try { return await cachedAutomaticBurns(); } catch { return null; }
}

export async function getTotalPonsbotBurned(): Promise<string | null> {
  try { return await cachedTotalBurns(); } catch { return null; }
}
