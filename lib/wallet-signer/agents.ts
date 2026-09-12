import { createPublicClient, parseAbi, type Address } from "viem";
import { z } from "zod";
import { resilientRobinhoodHttp } from "../rpc-http";
import { geckoTokenMarkets } from "../gecko-token-market";
import { ethUsdPrice } from "./pricing";
import { provisionWallet } from "./service";
import { tradingAgentCapabilities } from "../trading-agents/config";
import { agentMarketsSchema, type AgentMarkets } from "../trading-agents/market";
import { parseExplorerHoldings } from "../wallet-holdings";

export async function agentWalletHoldings(walletAddress: string, knownTokens: string[]) {
  const response = await fetch(`https://robinhoodchain.blockscout.com/api/v2/addresses/${address.parse(walletAddress)}/token-balances`, { signal: AbortSignal.timeout(8000), cache: "no-store" }).catch(() => null);
  const discovered = response?.ok ? parseExplorerHoldings(await response.json()) : { holdings: [], complete: false };
  const tokens = [...new Set([...knownTokens, ...discovered.holdings.flatMap(t => t.address ? [t.address] : [])].map(t => t.toLowerCase()))];
  const market = await agentMarketSnapshot({ walletAddress, tokens: tokens.slice(0, 100) }).catch(async () => {
    // Owner ETH withdrawals do not depend on a pricing provider's availability.
    const rpc = createPublicClient({ transport: resilientRobinhoodHttp(process.env.ROBINHOOD_RPC_URL) });
    if (await rpc.getChainId() !== 4663) throw new Error("AGENT_WRONG_CHAIN");
    return { cashWei: (await rpc.getBalance({ address: walletAddress as Address })).toString(), observedAt: Date.now(), tokens: [] as AgentMarkets["tokens"] };
  });
  return { cashWei: market.cashWei!, observedAt: market.observedAt, complete: discovered.complete && tokens.length <= 100 && market.tokens.length === tokens.length,
    tokens: market.tokens.filter(t => t.balance && BigInt(t.balance) > 0n).map(t => ({ address: t.address, symbol: t.symbol, decimals: t.decimals, balance: t.balance!, ...(t.priceUsd ? { priceUsd: t.priceUsd } : {}) })) };
}

const agentId = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const identity = z.object({ agentId }).strict();
const marketInput = z.object({ tokens: z.array(address).max(100), walletAddress: address.optional() }).strict();
const tokenAbi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function balanceOf(address) view returns(uint256)"]);
function requireEnabled() { if (!tradingAgentCapabilities().enabled) throw new Error("TRADING_AGENTS_DISABLED"); }

export async function provisionAgentWallet(raw: unknown) {
  requireEnabled();
  if (!tradingAgentCapabilities().walletProvisioning) throw new Error("AGENT_WALLET_PROVISIONING_DISABLED");
  const input = identity.parse(raw);
  // A separate HMAC namespace cannot resolve to any x:<user-id> account.
  return provisionWallet(`agent:${input.agentId}`);
}

/** Live inventory is never synthesized from the simulated portfolio. */
export async function agentLiveContext(raw: unknown) {
  if (!tradingAgentCapabilities().liveTrading) throw new Error("LIVE_DISABLED");
  const input = z.object({ agentId, walletAddress: address, tokens: z.array(address).max(100), minimumBlock: z.string().regex(/^\d+$/).optional() }).strict().parse(raw);
  const wallet = await provisionWallet(`agent:${input.agentId}`);
  if (wallet.address.toLowerCase() !== input.walletAddress.toLowerCase()) throw new Error("BOT_WALLET_MISMATCH");
  if (input.minimumBlock) {
    const client = createPublicClient({ transport: resilientRobinhoodHttp(process.env.ROBINHOOD_RPC_URL) });
    if (await client.getBlockNumber({ cacheTime: 0 }) < BigInt(input.minimumBlock)) throw new Error("AGENT_RPC_BEHIND");
  }
  const inventory = await agentWalletHoldings(input.walletAddress, []);
  const tokens = [...new Set([...inventory.tokens.map(t => t.address), ...input.tokens].map(t => t.toLowerCase()))].slice(0, 100);
  const markets = await agentMarketSnapshot({ walletAddress: input.walletAddress, tokens });
  return { markets, snapshot: { cashWei: markets.cashWei!, observedAt: markets.observedAt,
    complete: inventory.complete && inventory.tokens.every(t => markets.tokens.some(m => m.address === t.address.toLowerCase() && m.balance !== undefined)),
    tokens: markets.tokens.filter(t => t.balance && BigInt(t.balance) > 0n).map(t => ({ token: t.address, amount: t.balance! })) } };
}

