import { PONS_PAIR_CATALOG } from "../pair-catalog";
import { isTokenIndexExcluded } from "../token-index-exclusions";

export type TradeMix = { platform: number; secondary: number };
export const secondaryAgentTokens = [
  { address: "0x39dbed3a2bd333467115de45665cc57f813c4571", symbol: "PONS" },
  ...PONS_PAIR_CATALOG.map(([address, symbol]) => ({ address: address.toLowerCase(), symbol })),
].filter(t => !["0x0000000000000000000000000000000000000000", "0x0bd7d308f8e1639fab988df18a8011f41eacad73"].includes(t.address) && !isTokenIndexExcluded(t.address));
const secondary = new Set(secondaryAgentTokens.map(t => t.address));
export const isSecondaryAgentToken = (address: string) => secondary.has(address.toLowerCase());
export function secondaryTradeAvailable(mix: TradeMix = { platform: 0, secondary: 0 }) {
  return Number.isSafeInteger(mix.platform) && Number.isSafeInteger(mix.secondary)
    && mix.platform >= 0 && mix.secondary >= 0
    && BigInt(mix.platform) >= 4n * (BigInt(mix.secondary) + 1n);
}
export function countAgentTrade(mix: TradeMix | undefined, bucket: keyof TradeMix): TradeMix {
  const next = { platform: mix?.platform ?? 0, secondary: mix?.secondary ?? 0 };
  next[bucket] += 1;
  if (!Number.isSafeInteger(next[bucket])) throw new Error("TRADE_COUNTER_OVERFLOW");
  return next;
}
