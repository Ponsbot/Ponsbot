import { describe, expect, it } from "vitest";
import { tradingAgentCapabilities } from "../lib/trading-agents/config";
import { agentDecisionSchema, agentPolicySchema, isAgentPlatformToken, paperPortfolioSchema, settlePaperDecision, units,
  type AgentPolicy, type PaperPortfolio, type PaperQuote } from "../lib/trading-agents/policy";

const token = "0x1111111111111111111111111111111111111111";
const now = Date.parse("2026-09-12T12:00:00Z");
const policy: AgentPolicy = { intervalMs: 60_000, maxTradeWei: "1000", maxDailyTurnoverWei: "3000",
  maxGasPerTradeWei: "20", maxDailyGasWei: "100", reserveWei: "100", maxPositions: 2, maxSlippageBps: 100, maxTradesPerDay: 5 };
const portfolio: PaperPortfolio = { cashWei: "10000", holdings: [], day: "2026-09-12", turnoverWei: "0", gasWei: "0", trades: 0 };
const launch = { tokenAddress: token, publicPublished: true, launchMode: "pons", transactionHash: `0x${"a".repeat(64)}` };
const decision = { action: "buy" as const, token, amount: "200", reason: "Test decision" };
const quote: PaperQuote = { chainId: 4663, agentId: "agent", cycleId: "cycle", policyVersion: 1,
  action: "buy", token, amountIn: "200", amountOut: "5000", minAmountOut: "4990", gasWei: "10", observedAt: now - 1000, expiresAt: now + 10_000 };
const input = () => ({ agentId: "agent", cycleId: "cycle", policyVersion: 1, now, policy, portfolio, decision, quote, launch });

describe("trading agent staging", () => {
  it("is off by default", () => expect(tradingAgentCapabilities({}).paperTrading).toBe(false));
  it.each(["1", "TRUE", "yes", " true ", "false"])("rejects implicit enablement %s", value =>
    expect(tradingAgentCapabilities({ TRADING_AGENTS_ENABLED: value, TRADING_AGENTS_PAPER_ENABLED: "true" }).paperTrading).toBe(false));
  it("enables live capability only with both explicit gates", () => {
    expect(tradingAgentCapabilities({ TRADING_AGENTS_ENABLED: "true", TRADING_AGENTS_PAPER_ENABLED: "true", TRADING_AGENTS_LIVE_ENABLED: "true" }))
      .toEqual({ enabled: true, paperTrading: true, liveTrading: true, publicCommands: false, walletProvisioning: false, website: false, scheduler: false });
  });
});

describe("platform-only universe", () => {
  it("accepts an indexed public platform launch by address", () => expect(isAgentPlatformToken(token.toUpperCase().replace("0X", "0x"), launch)).toBe(true));
  it.each([null, {}, { ...launch, publicPublished: false }, { ...launch, launchMode: "external" },
    { ...launch, tokenAddress: `0x${"2".repeat(40)}` }, { ...launch, transactionHash: "pending" }])("rejects non-platform evidence %#", evidence => {
    expect(isAgentPlatformToken(token, evidence)).toBe(false);
    expect(() => settlePaperDecision({ ...input(), launch: evidence })).toThrow("NOT_PONS_BOT_PLATFORM_TOKEN");
  });
  it("rejects excluded launches even if a stale public record remains", () => {
    const excluded = "0xdf1f5f5afce9ced806f753783d7103301708eb07";
    expect(isAgentPlatformToken(excluded, { ...launch, tokenAddress: excluded })).toBe(false);
  });
  it("rejects ETH as a token target", () => expect(isAgentPlatformToken(`0x${"0".repeat(40)}`, { ...launch, tokenAddress: `0x${"0".repeat(40)}` })).toBe(false));
});

describe("decision validation", () => {
  it.each(["send", "burn", "launch", "approve", "bridge", "withdraw", "setPolicy"])("does not provide %s", action =>
    expect(agentDecisionSchema.safeParse({ ...decision, action }).success).toBe(false));
  it.each(["recipient", "ownerXUserId", "walletAddress", "maxTradeWei", "quote", "calldata"])("rejects model override %s", key =>
    expect(agentDecisionSchema.safeParse({ ...decision, [key]: "override" }).success).toBe(false));
  it.each(["-1", "1.5", "1e18", "01", " 1", "0x10", "NaN", (2n ** 256n).toString()])("rejects unsafe integer %s", value =>
    expect(units.safeParse(value).success).toBe(false));
  it("rejects zero trades", () => expect(agentDecisionSchema.safeParse({ ...decision, amount: "0" }).success).toBe(false));
  it.each(["NaN", "1e18", "-3", "1.5"])("invalid policy and decision amounts do not escape safeParse: %s", value => {
    expect(agentPolicySchema.safeParse({ ...policy, maxTradeWei: value }).success).toBe(false);
    expect(agentDecisionSchema.safeParse({ ...decision, amount: value }).success).toBe(false);
  });
  it("rejects duplicate holdings", () => expect(paperPortfolioSchema.safeParse({ ...portfolio, holdings: [{ token, amount: "1" }, { token, amount: "2" }] }).success).toBe(false));
  it.each([{ intervalMs: 0 }, { maxPositions: 21 }, { maxSlippageBps: 10000 }, { maxTradeWei: "3001" }, { maxDailyGasWei: "1" }])("rejects invalid policy %#", change =>
    expect(agentPolicySchema.safeParse({ ...policy, ...change }).success).toBe(false));
});

