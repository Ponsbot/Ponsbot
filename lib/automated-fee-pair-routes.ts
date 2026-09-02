import { type Address } from "viem";
import catalog from "./pons-pair-catalog.json";

type PairRouteCatalogEntry = {
  address: string;
  symbol: string;
  route?: { kind: "v3" | "v4"; fee: number; tickSpacing: number; hook: string };
};

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
const routedEntries = (catalog as PairRouteCatalogEntry[]).filter(
  (entry): entry is PairRouteCatalogEntry & { route: NonNullable<PairRouteCatalogEntry["route"]> } => Boolean(entry.route),
);

export const AUTOMATED_FEE_PAIR_ROUTES: readonly AutomatedFeePairRoute[] = routedEntries.map((entry) => ({
  pairAsset: entry.address as Address,
  symbol: entry.symbol,
  kind: entry.route.kind,
  fee: entry.route.fee,
  tickSpacing: entry.route.tickSpacing,
  hook: entry.route.hook as Address,
}));
