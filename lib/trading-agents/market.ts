import { z } from "zod";
import { parseUnits } from "viem";
import { units, tokenAddress, type AgentDecision, type PaperQuote } from "./policy";

export const agentMarketsSchema = z.object({
  observedAt: z.number().int().positive(), ethUsd: z.number().finite().positive(), gasPriceWei: units,
  tokens: z.array(z.object({ address: tokenAddress, symbol: z.string().min(1).max(100), decimals: z.number().int().min(0).max(255),
    priceUsd: z.number().finite().positive().optional(), volume24hUsd: z.number().finite().nonnegative().optional(),
    priceObservedAt: z.number().int().positive().optional(), balance: units.optional(),
  }).strict()).max(100), cashWei: units.optional(),
}).strict();
export type AgentMarkets = z.infer<typeof agentMarketsSchema>;

/** Mark-price paper fill, not a routed on-chain execution quote or liquidity guarantee. */
export function paperMarketQuote(markets: AgentMarkets, decision: Exclude<AgentDecision, { action: "hold" }>, scope: { agentId: string; cycleId: string; policyVersion: number }, now: number): PaperQuote {
  const data = agentMarketsSchema.parse(markets), asset = data.tokens.find(t => t.address === decision.token);
  if (!asset?.priceUsd || !asset.priceObservedAt || asset.priceObservedAt > now || now - asset.priceObservedAt > 60_000
    || data.observedAt > now || now - data.observedAt > 60_000) throw new Error("AGENT_MARKET_STALE");
  const tokenPrice = parseUnits(asset.priceUsd.toFixed(18), 18), ethPrice = parseUnits(data.ethUsd.toFixed(18), 18);
  if (tokenPrice <= 0n || ethPrice <= 0n) throw new Error("AGENT_PRICE_TOO_SMALL");
  const input = BigInt(units.parse(decision.amount)), scale = 10n ** BigInt(asset.decimals);
  const fair = decision.action === "buy" ? input * ethPrice * scale / (10n ** 18n * tokenPrice)
    : input * tokenPrice * 10n ** 18n / (scale * ethPrice);
  // Explicit 1% paper execution haircut; real execution must use a routed quote.
  const amountOut = fair * 99n / 100n;
  if (amountOut <= 0n) throw new Error("AGENT_QUOTE_ZERO");
  return { ...scope, chainId: 4663, action: decision.action, token: decision.token, amountIn: decision.amount,
    amountOut: amountOut.toString(), minAmountOut: (amountOut * 99n / 100n).toString(),
    gasWei: (BigInt(data.gasPriceWei) * 300_000n * 11n / 10n).toString(), observedAt: now, expiresAt: now + 30_000 };
}
