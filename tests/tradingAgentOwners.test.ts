import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { listOwned, webList } from "../convex/tradingAgentOwners";
const invoke = (fn: unknown, ctx: unknown, args: unknown): Promise<unknown> =>
  (fn as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> })._handler(ctx, args);
afterEach(() => vi.unstubAllEnvs());
const args = { secret: "test-secret", sessionId: "web_test-session", ownerXUserId: "123" };
function enable() {
  vi.stubEnv("TRADING_AGENTS_ENABLED", "true");
  vi.stubEnv("TRADING_AGENTS_WEBSITE_ENABLED", "true");
}
describe("owner bot access", () => {
  it("rejects requests when the website feature is disabled", async () => {
    vi.stubEnv("TRADING_AGENTS_ENABLED", "false");
    const runAction = vi.fn();
    await expect(invoke(webList, { runAction }, args)).rejects.toThrow("AGENTS_DISABLED");
    expect(runAction).not.toHaveBeenCalled();
  });
  it("does not query bots for revoked, expired or wrong-owner sessions", async () => {
    enable(); const runQuery = vi.fn();
    await expect(invoke(webList, { runAction: vi.fn().mockResolvedValue(false), runQuery }, args)).rejects.toThrow("UNAUTHORIZED");
    expect(runQuery).not.toHaveBeenCalled();
  });
  it("propagates secret authorization failures without reading bots", async () => {
    enable(); const runQuery = vi.fn();
    await expect(invoke(webList, { runAction: vi.fn().mockRejectedValue(new Error("unauthorized")), runQuery }, args)).rejects.toThrow();
    expect(runQuery).not.toHaveBeenCalled();
  });
  it("verifies the session before querying only its owner", async () => {
    enable(); const runAction = vi.fn().mockResolvedValue(true), runQuery = vi.fn().mockResolvedValue([]);
    expect(await invoke(webList, { runAction, runQuery }, args)).toEqual([]);
    expect(getFunctionName(runAction.mock.calls[0][0])).toBe("wallets:verifyWebSession");
    expect(runAction.mock.calls[0][1]).toEqual(args);
    expect(runQuery.mock.calls[0][1]).toEqual({ ownerXUserId: "123" });
  });
  it("uses the owner index and returns no private policies, descriptions or leases", async () => {
    const eq = vi.fn(); const take = vi.fn().mockResolvedValue([{ _id: "bot123", name: "Moss", mode: "paper", strategy: "private", leaseToken: "private", portfolio: { cashWei: "10", holdings: [] } }]);
    const withIndex = vi.fn((_index, fn) => { fn({ eq }); return { take }; });
    expect(await invoke(listOwned, { db: { query: (table: string) => table === "tradingAgents" ? { withIndex } : { withIndex: () => ({ order: () => ({ take: async () => [] }) }) } } }, { ownerXUserId: "123" })).toEqual([{ id: "bot123", name: "Moss", mode: "paper", cashWei: "10", holdings: [], transactions: [] }]);
    expect(eq).toHaveBeenCalledWith("ownerXUserId", "123");
    expect(take).toHaveBeenCalledWith(3);
  });
});
