import catalog from "./pons-pair-catalog.json";

export const PONS_PAIR_CATALOG: ReadonlyArray<readonly [string, string, string, number?]> = catalog.map(
  (entry) => [entry.address, entry.symbol, entry.name, entry.decimals] as const,
);

export const PUBLISHED_PAIR_SYMBOLS = [
  ...PONS_PAIR_CATALOG.map(([, symbol]) => symbol),
  "ETH",
] as const;

export const PUBLISHED_PAIR_LIST = PUBLISHED_PAIR_SYMBOLS.join(", ");
