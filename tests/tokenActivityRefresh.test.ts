import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
const mocks = vi.hoisted(() => ({ rpc: {} as any, gecko: vi.fn(), urls: [] as string[] }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(),
  http: (url: string) => { mocks.urls.push(url); return url; }, createPublicClient: () => mocks.rpc,
}));
vi.mock("../lib/gecko-shared", () => ({ geckoSharedFetch: mocks.gecko }));
import { refreshTokenActivity } from "../lib/token-activity-refresh";
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
let client: any, launch: any, history: any, phase: number;
const fresh = () => ({ headers: { "x-market-observed-at": String(Date.now()) } });
const run = (kind: "trades" | "holders", previous = {}) => refreshTokenActivity(client, "secret", a(1), kind, "lease", previous);
beforeEach(() => {
  vi.stubEnv("WEBSITE_PUBLIC_RPC_URL", "https://public.test"); vi.stubEnv("ROBINHOOD_RPC_URL", "https://paid.test");
  mocks.urls.length = 0; phase = 0; history = { top: [] };
  launch = { tokenAddress: a(1), creatorAddress: a(2), poolAddress: a(3), transactionHash: h(1), graduated: false };
  const cache = new Map<string, any>();
  client = { query: vi.fn(async (ref, args) => {
    switch (getFunctionName(ref)) {
      case "marketData:readCache": return cache.get(args.key) ?? null;
      case "site:getLaunch": return launch;
      case "site:tokenActivity": return [];
      case "site:marketRuntimeConfig": return { factory: a(4) };
      case "marketData:holderHistory": return history;
      default: throw new Error(getFunctionName(ref));
    }
  }), mutation: vi.fn(async (ref, args) => {
    switch (getFunctionName(ref)) {
      case "marketData:writeCache": cache.set(args.key, { json: args.json }); return;
      case "marketData:recordHolderHistory": history = { throughBlock: args.throughBlock, blockHash: args.blockHash, top: [{ address: a(2), raw: "1000" }] }; return true;
      default: throw new Error(`unexpected mutation ${getFunctionName(ref)}`);
    }
  }) };
  const seconds = BigInt(Math.floor(Date.now() / 1000));
  mocks.rpc = {
    getChainId: vi.fn(async () => 4663),
    getBlock: vi.fn(async ({ blockNumber }: any) => ({ number: blockNumber ?? 20000n, hash: h(Number(blockNumber ?? 20000n)), timestamp: seconds - (20000n - (blockNumber ?? 20000n)) / 10n })),
    readContract: vi.fn(async ({ functionName, args }: any) => {
      if (functionName === "decimals") return 0;
      if (functionName === "totalSupply") return 1000n;
      if (functionName === "balanceOf") return args[0] === a(2) ? 1000n : 0n;
      if (functionName === "getLaunchedToken") return { exists: true, phase, curve: a(3), pairToken: a(0), poolFee: 3000, tickSpacing: 60 };
      if (functionName === "memeHook") return a(5);
      if (functionName === "poolManager") return a(6);
      throw new Error(functionName);
    }),
    getLogs: vi.fn(async () => []), getTransaction: vi.fn(async () => ({ from: a(2) })),
    getTransactionReceipt: vi.fn(async () => ({ status: "success", blockNumber: 19900n })),
  };
  mocks.gecko.mockReset().mockImplementation(async (url: string) => new Response(JSON.stringify({ data: url.endsWith("/pools") ? [{ attributes: { address: a(3) } }] : [] }), fresh()));
  vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("public-only recent table workers", () => {
  it("does not use Alchemy or the general market index, even if public RPC fails", async () => {
    mocks.rpc.getChainId.mockRejectedValue(new Error("offline"));
    const result = await run("trades");
    expect(result.json).toBeDefined(); // A valid Gecko empty response remains usable.
    expect(mocks.urls).toEqual(["https://public.test"]);
    expect(client.mutation.mock.calls.every(([ref]: any[]) => getFunctionName(ref) === "marketData:writeCache")).toBe(true);
  });
  it("gets recent curve trades without receipts, valuations or a historical scan", async () => {
    mocks.gecko.mockResolvedValue(new Response(null, { status: 429 }));
    mocks.rpc.getLogs.mockImplementation(async (args: any) => args.event.name === "CurveBuy" ? [{ transactionHash: h(7), logIndex: 4, blockNumber: 19970n, args: { buyer: a(2), tokensOut: 12n } }] : []);
    const result = JSON.parse((await run("trades")).json!);
    expect(result.trades[0]).toMatchObject({ kind: "buy", tokenAmount: "12", walletAddress: a(2), source: "rpc" });
    expect(result.trades[0].marketCapUsd).toBeUndefined();
    expect(mocks.rpc.getTransactionReceipt).not.toHaveBeenCalled();
    expect(mocks.rpc.getLogs.mock.calls.every(([args]: any[]) => args.toBlock - args.fromBlock < 10000n)).toBe(true);
  });
  it("does not use the V4 router address as the trader", async () => {
    phase = 2; launch.graduated = true;
    mocks.rpc.getLogs.mockImplementation(async (args: any) => args.event.name === "Swap" ? [{ transactionHash: h(8), logIndex: 5, blockNumber: 19970n, args: { sender: a(99), amount0: -50n, amount1: 10n } }] : []);
    const result = JSON.parse((await run("trades")).json!);
    expect(result.trades[0]).toMatchObject({ kind: "buy", walletAddress: a(2), tokenAmount: "10" });
    expect(mocks.rpc.getTransaction).toHaveBeenCalledTimes(1);
  });
  it("keeps old trades if both providers fail", async () => {
    mocks.rpc.getChainId.mockRejectedValue(new Error("offline")); mocks.gecko.mockResolvedValue(new Response(null, { status: 503 }));
    expect((await run("trades", { json: '{"trades":[{"id":"saved"}]}' })).json).toBeUndefined();
  });
  it("a completed empty tail removes reorged RPC rows without erasing older history", async () => {
    const row = { id: "x", transactionHash: h(9), logIndex: 1, kind: "buy", walletAddress: a(2), tokenAmount: "1", source: "rpc" };
    const result = JSON.parse((await run("trades", { json: JSON.stringify({ trades: [{ ...row, timestamp: Date.now() - 10000 }, { ...row, id: "y", logIndex: 2, timestamp: Date.now() - 600000 }] }) })).json!);
    expect(result.trades).toHaveLength(1); expect(result.trades[0].logIndex).toBe(2);
  });
  it("bootstraps holder history with a bounded batch when the explorer is blocked", async () => {
    mocks.rpc.getLogs.mockImplementation(async (args: any) => args.fromBlock === 19900n ? [{ args: { from: a(0), to: a(2), value: 1000n } }] : []);
    const refreshed = await run("holders");
    const result = JSON.parse(refreshed.json!);
    expect(JSON.parse(refreshed.stateJson).historySpan).toBe(100000);
    expect(result).toMatchObject({ holders: [{ address: a(2), amount: "1000", percentage: 100 }], partial: false });
    const batch = client.mutation.mock.calls.find(([ref]: any[]) => getFunctionName(ref) === "marketData:recordHolderHistory")[1];
    expect(batch).toMatchObject({ throughBlock: "19980", deltas: [{ address: a(2), delta: "1000" }] });
    expect(mocks.rpc.readContract.mock.calls.filter(([r]: any[]) => r.functionName === "balanceOf").every(([r]: any[]) => r.blockNumber === 19980n)).toBe(true);
  });
  it("does not repeat the explorer request every minute after a failed baseline", async () => {
    await run("holders", { stateJson: JSON.stringify({ baselineAttemptAt: Date.now() - 60000 }) });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves named V3 liquidity labels from the explorer baseline", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ items: [{ address: { hash: a(2), name: "Uniswap V3 Liquidity" }, value: "1000" }] }));
    launch.creatorAddress = a(9);
    const result = JSON.parse((await run("holders")).json!);
    expect(result.holders[0].tag).toBe("Uniswap V3 Liquidity");
  });
  it("continues missing history after an older explorer baseline stops working", async () => {
    await run("holders", { stateJson: JSON.stringify({ baselineAt: Date.now() - 700000, baselineAttemptAt: Date.now() }) });
    expect(client.mutation.mock.calls.some(([ref]: any[]) => getFunctionName(ref) === "marketData:recordHolderHistory")).toBe(true);
  });
  it("retains the old ranking when any candidate balance read fails", async () => {
    const original = mocks.rpc.readContract.getMockImplementation();
    mocks.rpc.readContract.mockImplementation(async (args: any) => { if (args.functionName === "balanceOf") throw new Error("offline"); return original(args); });
    const result = await run("holders", { json: '{"holders":[{"address":"saved","amount":"1"}]}' });
    expect(result.json).toBeUndefined(); expect(result.diagnostic).toBe("holder_balance_read_failed");
  });
  it("does not apply another history batch after a checkpoint hash mismatch", async () => {
    history = { throughBlock: "19900", blockHash: h(1), top: [] };
    const result = JSON.parse((await run("holders")).json!);
    expect(result.partial).toBe(true);
    expect(client.mutation.mock.calls.some(([ref]: any[]) => getFunctionName(ref) === "marketData:recordHolderHistory")).toBe(false);
  });
});
