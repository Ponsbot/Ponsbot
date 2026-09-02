import "server-only";
import { ConvexHttpClient } from "convex/browser";
import { unstable_cache } from "next/cache";
import { readPublicMarketStates } from "./public-display-cache";
import { createPublicClient, formatEther, formatUnits, isAddress, parseAbi, type Address } from "viem";
import { api } from "@/convex/_generated/api";
import { tokenUnitPriceUsd, type MarketInfrastructure } from "@/lib/token-market-cap";
import { ethUsdPrice } from "@/lib/wallet-signer/pricing";
import { reliableHttp, retryingRpcFetch } from "@/lib/rpc-http";
import { mergeWalletTokenHoldings, parseExplorerHoldings, walletBalanceTokens, type PublicHolding, type KnownWalletToken, type RpcTokenHoldings } from "./wallet-holdings";
export type { PublicHolding } from "./wallet-holdings";

export type PublicLaunch = {
  name: string; symbol: string; imageUri: string; description?: string;
  website?: string; twitter?: string; telegram?: string; tokenAddress?: string;
  transactionHash: string; devBuySucceeded?: boolean; creatorAddress?: string; createdAt: number;
  pairToken?: string; pairSymbol?: string; poolAddress?: string; launcherUsername?: string; marketCapUsd?: number; marketCapUpdatedAt?: number; lastBuyAt?: number; storedMarketCapUsd?: number; volume24hUsd?: number; volume24hUpdatedAt?: number; graduated?: boolean; graduationUpdatedAt?: number;
  launchPostUrl?: string;
  creatorFeeRecipient?: string; feeRecipientUsername?: string; holderFeeSharing?: boolean; feesReassignedAt?: number;
  automatedFeeBuybackEnabled?: boolean;
};

export class SiteDataUnavailableError extends Error {}

export async function listLaunches(limit = 24): Promise<PublicLaunch[]> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new SiteDataUnavailableError("Public site data is not configured");
  try {
    const client = new ConvexHttpClient(url);
    const launches = await client.query(api.site.listLaunches, { limit });
    return launches.map((launch) => launch.storedMarketCapUsd === undefined ? launch : { ...launch, marketCapUsd: launch.storedMarketCapUsd });
  } catch (error) {
    console.error("public_launch_list_failed", error instanceof Error ? error.message : "unknown");
    throw new SiteDataUnavailableError("Launch data is temporarily unavailable");
  }
}

export async function highestMarketCapLaunches(): Promise<PublicLaunch[]> {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new SiteDataUnavailableError("Public site data is not configured");
  const result = await new ConvexHttpClient(url).query(api.site.listLaunchesPage, {
    paginationOpts: { cursor: null, numItems: 20 }, sort: "mcap",
  });
  return result.page;
}

export type PlatformStats = {
  launches: number;
  wallets: number;
  lifetimeVolumeUsd: number;
  lifetimeVolumeCoverage: number;
  feesClaimed: Array<{ symbol: string; amount: number }>;
  feesClaimedUsd: number;
  feeValuationVersion?: number;
  feeClaimsUnpriced?: number;
  feeClaimTransactions: number;
  marketUpdatedAt: number;
};

const cachedPlatformStats = unstable_cache(async (): Promise<PlatformStats> => {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new SiteDataUnavailableError("Public site data is not configured");
  const client = new ConvexHttpClient(url);
  const stats = await client.query(api.site.platformStats, {});
  return {
    ...stats,
    lifetimeVolumeUsd: finiteStat(stats.lifetimeVolumeUsd),
    lifetimeVolumeCoverage: finiteStat(stats.lifetimeVolumeCoverage),
    feesClaimedUsd: finiteStat(stats.feesClaimedUsd),
  };
}, ["public-platform-stats-v6-historical-fees"], { revalidate: 5 * 60 });

