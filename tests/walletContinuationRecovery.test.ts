import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import * as continuations from "../convex/walletContinuations";
import * as deliveries from "../convex/telegramDeliveries";
import { safeFailure } from "../convex/wallets";
import { NON_INDEXED_BUY_TARGET_MESSAGE } from "../lib/buy-target-policy";
import { walletContinuation } from "../lib/wallet-continuation";

type Row = Record<string, any>;
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const ca = "0x1111111111111111111111111111111111111111";
const identity = { owner: "owner", source: "terminal", scope: "session" };
const command = { kind: "buy", amount: "14", unit: "usd", token: "DUP", slippageBps: 250 };
function fixture() {
  const tables = new Map<string, Row[]>();
  let seq = 0;
  const db = {
    async get(id: string) { return [...tables.values()].flat().find(row => row._id === id) ?? null; },
    async insert(table: string, value: Row) { const row = { ...value, _id: `row-${++seq}` }; tables.set(table, [...tables.get(table) || [], row]); return row._id; },
    async patch(id: string, value: Row) { Object.assign((await db.get(id))!, value); },
    async delete(id: string) { for (const [table, rows] of tables) tables.set(table, rows.filter(row => row._id !== id)); },
    query(table: string) {
      const filters: ((row: Row) => boolean)[] = [];
      const index = { eq(key: string, value: unknown) { filters.push(row => row[key] === value); return index; }, lte(key: string, value: number) { filters.push(row => row[key] <= value); return index; } };
      const all = () => (tables.get(table) || []).filter(row => filters.every(filter => filter(row)));
      const q = { withIndex(_name: string, fn: any) { fn(index); return q; }, unique: async () => all()[0] ?? null, take: async (n: number) => all().slice(0, n) };
      return q;
    },
  };
  const action = vi.fn(async (name: string) => name === "wallets:verifyTokenTickerContract" ? { matches: true } : true);
  const otherQuery = vi.fn(async (name: string) => name === "telegram:boundUpdateLink" ? { valid: true, link: { ownerXUserId: "owner" } } : { status: "confirmed", finalMessage: "Confirmed actual transaction" });
  const ctx: any = { db, scheduler: { runAfter: vi.fn() } };
  const dispatch = (ref: any, args: any) => {
    const [module, method] = getFunctionName(ref).split(":");
    const exports = module === "walletContinuations" ? continuations : module === "telegramDeliveries" ? deliveries : null;
    return exports ? invoke((exports as any)[method], ctx, args) : undefined;
  };
  ctx.runMutation = vi.fn((ref, args) => dispatch(ref, args));
  ctx.runQuery = vi.fn((ref, args) => dispatch(ref, args) ?? otherQuery(getFunctionName(ref)));
  ctx.runAction = vi.fn((ref, args) => dispatch(ref, args) ?? action(getFunctionName(ref)));
  return { ctx, tables, action, otherQuery };
}
afterEach(() => vi.useRealTimers());
async function save(ctx: any, message = NON_INDEXED_BUY_TARGET_MESSAGE) {
  await invoke(continuations.save, ctx, { ...identity, requestId: "original", commandJson: JSON.stringify(command), sourceText: "buy $14 of DUP", message });
}
describe("durable wallet clarifications", () => {
  it.each(["terminal", "telegram"])("restores the exact original buy from a CA on %s", async source => {
    const f = fixture(); const id = { ...identity, source };
    await invoke(continuations.save, f.ctx, { ...id, requestId: "original", commandJson: JSON.stringify(command), sourceText: "buy $14 of DUP", message: NON_INDEXED_BUY_TARGET_MESSAGE });
    const result = await invoke(continuations.resolve, f.ctx, { ...id, text: `CA: ${ca}`, requestId: "reply" });
    expect(JSON.parse(result.commandJson)).toMatchObject({ ...command, token: ca });
  });
  it("does not consume or erase the request for a wallet question", async () => {
    const f = fixture(); await save(f.ctx);
    expect(await invoke(continuations.resolve, f.ctx, { ...identity, text: "what's my wallet?", requestId: "question" })).toBeNull();
    expect(await invoke(continuations.resolve, f.ctx, { ...identity, text: ca, requestId: "reply" })).toHaveProperty("commandJson");
  });
  it("rejects a duplicate sibling but permits idempotent execution of the same reply", async () => {
    const f = fixture(); await save(f.ctx);
    const args = { ...identity, text: ca, requestId: "reply" };
    expect(await invoke(continuations.resolve, f.ctx, args)).toHaveProperty("commandJson");
    expect(await invoke(continuations.resolve, f.ctx, args)).toHaveProperty("commandJson");
    expect(await invoke(continuations.resolve, f.ctx, { ...args, requestId: "sibling" })).toHaveProperty("message");
  });
  it("re-prompts on mismatch and allows the corrected contract", async () => {
    const f = fixture(); await save(f.ctx); f.action.mockResolvedValueOnce({ matches: false });
    expect((await invoke(continuations.resolve, f.ctx, { ...identity, text: ca, requestId: "wrong" })).message).toContain("does not match $DUP");
    expect(await invoke(continuations.resolve, f.ctx, { ...identity, text: ca, requestId: "corrected" })).toHaveProperty("commandJson");
  });
  it("keeps recovery available after an RPC failure", async () => {
    const f = fixture(); await save(f.ctx); f.action.mockRejectedValueOnce(new Error("timeout"));
    expect((await invoke(continuations.resolve, f.ctx, { ...identity, text: ca, requestId: "first" })).message).toContain("saved");
    expect(await invoke(continuations.resolve, f.ctx, { ...identity, text: ca, requestId: "retry" })).toHaveProperty("commandJson");
  });
  it.each([{ owner: "other" }, { scope: "another-session" }, { source: "telegram" }])("does not expose another continuation through %j", async override => {
    const f = fixture(); await save(f.ctx);
    expect(await invoke(continuations.resolve, f.ctx, { ...identity, ...override, text: ca, requestId: "reply" })).toBeNull();
    expect(f.action).not.toHaveBeenCalled();
  });
  it("returns expiry without executing or verifying", async () => {
    vi.useFakeTimers(); const f = fixture(); await save(f.ctx); vi.advanceTimersByTime(600_001);
    expect((await invoke(continuations.resolve, f.ctx, { ...identity, text: ca, requestId: "late" })).message).toContain("expired");
    expect(f.action).not.toHaveBeenCalled();
  });
  it("restores a gas request from persisted command data", async () => {
    const f = fixture(); await save(f.ctx, '⛽ Simulated gas for this transaction is 0.001 ETH. Fund your wallet, then reply “resume”.');
    const result = await invoke(continuations.resolve, f.ctx, { ...identity, text: "resume!", requestId: "funded" });
    expect(JSON.parse(result.commandJson)).toEqual(command);
  });
  it("preserves the buy receipt when only the burn failed", () => {
    const partial = "The buy completed, but the burn did not. The purchased tokens remain in your wallet. Buy TXN: https://example.test/tx";
    expect(safeFailure(new Error(partial), "buy_and_burn")).toBe(`⚠️ ${partial}`);
    expect(walletContinuation(`⚠️ ${partial}`, { ...command, kind: "buy_and_burn" } as any)).toBeNull();
  });
});
describe("durable Telegram delivery", () => {
  const job = { requestId: "telegram:1:2:buy", ownerXUserId: "owner", telegramUserId: "1", telegramChatId: "1", telegramUpdateId: "2" };
  it("waits beyond five minutes and delivers the eventual real result", async () => {
    vi.useFakeTimers(); const f = fixture(); await invoke(deliveries.enqueue, f.ctx, job); vi.advanceTimersByTime(6000);
    f.otherQuery.mockImplementation(async name => name === "telegram:boundUpdateLink" ? { valid: true, link: { ownerXUserId: "owner" } } : { status: "simulating" } as any);
    await invoke(deliveries.deliver, f.ctx, { requestId: job.requestId });
    expect(f.action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(360_000);
    f.otherQuery.mockImplementation(async name => name === "telegram:boundUpdateLink" ? { valid: true, link: { ownerXUserId: "owner" } } : { status: "confirmed", finalMessage: "Real success" });
    await invoke(deliveries.deliver, f.ctx, { requestId: job.requestId });
    expect(f.tables.get("telegramWalletDeliveries")?.[0].status).toBe("delivered");
    expect(f.action).toHaveBeenCalledWith("telegram:deliverHoudiniMessage");
  });
  it("retries delivery failures without calling wallet execution", async () => {
    vi.useFakeTimers(); const f = fixture(); await invoke(deliveries.enqueue, f.ctx, job); vi.advanceTimersByTime(6000); f.action.mockRejectedValueOnce(new Error("Telegram 500"));
    await invoke(deliveries.deliver, f.ctx, { requestId: job.requestId });
    expect(f.tables.get("telegramWalletDeliveries")?.[0].status).toBe("pending");
    vi.advanceTimersByTime(6000); await invoke(deliveries.deliver, f.ctx, { requestId: job.requestId });
    expect(f.tables.get("telegramWalletDeliveries")?.[0].status).toBe("delivered");
    expect(f.action.mock.calls.every(([name]) => name === "telegram:deliverHoudiniMessage")).toBe(true);
  });
  it("cancels delivery after the original X link changes", async () => {
    vi.useFakeTimers(); const f = fixture(); await invoke(deliveries.enqueue, f.ctx, job); vi.advanceTimersByTime(6000); f.otherQuery.mockResolvedValue({ valid: false } as any);
    await invoke(deliveries.deliver, f.ctx, { requestId: job.requestId });
    expect(f.tables.get("telegramWalletDeliveries")?.[0].status).toBe("cancelled"); expect(f.action).not.toHaveBeenCalled();
  });
  it("delivers one time across repeated scheduler callbacks", async () => {
    vi.useFakeTimers(); const f = fixture(); await invoke(deliveries.enqueue, f.ctx, job); await invoke(deliveries.enqueue, f.ctx, job); vi.advanceTimersByTime(6000);
    await invoke(deliveries.deliver, f.ctx, { requestId: job.requestId }); await invoke(deliveries.deliver, f.ctx, { requestId: job.requestId });
    expect(f.action).toHaveBeenCalledTimes(1);
  });
});
