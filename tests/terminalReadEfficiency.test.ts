/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalTokenCatalog } from "../convex/site";
import { listTerminalHistory } from "../convex/wallets";
import { readFileSync } from "node:fs";
const handler = (f: any) => f._handler;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
function fixture() {
  const tables: Record<string, any[]> = {}, indexes: string[] = [];
  const ctx: any = { db: {
    query(table: string) {
      const checks: Array<(r: any) => boolean> = []; let direction = "desc";
      const b: any = {};
      for (const op of ["eq", "gt", "gte"]) b[op] = (key: string, value: any) => { checks.push(r => op === "eq" ? r[key] === value : op === "gt" ? r[key] > value : r[key] >= value); return b; };
      const result = () => (tables[table] ?? []).filter(r => checks.every(c => c(r))).sort((a, b) => direction === "asc" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
      const q: any = { withIndex: (name: string, fn: any) => { indexes.push(`${table}:${name}`); fn(b); return q; },
        filter: (fn: any) => { fn({ field: (key: string) => key, eq: b.eq }); return q; }, order: (d: string) => { direction = d; return q; },
        take: async (n: number) => result().slice(0, n), collect: async () => result(), unique: async () => result()[0] ?? null };
      return q;
    }, get: async () => null,
  } };
  const launch = (n: number, overrides: any = {}) => ({ tokenAddress: address(n), name: `Token ${n}`, symbol: `T${n}`, publicPublished: true, createdAt: n,
    publicLastBuyAt: Date.now(), ownerXUserId: "owner", ...overrides });
  return { ctx, indexes, tables, launch };
}
afterEach(() => { vi.unstubAllEnvs(); });
describe("shared terminal catalog versus private history", () => {
  it("reads the public catalog once without a duplicate active scan below 2,000 launches", async () => {
    vi.stubEnv("WEB_AUTH_SECRET", "secret"); const f = fixture();
    f.tables.tokenLaunches = [f.launch(1), f.launch(2, { publicPublished: false })];
    f.tables.tokenRegistry = [{ address: address(3), normalizedAddress: address(3), symbol: "MSFT", name: "Microsoft", active: true }];
    expect(await handler(terminalTokenCatalog)(f.ctx, { secret: "secret" })).toEqual([
      { tokenAddress: address(1), name: "Token 1", symbol: "T1", pairToken: undefined },
      { tokenAddress: address(3), name: "Microsoft", symbol: "MSFT" },
    ]);
    expect(f.indexes).not.toContain("tokenLaunches:by_public_last_buy");
    await expect(handler(terminalTokenCatalog)(f.ctx, { secret: "bad" })).rejects.toThrow("authorization");
  });
  it("keeps an older active launch beyond the newest 2,000", async () => {
    vi.stubEnv("WEB_AUTH_SECRET", "secret"); const f = fixture();
    f.tables.tokenLaunches = Array.from({ length: 2001 }, (_, n) => f.launch(n + 1));
    const result = await handler(terminalTokenCatalog)(f.ctx, { secret: "secret" });
    expect(result).toHaveLength(2001); expect(result.some((r: any) => r.tokenAddress === address(1))).toBe(true);
  });
  it("loads owner history without scanning the global catalog and gives empty history an incremental cursor", async () => {
    const f = fixture(); const before = Date.now() - 1;
    const result = await handler(listTerminalHistory)(f.ctx, { ownerXUserId: "owner", sessionId: "session", includeCatalog: true, includePublicCatalog: false });
    expect(result.updatedThrough).toBeGreaterThanOrEqual(before);
    expect(result.messages).toEqual([]); expect(result.actions).toEqual([]);
    expect(f.indexes).not.toContain("tokenLaunches:by_public_created_at");
    expect(f.indexes).not.toContain("tokenLaunches:by_public_last_buy");
    expect(f.indexes).toContain("tokenLaunches:by_owner_created_at");
  });
  it("includes public LP identifiers in recent liquidity actions", async () => {
    const f = fixture(); const now = Date.now();
    f.tables.liquidityExecutions = [
      { _id: "execution-new", conversationId: "conversation-new", ownerXUserId: "owner", walletId: "wallet", planJson: "{}", stepsJson: "[]",
        positionIds: ["LP-1234ABCD"], status: "confirmed", response: "Position opened", createdAt: now, updatedAt: now },
      { _id: "execution-legacy", conversationId: "conversation-legacy", ownerXUserId: "owner", walletId: "wallet",
        planJson: JSON.stringify({ claimPositions: [{ positionId: "LP-AABBCCDD" }, { positionId: "LP-00112233" }] }), stepsJson: "[]",
        status: "confirmed", response: "Fees collected", createdAt: now - 1, updatedAt: now - 1 },
    ];
    const result = await handler(listTerminalHistory)(f.ctx, { ownerXUserId: "owner", sessionId: "session", includeCatalog: false, includePublicCatalog: false });
    expect(result.actions[0]).toMatchObject({ requestId: "liquidity:execution-new", lpIdentifiers: ["LP-1234ABCD"] });
    expect(result.actions[1]).toMatchObject({ requestId: "liquidity:execution-legacy", lpIdentifiers: ["LP-AABBCCDD", "LP-00112233"] });
  });
  it("authenticates before any cached catalog read and never caches private history", () => {
    const route = readFileSync("app/api/terminal/route.ts", "utf8");
    expect(route.indexOf("if (!await activeSession")).toBeLessThan(route.indexOf("readTerminalCatalog(convexUrl)"));
    const cache = readFileSync("lib/public-display-cache.ts", "utf8");
    expect(cache).not.toMatch(/api\.wallets\.|sessionId|ownerXUserId/);
    expect(cache).toContain("revalidate: 15"); expect(cache).toContain("revalidate: 60");
  });
});
