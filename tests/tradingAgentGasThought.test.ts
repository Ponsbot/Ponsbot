import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../convex/tradingAgentLive";

type Row = Record<string, unknown>;
const invoke = (ctx: unknown, args: unknown) => (complete as unknown as { _handler(ctx: unknown, args: unknown): Promise<unknown> })._handler(ctx, args);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T15:00:00Z"));
  vi.stubEnv("TRADING_AGENTS_ENABLED", "true"); vi.stubEnv("TRADING_AGENTS_LIVE_ENABLED", "true");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
function fixture(cashWei = "10", observedAt = Date.now(), completeSnapshot = true) {
  const now = Date.now();
  const rows: Record<string, Row> = {
    cycle: { _id: "cycle", agentId: "agent", kind: "trade", status: "leased", leaseToken: "lease", leaseUntil: now + 180000, policyVersion: 1 },
    agent: { _id: "agent", mode: "live", status: "running", activeCycleId: "cycle", policyVersion: 1,
      policy: { maxGasPerTradeWei: "20", reserveWei: "100" }, schedule: { anchorAt: now, nextThoughtAt: now + 300000, nextTradeAt: now } },
  };
  const ctx = { db: { get: async (id: string) => rows[id], patch: async (id: string, patch: Row) => Object.assign(rows[id], patch), insert: vi.fn() }, scheduler: { runAfter: vi.fn() } };
  const args = { cycleId: "cycle", leaseToken: "lease", gasFallbackThought: true,
    resultJson: JSON.stringify({ thought: "The garden could use a honeycomb-shaped fountain." }),
    snapshotJson: JSON.stringify({ cashWei, tokens: [], observedAt, complete: completeSnapshot }) };
  return { rows, ctx, args };
}
describe("underfunded trade slots become ordinary thoughts", () => {
  it("saves a thought without scheduling a trade and advances only the trade timer", async () => {
    const { rows, ctx, args } = fixture(); const priorThought = (rows.agent.schedule as Row).nextThoughtAt;
    await invoke(ctx, args);
    expect(rows.cycle).toMatchObject({ kind: "thought", status: "held", diagnosticCode: "INSUFFICIENT_GAS_RESERVE", thought: "The garden could use a honeycomb-shaped fountain." });
    expect(rows.cycle.decisionJson).toBeUndefined(); expect(ctx.db.insert).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    expect((rows.agent.schedule as Row).nextThoughtAt).toBe(priorThought);
    expect(Number((rows.agent.schedule as Row).nextTradeAt)).toBeGreaterThan(Date.now() + 40 * 60000);
    expect(rows.agent.activeCycleId).toBeUndefined();
    await invoke(ctx, args); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it.each([["120", 0, true], ["10", -60001, true], ["10", 1, true], ["10", 0, false]])("rejects an unsubstantiated fallback (%s/%s/%s)", async (cash, offset, valid) => {
    const { rows, ctx, args } = fixture(cash, Date.now() + Number(offset), Boolean(valid));
    await invoke(ctx, args); expect(rows.cycle.status).toBe("rejected"); expect(rows.cycle.thought).toBeUndefined(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
});
