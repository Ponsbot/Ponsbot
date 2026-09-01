import { beforeEach, describe, expect, it, vi } from "vitest";
import * as wallets from "../convex/wallets";

type Row = Record<string, any>;
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

function fixture() {
  const rows: Row[] = [];
  let sequence = 0;
  const db: any = {
    async insert(_table: string, row: Row) {
      const _id = `terminalMessages:${++sequence}`;
      rows.push({ ...row, _id, _creationTime: sequence });
      return _id;
    },
    async get(id: string) { return rows.find(row => row._id === id) ?? null; },
    async patch(id: string, patch: Row) { Object.assign(rows.find(row => row._id === id)!, patch); },
    query() {
      const predicates: Array<(row: Row) => boolean> = [];
      let descending = false;
      const index = { eq(key: string, value: unknown) { predicates.push(row => row[key] === value); return index; } };
      const query = {
        withIndex(_name: string, use?: (q: typeof index) => unknown) { use?.(index); return query; },
        order(direction: string) { descending = direction === "desc"; return query; },
        async take(count: number) {
          const found = rows.filter(row => predicates.every(test => test(row)))
            .sort((a, b) => (descending ? -1 : 1) * (a.createdAt - b.createdAt));
          return found.slice(0, count);
        },
      };
      return query;
    },
  };
  return { db, rows };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T18:00:00Z"));
});

describe("terminal gas resume", () => {
  it("reconstructs a fresh request and permits only one idempotent request id", async () => {
    const ctx = fixture();
    await ctx.db.insert("terminalMessages", { sessionId: "session", ownerXUserId: "owner", role: "user", messageType: "chat", text: "buy $20 of TEST", createdAt: Date.now() - 2_000 });
    await ctx.db.insert("terminalMessages", { sessionId: "session", ownerXUserId: "owner", role: "assistant", messageType: "result", text: "⛽ You'll need to fund your wallet with ETH for gas to buy. Fund it, then reply “resume”.", createdAt: Date.now() - 1_000 });
    const context = await invoke(wallets.terminalGasResumeContext, ctx, { sessionId: "session", ownerXUserId: "owner" });
    expect(context).toMatchObject({ sourceText: "buy $20 of TEST" });
    const first = { promptMessageId: context.promptMessageId, sessionId: "session", ownerXUserId: "owner", requestId: "request-one" };
    expect(await invoke(wallets.claimTerminalGasResume, ctx, first)).toBe(true);
    expect(await invoke(wallets.claimTerminalGasResume, ctx, first)).toBe(true);
    expect(await invoke(wallets.claimTerminalGasResume, ctx, { ...first, requestId: "request-two" })).toBe(false);
    expect(await invoke(wallets.terminalGasResumeContext, ctx, { sessionId: "session", ownerXUserId: "owner" })).toBeNull();
  });

  it("rejects expired and wrong-owner prompts", async () => {
    const ctx = fixture();
    const promptMessageId = await ctx.db.insert("terminalMessages", { sessionId: "session", ownerXUserId: "owner", role: "assistant", messageType: "result", text: "⛽ You'll need to fund your wallet with ETH for gas to buy. Fund it, then reply “resume”.", createdAt: Date.now() - 11 * 60_000 });
    expect(await invoke(wallets.terminalGasResumeContext, ctx, { sessionId: "session", ownerXUserId: "owner" })).toBeNull();
    expect(await invoke(wallets.claimTerminalGasResume, ctx, { promptMessageId, sessionId: "session", ownerXUserId: "other", requestId: "request" })).toBe(false);
  });
});
