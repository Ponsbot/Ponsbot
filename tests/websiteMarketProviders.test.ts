import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
const mocks = vi.hoisted(() => ({ clients: new Map<string, any>(), gecko: vi.fn(), quote: vi.fn() }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(),
  http: (url: string) => url, createPublicClient: (config: any) => mocks.clients.get(config.transport),
}));
vi.mock("../lib/gecko-shared", () => ({ geckoSharedFetch: mocks.gecko }));
vi.mock("../lib/token-market-cap", () => ({ quoteDetails: mocks.quote }));
import { refreshWebsiteMarkets, rpcBlockFresh, websiteRpcReader } from "../lib/website-market";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const config = { factory: addr(100), stateView: addr(101) };
const target = { tokenAddress: addr(1), curveAddress: addr(2), pairToken: addr(0), graduated: false };
let publicRpc: any, paidRpc: any, client: any;
beforeEach(() => {
  vi.stubEnv("WEBSITE_PUBLIC_RPC_URL", "https://public.test"); vi.stubEnv("ROBINHOOD_RPC_URL", "https://paid.test");
  const rpc = () => ({ getChainId: vi.fn(async () => 4663), getBlock: vi.fn(async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) })), readContract: vi.fn(async ({ functionName }: any) => {
    if (functionName === "getLaunchedToken") return { exists: true, phase: 0, curve: addr(2), pairToken: addr(0), poolFee: 3000, tickSpacing: 60 };
    if (functionName === "decimals") return 18;
    if (functionName === "totalSupply") return 1000n * 10n ** 18n;
    if (functionName === "getReserves") return [1n * 10n ** 18n, 100n * 10n ** 18n];
    if (functionName === "memeHook") return addr(3);
    throw new Error(functionName);
  }) });
  publicRpc = rpc(); paidRpc = rpc(); mocks.clients.set("https://public.test", publicRpc); mocks.clients.set("https://paid.test", paidRpc);
  client = { query: vi.fn(async () => null), mutation: vi.fn(async (ref: any) => getFunctionName(ref) === "marketData:reserveAlchemy" ? true : undefined) };
  mocks.gecko.mockReset().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { headers: { "x-market-observed-at": String(Date.now()) } }));
  mocks.quote.mockReset().mockResolvedValue({ decimals: 18, usd: 2000 });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("website provider fallback", () => {
  it("rejects stale/future RPC heads", () => {
    expect(rpcBlockFresh(1000n, 1_100_000)).toBe(true);
    expect(rpcBlockFresh(1000n, 1_121_000)).toBe(false);
    expect(rpcBlockFresh(1000n, 900_000)).toBe(false);
  });
  it("does not use paid RPC when the public RPC works", async () => {
    const result = await websiteRpcReader(client, "s")(async () => 1);
    expect(result).toBe(1); expect(client.mutation).not.toHaveBeenCalled(); expect(paidRpc.getChainId).not.toHaveBeenCalled();
  });
  it("checks freshness and chain ID before accepting public RPC", async () => {
    publicRpc.getChainId.mockResolvedValue(1);
    const reader = websiteRpcReader(client, "s");
    const read = vi.fn(async rpc => rpc === paidRpc ? "paid" : "public");
    expect(await reader(read)).toBe("paid"); expect(read).toHaveBeenCalledTimes(1);
  });
  it("never bypasses the Alchemy budget on a public RPC failure", async () => {
    publicRpc.getBlock.mockRejectedValue(new Error("timeout")); client.mutation.mockResolvedValue(false);
    const read = vi.fn(); await expect(websiteRpcReader(client, "s")(read)).rejects.toThrow("fallback unavailable");
    expect(read).not.toHaveBeenCalled(); expect(paidRpc.getBlock).not.toHaveBeenCalled();
  });
  it("falls back on an invalid public contract read", async () => {
    const read = vi.fn(async rpc => { if (rpc === publicRpc) throw new Error("RPC rejected"); return 20; });
    expect(await websiteRpcReader(client, "s")(read)).toBe(20);
    expect(client.mutation).toHaveBeenCalledTimes(1);
  });
  it("prefers Gecko valuation without reserve or paid reads", async () => {
    mocks.gecko.mockResolvedValue(new Response(JSON.stringify({ data: [{ attributes: { address: addr(2), fdv_usd: "150000", volume_usd: { h24: "1234" } } }] }), { headers: { "x-market-observed-at": String(Date.now() - 1000) } }));
    const results = await refreshWebsiteMarkets(client, "s", [target], config);
    expect(results[0]).toMatchObject({ marketCapUsd: 150000, marketCapSource: "gecko", volume24hUsd: 1234 });
    expect(publicRpc.readContract.mock.calls.some(([a]: any[]) => a.functionName === "getReserves")).toBe(false);
    expect(publicRpc.getBlock).not.toHaveBeenCalled();
    expect(paidRpc.getBlock).not.toHaveBeenCalled();
  });
  it("calculates a missing Gecko cap from public curve reserves", async () => {
    const results = await refreshWebsiteMarkets(client, "s", [target], config);
    expect(results[0]).toMatchObject({ marketCapUsd: 20000, marketCapSource: "onchain" });
    expect(paidRpc.getBlock).not.toHaveBeenCalled();
  });
  it("reuses stable metadata and one pair price for multiple tokens", async () => {
    const results = await refreshWebsiteMarkets(client, "s", [target, { ...target, tokenAddress: addr(4) }], config);
    expect(results).toHaveLength(2);
    expect(mocks.quote).toHaveBeenCalledTimes(1);
  });
  it("keeps failed prices missing, never fabricates a zero", async () => {
    publicRpc.readContract.mockRejectedValue(new Error("offline")); paidRpc.readContract.mockRejectedValue(new Error("offline"));
    const results = await refreshWebsiteMarkets(client, "s", [target], config);
    expect(results.every(r => r.marketCapUsd === undefined)).toBe(true);
  });
  it("does not refresh a Gecko volume timestamp when RPC supplies the missing cap", async () => {
    const observedAt = Date.now() - 20_000;
    mocks.gecko.mockResolvedValue(new Response(JSON.stringify({ data: [{ attributes: { address: addr(2), volume_usd: { h24: "44" } } }] }), { headers: { "x-market-observed-at": String(observedAt) } }));
    const results = await refreshWebsiteMarkets(client, "s", [target], config);
    expect(results[0]).toMatchObject({ volume24hUsd: 44, volumeObservedAt: observedAt, marketCapUsd: 20000 });
  });
});
