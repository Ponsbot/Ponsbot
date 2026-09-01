import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";
import { DELTA_LIQUIDITY as A, liquidityCandidateSchema, type LiquidityCandidate } from "../lib/liquidity-workflow";
import { liquiditySqrtTick } from "../lib/liquidity-math";
import { compareLiquidityCandidates, liquidityFeeOpportunity, liquidityHourlyActivity, liquidityMetric, liquidityVolumeTier } from "../lib/liquidity-analysis-policy";
const mocks = vi.hoisted(() => ({ read: vi.fn(), gecko: vi.fn(), price: vi.fn(), block: vi.fn(), logs: vi.fn() }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({ readContract: mocks.read, getBlockNumber: mocks.block, getLogs: mocks.logs }) }));
vi.mock("../lib/gecko-shared", () => ({ geckoSharedFetch: mocks.gecko }));
vi.mock("../lib/wallet-signer/pricing", () => ({ ethUsdPrice: mocks.price }));
import { discoverLiquidityPools } from "../lib/liquidity-markets";
const token: Address = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07";
type Row = { attributes: { address: string; reserve_in_usd: string; volume_usd: { h1?: string; h6?: string; h24?: string }; transactions: { h1: { buys: number; sells: number } } } };
const address = (i: number) => `0x${(i + 200).toString(16).padStart(40, "0")}` as Address;
let rows: Row[], inactive: Set<number>, unsupported: Set<number>, spacing: number;
function row(i: number, hour?: number, day?: number): Row {
  return { attributes: { address: address(i), reserve_in_usd: "100000", volume_usd: { ...(hour === undefined ? {} : { h1: String(hour), h6: String(hour * 6) }), ...(day === undefined ? {} : { h24: String(day) }) }, transactions: { h1: { buys: 3, sells: 2 } } } };
}
beforeEach(() => {
  vi.resetAllMocks(); rows = []; inactive = new Set(); unsupported = new Set(); spacing = 10;
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No network allowed")));
  mocks.block.mockResolvedValue(12345n); mocks.price.mockResolvedValue(2000);
  mocks.gecko.mockImplementation(async () => Response.json({ data: rows }, { headers: { "x-market-observed-at": String(Date.now()) } }));
  mocks.read.mockImplementation(async ({ address: target, functionName, args = [] }) => {
    const i = Number(BigInt(target)) - 200;
    if (functionName === "symbol") return "TEST";
    if (functionName === "decimals") return 18;
    if (functionName === "totalSupply") return 1_000_000_000n * 10n ** 18n;
    if (functionName === "token0") return A.weth;
    if (functionName === "token1") return unsupported.has(i) ? zeroAddress : token;
    if (functionName === "fee") return 4000 + i * 100;
    if (functionName === "tickSpacing") return spacing;
    if (functionName === "getPool") {
      const n = (args[2] - 4000) / 100;
      return args[0] === A.weth && args[1] === token && rows.some(r => r.attributes.address === address(n)) ? address(n) : zeroAddress;
    }
    if (functionName === "slot0") return [liquiditySqrtTick(145080), 145080, 0, 0, 0, 0, true];
    if (functionName === "liquidity") return inactive.has(i) ? 0n : 10n ** 22n;
    if (functionName === "getSlot0") return [0n, 0, 0, 3000];
    if (functionName === "getLiquidity") return 0n;
    throw new Error(`Unexpected read ${functionName}`);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("adaptive live liquidity analysis", () => {
  it("replaces twelve incompatible high-tier candidates before relaxing to quieter pools", async () => {
    rows = Array.from({ length: 12 }, (_, i) => row(i + 30, 50000, 1200000));
    for (let i = 30; i < 42; i++) unsupported.add(i);
    rows.push(...[42, 43, 44].map(i => row(i, 5000, 120000)), ...[45, 46, 47].map(i => row(i, 150, 3600)));
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 });
    expect(result.candidates).toHaveLength(3); expect(result.analysis.stage).toBe("high");
    expect(result.candidates.every(p => p.volumeTier === "high")).toBe(true);
    expect(mocks.read.mock.calls.some(([r]) => r.address === address(45))).toBe(false);
  });
  it("excludes a pool that cannot fit twenty bands into the complete requested range", async () => {
    rows = [row(50, 5000, 120000)]; spacing = 477;
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 }, { fields: { downPercent: 25, upPercent: 25, bands: 20, shape: "bell" } });
    expect(result.candidates).toHaveLength(0); expect(result.analysis.diagnostics).toContain("POOL_SETTINGS_INCOMPATIBLE");
  });
  it("does not reject a band count before the user has chosen the actual range", async () => {
    rows = [row(51, 5000, 120000)]; spacing = 477;
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 }, { fields: { bands: 20, shape: "bell" } });
    expect(result.candidates).toHaveLength(1); expect(result.analysis.diagnostics).toContain("SOME_RANGES_NOT_COMPARABLE");
  });
  it("reports settings incompatibility separately for a previously selected pool", async () => {
    rows = [row(52, 5000, 120000)]; spacing = 477;
    const first = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 });
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 }, { selected: first.candidates[0], fields: { downPercent: 25, upPercent: 25, bands: 20, shape: "bell" } });
    expect(result.selected).toBeUndefined(); expect(result.analysis.diagnostics).toContain("SELECTED_POOL_SETTINGS_INCOMPATIBLE");
  });
  it("checks current lower-tier activity when high-tier pools have stopped trading", async () => {
    rows = [row(53, 0, 20000), row(54, 0, 20000), row(55, 0, 20000), row(56, 300, 7200)];
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 });
    expect(result.candidates[0].id).toBe(address(56));
  });
  it("stops after three high-volume compatible pools and does not read the low tier", async () => {
    rows = [row(0, 5000, 120000), row(1, 2000, 50000), row(2, 10, 11000), row(3, 150, 1500)];
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 }, { fresh: true });
    expect(result.analysis.stage).toBe("high"); expect(result.candidates).toHaveLength(3);
    expect(mocks.read.mock.calls.some(([r]) => r.address === address(3))).toBe(false);
    expect(mocks.gecko.mock.calls[0].slice(1, 5)).toEqual([60000, 8000, true, false]);
    expect(mocks.gecko.mock.calls[0][5]).toBeGreaterThan(0);
    for (const p of result.candidates) expect(liquidityCandidateSchema.safeParse(p).success).toBe(true);
  });
  it.each([0, 1, 2])("widens after %i high-volume compatible pools", async high => {
    rows = Array.from({ length: 4 }, (_, i) => row(i, i < high ? 1500 : 150, i < high ? 40000 : 1500));
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 });
    expect(result.analysis.stage).toBe("low"); expect(result.candidates).toHaveLength(4);
    expect(result.candidates.filter(p => p.volumeTier === "high")).toHaveLength(high);
    expect(result.candidates.every(p => p.volumeSixHourUsd !== null && p.volumeDayUsd !== null)).toBe(true);
  });
  it("does not count inactive or incompatible high-volume pools toward the target", async () => {
    // Distinct IDs avoid the immutable-descriptor cache populated by other tests.
    rows = [row(10, 5000, 120000), row(11, 5000, 120000), row(12, 5000, 120000), row(13, 100, 1000), row(14, 100, 1000)];
    unsupported.add(10); inactive.add(11);
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 });
    expect(result.analysis.stage).toBe("low"); expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map(p => p.id)).not.toContain(address(10)); expect(result.candidates.map(p => p.id)).not.toContain(address(11));
  });
  it("preserves quiet and unknown-volume options without inventing zero volume", async () => {
    rows = [row(0), row(1, 0, 0), row(2, 3, 50)];
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 });
    expect(result.analysis.stage).toBe("limited"); expect(result.candidates).toHaveLength(3);
    expect(result.candidates.find(p => p.id === address(0))?.volumeHourUsd).toBeNull();
    expect(result.candidates.find(p => p.id === address(1))?.volumeHourUsd).toBe(0);
  });
  it("continues canonical checks on a provider deferral and records its cause", async () => {
    mocks.gecko.mockResolvedValue(new Response(null, { status: 429, headers: { "x-gecko-local-deferral": "1" } }));
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 });
    expect(result.analysis.diagnostics).toContain("GECKO_BUDGET_DEFERRED"); expect(result.analysis.checkedPools).toBe(20);
  });
  it("accepts a recent cached response immediately when fresh interactive data is unavailable", async () => {
    mocks.gecko.mockResolvedValue(Response.json({ data: [row(0, 10000, 100000)] }, { headers: { "x-market-observed-at": String(Date.now() - 30_000) } }));
    const result = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 }, { fresh: true });
    expect(result.analysis.diagnostics).toContain("GECKO_RECENT_CACHE_FALLBACK"); expect(result.analysis.summaries).toBe(1);
  });
  it("prices ETH budgets independently and updates share for the requested shape/range", async () => {
    rows = [row(0, 10000, 200000)];
    const reference = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 });
    const eth = await discoverLiquidityPools(token, undefined, undefined, { fresh: true, fields: { amount: ".05", unit: "eth" } });
    expect(mocks.price).toHaveBeenCalledTimes(1);
    expect(eth.candidates[0].estimatedBudgetSharePercent).toBeCloseTo(reference.candidates[0].estimatedBudgetSharePercent!, 10);
    const requested = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 }, { fields: { downPercent: 10, upPercent: 10, shape: "bell", bands: 5 } });
    expect(requested.candidates[0].shareBasis).toBe("requested");
    expect(requested.candidates[0].estimatedBudgetSharePercent).not.toBe(reference.candidates[0].estimatedBudgetSharePercent);
  });
  it("verifies a selected quiet pool on refresh even when high-volume pools fill the shortlist", async () => {
    rows = [row(0, 0, 0)];
    const first = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 });
    rows = [row(0, 0, 0), row(1, 10000), row(2, 10000), row(3, 10000)];
    const next = await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 }, { selected: first.candidates[0] });
    expect(next.selected?.id).toBe(address(0)); expect(next.candidates.map(p => p.id)).toContain(address(0));
    inactive.add(0);
    expect((await discoverLiquidityPools(token, 100, { ETH: 2000, USDG: 1 }, { selected: first.candidates[0] })).selected).toBeUndefined();
  });
});
describe("grounded activity and fee comparisons", () => {
  it("accepts either window at each exact boundary", () => {
    expect(liquidityVolumeTier(1000, null)).toBe("high"); expect(liquidityVolumeTier(null, 10000)).toBe("high");
    expect(liquidityVolumeTier(100, 9999)).toBe("low"); expect(liquidityVolumeTier(null, 1000)).toBe("low");
    expect(liquidityVolumeTier(null, null)).toBe("limited"); expect(liquidityVolumeTier(99, 999)).toBe("limited");
  });
  it.each([undefined, null, "", " ", -1, "NaN", {}, Infinity])("does not treat missing/invalid metric %s as zero", value => expect(liquidityMetric(value)).toBeNull());
  it("tempers a volume spike and accounts for competing liquidity instead of fee alone", () => {
    const small = { id: "small", volumeHourUsd: 2000, volumeSixHourUsd: 12000, volumeDayUsd: 48000, netLpFeePercent: .3, estimatedBudgetSharePercent: 1 } as LiquidityCandidate;
    const large = { ...small, id: "large", netLpFeePercent: 1, estimatedBudgetSharePercent: .01, volumeHourUsd: 100000 };
    expect(liquidityHourlyActivity(large)).toBe(2000); expect(liquidityFeeOpportunity(small)).toBeGreaterThan(liquidityFeeOpportunity(large)!);
    expect([large, small].sort(compareLiquidityCandidates)[0].id).toBe("small");
    expect(liquidityFeeOpportunity({ ...small, volumeHourUsd: null, volumeSixHourUsd: null, volumeDayUsd: null })).toBeNull();
  });
});
