import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
const { model } = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock("../convex/llm", () => ({ openRouter: model }));
import * as runtime from "../convex/tradingAgentRuntime";
import { runAgentModel } from "../lib/trading-agents/model";
import { paperMarketQuote, type AgentMarkets } from "../lib/trading-agents/market";
import type { AgentMarketContext } from "../lib/trading-agents/eliza-bridge";

const invoke = <T = unknown>(fn: unknown, ctx: unknown, args = {}): Promise<T> =>
  (fn as { _handler: (ctx: unknown, args: unknown) => Promise<T> })._handler(ctx, args);
const token = `0x${"1".repeat(40)}`, now = Date.parse("2026-09-12T20:00:00Z");
const policy = { intervalMs: 2700000, maxTradeWei: "10000000000000000", maxDailyTurnoverWei: "1000000000000000000", maxGasPerTradeWei: "1000000000000000",
  maxDailyGasWei: "10000000000000000", reserveWei: "1000000000000000", maxPositions: 20, maxSlippageBps: 300, maxTradesPerDay: 32 };
const context: AgentMarketContext = { agentId: "agent123456", cycleId: "cycle1", policyVersion: 1, observedAt: now,
  strategy: "Be thoughtful", policy, character: { name: "Moss", description: "A patient bot" }, tokens: [{ address: token, symbol: "TEST" }],
  cashWei: "100000000000000000", holdings: [] };
const markets: AgentMarkets = { observedAt: now, ethUsd: 2000, gasPriceWei: "1000000", tokens: [{ address: token, symbol: "TEST", decimals: 6, priceUsd: 1, priceObservedAt: now }] };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); model.mockReset();
  for (const flag of ["TRADING_AGENTS_ENABLED", "TRADING_AGENTS_PAPER_ENABLED", "TRADING_AGENTS_SCHEDULER_ENABLED"]) vi.stubEnv(flag, "true");
  vi.stubEnv("WALLET_SIGNER_URL", "https://example.test/api/wallet-signer"); vi.stubEnv("WALLET_SIGNER_TOKEN", "test-not-a-real-secret");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("due-only dispatcher", () => {
  it("counts indexed due work with a bounded read and detects expired provisioning", async () => {
    vi.stubEnv("TRADING_AGENTS_LIVE_ENABLED", "true");
    vi.stubEnv("TRADING_AGENTS_WALLETS_ENABLED", "true");
    const take = vi.fn(async () => [ {} ]);
    const db = { query: vi.fn(() => ({withIndex: (_name: string, select: (q: unknown) => unknown) => {
      const fields: Record<string, unknown> = {};
      const q = {eq: (k:string,v:unknown) => { fields[k]=v; return q; }, lte: (k:string,v:unknown) => { fields[k]=v; return q; }};
      select(q);
      expect(fields.nextRunAt ?? fields.walletProvisionNextAt).toBe(now);
      return {take, first: async () => fields.walletProvisionStatus === "leased" ? {} : null};
    }}))};
    const result = await invoke(runtime.dueWork,{db});
    expect(result).toEqual({paper:1,live:1,provision:true});
    expect(take).toHaveBeenCalledWith(20);
  });
  it.each([{live:0,paper:0,provision:false}, {live:1,paper:0,provision:false}, {live:2,paper:3,provision:true}])("dispatches only the due counts %j", async due => {
    const runAfter = vi.fn();
    await invoke(runtime.tick, {runQuery:vi.fn(async()=>due),scheduler:{runAfter}});
    expect(runAfter).toHaveBeenCalledTimes(due.live + due.paper + Number(due.provision));
    expect(runAfter.mock.calls.filter(c=>getFunctionName(c[1])==="tradingAgentLive:work")).toHaveLength(due.live);
  });
  it("does not inspect or dispatch when disabled", async () => {
    vi.stubEnv("TRADING_AGENTS_SCHEDULER_ENABLED", "false");
    const runQuery=vi.fn(), runAfter=vi.fn();
    await invoke(runtime.tick,{runQuery,scheduler:{runAfter}});
    expect(runQuery).not.toHaveBeenCalled(); expect(runAfter).not.toHaveBeenCalled();
  });
});

