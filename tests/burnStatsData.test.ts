import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PONSBOT_BURN_ADDRESS, PONSBOT_BURN_TOKEN } from "../lib/burn-stats";

const mocks = vi.hoisted(() => ({ query: vi.fn(), readContract: vi.fn(), cache: vi.fn((fn) => fn) }));
vi.mock("next/cache", () => ({ unstable_cache: mocks.cache }));
vi.mock("convex/browser", () => ({ ConvexHttpClient: class { query = mocks.query; } }));
vi.mock("viem", async (original) => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({ readContract: mocks.readContract }) }));
vi.mock("../lib/rpc-http", () => ({ reliableHttp: vi.fn() }));
import { getAutomaticPonsbotBurned, getTotalPonsbotBurned } from "../lib/burn-stats-data";

beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://test.convex.cloud"); mocks.query.mockReset(); mocks.readContract.mockReset(); });
afterEach(() => vi.unstubAllEnvs());

describe("cached burn data sources", () => {
  it("caches the two sources independently for five minutes", () => {
    expect(mocks.cache).toHaveBeenCalledWith(expect.any(Function), ["public-automatic-ponsbot-burns-v1"], { revalidate: 300 });
    expect(mocks.cache).toHaveBeenCalledWith(expect.any(Function), ["public-total-ponsbot-burns-v1"], { revalidate: 300 });
  });
  it("reads the canonical token's dead-address balance and never adds automatic burns again", async () => {
    mocks.readContract.mockResolvedValue(123456789000000000000n);
    expect(await getTotalPonsbotBurned()).toBe("123456789000000000000");
    expect(mocks.readContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      address: PONSBOT_BURN_TOKEN, functionName: "balanceOf", args: [PONSBOT_BURN_ADDRESS],
    }));
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("returns the confirmed creator-fee aggregate unchanged", async () => {
    mocks.query.mockResolvedValue({ ponsbotBurned: "12345678901234567890" });
    expect(await getAutomaticPonsbotBurned()).toBe("12345678901234567890");
    expect(mocks.readContract).not.toHaveBeenCalled();
  });
  it("preserves automatic totals during RPC failure", async () => {
    mocks.query.mockResolvedValue({ ponsbotBurned: "100" });
    mocks.readContract.mockRejectedValue(new Error("RPC unavailable"));
    expect(await Promise.all([getAutomaticPonsbotBurned(), getTotalPonsbotBurned()])).toEqual(["100", null]);
  });
  it("preserves the on-chain total during a Convex failure", async () => {
    mocks.query.mockRejectedValue(new Error("Convex unavailable")); mocks.readContract.mockResolvedValue(200n);
    expect(await Promise.all([getAutomaticPonsbotBurned(), getTotalPonsbotBurned()])).toEqual([null, "200"]);
  });
  it("does not report unavailable or invalid data as zero", async () => {
    mocks.query.mockResolvedValue({ ponsbotBurned: "NaN" });
    expect(await getAutomaticPonsbotBurned()).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "");
    expect(await getAutomaticPonsbotBurned()).toBeNull();
  });
});
