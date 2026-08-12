import { ConvexHttpClient } from "convex/browser";
import { createPublicClient, formatEther, formatUnits, http, isAddress, parseAbi, type Address } from "viem";
import { api } from "@/convex/_generated/api";
import { addMarketCaps } from "@/lib/token-market-cap";
import { tokenUnitPriceUsd } from "@/lib/token-market-cap";
import { ethUsdPrice } from "@/lib/wallet-signer/pricing";

export type PublicLaunch = {
  name: string; symbol: string; imageUri: string; description?: string;
  website?: string; twitter?: string; telegram?: string; tokenAddress?: string;
  transactionHash: string; devBuySucceeded?: boolean; creatorAddress?: string; createdAt: number;
  pairToken?: string; pairSymbol?: string; poolAddress?: string; launcherUsername?: string; marketCapUsd?: number; marketCapUpdatedAt?: number; lastBuyAt?: number; storedMarketCapUsd?: number; volume24hUsd?: number; graduated?: boolean;
};

const PREVIEW_WALLET = "0x0000000000000000000000000000000000000b07";
const PREVIEW_TOKEN = "0x0000000000000000000000000000000000000a11";

function previewLaunch(tokenAddress: string): PublicLaunch {
  return {
    name: "Pons Bot Preview",
    symbol: "PONSBOT",
    imageUri: "/ponsbot.png",
    description: "A preview of a token launched through Pons Bot on Pons V2.",
    website: "https://ponsfamily.com",
    twitter: "https://x.com/Ponsbotfamily",
    tokenAddress,
    transactionHash: `0x${"1".repeat(64)}`,
    devBuySucceeded: true,
    creatorAddress: "0x0000000000000000000000000000000000000B07",
    launcherUsername: "PonsbotPreview",
    pairSymbol: "MSFT",
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
    return await addMarketCaps(launches.map((launch) => launch.storedMarketCapUsd === undefined ? launch : { ...launch, marketCapUsd: launch.storedMarketCapUsd, marketCapUpdatedAt: Date.now() }));
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
    return (await addMarketCaps([launch.storedMarketCapUsd === undefined ? launch : { ...launch, marketCapUsd: launch.storedMarketCapUsd, marketCapUpdatedAt: Date.now() }]))[0];
  } catch (error) {
    console.error("public_launch_lookup_failed", error instanceof Error ? error.message : "unknown");
    return null;
  }
}

type ExplorerTokenBalance = {
  value: string;
  token: { address_hash: string; decimals: string | null; icon_url: string | null; name: string; symbol: string };
};

export type PublicHolding = { address?: string; name: string; symbol: string; balance: string; iconUrl?: string; isPonsbotLaunch?: boolean; isPairAsset?: boolean; usdValue?: number };
type PublicWalletRecord = { address: string; createdAt: number; username?: string; tokens?: Array<{ address: string; symbol: string; iconUrl?: string; isPonsbotLaunch?: boolean }> };
type StockAsset = { tokenSymbol: string; tokenName: string; currentMultiplier: string; logoUrl?: string; deployments?: Array<{ contractAddress: string; chainId: number }> };
const ETH_ICON_URL = "https://cryptologos.cc/logos/ethereum-eth-logo.png";
const STOCK_ICON_DOMAINS: Record<string, string> = {
  NVDA: "nvidia.com", SPCX: "spacex.com", GOOGL: "google.com", TSLA: "tesla.com",
  GME: "gamestop.com", AAPL: "apple.com", SPY: "ssga.com", SNDK: "sandisk.com",
  AMD: "amd.com", AMZN: "amazon.com", MSFT: "microsoft.com", META: "meta.com",
  CRCL: "circle.com", COIN: "coinbase.com", MU: "micron.com", PLTR: "palantir.com",
  USDG: "globaldollar.com",
};

function stockIconUrl(symbol: string) {
  const domain = STOCK_ICON_DOMAINS[symbol.toUpperCase()];
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : undefined;
}

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
      return { address: token.address, name: name || symbol, symbol, balance: formatDisplay(formatUnits(balance, decimals)), iconUrl: token.iconUrl, isPonsbotLaunch: token.isPonsbotLaunch };
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