describe("paper-only settlement", () => {
  it("buys using exact cash and modeled gas without mutating its inputs", () => {
    const settled = settlePaperDecision(input());
    expect(settled.portfolio).toEqual({ cashWei: "9790", holdings: [{ token, amount: "5000" }], day: "2026-09-12", turnoverWei: "200", gasWei: "10", trades: 1 });
    expect(portfolio.holdings).toEqual([]);
  });
  it("holds without requiring a quote or paying paper gas", () => {
    expect(settlePaperDecision({ ...input(), decision: { action: "hold", reason: "No opportunity" }, quote: undefined, launch: null }).portfolio).toEqual(portfolio);
  });
  it("sells only held tokens and removes empty positions", () => {
    const bought = settlePaperDecision(input()).portfolio;
    const sold = settlePaperDecision({ ...input(), portfolio: bought, decision: { ...decision, action: "sell", amount: "5000" },
      quote: { ...quote, action: "sell", amountIn: "5000", amountOut: "210", minAmountOut: "208" } });
    expect(sold.portfolio).toEqual({ ...portfolio, cashWei: "9990", turnoverWei: "410", gasWei: "20", trades: 2 });
  });
  it.each([
    [{ agentId: "other" }, "QUOTE_SCOPE_MISMATCH"], [{ cycleId: "other" }, "QUOTE_SCOPE_MISMATCH"],
    [{ policyVersion: 2 }, "QUOTE_SCOPE_MISMATCH"], [{ token: `0x${"3".repeat(40)}` }, "QUOTE_DECISION_MISMATCH"],
    [{ amountIn: "201" }, "QUOTE_DECISION_MISMATCH"], [{ action: "sell" }, "QUOTE_DECISION_MISMATCH"],
    [{ expiresAt: now }, "QUOTE_EXPIRED"], [{ observedAt: now + 1 }, "QUOTE_EXPIRED"],
    [{ observedAt: now - 60_001 }, "QUOTE_EXPIRED"], [{ expiresAt: now + 100_000 }, "QUOTE_EXPIRED"],
    [{ minAmountOut: "1" }, "SLIPPAGE_LIMIT"], [{ minAmountOut: "5001" }, "SLIPPAGE_LIMIT"],
    [{ gasWei: "21" }, "GAS_LIMIT"],
  ])("rejects invalid quote %#", (change, error) => expect(() => settlePaperDecision({ ...input(), quote: { ...quote, ...change as object } })).toThrow(String(error)));
  it("rejects wrong chain", () => expect(() => settlePaperDecision({ ...input(), quote: { ...quote, chainId: 1 } })).toThrow());
  it.each([
    [{ turnoverWei: "2900" }, "DAILY_TURNOVER_LIMIT"], [{ gasWei: "99" }, "GAS_LIMIT"],
    [{ trades: 5 }, "DAILY_TRADE_LIMIT"], [{ cashWei: "309" }, "INSUFFICIENT_CASH_AND_GAS"],
    [{ day: "2026-09-13" }, "CLOCK_ROLLBACK"],
  ])("enforces portfolio limits %#", (change, error) => expect(() => settlePaperDecision({ ...input(), portfolio: { ...portfolio, ...change as object } })).toThrow(String(error)));
  it("enforces the per-trade cap", () => expect(() => settlePaperDecision({ ...input(), policy: { ...policy, maxTradeWei: "199" } })).toThrow("TRADE_LIMIT"));
  it("enforces 20% of the current ETH cash, not a stale initial budget", () => {
    expect(() => settlePaperDecision({ ...input(), portfolio: { ...portfolio, cashWei: "999" } })).toThrow("ETH_RESERVE_BUY_LIMIT");
    expect(settlePaperDecision({ ...input(), portfolio: { ...portfolio, cashWei: "1000" } }).portfolio.cashWei).toBe("790");
  });
  it("can sell an entire position even when its proceeds exceed the per-buy cap", () => {
    const sold = settlePaperDecision({ ...input(), portfolio: { ...portfolio, holdings: [{ token, amount: "5000" }] },
      decision: { ...decision, action: "sell", amount: "5000" }, quote: { ...quote, action: "sell", amountIn: "5000", amountOut: "2000", minAmountOut: "1990" } });
    expect(sold.portfolio.holdings).toEqual([]);
  });
  it("enforces max positions", () => expect(() => settlePaperDecision({ ...input(), policy: { ...policy, maxPositions: 1 },
    portfolio: { ...portfolio, holdings: [{ token: `0x${"2".repeat(40)}`, amount: "1" }] } })).toThrow("POSITION_LIMIT"));
  it("does not fund sell gas from proceeds", () => expect(() => settlePaperDecision({ ...input(), decision: { ...decision, action: "sell" },
    portfolio: { ...portfolio, cashWei: "0", holdings: [{ token, amount: "1000" }] }, quote: { ...quote, action: "sell", amountOut: "210", minAmountOut: "208" } })).toThrow("INSUFFICIENT_CASH_AND_GAS"));
  it("rejects selling missing holdings", () => expect(() => settlePaperDecision({ ...input(), decision: { ...decision, action: "sell" },
    quote: { ...quote, action: "sell", amountOut: "210", minAmountOut: "208" } })).toThrow("INSUFFICIENT_TOKEN_BALANCE"));
  it("resets only daily counters at UTC rollover", () => {
    const result = settlePaperDecision({ ...input(), portfolio: { ...portfolio, day: "2026-09-11", trades: 5, turnoverWei: "3000", gasWei: "100" } });
    expect(result.portfolio.trades).toBe(1);
    expect(result.portfolio.cashWei).toBe("9790");
  });
});
