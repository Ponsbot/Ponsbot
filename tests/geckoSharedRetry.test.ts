import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ mutation: vi.fn() }));
vi.mock("convex/browser", () => ({ ConvexHttpClient: class { mutation = mocks.mutation; } }));
import { geckoSharedFetch } from "../lib/gecko-shared";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe("shared Gecko retry headers", () => {
  it("waits for an interactive slot longer than background pacing without losing freshness", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud"); vi.stubEnv("MARKET_INDEX_SECRET", "test-only");
    const freshAfter = Date.now();
    mocks.mutation.mockResolvedValueOnce({ acquired: false, stale: true, retryAt: freshAfter + 6000 }).mockResolvedValueOnce({ acquired: true }).mockResolvedValueOnce(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })));
    const pending = geckoSharedFetch("https://api.geckoterminal.com/api/v2/test", 60000, 8000, false, true, freshAfter, "interactive");
    await vi.advanceTimersByTimeAsync(6000);
    expect((await pending).status).toBe(200);
    for (const [, args] of mocks.mutation.mock.calls.slice(0, 2)) expect(args).toMatchObject({ freshAfter, priority: "interactive" });
  });
  it("waits through an ordinary one-minute interactive provider cooldown", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud"); vi.stubEnv("MARKET_INDEX_SECRET", "test-only");
    const freshAfter = Date.now();
    mocks.mutation.mockResolvedValueOnce({ acquired: false, stale: true, retryAt: freshAfter + 60_000 })
      .mockResolvedValueOnce({ acquired: true }).mockResolvedValueOnce(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "fresh" }] })));
    const pending = geckoSharedFetch("https://api.geckoterminal.com/api/v2/test", 60_000, 8_000, false, true, freshAfter, "interactive");
    await vi.advanceTimersByTimeAsync(59_999); expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await pending).json()).toEqual({ data: [{ id: "fresh" }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not sleep through a long provider cooldown even for an interactive quote", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud"); vi.stubEnv("MARKET_INDEX_SECRET", "test-only");
    mocks.mutation.mockResolvedValue({ acquired: false, stale: true, retryAt: Date.now() + 600000 });
    vi.stubGlobal("fetch", vi.fn());
    expect((await geckoSharedFetch("https://api.geckoterminal.com/api/v2/test", 60000, 8000, false, true, Date.now(), "interactive")).status).toBe(429);
    expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("carries a live comparison freshness boundary through every budget retry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud"); vi.stubEnv("MARKET_INDEX_SECRET", "test-only");
    const freshAfter = Date.now();
    mocks.mutation.mockResolvedValueOnce({ acquired: false, stale: true, retryAt: Date.now() + 2500 })
      .mockResolvedValueOnce({ acquired: true }).mockResolvedValueOnce(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })));
    const task = geckoSharedFetch("https://api.geckoterminal.com/api/v2/test", 60000, 8000, false, true, freshAfter);
    await vi.advanceTimersByTimeAsync(2500); expect((await task).status).toBe(200);
    expect(mocks.mutation.mock.calls.slice(0, 2).every(([, args]) => args.freshAfter === freshAfter)).toBe(true);
  });
  it("lets background batches wait for a short pacing slot, then reserves again", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud"); vi.stubEnv("MARKET_INDEX_SECRET", "test-only");
    mocks.mutation.mockResolvedValueOnce({ acquired: false, stale: true, retryAt: Date.now() + 2500 })
      .mockResolvedValueOnce({ acquired: true }).mockResolvedValueOnce(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })));
    const task = geckoSharedFetch("https://api.geckoterminal.com/api/v2/test", 60000, 8000, false, true);
    await vi.advanceTimersByTimeAsync(2499); expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect((await task).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1); expect(mocks.mutation).toHaveBeenCalledTimes(3);
  });
  it("preserves the provider Retry-After rather than inventing an earlier retry", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud"); vi.stubEnv("MARKET_INDEX_SECRET", "test-only");
    mocks.mutation.mockResolvedValueOnce({ acquired: true }).mockResolvedValueOnce(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 429, headers: { "retry-after": "600" } })));
    const response = await geckoSharedFetch("https://api.geckoterminal.com/api/v2/test");
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("600");
    expect(mocks.mutation.mock.calls[1][1]).toMatchObject({ retryAfter: "600", throttled: true });
  });
  it("does not contact Gecko when the shared budget or lease rejects the request", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example.convex.cloud"); vi.stubEnv("MARKET_INDEX_SECRET", "test-only");
    mocks.mutation.mockResolvedValue({ acquired: false }); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const response = await geckoSharedFetch("https://api.geckoterminal.com/api/v2/test");
    expect(response.status).toBe(429); expect(fetch).not.toHaveBeenCalled();
    expect(response.headers.get("x-gecko-local-deferral")).toBe("1");
  });
});