export async function getWalletHoldings(address: string): Promise<{ holdings: PublicHolding[]; available: boolean; username?: string }> {
  if (!isAddress(address)) return { holdings: [], available: false };
  if (address.toLowerCase() === PREVIEW_WALLET) return { holdings: [
    { name: "Ethereum", symbol: "ETH", balance: "1.284", iconUrl: ETH_ICON_URL, usdValue: 5_120.58 },
    { address: "0x0000000000000000000000000000000000000A11", name: "Pons Bot Preview", symbol: "PONSBOT", balance: "12,500,000", iconUrl: "/ponsbot.png", isPonsbotLaunch: true, usdValue: 1_562.5 },
    { address: "0x0000000000000000000000000000000000005Ad0", name: "Sandisk", symbol: "SNDK", balance: "842.75", isPairAsset: true, usdValue: 42_137.5 },
  ], available: true, username: "PonsbotPreview" };
  const base = "https://robinhoodchain-mainnet-explorer-api.rpc.caldera.xyz/api/v2";
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const walletRecord = convexUrl
    ? await new ConvexHttpClient(convexUrl).query(api.site.getWallet, { address }).catch(() => null) as PublicWalletRecord | null
    : null;
  const [accountResult, tokensResult, rpcEthResult, rpcTokensResult] = await Promise.allSettled([
    fetch(`${base}/addresses/${address}`, { next: { revalidate: 20 }, signal: AbortSignal.timeout(8_000) }),
    fetch(`${base}/addresses/${address}/token-balances`, { next: { revalidate: 20 }, signal: AbortSignal.timeout(8_000) }),
    rpcEthBalance(address),
    indexedTokenHoldings(address as Address, walletRecord?.tokens),
  ]);
  const holdings: PublicHolding[] = [];
  let ethBalance = rpcEthResult.status === "fulfilled" ? rpcEthResult.value : undefined;
  if (accountResult.status === "fulfilled" && accountResult.value.ok) {
    try {
      const account = await accountResult.value.json() as { coin_balance?: string };
      if (account.coin_balance && /^\d+$/.test(account.coin_balance)) ethBalance = BigInt(account.coin_balance);
    } catch { /* The RPC result remains authoritative when explorer JSON is malformed. */ }
  }
  if (ethBalance !== undefined && ethBalance > 0n) {
    holdings.push({ name: "Ethereum", symbol: "ETH", balance: formatDisplay(formatEther(ethBalance)), iconUrl: ETH_ICON_URL });
  }
  let tokens: ExplorerTokenBalance[] = [];
  if (tokensResult.status === "fulfilled" && tokensResult.value.ok) {
    try {
      const tokenPayload = await tokensResult.value.json();
      if (Array.isArray(tokenPayload)) tokens = tokenPayload as ExplorerTokenBalance[];
    } catch { /* Indexed RPC balances are still usable without explorer JSON. */ }
  }
  try {
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
  } catch { /* Ignore malformed explorer token entries and retain valid holdings. */ }
  const rpcTokens = rpcTokensResult.status === "fulfilled" ? rpcTokensResult.value : [];
    const knownByAddress = new Map(holdings.flatMap((holding, index) => holding.address ? [[holding.address.toLowerCase(), index] as const] : []));
    for (const holding of rpcTokens) {
      if (!holding.address) continue;
      const normalized = holding.address.toLowerCase();
      const existingIndex = knownByAddress.get(normalized);
      if (existingIndex !== undefined) {
        if (!holdings[existingIndex].iconUrl && holding.iconUrl) holdings[existingIndex].iconUrl = holding.iconUrl;
        if (holding.isPonsbotLaunch) holdings[existingIndex].isPonsbotLaunch = true;
        continue;
      }
      holdings.push(holding);
      knownByAddress.set(normalized, holdings.length - 1);
    }
  const available = rpcEthResult.status === "fulfilled"
    || rpcTokensResult.status === "fulfilled"
    || (accountResult.status === "fulfilled" && (accountResult.value.ok || accountResult.value.status === 404))
    || (tokensResult.status === "fulfilled" && (tokensResult.value.ok || tokensResult.value.status === 404));
  for (const holding of holdings) if (STOCK_ICON_DOMAINS[holding.symbol.toUpperCase()]) holding.isPairAsset = true;
  // Balances are the primary wallet-page data. Give pricing a short window,
  // then render balances without USD estimates rather than making a slow
  // third-party price service hold up the whole page.
  const displayedHoldings = await Promise.race([
    enrichHoldingDisplay(holdings),
    new Promise<PublicHolding[]>((resolve) => setTimeout(() => resolve(holdings), 750)),
  ]);
  return { holdings: displayedHoldings, available, username: walletRecord?.username };
}

async function enrichHoldingDisplay(holdings: PublicHolding[]) {
  const enriched = holdings.map((holding) => ({ ...holding }));
  const stockAssets = await fetch("https://api.robinhood.com/rhj/assets", { next: { revalidate: 300 }, signal: AbortSignal.timeout(5_000) })
    .then(async (response) => response.ok ? (await response.json() as { assets?: StockAsset[] }).assets || [] : [])
    .catch(() => [] as StockAsset[]);
  const byAddress = new Map<string, StockAsset>();
  for (const asset of stockAssets) {
    const deployment = asset.deployments?.find((item) => item.chainId === 4663);
    if (deployment) byAddress.set(deployment.contractAddress.toLowerCase(), asset);
  }
  const ethPrice = enriched.some((holding) => holding.symbol === "ETH") ? await ethUsdPrice().catch(() => undefined) : undefined;
  await Promise.all(enriched.map(async (holding) => {
    const balance = Number(holding.balance.replace(/,/g, ""));
    if (!Number.isFinite(balance)) return;
    if (holding.symbol === "ETH") {
      if (ethPrice !== undefined) holding.usdValue = balance * ethPrice;
      return;
    }
    const stock = holding.address ? byAddress.get(holding.address.toLowerCase()) : undefined;
    if (stock) {
      // Robinhood's stock-token artwork can be a generic Robinhood badge.
      // Prefer the recognizable underlying company/asset icon in the wallet.
      holding.iconUrl = stockIconUrl(stock.tokenSymbol) || stock.logoUrl || holding.iconUrl;
      holding.isPairAsset = true;
      const quote = await fetch(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(stock.tokenSymbol)}`, { next: { revalidate: 15 }, signal: AbortSignal.timeout(5_000) })
        .then(async (response) => response.ok ? (await response.json() as { quotes?: Array<{ bid: string; ask: string; generatedAt: string }> }).quotes?.[0] : undefined)
        .catch(() => undefined);
      if (quote && Date.now() - Date.parse(quote.generatedAt) <= 5 * 60_000) {
        const price = ((Number(quote.bid) + Number(quote.ask)) / 2) * Number(stock.currentMultiplier);
        if (Number.isFinite(price) && price >= 0) holding.usdValue = balance * price;
      }
      return;
    }
    if (holding.isPonsbotLaunch && holding.address) {
      const price = await tokenUnitPriceUsd(holding.address as Address).catch(() => undefined);
      if (price !== undefined) holding.usdValue = balance * price;
    }
  }));
  return enriched;
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
