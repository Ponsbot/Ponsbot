import { afterEach, describe, expect, it, vi } from "vitest";
import { coinGeckoFetch, paidCoinGeckoUrl } from "../lib/coingecko-client";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("paid CoinGecko client", () => {
  it("maps public price and GeckoTerminal paths to the paid API", () => {
    expect(paidCoinGeckoUrl("https://api.coingecko.com/api/v3/simple/price?ids=ethereum"))
      .toBe("https://pro-api.coingecko.com/api/v3/simple/price?ids=ethereum");
    expect(paidCoinGeckoUrl("https://api.geckoterminal.com/api/v2/networks/robinhood/pools/x"))
      .toBe("https://pro-api.coingecko.com/api/v3/onchain/networks/robinhood/pools/x");
  });

  it("uses the paid endpoint and server-only header when configured", async () => {
    vi.stubEnv("COINGECKO_PRO_API_KEY", "paid-test-key");
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await coinGeckoFetch("https://api.coingecko.com/api/v3/simple/price")).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://pro-api.coingecko.com/api/v3/simple/price");
    expect(new Headers(init?.headers).get("x-cg-pro-api-key")).toBe("paid-test-key");
  });

  it("falls back to the public endpoint without forwarding the paid key", async () => {
    vi.stubEnv("COINGECKO_PRO_API_KEY", "paid-test-key");
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ethereum: { usd: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await coinGeckoFetch("https://api.coingecko.com/api/v3/simple/price")).ok).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.coingecko.com/api/v3/simple/price");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).has("x-cg-pro-api-key")).toBe(false);
  });
});
