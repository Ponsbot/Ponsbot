import { createPublicClient, encodeAbiParameters, formatUnits, http, keccak256, parseAbi, zeroAddress, type Address } from "viem";
import { ethUsdPrice } from "@/lib/wallet-signer/pricing";
import { rememberSharedPrice, sharedPrice } from "./shared-price-cache";
import type { PublicLaunch } from "@/lib/site-data";

const DEFAULT_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address;
const DEFAULT_STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as Address;
const CACHE_MS = 60_000;
const PREVIEW_TOKEN = "0x0000000000000000000000000000000000000a11";
const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) launched)",
  "function memeHook() view returns (address)",
]);
const curveAbi = parseAbi(["function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)"]);
const erc20Abi = parseAbi(["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const stateViewAbi = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)"]);
const marketCapCache = new Map<string, { value?: number; expiresAt: number }>();

function rpcClient(signal?: AbortSignal) {
  return createPublicClient({ batch: { multicall: true }, transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 8_000, ...(signal ? { fetchOptions: { signal } } : {}) }) });
}

export type MarketInfrastructure = { factory: Address; stateView: Address };

function marketInfrastructure(input?: MarketInfrastructure): MarketInfrastructure {
  return input || {
    factory: (process.env.PONS_V2_FACTORY_ADDRESS || DEFAULT_FACTORY) as Address,
    stateView: (process.env.PONS_V4_STATE_VIEW_ADDRESS || DEFAULT_STATE_VIEW) as Address,
  };
}

export async function addMarketCaps<T extends PublicLaunch>(launches: T[], infrastructure?: MarketInfrastructure): Promise<T[]> {
  return await Promise.all(launches.map(async (launch) => {
    if (!launch.tokenAddress || !/^0x[a-fA-F0-9]{40}$/.test(launch.tokenAddress)) return launch;
    if (launch.tokenAddress.toLowerCase() === PREVIEW_TOKEN) return { ...launch, marketCapUsd: 125_000, marketCapUpdatedAt: Date.now() };
    if (launch.marketCapUsd !== undefined && launch.marketCapUpdatedAt !== undefined && Date.now() - launch.marketCapUpdatedAt < CACHE_MS) return launch;
    try {
      const marketCapUsd = await tokenMarketCapUsd(launch.tokenAddress as Address, undefined, undefined, infrastructure);
      return marketCapUsd === undefined ? launch : { ...launch, marketCapUsd, marketCapUpdatedAt: Date.now() };
    } catch (error) {
      console.error("token_market_cap_failed", launch.tokenAddress, error instanceof Error ? error.message : "unknown");
      return launch;
    }
  }));
}

export async function tokenMarketCapUsd(token: Address, blockNumber?: bigint, signal?: AbortSignal, configured?: MarketInfrastructure) {
  signal?.throwIfAborted();
  const key = token.toLowerCase();
  const existing = marketCapCache.get(key);
  if (blockNumber === undefined && existing && existing.expiresAt > Date.now()) return existing.value;
  const rpc = rpcClient(signal);
  const infrastructure = marketInfrastructure(configured);
  const launched = await rpc.readContract({ address: infrastructure.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [token], blockNumber });
  if (!launched.exists || launched.phase === 1 || launched.phase === 3) return remember(key, undefined);
  const [supplyRaw, tokenDecimals, quote] = await Promise.all([
    rpc.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply", blockNumber }),
    rpc.readContract({ address: token, abi: erc20Abi, functionName: "decimals", blockNumber }),
    quoteDetails(rpc, launched.pairToken, signal),
  ]);
  const supply = Number(formatUnits(supplyRaw, tokenDecimals));
  let tokenPriceInQuote: number;
  if (launched.phase === 0) {
    const [quoteReserve, tokenReserve] = await rpc.readContract({ address: launched.curve, abi: curveAbi, functionName: "getReserves", blockNumber });
    tokenPriceInQuote = Number(formatUnits(quoteReserve, quote.decimals)) / Number(formatUnits(tokenReserve, tokenDecimals));
  } else {
    const hook = await rpc.readContract({ address: infrastructure.factory, abi: factoryAbi, functionName: "memeHook", blockNumber });
    const [currency0, currency1] = launched.pairToken.toLowerCase() < token.toLowerCase() ? [launched.pairToken, token] : [token, launched.pairToken];
    const poolId = keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, launched.poolFee, launched.tickSpacing, hook],
    ));
    const [sqrtPriceX96] = await rpc.readContract({ address: infrastructure.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId], blockNumber });
    const rawCurrency1Per0 = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
    const tokenIsCurrency0 = token.toLowerCase() === currency0.toLowerCase();
    tokenPriceInQuote = tokenIsCurrency0
      ? rawCurrency1Per0 * 10 ** (tokenDecimals - quote.decimals)
      : (1 / rawCurrency1Per0) * 10 ** (tokenDecimals - quote.decimals);
  }
  const value = supply * tokenPriceInQuote * quote.usd;
  const valid = Number.isFinite(value) && value >= 0 ? value : undefined;
  return blockNumber === undefined ? remember(key, valid) : valid;
}

