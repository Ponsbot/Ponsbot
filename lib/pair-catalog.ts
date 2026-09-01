import catalog from "./pons-pair-catalog.json";

export const PONS_PAIR_CATALOG: ReadonlyArray<readonly [string, string, string, number?]> = catalog.map(
  (entry) => [entry.address, entry.symbol, entry.name, entry.decimals] as const,
);

// RIVN remains indexed for trading/search but is intentionally not published
// as a currently supported launch pair.
export const PUBLISHED_PAIR_SYMBOLS = [
  ...PONS_PAIR_CATALOG.map(([, symbol]) => symbol).filter((symbol) => symbol !== "RIVN"),
  "ETH",
] as const;

export const PUBLISHED_PAIR_LIST = PUBLISHED_PAIR_SYMBOLS.join(", ");
