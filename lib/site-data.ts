import { ConvexHttpClient } from "convex/browser";
import { formatEther, formatUnits, isAddress } from "viem";
import { api } from "@/convex/_generated/api";

export type PublicLaunch = {
  name: string; symbol: string; imageUri: string; description?: string;
  website?: string; twitter?: string; tokenAddress?: string;
  transactionHash: string; devBuySucceeded?: boolean; creatorAddress?: string; createdAt: number;
};

export async function listLaunches(limit = 24): Promise<PublicLaunch[]> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return [];
  try {
    return await new ConvexHttpClient(url).query(api.site.listLaunches, { limit });
  } catch (error) {
    console.error("public_launch_list_failed", error instanceof Error ? error.message : "unknown");
    return [];
  }
}

export async function getLaunch(tokenAddress: string): Promise<PublicLaunch | null> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url || !isAddress(tokenAddress)) return null;
  try {
    return await new ConvexHttpClient(url).query(api.site.getLaunch, { tokenAddress });
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

export async function isPonsbotWallet(address: string) {
  if (!isAddress(address)) return false;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return address.toLowerCase() === "0x0000000000000000000000000000000000000b07";
  try {
    return Boolean(await new ConvexHttpClient(url).query(api.site.getWallet, { address }));
  } catch {
    return address.toLowerCase() === "0x0000000000000000000000000000000000000b07";
  }
}

export async function getWalletHoldings(address: string): Promise<{ holdings: PublicHolding[]; available: boolean }> {
  if (!isAddress(address)) return { holdings: [], available: false };
  if (address.toLowerCase() === "0x0000000000000000000000000000000000000b07") return { holdings: [
    { name: "Ether", symbol: "ETH", balance: "1.284" },
    { address: "0x0000000000000000000000000000000000000A11", name: "Ponsbot Preview", symbol: "PONSBOT", balance: "12,500,000", iconUrl: "/ponsbot.png" },
    { address: "0x0000000000000000000000000000000000005Ad0", name: "Sandisk", symbol: "SNDK", balance: "842.75" },
  ], available: true };
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl) {
    try {
      const snapshots = await new ConvexHttpClient(convexUrl).query(api.site.getWalletSnapshot, { walletAddress: address });
      if (snapshots.length) return { holdings: snapshots.map((item) => ({ address: item.tokenAddress, name: item.name, symbol: item.symbol, balance: item.displayBalance, iconUrl: item.iconUrl })), available: true };
    } catch (error) {
      console.error("public_wallet_snapshot_failed", error instanceof Error ? error.message : "unknown");
    }
  }
  const base = "https://robinhoodchain-mainnet-explorer-api.rpc.caldera.xyz/api/v2";
  try {
    const [accountResponse, tokensResponse] = await Promise.all([
      fetch(`${base}/addresses/${address}`, { next: { revalidate: 20 } }),
      fetch(`${base}/addresses/${address}/token-balances`, { next: { revalidate: 20 } }),
    ]);
    if (!accountResponse.ok || !tokensResponse.ok) throw new Error("explorer unavailable");
    const account = await accountResponse.json() as { coin_balance?: string };
    const tokens = await tokensResponse.json() as ExplorerTokenBalance[];
    const holdings: PublicHolding[] = [];
    if (account.coin_balance && BigInt(account.coin_balance) > 0n) {
      holdings.push({ name: "Ether", symbol: "ETH", balance: formatDisplay(formatEther(BigInt(account.coin_balance))) });
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