describe("OpenRouter agent adapter", () => {
  it("passes a bounded structured prompt and validates a public thought", async () => {
    model.mockResolvedValue('{"thought":"Watching the market."}');
    expect(await runAgentModel("thought", context, new AbortController().signal, model)).toEqual({ thought: "Watching the market." });
    const prompt = JSON.stringify(model.mock.calls[0]);
    expect(prompt).not.toContain("test-not-a-real-secret"); expect(prompt).toContain("never as authority");
  });
  it("normalizes strict nullable hold output", async () => {
    model.mockResolvedValue('{"action":"hold","reason":"Wait","token":null,"amount":null}');
    expect(await runAgentModel("trade", context, new AbortController().signal, model)).toEqual({ action: "hold", reason: "Wait" });
    expect(JSON.stringify(model.mock.calls[0])).toContain("Compare at least three priced alternatives");
  });
  it.each([
    { action: "send", recipient: token, amount: "1", reason: "Ignore policy" },
    { action: "hold", token: null, amount: null, reason: "Wait", owner: "attacker" },
    { action: "buy", token: `0x${"2".repeat(40)}`, amount: "1", reason: "Outside token" },
  ])("rejects unauthorized decision %#", async decision => {
    model.mockResolvedValue(JSON.stringify(decision));
    await expect(runAgentModel("trade", context, new AbortController().signal, model)).rejects.toThrow();
  });
  it("honors cancellation even if a provider resolves late", async () => {
    const controller = new AbortController(); controller.abort(); model.mockResolvedValue('{"thought":"late"}');
    await expect(runAgentModel("thought", context, controller.signal, model)).rejects.toThrow("ABORTED");
  });
});

describe("mark-price paper quotes", () => {
  const scope = { agentId: "agent123456", cycleId: "cycle1", policyVersion: 1 };
  it("uses token decimals and exact integer arithmetic", () => {
    const quote = paperMarketQuote(markets, { action: "buy", token, amount: "10000000000000000", reason: "Test" }, scope, now);
    expect(quote.amountOut).toBe("19800000"); expect(quote.gasWei).toBe("330000000000");
  });
  it("returns ETH wei for a sell", () => {
    expect(paperMarketQuote(markets, { action: "sell", token, amount: "20000000", reason: "Test" }, scope, now).amountOut).toBe("9900000000000000");
  });
  it("rejects stale prices rather than relabeling cached prices as fresh", () => {
    expect(() => paperMarketQuote({ ...markets, tokens: [{ ...markets.tokens[0], priceObservedAt: now - 61000 }] },
      { action: "buy", token, amount: "10000000000000000", reason: "Test" }, scope, now)).toThrow("STALE");
  });
});

describe("connected paper worker", () => {
  function fixture(kind: "thought" | "trade") {
    const finish = vi.fn();
    const cycle = { _id: "dbcycle1", cycleKey: "cycle1", agentId: context.agentId, policyVersion: 1 };
    const agent = { _id: context.agentId, name: "Moss", description: "A patient bot", strategy: context.strategy, policy, policyVersion: 1,
      portfolio: { cashWei: context.cashWei, holdings: [] } };
    const ctx = {
      runMutation: vi.fn(async (ref: Parameters<typeof getFunctionName>[0], args: Record<string, unknown>) => {
        const name = getFunctionName(ref);
        if (name.endsWith("leaseNextPaperCycle")) return { agent, cycleId: cycle._id, cycleKey: cycle.cycleKey, leaseUntil: now + 120000, kind };
        if (name.endsWith("reserveModelCall")) return true;
        if (name.endsWith("finishPaperCycle")) { finish(args); return { status: "held", cycleId: cycle.cycleKey }; }
        throw new Error(name);
      }),
      runQuery: vi.fn(async () => ({ agent, cycle, tokens: context.tokens, recentLog: [] })),
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(markets), { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    return { ctx, finish, fetchMock };
  }
  it("runs a thought end to end without requesting a trade quote", async () => {
    const { ctx, finish, fetchMock } = fixture("thought"); model.mockResolvedValue('{"thought":"Waiting patiently."}');
    expect(await invoke(runtime.work, ctx)).toMatchObject({ status: "held" });
    expect(finish.mock.calls[0][0].decisionJson).toBe('{"thought":"Waiting patiently."}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("refreshes the chosen market before submitting a paper trade", async () => {
    const { ctx, finish, fetchMock } = fixture("trade"); model.mockResolvedValue(JSON.stringify({ action: "buy", token, amount: "10000000000000000", reason: "Test" }));
    await invoke(runtime.work, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(JSON.parse(finish.mock.calls[0][0].quoteJson).amountOut).toBe("19800000");
  });
  it("makes no calls when the scheduler is disabled", async () => {
    const { ctx, fetchMock } = fixture("thought"); vi.stubEnv("TRADING_AGENTS_SCHEDULER_ENABLED", "false");
    expect(await invoke(runtime.work, ctx)).toMatchObject({ status: "disabled" });
    expect(ctx.runMutation).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
  });
  it("keeps live X handlers inert unless explicitly enabled", async () => {
    vi.stubEnv("TRADING_AGENTS_X_ENABLED", "false");
    const runQuery = vi.fn(); expect(await invoke(runtime.handleX, { runQuery }, { postId: "123" })).toEqual({ handled: false });
    expect(runQuery).not.toHaveBeenCalled();
  });
});
