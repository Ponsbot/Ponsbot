import { z } from "zod";
import { isSecondaryAgentToken, secondaryTradeAvailable, type TradeMix } from "./universe";
import { isTokenIndexExcluded } from "../token-index-exclusions";
import { BOT_BUY_RESERVE_BPS, TRADING_AGENT_CHAIN_ID } from "./config";

const integer = z.number().int().safe().nonnegative();
const validUnits = (value: string) => /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
export const units = z.string().refine(validUnits, "expected uint256 decimal string");
const positiveUnits = units.refine(value => validUnits(value) && BigInt(value) > 0n, "amount must be positive");
export const tokenAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value => value.toLowerCase());
export const agentPolicySchema = z.object({
  intervalMs: integer.min(60_000).max(86_400_000),
  maxTradeWei: positiveUnits,
  maxDailyTurnoverWei: positiveUnits,
  maxGasPerTradeWei: positiveUnits,
  maxDailyGasWei: positiveUnits,
  reserveWei: units,
  maxPositions: integer.min(1).max(20),
  maxSlippageBps: integer.min(1).max(500),
  maxTradesPerDay: integer.min(1).max(100),
}).strict().refine(p => validUnits(p.maxDailyTurnoverWei) && validUnits(p.maxTradeWei)
  && BigInt(p.maxDailyTurnoverWei) >= BigInt(p.maxTradeWei), "daily turnover below per-trade limit")
  .refine(p => validUnits(p.maxDailyGasWei) && validUnits(p.maxGasPerTradeWei)
    && BigInt(p.maxDailyGasWei) >= BigInt(p.maxGasPerTradeWei), "daily gas below per-trade limit");
export type AgentPolicy = z.infer<typeof agentPolicySchema>;

// Amount is native wei for BUY, token base units for SELL. Never natural language or floating point.
export const agentDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("hold"), reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ action: z.literal("buy"), token: tokenAddress, amount: positiveUnits, reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ action: z.literal("sell"), token: tokenAddress, amount: positiveUnits, reason: z.string().trim().min(1).max(500) }).strict(),
]);
export type AgentDecision = z.infer<typeof agentDecisionSchema>;

export const paperPortfolioSchema = z.object({
  cashWei: units,
  holdings: z.array(z.object({ token: tokenAddress, amount: positiveUnits }).strict()).max(20),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  turnoverWei: units, gasWei: units, trades: integer,
}).strict().refine(p => new Set(p.holdings.map(h => h.token)).size === p.holdings.length, "duplicate holding");
export type PaperPortfolio = z.infer<typeof paperPortfolioSchema>;

// Produced by a trusted quote adapter, NEVER accepted from model options.
export const paperQuoteSchema = z.object({
  chainId: z.literal(TRADING_AGENT_CHAIN_ID), agentId: z.string().min(1).max(128),
  cycleId: z.string().min(1).max(200), policyVersion: integer,
  action: z.enum(["buy", "sell"]), token: tokenAddress, amountIn: positiveUnits,
  amountOut: positiveUnits, minAmountOut: positiveUnits, gasWei: positiveUnits,
  observedAt: integer, expiresAt: integer,
}).strict();
export type PaperQuote = z.infer<typeof paperQuoteSchema>;

export type PlatformTokenEvidence = {
  tokenAddress?: string; launchMode?: string; publicPublished?: boolean; transactionHash?: string;
};
export function isAgentPlatformToken(address: string, launch: PlatformTokenEvidence | null | undefined) {
  const parsed = tokenAddress.safeParse(address);
  return Boolean(parsed.success && parsed.data !== "0x0000000000000000000000000000000000000000"
    && !isSecondaryAgentToken(parsed.data) && !isTokenIndexExcluded(parsed.data) && launch?.publicPublished === true
    && launch.launchMode === "pons" && launch.tokenAddress?.toLowerCase() === parsed.data
    && /^0x[0-9a-fA-F]{64}$/.test(launch.transactionHash ?? ""));
}

export class AgentPolicyError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "AgentPolicyError"; }
}
function requirePolicy(condition: boolean, code: string): asserts condition {
  if (!condition) throw new AgentPolicyError(code);
}

