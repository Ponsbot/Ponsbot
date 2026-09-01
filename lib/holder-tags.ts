export const PONS_V2_LAUNCH_LOCKER = "0x267444d099b10fb5ed7c3cc7b7c767adca574952";

export type HolderTag = "Creator" | "Pons V2 Launch Locker" | "Bonding Curve" | "Liquidity" | "Uniswap V3 Liquidity" | "Uniswap V4 Liquidity";

export function holderTag(address: string, creator: string | undefined, liquidity: string | undefined, name = "", graduated = false): HolderTag | undefined {
  const normalized = address.toLowerCase();
  if (normalized === PONS_V2_LAUNCH_LOCKER) return "Pons V2 Launch Locker";
  if (normalized === "0x8366a39cc670b4001a1121b8f6a443a643e40951") return "Uniswap V4 Liquidity";
  if (normalized === creator) return "Creator";
  // Blockscout supplies verified contract names where available. V4 liquidity
  // is held by the singleton PoolManager rather than a token-specific pool.
  if (/uniswap\s*v?4|v4\s*(?:pool|liquidity)|poolmanager/i.test(name)) return "Uniswap V4 Liquidity";
  if (/uniswap\s*v?3|v3\s*(?:pool|liquidity)/i.test(name)) return "Uniswap V3 Liquidity";
  if (!graduated && (normalized === liquidity || /bonding\s*curve|pons.*curve|curve/i.test(name))) return "Bonding Curve";
  if (normalized === liquidity || /pool|liquidity|locker|hook|curve/i.test(name)) return "Liquidity";
  return undefined;
}
