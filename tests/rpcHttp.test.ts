import { afterEach, describe, expect, it, vi } from "vitest";
import { resilientRobinhoodHttp, retryingRpcFetch } from "../lib/rpc-http";
import { createPublicClient } from "viem";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RPC retry handling", () => {
  it("retries transient 429 responses and returns the successful response", async () => {
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", mockedFetch);

    const response = await retryingRpcFetch("https://rpc.example");

    expect(response.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent client errors", async () => {
    const mockedFetch = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", mockedFetch);

    const response = await retryingRpcFetch("https://rpc.example");

    expect(response.status).toBe(400);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the public RPC for a read rejected with 403", async () => {
    const mockedFetch = vi.fn()
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" }), {
        status: 200, headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", mockedFetch);
    const client = createPublicClient({ transport: resilientRobinhoodHttp("https://configured.example") });

    await expect(client.getChainId()).resolves.toBe(4663);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(String(mockedFetch.mock.calls[1]?.[0])).toBe("https://rpc.mainnet.chain.robinhood.com");
  });

  it("never falls back for raw transaction submission", async () => {
    const mockedFetch = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", mockedFetch);
    const transport = resilientRobinhoodHttp("https://configured.example")({ chain: undefined, retryCount: 0 });

    await expect(transport.request({ method: "eth_sendRawTransaction", params: ["0x01"] })).rejects.toBeTruthy();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});
