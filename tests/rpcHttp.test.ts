import { afterEach, describe, expect, it, vi } from "vitest";
import { retryingRpcFetch } from "../lib/rpc-http";

afterEach(() => vi.unstubAllGlobals());

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
});
