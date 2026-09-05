export const TOKEN_INDEX_EXCLUSIONS = new Set([
  "0x9a235e8d56b3e397c39c999f88dd401827ea7b07",
  "0xa60ba99d5229077ab8f80035dc8a810d3e310b07",
  // Duplicate PDOG launch; keep the other PDOG as the sole indexed ticker match.
  "0xdf1f5f5afce9ced806f753783d7103301708eb07",
  // Private automated-fee test token, never part of the public token catalog.
  "0xe5d0aac01c27dcc95e8a787efd1b767b4945bb07",
]);

export function isTokenIndexExcluded(address: string | undefined | null) {
  return Boolean(address && TOKEN_INDEX_EXCLUSIONS.has(address.toLowerCase()));
}