function finiteStat(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function getPlatformStats(): Promise<PlatformStats> {
  try {
    return await cachedPlatformStats();
  } catch (error) {
    console.error("public_platform_stats_failed", error instanceof Error ? error.message : "unknown");
    throw new SiteDataUnavailableError("Platform statistics are temporarily unavailable");
  }
}

export async function getLaunch(tokenAddress: string): Promise<PublicLaunch | null> {
  if (!isAddress(tokenAddress)) return null;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new SiteDataUnavailableError("Public site data is not configured");
  try {
    const client = new ConvexHttpClient(url);
    const launch = await client.query(api.site.getLaunch, { tokenAddress });
    if (!launch) return null;
    return launch.storedMarketCapUsd === undefined ? launch : { ...launch, marketCapUsd: launch.storedMarketCapUsd };
  } catch (error) {
    console.error("public_launch_lookup_failed", error instanceof Error ? error.message : "unknown");
    throw new SiteDataUnavailableError("Launch data is temporarily unavailable");
  }
}

export type PublicWalletRecord = { address: string; createdAt: number; username?: string; tokens?: KnownWalletToken[] };
type StockAsset = { tokenSymbol: string; tokenName: string; currentMultiplier: string; logoUrl?: string; deployments?: Array<{ contractAddress: string; chainId: number }> };
const ETH_ICON_URL = "https://cryptologos.cc/logos/ethereum-eth-logo.png";
const STOCK_ICON_DOMAINS: Record<string, string> = {
  NVDA: "nvidia.com", SPCX: "spacex.com", GOOGL: "google.com", TSLA: "tesla.com", RIVN: "rivian.com",
  GME: "gamestop.com", AAPL: "apple.com", SPY: "ssga.com", SNDK: "sandisk.com",
  AMD: "amd.com", AMZN: "amazon.com", MSFT: "microsoft.com", META: "meta.com",
  CRCL: "circle.com", COIN: "coinbase.com", MU: "micron.com", PLTR: "palantir.com",
  TTWO: "take2games.com", COST: "costco.com", DJT: "tmtgcorp.com", MSTR: "strategy.com",
  QQQ: "invesco.com", RDDT: "reddit.com",
  USDG: "globaldollar.com",
  CBBTC: "coinbase.com",
  HIMS: "hims.com",
  BB: "blackberry.com",
  GLD: "spdrgoldshares.com",
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
  "function totalSupply() view returns (uint256)",
]);

async function indexedTokenHoldings(wallet: Address, tokens: KnownWalletToken[]): Promise<RpcTokenHoldings> {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  const client = createPublicClient({ transport: reliableHttp(rpcUrl, { batch: true, timeout: 8_000, fetchOptions: { signal: AbortSignal.timeout(8_000) } }) });
  const zeroAddresses: string[] = [];
  let complete = true;
  const results = await Promise.all(tokens.map(async (token): Promise<PublicHolding | undefined> => {
    try {
      const tokenAddress = token.address as Address;
      const balance = await client.readContract({ address: tokenAddress, abi: publicTokenAbi, functionName: "balanceOf", args: [wallet] });
      if (balance <= 0n) { zeroAddresses.push(token.address.toLowerCase()); return undefined; }
      const [decimals, symbol, name] = await Promise.all([
        client.readContract({ address: tokenAddress, abi: publicTokenAbi, functionName: "decimals" }),
        client.readContract({ address: tokenAddress, abi: publicTokenAbi, functionName: "symbol" }).catch(() => token.symbol),
        client.readContract({ address: tokenAddress, abi: publicTokenAbi, functionName: "name" }).catch(() => token.symbol),
      ]);
      return { address: token.address, name: name || symbol, symbol, balance: formatDisplay(formatUnits(balance, decimals)), iconUrl: token.iconUrl, isPonsbotLaunch: token.isPonsbotLaunch };
    } catch {
      complete = false;
      return undefined;
    }
  }));
  return { holdings: results.filter((holding): holding is PublicHolding => Boolean(holding)), zeroAddresses, complete };
}

