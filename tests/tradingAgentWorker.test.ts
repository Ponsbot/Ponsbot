import { afterEach, describe, expect, it, vi } from "vitest";
import { createPonsAgentBridge, type AgentMarketContext } from "../lib/trading-agents/eliza-bridge";
import { runPaperAgentCycle, type PaperWorkerPorts } from "../lib/trading-agents/paper-worker";

const token = `0x${"1".repeat(40)}`;
const enabled = { TRADING_AGENTS_ENABLED: "true", TRADING_AGENTS_PAPER_ENABLED: "true" };
const context = (): AgentMarketContext => ({ agentId: "agent", cycleId: "cycle", policyVersion: 1, observedAt: Date.now(), tokens: [{ address: token, symbol: "TEST" }], cashWei: "1000", holdings: [],
  strategy: "Paper test", policy: { intervalMs: 60_000, maxTradeWei: "1000", maxDailyTurnoverWei: "3000", maxGasPerTradeWei: "20",
    maxDailyGasWei: "100", reserveWei: "100", maxPositions: 2, maxSlippageBps: 100, maxTradesPerDay: 5 } });
function ports() {
  return {
    lease: vi.fn(async () => ({ agentId: "agent", cycleId: "cycle", policyVersion: 1, leaseUntil: Date.now() + 120_000 })),
    loadContext: vi.fn(async () => context()), decide: vi.fn(async (): Promise<unknown> => ({ action: "buy", token, amount: "1", reason: "Test" })),
    quote: vi.fn(async () => ({ chainId: 4663 as const, agentId: "agent", cycleId: "cycle", policyVersion: 1, token, action: "buy" as const,
      amountIn: "1", amountOut: "10", minAmountOut: "10", gasWei: "1", observedAt: Date.now(), expiresAt: Date.now() + 10_000 })),
    finish: vi.fn(async () => ({ status: "paper_filled", cycleId: "cycle" })),
  } satisfies PaperWorkerPorts;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("paper worker", () => {
  it("makes no calls when disabled", async () => { const p = ports(); expect(await runPaperAgentCycle(p, {})).toEqual({ status: "disabled" }); expect(p.lease).not.toHaveBeenCalled(); });
  it("runs one bounded paper decision using a separate quote provider", async () => {
    const p = ports(); expect((await runPaperAgentCycle(p, enabled)).status).toBe("paper_filled");
    expect(p.decide).toHaveBeenCalledOnce(); expect(p.quote).toHaveBeenCalledOnce(); expect(p.finish).toHaveBeenCalledOnce();
  });
  it("does not quote a hold decision", async () => {
    const p = ports(); p.decide.mockResolvedValue({ action: "hold", reason: "Wait" });
    await runPaperAgentCycle(p, enabled); expect(p.quote).not.toHaveBeenCalled(); expect(p.finish).toHaveBeenCalledOnce();
  });
  it("uses the separate thought adapter without asking for or quoting a trade", async () => {
    const p = ports();
    const finish = vi.fn<PaperWorkerPorts["finish"]>(async () => ({ status: "held", cycleId: "cycle" }));
    const thoughtPorts: PaperWorkerPorts = { ...p, finish, lease: async () => ({ agentId: "agent", cycleId: "cycle", policyVersion: 1, leaseUntil: Date.now() + 120000, kind: "thought" }),
      think: vi.fn(async () => ({ thought: "A quiet day to study platform tokens." })) };
    await runPaperAgentCycle(thoughtPorts, enabled);
    expect(thoughtPorts.think).toHaveBeenCalledOnce(); expect(p.decide).not.toHaveBeenCalled(); expect(p.quote).not.toHaveBeenCalled();
    expect(finish.mock.calls[0]?.[1]).toBe(JSON.stringify({ thought: "A quiet day to study platform tokens." }));
  });
  it("rejects an action smuggled into a thought", async () => {
    const p = ports();
    const thoughtPorts: PaperWorkerPorts = { ...p, lease: async () => ({ agentId: "agent", cycleId: "cycle", policyVersion: 1, leaseUntil: Date.now() + 120000, kind: "thought" }),
      think: async () => ({ thought: "Do it", action: "buy", token, amount: "1" }) };
    expect((await runPaperAgentCycle(thoughtPorts, enabled)).status).toBe("needs_reconciliation");
    expect(p.quote).not.toHaveBeenCalled(); expect(p.finish).not.toHaveBeenCalled();
  });
  it.each([{ action: "send", token, amount: "1" }, { action: "buy", token: `0x${"2".repeat(40)}`, amount: "1", reason: "external" }])("rejects unauthorized decisions %# before quoting", async decision => {
    const p = ports(); p.decide.mockResolvedValue(decision);
    expect((await runPaperAgentCycle(p, enabled)).status).toBe("needs_reconciliation");
    expect(p.quote).not.toHaveBeenCalled(); expect(p.finish).not.toHaveBeenCalled();
  });
  it.each([{ agentId: "other" }, { cycleId: "old" }, { policyVersion: 0 }, { observedAt: 1 }])("does not let stale context reach the model %#", async mismatch => {
    const p = ports(); p.loadContext.mockResolvedValue({ ...context(), ...mismatch });
    await runPaperAgentCycle(p, enabled); expect(p.decide).not.toHaveBeenCalled();
  });
  it("rejects malformed market data before reasoning", async () => {
    const p = ports(); p.loadContext.mockResolvedValue({ ...context(), tokens: [{ address: token, symbol: "TEST", priceUsd: NaN }] });
    expect((await runPaperAgentCycle(p, enabled)).status).toBe("needs_reconciliation"); expect(p.decide).not.toHaveBeenCalled();
  });
  it("does not retry uncertain paper completion", async () => {
    const p = ports(); p.finish.mockRejectedValue(new Error("lost response"));
    expect((await runPaperAgentCycle(p, enabled)).status).toBe("needs_reconciliation"); expect(p.finish).toHaveBeenCalledOnce();
  });
  it("times out without allowing a late reasoner to quote or finish", async () => {
    vi.useFakeTimers(); const p = ports(); let resolve: (value: unknown) => void = () => undefined;
    p.decide.mockImplementation(() => new Promise(r => { resolve = r; }));
    const result = runPaperAgentCycle(p, enabled);
    await vi.advanceTimersByTimeAsync(90_001);
    expect((await result).status).toBe("needs_reconciliation");
    resolve({ action: "buy", token, amount: "1", reason: "late" });
    await vi.advanceTimersByTimeAsync(1);
    expect(p.quote).not.toHaveBeenCalled(); expect(p.finish).not.toHaveBeenCalled();
  });
});

describe("Eliza bridge scope", () => {
  const build = () => {
    const submit = vi.fn(async () => ({ cycleId: "cycle", status: "paper_filled" }));
    const load = vi.fn(async () => context());
    return { submit, load, plugin: createPonsAgentBridge({ runtimeAgentId: "eliza", ponsAgentId: "agent", loadContext: load, submitPaperDecision: submit }) };
  };
  const options = () => ({ proposal: { action: "buy", token, amount: "1", reason: "test" }, cycleId: "cycle", policyVersion: 1 });
  it("denies other runtime agents before reading data", async () => {
    const b = build(); await expect(b.plugin.providers[0].get({ agentId: "outsider" })).rejects.toThrow("AGENT_SCOPE_MISMATCH");
    expect((await b.plugin.actions[0].handler({ agentId: "outsider" }, null, null, options())).success).toBe(false);
    expect(b.load).not.toHaveBeenCalled(); expect(b.submit).not.toHaveBeenCalled();
  });
  it("binds provider data to the Pons agent", async () => {
    const b = build(); b.load.mockResolvedValue({ ...context(), agentId: "other" });
    await expect(b.plugin.providers[0].get({ agentId: "eliza" })).rejects.toThrow("AGENT_SCOPE_MISMATCH");
  });
  it.each([{ cycleId: "old" }, { policyVersion: 0 }, { cycleId: undefined }])("rejects stale proposal scope %#", async change => {
    const b = build(); expect((await b.plugin.actions[0].handler({ agentId: "eliza" }, null, null, { ...options(), ...change })).success).toBe(false);
    expect(b.submit).not.toHaveBeenCalled();
  });
  it("only submits a valid bound paper proposal", async () => {
    const b = build(); expect((await b.plugin.actions[0].handler({ agentId: "eliza" }, null, null, options())).success).toBe(true);
    expect(b.submit).toHaveBeenCalledOnce();
  });
});