export async function tokenUnitPriceUsd(token: Address, signal?: AbortSignal, infrastructure?: MarketInfrastructure) {
  signal?.throwIfAborted();
  const [marketCap, supplyRaw, decimals] = await Promise.all([
    tokenMarketCapUsd(token, undefined, signal, infrastructure),
    rpcClient(signal).readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
    rpcClient(signal).readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  const supply = Number(formatUnits(supplyRaw, decimals));
  if (marketCap === undefined || !Number.isFinite(supply) || supply <= 0) return undefined;
  return marketCap / supply;
}

function remember(key: string, value?: number) {
  marketCapCache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
  return value;
}

async function quoteDetails(rpc: ReturnType<typeof rpcClient>, pairToken: Address, signal?: AbortSignal) {
  if (pairToken === zeroAddress) return { decimals: 18, usd: await ethUsdPrice(signal) };
  const [decimals, symbol] = await Promise.all([
    rpc.readContract({ address: pairToken, abi: erc20Abi, functionName: "decimals" }),
    rpc.readContract({ address: pairToken, abi: erc20Abi, functionName: "symbol" }),
  ]);
  const cachedUsd = await sharedPrice(`pair-usd:${symbol.toUpperCase()}`);
  if (cachedUsd && Number.isFinite(cachedUsd) && cachedUsd > 0) return { decimals, usd: cachedUsd };
  const [assetResponse, priceResponse] = await Promise.all([
    fetch("https://api.robinhood.com/rhj/assets", { next: { revalidate: 300 }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000) }),
    fetch(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(symbol)}`, { next: { revalidate: 15 }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000) }),
  ]);
  if (!assetResponse.ok || !priceResponse.ok) throw new Error("paired asset price is unavailable");
  const assets = await assetResponse.json() as { assets?: Array<{ tokenSymbol: string; currentMultiplier: string; deployments?: Array<{ contractAddress: string; chainId: number }> }> };
  const prices = await priceResponse.json() as { quotes?: Array<{ bid: string; ask: string; generatedAt: string }> };
  const asset = assets.assets?.find((item) => item.tokenSymbol === symbol && item.deployments?.some((deployment) => deployment.chainId === 4663 && deployment.contractAddress.toLowerCase() === pairToken.toLowerCase()));
  const quote = prices.quotes?.[0];
  if (!asset || !quote || Date.now() - Date.parse(quote.generatedAt) > 5 * 60_000) throw new Error("paired asset price is stale or unverified");
  const usd = ((Number(quote.bid) + Number(quote.ask)) / 2) * Number(asset.currentMultiplier);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("paired asset price is invalid");
  await rememberSharedPrice(`pair-usd:${symbol.toUpperCase()}`, usd, Date.parse(quote.generatedAt), 15_000);
  return { decimals, usd };
}