async function rpcEthBalance(address: string) {
  const response = await retryingRpcFetch(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", {
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

export async function getPonsbotWallet(address: string): Promise<PublicWalletRecord | null> {
  if (!isAddress(address)) return null;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new SiteDataUnavailableError("Public site data is not configured");
  try {
    return await new ConvexHttpClient(url).query(api.site.getWallet, { address }) as PublicWalletRecord | null;
  } catch {
    throw new SiteDataUnavailableError("Wallet data is temporarily unavailable");
  }
}

export async function isPonsbotWallet(address: string) {
  return Boolean(await getPonsbotWallet(address));
}

export async function getWalletHoldings(
  address: string,
  knownWallet?: PublicWalletRecord,
  options?: { pricingWaitMs?: number },
): Promise<{ holdings: PublicHolding[]; available: boolean; username?: string }> {
  if (!isAddress(address)) return { holdings: [], available: false };
  const base = "https://robinhoodchain.blockscout.com/api/v2";
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const walletRecord = knownWallet ?? (convexUrl
    ? await new ConvexHttpClient(convexUrl).query(api.site.getWallet, { address }).catch(() => null) as PublicWalletRecord | null
    : null);
  const knownTokens = walletBalanceTokens(walletRecord?.tokens);
  const [accountResult, tokensResult, rpcEthResult, rpcTokensResult] = await Promise.allSettled([
    fetch(`${base}/addresses/${address}`, { next: { revalidate: 20 }, signal: AbortSignal.timeout(8_000) }),
    fetch(`${base}/addresses/${address}/tokens?type=ERC-20`, { next: { revalidate: 20 }, signal: AbortSignal.timeout(8_000) }),
    rpcEthBalance(address),
    indexedTokenHoldings(address as Address, knownTokens),
  ]);
  const holdings: PublicHolding[] = [];
  let ethBalance = rpcEthResult.status === "fulfilled" ? rpcEthResult.value : undefined;
  if (accountResult.status === "fulfilled" && accountResult.value.ok) {
    try {
      const account = await accountResult.value.json() as { coin_balance?: string };
      if (ethBalance === undefined && account.coin_balance && /^\d+$/.test(account.coin_balance)) ethBalance = BigInt(account.coin_balance);
    } catch { /* The RPC result remains authoritative when explorer JSON is malformed. */ }
  }
  if (ethBalance !== undefined && ethBalance > 0n) {
    holdings.push({ name: "Ethereum", symbol: "ETH", balance: formatDisplay(formatEther(ethBalance)), iconUrl: ETH_ICON_URL });
  }
  let explorerTokens: ReturnType<typeof parseExplorerHoldings> = { holdings: [], complete: false };
  if (tokensResult.status === "fulfilled" && tokensResult.value.ok) {
    try {
      explorerTokens = parseExplorerHoldings(await tokensResult.value.json());
    } catch { /* Indexed RPC balances are still usable without explorer JSON. */ }
  }
  const rpcTokens = rpcTokensResult.status === "fulfilled" ? rpcTokensResult.value : { holdings: [], zeroAddresses: [], complete: false };
  holdings.push(...mergeWalletTokenHoldings(explorerTokens.holdings.map(holding => ({ ...holding, balance: formatDisplay(holding.balance) })), rpcTokens, knownTokens));
  // A zero ETH balance or an empty/failed RPC token scan cannot establish that
  // all tokens are absent. Only a complete discovery plus balance reads can.
  const available = holdings.length > 0 || ethBalance !== undefined && explorerTokens.complete && rpcTokens.complete;
  for (const holding of holdings) if (STOCK_ICON_DOMAINS[holding.symbol.toUpperCase()]) holding.isPairAsset = true;
  // Balances are the primary wallet-page data. Give pricing a short window,
  // then render balances without USD estimates rather than making a slow
  // third-party price service hold up the whole page.
  const pricingController = new AbortController();
  const pricingWaitMs = Math.max(250, Math.min(options?.pricingWaitMs ?? 750, 8_000));
  const displayedHoldings = await Promise.race([
    enrichHoldingDisplay(holdings, pricingController.signal),
    new Promise<PublicHolding[]>((resolve) => setTimeout(() => resolve(holdings), pricingWaitMs)),
  ]);
  pricingController.abort();
  return { holdings: displayedHoldings, available, username: walletRecord?.username };
}

async function enrichHoldingDisplay(holdings: PublicHolding[], signal: AbortSignal) {
  const enriched = holdings.map((holding) => ({ ...holding }));
  const stockAssets = await fetch("https://api.robinhood.com/rhj/assets", { next: { revalidate: 300 }, signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) })
    .then(async (response) => response.ok ? (await response.json() as { assets?: StockAsset[] }).assets || [] : [])
    .catch(() => [] as StockAsset[]);
  const byAddress = new Map<string, StockAsset>();
  for (const asset of stockAssets) {
    const deployment = asset.deployments?.find((item) => item.chainId === 4663);
    if (deployment) byAddress.set(deployment.contractAddress.toLowerCase(), asset);
  }
  if (signal.aborted) return enriched;
  let marketInfrastructure: MarketInfrastructure | undefined;
  const launchAddresses = enriched.flatMap((holding) => holding.isPonsbotLaunch && holding.address ? [holding.address] : []);
  const storedLaunchPrices = new Map<string, number>();
  if (launchAddresses.length) {
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    const convex = convexUrl ? new ConvexHttpClient(convexUrl) : null;
    const [runtime, marketStates] = convex ? await Promise.all([
      convex.query(api.site.marketRuntimeConfig, {}).catch(() => null),
      readPublicMarketStates(convexUrl!, launchAddresses.slice(0, 50)).catch(() => []),
    ]) : [null, []];
    if (runtime?.factory && runtime.stateView) marketInfrastructure = { factory: runtime.factory as Address, stateView: runtime.stateView as Address };
    for (const market of marketStates) {
      if (typeof market.marketCapUsd === "number" && Number.isFinite(market.marketCapUsd)) {
        storedLaunchPrices.set(market.tokenAddress.toLowerCase(), market.marketCapUsd);
      }
    }
  }
  const ethPrice = enriched.some((holding) => holding.symbol === "ETH") ? await ethUsdPrice(signal).catch(() => undefined) : undefined;
  await Promise.all(enriched.map(async (holding) => {
    if (signal.aborted) return;
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
      const quote = await fetch(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(stock.tokenSymbol)}`, { next: { revalidate: 15 }, signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) })
        .then(async (response) => response.ok ? (await response.json() as { quotes?: Array<{ bid: string; ask: string; generatedAt: string }> }).quotes?.[0] : undefined)
        .catch(() => undefined);
      if (quote && Date.now() - Date.parse(quote.generatedAt) <= 5 * 60_000) {
        const price = ((Number(quote.bid) + Number(quote.ask)) / 2) * Number(stock.currentMultiplier);
        if (Number.isFinite(price) && price >= 0) holding.usdValue = balance * price;
      }
      return;
    }
    if (holding.isPonsbotLaunch && holding.address) {
      if (signal.aborted) return;
      const storedMarketCap = storedLaunchPrices.get(holding.address.toLowerCase());
      let price: number | undefined;
      if (storedMarketCap !== undefined) {
        const client = createPublicClient({ transport: reliableHttp(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { batch: true }) });
        const [supplyRaw, decimals] = await Promise.all([
          client.readContract({ address: holding.address as Address, abi: publicTokenAbi, functionName: "totalSupply" }),
          client.readContract({ address: holding.address as Address, abi: publicTokenAbi, functionName: "decimals" }),
        ]).catch(() => [0n, 18] as const);
        const supply = Number(formatUnits(supplyRaw, decimals));
        if (Number.isFinite(supply) && supply > 0) price = storedMarketCap / supply;
      }
      if (price === undefined) price = await tokenUnitPriceUsd(holding.address as Address, signal, marketInfrastructure).catch(() => undefined);
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

// Retain the existing server-page import without exposing data/cache code to clients.
export { shortAddress } from "./address-display";

export const explorerAddress = (address: string) => `https://robinhoodchain.blockscout.com/address/${address}`;
export const explorerToken = (address: string) => `https://robinhoodchain.blockscout.com/token/${address}`;
