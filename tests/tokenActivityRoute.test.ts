import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ after: vi.fn(), query: vi.fn(), mutation: vi.fn(), refresh: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after, NextResponse: { json: (value: unknown, init?: ResponseInit) => Response.json(value, init) } }));
vi.mock("convex/browser", () => ({ ConvexHttpClient: class { query = mocks.query; mutation = mocks.mutation; } }));
vi.mock("../lib/token-activity-refresh", () => ({ refreshTokenActivity: mocks.refresh }));
import { tokenActivityResponse } from "../lib/token-activity-route";
const token = `0x${"a".repeat(40)}`;
const request = (extra = "") => new Request(`https://ponsbot.family/api/market/holders?token=${token}${extra}`);
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://test.convex.cloud"); vi.stubEnv("MARKET_INDEX_SECRET", "secret");
  mocks.after.mockReset(); mocks.refresh.mockReset(); mocks.query.mockReset(); mocks.mutation.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe("cached-first table API", () => {
  it("returns saved rows without waiting for a provider", async () => {
    mocks.query.mockResolvedValue({ json: '{"holders":[{"address":"saved"}]}', observedAt: 1, due: true, refreshing: false });
    const response = await tokenActivityResponse(request(), "holders");
    expect(await response.json()).toMatchObject({ available: true, refreshing: true, holders: [{ address: "saved" }] });
    expect(mocks.after).toHaveBeenCalledTimes(1); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("cache-only completion reads and expired sessions cannot enqueue providers", async () => {
    mocks.query.mockResolvedValue({ due: true, refreshing: false });
    expect(await (await tokenActivityResponse(request("&cacheOnly=1"), "holders")).json()).toMatchObject({ refreshing: false, available: false });
    expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it("does not start duplicate work when the durable lease is denied", async () => {
    mocks.query.mockResolvedValue({ due: true, refreshing: false }); mocks.mutation.mockResolvedValue(null);
    await tokenActivityResponse(request(), "holders"); await mocks.after.mock.calls[0][0]();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("handles unavailable Convex without returning destructive empty rows", async () => {
    mocks.query.mockRejectedValue(new Error("offline"));
    const response = await tokenActivityResponse(request(), "holders");
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ available: false });
  });
  it("rejects unknown/private tokens before enqueueing work", async () => {
    mocks.query.mockResolvedValue(null);
    expect((await tokenActivityResponse(request(), "holders")).status).toBe(404); expect(mocks.after).not.toHaveBeenCalled();
  });
});
