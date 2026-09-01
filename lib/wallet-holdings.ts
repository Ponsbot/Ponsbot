import { formatUnits, isAddress } from "viem";
import { PONSBOT_BURN_TOKEN } from "./burn-stats";
import { PONS_PAIR_CATALOG } from "./pair-catalog";

export type PublicHolding = { address?: string; name: string; symbol: string; balance: string; iconUrl?: string; isPonsbotLaunch?: boolean; isPairAsset?: boolean; usdValue?: number };
export type KnownWalletToken = { address: string; symbol: string; iconUrl?: string; isPonsbotLaunch?: boolean };
export type RpcTokenHoldings = { holdings: PublicHolding[]; zeroAddresses: string[]; complete: boolean };

// Incoming transfers do not necessarily create a walletTokenIndex entry.
// Liquidity funding/refunds also bypass the ordinary wallet transaction index.
// Always check PONSBOT and USDG without scanning every indexed asset/launch.
export function walletBalanceTokens(tokens: KnownWalletToken[] = []): KnownWalletToken[] {
  const known = new Map<string, KnownWalletToken>([[PONSBOT_BURN_TOKEN, {
    address: PONSBOT_BURN_TOKEN, symbol: "PONSBOT", isPonsbotLaunch: true,
  }]]);
  for (const [address, symbol] of PONS_PAIR_CATALOG) {
    if (symbol === "USDG") known.set(address.toLowerCase(), { address: address.toLowerCase(), symbol });
  }
  for (const token of tokens) {
    if (!isAddress(token.address, { strict: false })) continue;
    const address = token.address.toLowerCase();
    const previous = known.get(address);
    known.set(address, { ...previous, ...token, address, isPonsbotLaunch: previous?.isPonsbotLaunch || token.isPonsbotLaunch });
  }
  return [...known.values()];
}

/** Accept both Blockscout's paginated /tokens response and legacy arrays.
 * A 404, bad payload, or partly unreadable page is not proof of an empty wallet.
 */
export function parseExplorerHoldings(payload: unknown): { holdings: PublicHolding[]; complete: boolean } {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const entries = Array.isArray(payload) ? payload : record?.items;
  if (!Array.isArray(entries)) return { holdings: [], complete: false };
  let complete = Array.isArray(payload) || record?.next_page_params === null;
  const holdings: PublicHolding[] = [];
  for (const value of entries) {
    try {
      if (!value || typeof value !== "object") throw new Error();
      const entry = value as Record<string, unknown>, token = entry.token as Record<string, unknown> | undefined;
      if (token?.type && token.type !== "ERC-20") continue;
      if (!token || typeof token.address_hash !== "string" || !isAddress(token.address_hash, { strict: false })
        || typeof entry.value !== "string" || !/^\d+$/.test(entry.value)
        || token.decimals === null || token.decimals === undefined) throw new Error();
      const decimals = Number(token.decimals);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error();
      if (BigInt(entry.value) === 0n) continue;
      const symbol = typeof token.symbol === "string" && token.symbol ? token.symbol : "Token";
      holdings.push({ address: token.address_hash.toLowerCase(), symbol,
        name: typeof token.name === "string" && token.name ? token.name : symbol,
        balance: formatUnits(BigInt(entry.value), decimals),
        ...(typeof token.icon_url === "string" && token.icon_url ? { iconUrl: token.icon_url } : {}),
      });
    } catch { complete = false; /* One bad entry must not discard later balances. */ }
  }
  return { holdings, complete };
}

export function mergeWalletTokenHoldings(explorer: PublicHolding[], rpc: RpcTokenHoldings, known: KnownWalletToken[]) {
  const metadata = new Map(known.map(token => [token.address.toLowerCase(), token]));
  const zero = new Set(rpc.zeroAddresses.map(address => address.toLowerCase()));
  const holdings = new Map<string, PublicHolding>();
  for (const holding of explorer) {
    if (!holding.address || zero.has(holding.address.toLowerCase())) continue;
    const address = holding.address.toLowerCase(), token = metadata.get(address);
    holdings.set(address, { ...holding, address,
      iconUrl: token?.iconUrl || holding.iconUrl,
      isPonsbotLaunch: token?.isPonsbotLaunch || holding.isPonsbotLaunch,
    });
  }
  for (const holding of rpc.holdings) {
    if (!holding.address) continue;
    const address = holding.address.toLowerCase(), previous = holdings.get(address);
    holdings.set(address, { ...previous, ...holding, address,
      iconUrl: holding.iconUrl || previous?.iconUrl,
      isPonsbotLaunch: holding.isPonsbotLaunch || previous?.isPonsbotLaunch,
    });
  }
  return [...holdings.values()];
}
