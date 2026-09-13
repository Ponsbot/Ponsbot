/** Rotate discovery without losing held assets needed for sell decisions. */
export function diverseCandidates<T extends { address: string }>(tokens: T[], owned: Set<string>, seed: string, limit: number): T[] {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const unique = [...new Map(tokens.map(t => [t.address.toLowerCase(), t])).values()];
  const held = unique.filter(t => owned.has(t.address.toLowerCase()));
  const fresh = unique.filter(t => !owned.has(t.address.toLowerCase()));
  const start = hash % Math.max(1, fresh.length);
  const rotated = [...fresh.slice(start), ...fresh.slice(0, start)];
  return [...rotated.slice(0, Math.max(0, limit - held.length)), ...held].slice(0, limit);
}