/** Final pre-reservation balance check, without another price/discovery round trip. */
export async function agentLiveBalances(raw: unknown) {
  if (!tradingAgentCapabilities().liveTrading) throw new Error("LIVE_DISABLED");
  const input = z.object({ agentId, walletAddress: address, tokens: z.array(address).max(100) }).strict().parse(raw);
  const wallet = await provisionWallet(`agent:${input.agentId}`);
  if (wallet.address.toLowerCase() !== input.walletAddress.toLowerCase()) throw new Error("BOT_WALLET_MISMATCH");
  const client = createPublicClient({ transport: resilientRobinhoodHttp(process.env.ROBINHOOD_RPC_URL) });
  if (await client.getChainId() !== 4663) throw new Error("AGENT_WRONG_CHAIN");
  const tokens = [...new Set(input.tokens.map(t => t.toLowerCase() as Address))];
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const [cash, balances] = await Promise.all([
    client.getBalance({ address: input.walletAddress as Address, blockNumber }),
    tokens.length ? client.multicall({ multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11", blockNumber, allowFailure: false,
      contracts: tokens.map(token => ({ address: token, abi: tokenAbi, functionName: "balanceOf" as const, args: [input.walletAddress as Address] })) }) : Promise.resolve([]),
  ]);
  return { cashWei: cash.toString(), observedAt: Date.now(), complete: true,
    tokens: tokens.flatMap((token, index) => BigInt(balances[index]) > 0n ? [{ token, amount: balances[index].toString() }] : []) };
}

/** Read-only data. This endpoint has no arbitrary call, signing or broadcast operation. */
export async function agentMarketSnapshot(raw: unknown) {
  requireEnabled();
  const input = marketInput.parse(raw), addresses = [...new Set(input.tokens.map(a => a.toLowerCase() as Address))];
  const client = createPublicClient({ transport: resilientRobinhoodHttp(process.env.ROBINHOOD_RPC_URL) });
  if (await client.getChainId() !== 4663) throw new Error("AGENT_WRONG_CHAIN");
  const observedAt = Date.now();
  const [ethUsd, gasPrice, cashWei] = await Promise.all([
    ethUsdPrice(), client.getGasPrice(), input.walletAddress ? client.getBalance({ address: input.walletAddress as Address }) : undefined,
  ]);
  const tokens: AgentMarkets["tokens"] = [];
  for (let offset = 0; offset < addresses.length; offset += 30) {
    const batch = addresses.slice(offset, offset + 30);
    const [markets, metadata] = await Promise.all([
      geckoTokenMarkets(batch, { allowStale: true, ttlMs: 60_000, timeoutMs: 8000, priority: "background" }),
      client.multicall({ multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11", allowFailure: true,
        contracts: batch.flatMap(token => [
          { address: token, abi: tokenAbi, functionName: "symbol" as const },
          { address: token, abi: tokenAbi, functionName: "decimals" as const },
          ...(input.walletAddress ? [{ address: token, abi: tokenAbi, functionName: "balanceOf" as const, args: [input.walletAddress as Address] }] : []),
        ]),
      }),
    ]);
    const stride = input.walletAddress ? 3 : 2;
    batch.forEach((token, index) => {
      const symbol = metadata[index * stride], decimals = metadata[index * stride + 1], balance = metadata[index * stride + 2];
      if (symbol.status !== "success" || decimals.status !== "success") return;
      if (input.walletAddress && balance?.status !== "success") throw new Error("AGENT_BALANCE_UNAVAILABLE");
      const market = markets.get(token);
      tokens.push({ address: token, symbol: String(symbol.result).slice(0, 100), decimals: Number(decimals.result),
        ...(market?.priceUsd && market.priceUsd > 0 ? { priceUsd: market.priceUsd, priceObservedAt: market.observedAt } : {}),
        ...(market?.volume24hUsd !== undefined ? { volume24hUsd: market.volume24hUsd } : {}),
        ...(input.walletAddress ? { balance: String(balance.result) } : {}),
      });
    });
  }
  return agentMarketsSchema.parse({ observedAt, ethUsd, gasPriceWei: gasPrice.toString(), tokens, ...(cashWei === undefined ? {} : { cashWei: cashWei.toString() }) });
}
