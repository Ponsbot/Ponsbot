import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ mutation: vi.fn() }));
vi.mock("convex/browser", () => ({ ConvexHttpClient: class { mutation = mocks.mutation; } }));
import { geckoSharedFetch } from "../lib/gecko-shared";
const url = "https://api.geckoterminal.com/api/v2/test";
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://test.convex.cloud"); vi.stubEnv("MARKET_INDEX_SECRET", "secret");
  mocks.mutation.mockReset(); vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("shared Gecko stale response semantics", () => {
  it("fails closed when an explicit paid request has no paid key", async () => {
    const response = await geckoSharedFetch(url, 60_000, 1_000, false, false, undefined, "background", "paid", "lifetime_volume");
    expect(response.status).toBe(503);
    expect(response.headers.get("x-gecko-configuration-error")).toBe("missing-paid-key");
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the paid onchain endpoint and paid budget when configured", async () => {
    vi.stubEnv("COINGECKO_PRO_API_KEY", "paid-test-key");
    mocks.mutation.mockResolvedValueOnce({ acquired: true }).mockResolvedValueOnce(undefined);
    vi.mocked(fetch).mockResolvedValue(Response.json({ data: [] }));
    expect((await geckoSharedFetch(url)).ok).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://pro-api.coingecko.com/api/v3/onchain/test");
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("x-cg-pro-api-key")).toBe("paid-test-key");
    expect(mocks.mutation.mock.calls[0][1]).toMatchObject({ key: "coingecko-paid:test", paid: true });
  });
  it("serves stale history only to an opted-in display consumer", async () => {
    mocks.mutation.mockResolvedValue({ acquired: false, json: '{"data":[1]}', observedAt: 10, stale: true });
    expect((await geckoSharedFetch(url)).status).toBe(429);
    const history = await geckoSharedFetch(url, 60000, 1000, true);
    expect(history.status).toBe(200); expect(history.headers.get("x-market-stale")).toBe("1");
    expect(history.headers.get("x-market-observed-at")).toBe("10"); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([429, 503])("retains previous history after upstream %s without faking freshness", async status => {
    mocks.mutation.mockResolvedValueOnce({ acquired: true, json: '{"data":[1]}', observedAt: 10, stale: true }).mockResolvedValueOnce(undefined);
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
    const response = await geckoSharedFetch(url, 60000, 1000, true);
    expect(response.headers.get("x-market-observed-at")).toBe("10"); expect(response.headers.get("x-market-stale")).toBe("1");
    expect(mocks.mutation.mock.calls[1][1]).toMatchObject({ json: undefined, throttled: status === 429 });
  });
  it("does not replace good cached data with an invalid HTTP-200 error body", async () => {
    mocks.mutation.mockResolvedValueOnce({ acquired: true, json: '{"data":[1]}', observedAt: 10, stale: true }).mockResolvedValueOnce(undefined);
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "unavailable" }));
    expect(await (await geckoSharedFetch(url, 60000, 1000, true)).json()).toEqual({ data: [1] });
    expect(mocks.mutation.mock.calls[1][1].json).toBeUndefined();
  });
  it("uses fresh cached JSON without another provider call", async () => {
    mocks.mutation.mockResolvedValue({ acquired: false, json: '{"data":[]}', observedAt: 10, stale: false });
    expect((await geckoSharedFetch(url)).status).toBe(200); expect(fetch).not.toHaveBeenCalled();
  });
});
