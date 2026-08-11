import { ConvexHttpClient } from "convex/browser";
import { createPublicClient, formatEther, formatUnits, http, isAddress, parseAbi, type Address } from "viem";
import { api } from "@/convex/_generated/api";
import { addMarketCaps } from "@/lib/token-market-cap";

export type PublicLaunch = {
  name: string; symbol: string; imageUri: string; description?: string;
  website?: string; twitter?: string; telegram?: string; tokenAddress?: string;
  transactionHash: string; devBuySucceeded?: boolean; creatorAddress?: string; createdAt: number;
  pairToken?: string; poolAddress?: string; launcherUsername?: string; marketCapUsd?: number; marketCapUpdatedAt?: number;
};

const PREVIEW_WALLET = "0x0000000000000000000000000000000000000b07";
const PREVIEW_TOKEN = "0x0000000000000000000000000000000000000a11";

function previewLaunch(tokenAddress: string): PublicLaunch {
  return {
    name: "Ponsbot Preview",
    symbol: "PONSBOT",
    imageUri: "/ponsbot.png",
    description: "A preview of a token launched through Ponsbot on Pons V2.",
    website: "https://ponsfamily.com",
    twitter: "https://x.com/Ponsbotfamily",
    tokenAddress,
    transactionHash: `0x${"1".repeat(64)}`,
    devBuySucceeded: true,
    creatorAddress: "0x0000000000000000000000000000000000000B07",
    launcherUsername: "PonsbotPreview",
    marketCapUsd: 125_000,
    marketCapUpdatedAt: Date.now(),
    createdAt: 1_755_000_000_000,
  };
}

export async function listLaunches(limit = 24): Promise<PublicLaunch[]> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return [];
  try {
    const launches = await new ConvexHttpClient(url).query(api.site.listLaunches, { limit });
    return await addMarketCaps(launches);
  } catch (error) {
    console.error("public_launch_list_failed", error instanceof Error ? error.message : "unknown");
    return [];
  }
}

export async function getLaunch(tokenAddress: string): Promise<PublicLaunch | null> {
  if (!isAddress(tokenAddress)) return null;
  if (tokenAddress.toLowerCase() === PREVIEW_TOKEN) return previewLaunch(tokenAddress);
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return null;
  try {
    const launch = await new ConvexHttpClient(url).query(api.site.getLaunch, { tokenAddress });
    if (!launch) return null;
    return (await addMarketCaps([launch]))[0];
  } catch (error) {
    console.error("public_launch_lookup_failed", error instanceof Error ? error.message : "unknown");
    return null;
  }
}

type ExplorerTokenBalance = {
  value: string;
  token: { address_hash: string; decimals: string | null; icon_url: string | null; name: string; symbol: string };
};

export type PublicHolding = { address?: string; name: string; symbol: string; balance: string; iconUrl?: string };
type PublicWalletRecord = { address: string; createdAt: number; tokens?: Array<{ address: string; symbol: string; iconUrl?: string }> };
const ETH_ICON_URL = "https://cryptologos.cc/logos/ethereum-eth-logo.png";

const publicTokenAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

async function indexedTokenHoldings(wallet: Address, tokens: PublicWalletRecord["tokens"] = []) {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const client = createPublicClient({ transport: http(rpcUrl, { batch: true }) });
  const unique = [...new Map(tokens.filter((token) => isAddress(token.address)).map((token) => [token.address.toLowerCase(), token])).values()];
  const results = await Promise.all(unique.map(async (token): Promise<PublicHolding | undefined> => {
    try {
      const tokenAddress = token.address as Address;
      const [balance, decimals, symbol, name] = await Promise.all([
        client.readContract({ address: tokenAddress, abi: publicTokenAbi, functionName: "balanceOf", args: [wallet] }),
        client.readContract({ address: tokenAddress, abi: publicTokenAbi, functionName: "decimals" }),
        client.readContract({ address: tokenAddress, abi: publicTokenAbi, functionName: "symbol" }),
        client.readContract({ address: tokenAddress, abi: publicTokenAbi, functionName: "name" }).catch(() => token.symbol),
      ]);
      if (balance <= 0n) return undefined;
      return { address: token.address, name: name || symbol, symbol, balance: formatDisplay(formatUnits(balance, decimals)), iconUrl: token.iconUrl };
    } catch {
      return undefined;
    }
  }));
  return results.filter((holding): holding is PublicHolding => Boolean(holding));
}

