export function isAddressLiteral(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

/** Canonicalizes valid address literals without accepting malformed input. */
export function normalizedRpcAddress(value: string) {
  return isAddressLiteral(value) ? value.toLowerCase() : value;
}

/** Keep address identity case-insensitive when candidates come from mixed data sources. */
export function addNormalizedAddressMatch(matches: Set<string>, value: string) {
  matches.add(normalizedRpcAddress(value));
}