/** Pure paper settlement. No network, signing, transfers, allowances, or real wallet accounting. */
export function settlePaperDecision(input: {
  agentId: string; cycleId: string; policyVersion: number; now: number;
  policy: AgentPolicy; portfolio: PaperPortfolio; decision: unknown;
  quote?: unknown; launch?: PlatformTokenEvidence | null;
  tradeMix?: TradeMix;
}): { portfolio: PaperPortfolio; decision: AgentDecision; quote?: PaperQuote } {
  integer.parse(input.now);
  const policy = agentPolicySchema.parse(input.policy);
  const prior = paperPortfolioSchema.parse(input.portfolio);
  const decision = agentDecisionSchema.parse(input.decision);
  const day = new Date(input.now).toISOString().slice(0, 10);
  // A clock rollback must not reopen yesterday's budget.
  requirePolicy(day >= prior.day, "CLOCK_ROLLBACK");
  const portfolio = day === prior.day ? prior : { ...prior, day, trades: 0, turnoverWei: "0", gasWei: "0" };
  if (decision.action === "hold") return { portfolio, decision };
  requirePolicy(isAgentPlatformToken(decision.token, input.launch) || isSecondaryAgentToken(decision.token), "NOT_ALLOWED_AGENT_TOKEN");
  requirePolicy(!isSecondaryAgentToken(decision.token) || secondaryTradeAvailable(input.tradeMix), "SECONDARY_TRADE_QUOTA");
  const quote = paperQuoteSchema.parse(input.quote);
  requirePolicy(quote.agentId === input.agentId && quote.cycleId === input.cycleId
    && quote.policyVersion === input.policyVersion, "QUOTE_SCOPE_MISMATCH");
  requirePolicy(quote.token === decision.token && quote.action === decision.action && quote.amountIn === decision.amount, "QUOTE_DECISION_MISMATCH");
  requirePolicy(quote.observedAt <= input.now && input.now - quote.observedAt <= 60_000
    && quote.expiresAt > input.now && quote.expiresAt <= quote.observedAt + 60_000, "QUOTE_EXPIRED");
  const amountIn = BigInt(quote.amountIn), amountOut = BigInt(quote.amountOut), minimum = BigInt(quote.minAmountOut);
  const gas = BigInt(quote.gasWei), cash = BigInt(portfolio.cashWei);
  const notional = decision.action === "buy" ? amountIn : amountOut;
  requirePolicy(minimum <= amountOut && minimum * 10_000n >= amountOut * BigInt(10_000 - policy.maxSlippageBps), "SLIPPAGE_LIMIT");
  if (decision.action === "buy") requirePolicy(notional <= BigInt(policy.maxTradeWei), "TRADE_LIMIT");
  requirePolicy(BigInt(portfolio.turnoverWei) + notional <= BigInt(policy.maxDailyTurnoverWei), "DAILY_TURNOVER_LIMIT");
  requirePolicy(gas <= BigInt(policy.maxGasPerTradeWei) && BigInt(portfolio.gasWei) + gas <= BigInt(policy.maxDailyGasWei), "GAS_LIMIT");
  requirePolicy(portfolio.trades < policy.maxTradesPerDay, "DAILY_TRADE_LIMIT");
  const holding = portfolio.holdings.find(h => h.token === decision.token);
  const held = BigInt(holding?.amount ?? "0");
  // Gas must be available BEFORE a sale; sale proceeds cannot fund its initial gas.
  requirePolicy(cash >= gas + BigInt(policy.reserveWei) + (decision.action === "buy" ? amountIn : 0n), "INSUFFICIENT_CASH_AND_GAS");
  if (decision.action === "buy") requirePolicy(amountIn <= cash * BigInt(BOT_BUY_RESERVE_BPS) / 10_000n, "ETH_RESERVE_BUY_LIMIT");
  if (decision.action === "sell") requirePolicy(held >= amountIn, "INSUFFICIENT_TOKEN_BALANCE");
  else requirePolicy(Boolean(holding) || portfolio.holdings.length < policy.maxPositions, "POSITION_LIMIT");
  const balance = decision.action === "buy" ? held + amountOut : held - amountIn;
  const holdings = portfolio.holdings.filter(h => h.token !== decision.token);
  if (balance > 0n) holdings.push({ token: decision.token, amount: balance.toString() });
  return { decision, quote, portfolio: paperPortfolioSchema.parse({
    cashWei: (decision.action === "buy" ? cash - amountIn - gas : cash + amountOut - gas).toString(), holdings,
    day, trades: portfolio.trades + 1,
    turnoverWei: (BigInt(portfolio.turnoverWei) + notional).toString(),
    gasWei: (BigInt(portfolio.gasWei) + gas).toString(),
  }) };
}