async function rpcEthBalance(address: string) {
  const response = await fetch(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Robinhood RPC unavailable");
  const payload = await response.json() as { result?: string; error?: unknown };
  if (!/^0x[0-9a-f]+$/i.test(payload.result || "")) throw new Error("Robinhood RPC returned an invalid balance");
  return BigInt(payload.result!);
}

export async function isPonsbotWallet(address: string) {
  if (!isAddress(address)) return false;
  if (address.toLowerCase() === PREVIEW_WALLET) return true;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return false;
  try {
    return Boolean(await new ConvexHttpClient(url).query(api.site.getWallet, { address }));
  } catch {
    return false;
  }
}

export async function getWalletHoldings(address: string): Promise<{ holdings: PublicHolding[]; available: boolean }> {
  if (!isAddress(address)) return { holdings: [], available: false };
  if (address.toLowerCase() === PREVIEW_WALLET) return { holdings: [
    { name: "Ethereum", symbol: "ETH", balance: "1.284", iconUrl: ETH_ICON_URL },
    { address: "0x0000000000000000000000000000000000000A11", name: "Ponsbot Preview", symbol: "PONSBOT", balance: "12,500,000", iconUrl: "/ponsbot.png" },
    { address: "0x0000000000000000000000000000000000005Ad0", name: "Sandisk", symbol: "SNDK", balance: "842.75" },
  ], available: true };
  const base = "https://robinhoodchain-mainnet-explorer-api.rpc.caldera.xyz/api/v2";
  try {
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    const walletRecord = convexUrl
      ? await new ConvexHttpClient(convexUrl).query(api.site.getWallet, { address }) as PublicWalletRecord | null
      : null;
    const [accountResponse, tokensResponse, rpcTokens] = await Promise.all([
      fetch(`${base}/addresses/${address}`, { next: { revalidate: 20 }, signal: AbortSignal.timeout(8_000) }),
      fetch(`${base}/addresses/${address}/token-balances`, { next: { revalidate: 20 }, signal: AbortSignal.timeout(8_000) }),
      indexedTokenHoldings(address as Address, walletRecord?.tokens),
    ]);
    const accountMissing = accountResponse.status === 404;
    const tokensMissing = tokensResponse.status === 404;
    if ((!accountResponse.ok && !accountMissing) || (!tokensResponse.ok && !tokensMissing)) throw new Error("explorer unavailable");
    const account = accountResponse.ok
      ? await accountResponse.json() as { coin_balance?: string }
      : { coin_balance: (await rpcEthBalance(address)).toString() };
    const tokenPayload = tokensResponse.ok ? await tokensResponse.json() : [];
    const tokens = Array.isArray(tokenPayload) ? tokenPayload as ExplorerTokenBalance[] : [];
    const holdings: PublicHolding[] = [];
    if (account.coin_balance && BigInt(account.coin_balance) > 0n) {
      holdings.push({ name: "Ethereum", symbol: "ETH", balance: formatDisplay(formatEther(BigInt(account.coin_balance))), iconUrl: ETH_ICON_URL });
    }
    for (const item of tokens) {
      const decimals = Number(item.token.decimals || 18);
      if (BigInt(item.value) === 0n) continue;
      holdings.push({
        address: item.token.address_hash,
        name: item.token.name || item.token.symbol,
        symbol: item.token.symbol,
        balance: formatDisplay(formatUnits(BigInt(item.value), decimals)),
        iconUrl: item.token.icon_url || undefined,
      });
    }
    const knownByAddress = new Map(holdings.flatMap((holding, index) => holding.address ? [[holding.address.toLowerCase(), index] as const] : []));
    for (const holding of rpcTokens) {
      if (!holding.address) continue;
      const normalized = holding.address.toLowerCase();
      const existingIndex = knownByAddress.get(normalized);
      if (existingIndex !== undefined) {
        if (!holdings[existingIndex].iconUrl && holding.iconUrl) holdings[existingIndex].iconUrl = holding.iconUrl;
        continue;
      }
      holdings.push(holding);
      knownByAddress.set(normalized, holdings.length - 1);
    }
    return { holdings, available: true };
  } catch {
    return { holdings: [], available: false };
  }
}

function formatDisplay(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  if (number === 0) return "0";
  if (number < 0.0001) return number.toExponential(3);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(number);
}

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export const explorerAddress = (address: string) => `https://robinhoodchain.blockscout.com/address/${address}`;
export const explorerToken = (address: string) => `https://robinhoodchain.blockscout.com/token/${address}`;
