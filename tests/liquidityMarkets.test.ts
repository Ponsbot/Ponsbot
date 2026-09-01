import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";
import { liquidityPoolId, liquidityPoolKey } from "../lib/liquidity-contracts";
import type { LiquidityCandidate } from "../lib/liquidity-workflow";
import { DELTA_LIQUIDITY as A } from "../lib/liquidity-workflow";
import { liquiditySqrtTick } from "../lib/liquidity-math";
const rpc = vi.hoisted(() => ({ readContract: vi.fn(), getBlockNumber: vi.fn(), getLogs: vi.fn() }));
const gecko = vi.hoisted(() => vi.fn());
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => rpc }));
vi.mock("../lib/gecko-shared", () => ({ geckoSharedFetch: gecko }));
import { discoverLiquidityPools, liquidityReferencePrice, selectLiquidityCandidates } from "../lib/liquidity-markets";
const token: Address = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07", pool: Address = "0x1111111111111111111111111111111111111111";
beforeEach(() => {
  vi.resetAllMocks(); rpc.getBlockNumber.mockResolvedValue(100n); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No external network in tests")));
  gecko.mockImplementation(async () => new Response(JSON.stringify({ data: [{ attributes: { address: pool, base_token_price_usd: ".001", quote_token_price_usd: "2000", volume_usd: { h1: "10000" }, transactions: { h1: { buys: 20, sells: 10 } } }, relationships: { base_token: { data: { id: `robinhood_${token}` } }, quote_token: { data: { id: `robinhood_${A.weth}` } } } }] }), { headers: { "x-market-observed-at": String(Date.now()) } }));
  rpc.readContract.mockImplementation(async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
    if (functionName === "symbol") return "TEST"; if (functionName === "decimals") return 18;
    if (functionName === "token0") return A.weth; if (functionName === "token1") return token;
    if (functionName === "fee") return 5000; if (functionName === "tickSpacing") return 100;
    if (functionName === "getPool") return args?.[0] === A.weth && args?.[1] === token && args?.[2] === 5000 ? pool : zeroAddress;
    if (functionName === "slot0") return [liquiditySqrtTick(Math.floor(Math.log(2_000_000) / Math.log(1.0001))), 0, 0, 0, 0, 0, true];
    if (functionName === "liquidity" || functionName === "getLiquidity") return 10n ** 22n;
    if (functionName === "getSlot0") return [0n, 0, 0, 3000];
    throw new Error(`Unexpected RPC ${functionName}`);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("verified liquidity discovery and pricing", () => {
  it("keeps the busiest pools plus the largest and deepest alternatives", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `pool-${i}`, reserveUsd: i * 100, activeDepthUsd: (9 - i) * 10, volumeHourUsd: i > 2 && i < 8 ? 10000 : 0 }) as LiquidityCandidate);
    const shortlist = selectLiquidityCandidates(rows);
    expect(shortlist).toHaveLength(6); expect(new Set(shortlist.map(p => p.id)).size).toBe(6);
    for (const id of ["pool-9", "pool-0", "pool-3", "pool-4", "pool-5"]) expect(shortlist.some(p => p.id === id)).toBe(true);
  });
  it("recovers a non-preset V4 pool from public-RPC initialization logs without Blockscout", async () => {
    const key = liquidityPoolKey(token, "ETH", 4, 9000, 90), id = liquidityPoolId(key);
    gecko.mockImplementation(async () => new Response(JSON.stringify({ data: [{ attributes: { address: id, reserve_in_usd: "120000", base_token_price_usd: "2000", quote_token_price_usd: ".001" }, relationships: { base_token: { data: { id: `robinhood_${zeroAddress}` } }, quote_token: { data: { id: `robinhood_${token}` } } } }] }), { headers: { "x-market-observed-at": String(Date.now()) } }));
    rpc.getLogs.mockResolvedValue([{ args: { ...key, id } }]);
    const original = rpc.readContract.getMockImplementation()!;
    rpc.readContract.mockImplementation(arg => arg.functionName === "getSlot0" && arg.args[0] === id ? [liquiditySqrtTick(145080), 145080, 0, 9000] : original(arg));
    const result = await discoverLiquidityPools(token);
    expect(result.candidates.some(p => p.id === id && p.reserveUsd === 120000)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses a single configured-RPC fallback when public descriptor discovery fails", async () => {
    vi.stubEnv("ROBINHOOD_RPC_URL", "https://configured-rpc.invalid");
    const key = liquidityPoolKey(token, "ETH", 4, 9100, 91), id = liquidityPoolId(key);
    gecko.mockImplementation(async () => Response.json({ data: [{ attributes: { address: id, volume_usd: { h1: "2000", h24: "48000" } } }] }, { headers: { "x-market-observed-at": String(Date.now()) } }));
    rpc.getLogs.mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce([{ args: { ...key, id } }]);
    const original = rpc.readContract.getMockImplementation()!;
    rpc.readContract.mockImplementation(arg => arg.functionName === "getSlot0" && arg.args[0] === id ? [liquiditySqrtTick(145080), 145080, 0, 9100] : original(arg));
    const result = await discoverLiquidityPools(token);
    expect(result.candidates.some(p => p.id === id)).toBe(true);
    expect(rpc.getLogs).toHaveBeenCalledTimes(6); expect(fetch).not.toHaveBeenCalled();
    for (const [args] of rpc.getLogs.mock.calls.slice(0, 2)) expect(args).toMatchObject({ address: A.v4Manager, args: { id }, fromBlock: 0n, toBlock: 100n });
    expect(result.analysis.diagnostics).not.toContain("DESCRIPTOR_LOOKUP_FAILED");
  });
  it("caps configured descriptor fallbacks at six and reports incomplete discovery", async () => {
    vi.stubEnv("ROBINHOOD_RPC_URL", "https://configured-rpc.invalid");
    const ids = Array.from({ length: 10 }, (_, i) => liquidityPoolId(liquidityPoolKey(token, "ETH", 4, 9300 + i, 93)));
    gecko.mockImplementation(async () => Response.json({ data: ids.map(id => ({ attributes: { address: id, volume_usd: { h1: "2000", h24: "48000" } } })) }, { headers: { "x-market-observed-at": String(Date.now()) } }));
    rpc.getLogs.mockRejectedValue(new Error("unavailable"));
    const result = await discoverLiquidityPools(token);
    expect(rpc.getLogs).toHaveBeenCalledTimes(20); // Ten public, six configured, then four bounded exact-topic discovery calls.
    expect(result.analysis.diagnostics).toContain("DESCRIPTOR_LOOKUP_FAILED");
  });
  it("discovers a non-preset fee tier from Gecko and verifies the canonical V3 factory", async () => {
    const result = await discoverLiquidityPools(token, 100);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ id: pool, version: 3, feePips: 5000, tickSpacing: 100, volumeHourUsd: 10000 });
    expect(result.candidates[0].activeDepthUsd).toBeGreaterThan(100);
    expect(result.candidates[0].estimatedBudgetSharePercent).toBeGreaterThan(0);
    expect(result.candidates[0].estimatedBudgetSharePercent).toBeLessThan(100);
  });
  it("uses recent cached discovery immediately and still verifies the pool on-chain", async () => {
    const cachedAt = Date.now() - 30_000;
    const data = [{ attributes: { address: pool, base_token_price_usd: ".001", quote_token_price_usd: "2000", volume_usd: { h1: "10000" }, transactions: { h1: { buys: 20, sells: 10 } } }, relationships: { base_token: { data: { id: `robinhood_${token}` } }, quote_token: { data: { id: `robinhood_${A.weth}` } } } }];
    gecko.mockResolvedValueOnce(new Response(JSON.stringify({ data }), { headers: { "x-market-observed-at": String(cachedAt), "x-market-stale": "1" } }));
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 }, { fresh: true });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ id: pool, version: 3, feePips: 5000, tickSpacing: 100 });
    expect(result.analysis.diagnostics).toContain("GECKO_RECENT_CACHE_FALLBACK");
    expect(result.analysis.diagnostics).not.toContain("GECKO_HTTP_429");
    expect(gecko).toHaveBeenCalledWith(expect.any(String), 60_000, 8_000, true, false, expect.any(Number), "interactive");
    expect(gecko).toHaveBeenCalledTimes(1);
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "getPool", blockNumber: 100n }));
  });
  it("uses an interactive Gecko fallback that is several hours old", async () => {
    const cachedAt = Date.now() - 5 * 60 * 60_000;
    const data = [{ attributes: { address: pool, reserve_in_usd: "74000", base_token_price_usd: ".001", quote_token_price_usd: "2000", volume_usd: { h1: "2500", h24: "54000" }, transactions: { h1: { buys: 20, sells: 10 } } }, relationships: { base_token: { data: { id: `robinhood_${token}` } }, quote_token: { data: { id: `robinhood_${A.weth}` } } } }];
    gecko.mockResolvedValueOnce(new Response(JSON.stringify({ data }), { headers: { "x-market-observed-at": String(cachedAt), "x-market-stale": "1" } }));
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 }, { fresh: true });
    expect(gecko).toHaveBeenCalledTimes(1);
    expect(result.candidates[0]).toMatchObject({ id: pool, reserveUsd: 74000, volumeHourUsd: 2500, volumeDayUsd: 54000 });
    expect(result.analysis.diagnostics).toContain("GECKO_RECENT_CACHE_FALLBACK");
  });
  it("uses an older validated discovery snapshot and still verifies it onchain", async () => {
    const staleAt = Date.now() - (6 * 60 + 1) * 60_000;
    const data = [{ attributes: { address: pool, reserve_in_usd: "74000", base_token_price_usd: ".001", quote_token_price_usd: "2000", volume_usd: { h1: "2500", h24: "54000" }, transactions: { h1: { buys: 20, sells: 10 } } }, relationships: { base_token: { data: { id: `robinhood_${token}` } }, quote_token: { data: { id: `robinhood_${A.weth}` } } } }];
    gecko.mockResolvedValueOnce(new Response(JSON.stringify({ data }), { headers: { "x-market-observed-at": String(staleAt), "x-market-stale": "1" } }));
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 }, { fresh: true });
    expect(gecko).toHaveBeenCalledTimes(1);
    expect(result.analysis.diagnostics).toContain("GECKO_RECENT_CACHE_FALLBACK");
    expect(result.candidates.some(candidate => candidate.volumeHourUsd === 2500 && candidate.reserveUsd === 74000)).toBe(true);
  });
  it("discovers arbitrary V3 and V4 pools on-chain when Gecko and its cache are unavailable", async () => {
    const v3Fee = 7500, v3Spacing = 75;
    const v4Fee = 9000, v4Spacing = 90;
    const v4Key = liquidityPoolKey(token, "USDG", 4, v4Fee, v4Spacing);
    const v4Id = liquidityPoolId(v4Key);
    gecko.mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    rpc.getLogs.mockImplementation(async ({ address, args }: { address: Address; args?: { token0?: Address; token1?: Address; currency0?: Address; currency1?: Address } }) => {
      const [eth0, eth1] = [A.weth, token].sort();
      if (address === A.v3Factory && args?.token0 === eth0 && args?.token1 === eth1) return [{ args: { token0: eth0, token1: eth1, fee: v3Fee, tickSpacing: v3Spacing, pool } }];
      if (address === A.v4Manager && args?.currency0 === v4Key.currency0 && args?.currency1 === v4Key.currency1) return [{ args: { ...v4Key, id: v4Id, sqrtPriceX96: 1n, tick: 0 } }];
      return [];
    });
    const original = rpc.readContract.getMockImplementation()!;
    rpc.readContract.mockImplementation(arg => {
      if (arg.functionName === "getPool" && arg.args?.[2] === v3Fee) return pool;
      if (arg.functionName === "getSlot0" && arg.args?.[0] === v4Id) return [liquiditySqrtTick(0), 0, 0, v4Fee];
      if (arg.functionName === "getLiquidity" && arg.args?.[0] === v4Id) return 10n ** 22n;
      return original(arg);
    });
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 }, { fresh: true });
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 3, pair: "ETH", feePips: v3Fee, tickSpacing: v3Spacing }),
      expect.objectContaining({ id: v4Id, version: 4, pair: "USDG", feePips: v4Fee, tickSpacing: v4Spacing }),
    ]));
    expect(result.analysis.diagnostics).toContain("ONCHAIN_DISCOVERY_USED");
    expect(result.candidates.every(candidate => candidate.volumeHourUsd === null)).toBe(true);
  });
  it("prices uncatalogued tokens through a verified active compatible pool", async () => {
    expect(await liquidityReferencePrice(token, { ETH: 2000, USDG: 1 })).toBeCloseTo(.001, 5);
  });
  it("does not use a stale Gecko page to invent fresh volume or pricing", async () => {
    gecko.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { headers: { "x-market-observed-at": "1" } }));
    await expect(liquidityReferencePrice(token, { ETH: 2000, USDG: 1 })).rejects.toThrow("LP_REFERENCE_PRICE_UNAVAILABLE");
  });
});
