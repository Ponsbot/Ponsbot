import { type Address } from "viem";
import catalog from "./pons-pair-catalog.json";

export type AutomatedFeePairRoute = {
  pairAsset: Address;
  symbol: string;
  kind: "v3" | "v4";
  fee: number;
  tickSpacing: number;
  hook: Address;
};

// Direct pair-asset -> native-ETH routes verified from live Robinhood Chain
// quoters and, for V4, PoolManager Initialize events plus StateView liquidity.
// These are configuration inputs, not an implicit trust list: the on-chain
// executor remains fail-closed until the admin installs a route while global
// processing is disabled, and every execution still carries signed minima.
export const AUTOMATED_FEE_PAIR_ROUTES: readonly AutomatedFeePairRoute[] = catalog.map((entry) => ({
  pairAsset: entry.address as Address,
  symbol: entry.symbol,
  kind: entry.route.kind as "v3" | "v4",
  fee: entry.route.fee,
  tickSpacing: entry.route.tickSpacing,
  hook: entry.route.hook as Address,
}));
