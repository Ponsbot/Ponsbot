import { afterEach, describe, expect, it, vi } from "vitest";
import { zeroAddress } from "viem";
import { reserveLiveDecision } from "../lib/trading-agents/live-policy";
import { agentPolicySchema } from "../lib/trading-agents/policy";
import { save } from "../convex/tradingAgentExecution";
import { tradingAgentCapabilities } from "../lib/trading-agents/config";

const token = `0x${"1".repeat(40)}`, pair = `0x${"2".repeat(40)}`;
const policy = agentPolicySchema.parse({ intervalMs: 2700000, maxTradeWei: "2000", maxDailyTurnoverWei: "10000", maxGasPerTradeWei: "10", maxDailyGasWei: "100", reserveWei: "20", maxPositions: 20, maxSlippageBps: 300, maxTradesPerDay: 10 });
const now = 1800000000000;
const snapshot = { cashWei: "1000", tokens: [{ token, amount: "500" }], complete: true, observedAt: now };
const invoke = (fn: unknown, ctx: unknown, args: unknown): Promise<unknown> => (fn as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> })._handler(ctx, args);
afterEach(() => vi.unstubAllEnvs());

describe("live bot policy", () => {
  it("requires explicit master and live gates", () => {
    expect(tradingAgentCapabilities({ TRADING_AGENTS_LIVE_ENABLED: "true" }).liveTrading).toBe(false);
    expect(tradingAgentCapabilities({ TRADING_AGENTS_ENABLED: "true", TRADING_AGENTS_LIVE_ENABLED: "true" }).liveTrading).toBe(true);
  });
  it("limits purchases to 20% of actual ETH and reserves job gas once", () => {
    const result = reserveLiveDecision({ action: "buy", token, amount: "200", reason: "Within budget" }, policy, snapshot, undefined, now);
    expect(result.budget).toMatchObject({ buyWei: "200", gasReservedWei: "10", trades: 1 });
    expect(() => reserveLiveDecision({ action: "buy", token, amount: "201", reason: "Too much" }, policy, snapshot, undefined, now)).toThrow("LIVE_BUY_LIMIT");
  });
  it("allows the complete held token quantity, never more", () => {
    expect(reserveLiveDecision({ action: "sell", token, amount: "500", reason: "Exit" }, policy, snapshot, undefined, now).budget.trades).toBe(1);
    expect(() => reserveLiveDecision({ action: "sell", token, amount: "501", reason: "Oversell" }, policy, snapshot, undefined, now)).toThrow("INSUFFICIENT_TOKEN_BALANCE");
  });
  it("does not authorize trades from incomplete or stale inventory", () => {
    for (const inventory of [{ ...snapshot, complete: false }, { ...snapshot, observedAt: now - 60001 }]) {
      expect(() => reserveLiveDecision({ action: "buy", token, amount: "100", reason: "Buy" }, policy, inventory, undefined, now)).toThrow("LIVE_BALANCES_UNAVAILABLE");
    }
  });
  it("enforces the shared UTC-day gas and trade budget", () => {
    const previous = { day: new Date(now).toISOString().slice(0, 10), buyWei: "0", gasReservedWei: "100", trades: 1 };
    expect(() => reserveLiveDecision({ action: "sell", token, amount: "1", reason: "Sell" }, policy, snapshot, previous, now)).toThrow("LIVE_DAILY_LIMIT");
  });
});

function journal(kind: "buy" | "sell", phase: "funding" | "trade" | "convert", approval = false) {
  vi.stubEnv("WALLET_SIGNER_TOKEN", "test");
  const job: Record<string, unknown> = { _id: "job123456789", agentId: "agent12345678", cycleId: "cycle12345678", state: "active", step: 0,
    intentJson: JSON.stringify({ kind, token, amount: "100" }), gasSpentWei: "0", hashes: [`0x${"a".repeat(64)}`], signedJson: "{}",
    envelopeJson: JSON.stringify({ unsignedTransaction: "0x0200", toAddress: pair, valueWei: "0", nonce: 2, approval,
      route: { phase, pairToken: pair, outputToken: phase === "convert" ? zeroAddress : phase === "funding" || kind === "sell" ? pair : token } }) };
  const cycle: Record<string, unknown> = { status: "executing" };
  const agent: Record<string, unknown> = { _id: job.agentId, liveTradeMix: { platform: 4, secondary: 0 } };
  const ctx = { db: { get: async (id: string) => ({ ...(id === job.agentId ? agent : job) }), patch: async (id: string, patch: Record<string, unknown>) => { Object.assign(id === job._id ? job : id === job.agentId ? agent : cycle, patch); } }, scheduler: { runAfter: vi.fn(async () => null) } };
  const receipt = (outputAmount?: string, step = 0, success = true) => invoke(save, ctx, { secret: "test", jobId: job._id, step, kind: "receipt", value: JSON.stringify({ success, block: "50", gasWei: "3", outputAmount }) });
  return { job, cycle, agent, ctx, receipt };
}
describe("live execution phase journal", () => {
  it("advances funding exactly once and uses only this receipt's proceeds", async () => {
    const j = journal("buy", "funding");
    await j.receipt("37");
    expect(j.job).toMatchObject({ state: "active", phase: "trade", pairAmount: "37", step: 1, minimumNonce: 3, gasSpentWei: "3" });
    expect(await j.receipt("999")).toBe(false);
    expect(j.job.pairAmount).toBe("37");
  });
  it("approval does not advance to a money-moving phase", async () => {
    const j = journal("buy", "funding", true);
    await j.receipt();
    expect(j.job).toMatchObject({ phase: "funding", step: 1 });
    expect(j.job.pairAmount).toBeUndefined();
  });
  it("converts only the paired proceeds of a sale", async () => {
    const j = journal("sell", "trade");
    await j.receipt("42");
    expect(j.job).toMatchObject({ phase: "convert", pairAmount: "42", state: "active" });
    expect(j.agent.liveTradeMix).toEqual({ platform: 5, secondary: 0 });
    expect(j.job.tradeCounted).toBe(true);
    expect(await j.receipt("42")).toBe(false);
    expect(j.agent.liveTradeMix).toEqual({ platform: 5, secondary: 0 });
  });
  it("reports filled only after the final conversion", async () => {
    const j = journal("sell", "convert");
    await j.receipt();
    expect(j.job.state).toBe("confirmed");
    expect(j.cycle.status).toBe("live_filled");
  });
  it("does not claim success when ERC20 proceeds are missing", async () => {
    const j = journal("buy", "funding");
    await j.receipt("0");
    expect(j.job.state).toBe("failed");
    expect(j.cycle.status).toBe("rejected");
  });
  it("keeps a reverted trade distinct from a confirmed fill", async () => {
    const j = journal("buy", "trade");
    await j.receipt(undefined, 0, false);
    expect(j.job.state).toBe("failed");
    expect(j.cycle.status).toBe("rejected");
  });
});
