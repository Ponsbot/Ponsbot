import { parseAbi, zeroAddress, type PublicClient } from "viem";

export const CANONICAL_USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const abi = parseAbi([
  "function getPool(address,address,uint24) view returns(address)",
  "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns(uint128)",
]);

/** Canonical WETH/USDG reference, not the stock-asset price API. */
export async function usdgReferencePrice(rpc: Pick<PublicClient, "readContract">, ethUsd: number, blockNumber?: bigint) {
  const pool = await rpc.readContract({ address: FACTORY, abi, functionName: "getPool", args: [WETH, CANONICAL_USDG, 100], blockNumber });
  if (pool === zeroAddress) throw new Error("USDG reference pool unavailable");
  const [slot, liquidity] = await Promise.all([
    rpc.readContract({ address: pool, abi, functionName: "slot0", blockNumber }),
    rpc.readContract({ address: pool, abi, functionName: "liquidity", blockNumber }),
  ]);
  // WETH sorts first; 18 WETH decimals versus 6 USDG decimals.
  const usdgPerEth = (Number(slot[0]) / 2 ** 96) ** 2 * 10 ** 12;
  const usd = ethUsd / usdgPerEth;
  if (liquidity <= 0n || !Number.isFinite(usd) || usd <= 0) throw new Error("USDG reference price unavailable");
  return usd;
}
