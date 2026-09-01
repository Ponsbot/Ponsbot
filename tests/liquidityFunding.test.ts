import { describe, expect, it, vi } from "vitest";
import { parseEther, parseUnits, type Address } from "viem";
import { DELTA_LIQUIDITY as A } from "../lib/liquidity-workflow";
import { planLiquidityFunding, type LiquidityAssetRequirement, type LiquidityFundingDependencies } from "../lib/liquidity-funding";
import type { LiquidityTransaction } from "../lib/liquidity-contracts";
import { LIQUIDITY_RESPONSES, paginateLiquidityResponse } from "../lib/liquidity-responses";

const token: Address = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07";
const tx = (purpose: string, value = 0n): LiquidityTransaction => ({ to: A.manager, data: "0x", value: value.toString(), purpose });
const tokenNeed = (held = 0n): LiquidityAssetRequirement => ({ asset: token, required: 100n, held, symbol: "PONSBOT", decimals: 0 });
const usdNeed = (required: bigint, held: bigint): LiquidityAssetRequirement => ({ asset: A.usdg, required, held, symbol: "USDG", decimals: 6 });
function dependencies() {
  return {
    buy: vi.fn(async (_asset: Address, minimumOutput: bigint) => ({ nativeInput: minimumOutput, calls: [tx("funding_buy", minimumOutput)] })),
    convertUsdg: vi.fn(async (minimumEth: bigint, maximumUsdg: bigint) => {
      if (minimumEth > maximumUsdg) throw new Error("LP_INSUFFICIENT_FUNDING");
      return { usdgInput: minimumEth, calls: [tx("funding_approval"), tx("funding_usdg_to_eth")] };
    }),
    gasCosts: vi.fn(async (calls: LiquidityTransaction[]) => calls.map(() => 10n)),
  } satisfies LiquidityFundingDependencies;
}
function input(overrides: Partial<Parameters<typeof planLiquidityFunding>[0]> = {}) {
  return { protectedToken: token, ethBalance: 1000n, usdgBalance: 0n, requirements: [tokenNeed()], positionCalls: [tx("open", 50n)], ...overrides };
}

describe("liquidity automatic funding policy", () => {
  it("buys only the missing target amount before the deposit", async () => {
    const deps = dependencies(), plan = await planLiquidityFunding(input({ requirements: [tokenNeed(40n)] }), deps);
    expect(deps.buy).toHaveBeenCalledExactlyOnceWith(token, 60n);
    expect(plan.calls.map(c => c.purpose)).toEqual(["funding_buy", "open"]);
    expect(deps.convertUsdg).not.toHaveBeenCalled();
  });
  it("does not trade when both required holdings are sufficient", async () => {
    const deps = dependencies();
    await planLiquidityFunding(input({ requirements: [tokenNeed(100n), usdNeed(200n, 200n)] }), deps);
    expect(deps.buy).not.toHaveBeenCalled(); expect(deps.convertUsdg).not.toHaveBeenCalled();
  });
  it("buys missing USDG with ETH", async () => {
    const deps = dependencies();
    await planLiquidityFunding(input({ requirements: [tokenNeed(100n), usdNeed(200n, 50n)], usdgBalance: 50n }), deps);
    expect(deps.buy).toHaveBeenCalledExactlyOnceWith(A.usdg, 150n);
  });
  it("converts spare USDG first, covering both purchases and all transaction gas", async () => {
    const deps = dependencies();
    const plan = await planLiquidityFunding(input({ ethBalance: 40n, usdgBalance: 1000n }), deps);
    expect(plan.calls.map(c => c.purpose)).toEqual(["funding_approval", "funding_usdg_to_eth", "funding_buy", "open"]);
    expect(deps.convertUsdg).toHaveBeenLastCalledWith(150n, 1000n);
    expect(plan.gasReserve).toBe(40n);
    expect(plan.summary.join("\n")).toContain("spare USDG");
  });
  it("never converts the USDG reserved for the LP", async () => {
    const deps = dependencies();
    await planLiquidityFunding(input({ ethBalance: 40n, usdgBalance: 1000n, requirements: [tokenNeed(), usdNeed(600n, 1000n)] }), deps);
    expect(deps.convertUsdg.mock.calls.every(([, max]) => max === 400n)).toBe(true);
  });
  it("rejects an ETH shortfall even when the user owns many target tokens", async () => {
    const deps = dependencies();
    await expect(planLiquidityFunding(input({ ethBalance: 40n, requirements: [tokenNeed(10_000_000n)] }), deps)).rejects.toThrow("LP_INSUFFICIENT_FUNDING");
    expect(deps.buy).not.toHaveBeenCalled(); expect(deps.convertUsdg).not.toHaveBeenCalled();
  });
  it("does not spend all held USDG when some is reserved and the remainder is insufficient", async () => {
    const deps = dependencies();
    await expect(planLiquidityFunding(input({ ethBalance: 40n, usdgBalance: 650n, requirements: [tokenNeed(), usdNeed(600n, 650n)] }), deps)).rejects.toThrow("LP_INSUFFICIENT_FUNDING");
    expect(deps.convertUsdg).toHaveBeenCalledWith(130n, 50n);
  });
  it("does not sell USDG at all when USDG itself is the position token", async () => {
    const deps = dependencies();
    await expect(planLiquidityFunding(input({ protectedToken: A.usdg, ethBalance: 40n, usdgBalance: 1_000_000n, requirements: [usdNeed(10n, 1_000_000n)] }), deps)).rejects.toThrow("LP_INSUFFICIENT_FUNDING");
    expect(deps.convertUsdg).not.toHaveBeenCalled();
  });
  it("requires actual ETH for the initial USDG conversion gas", async () => {
    const deps = dependencies();
    await expect(planLiquidityFunding(input({ ethBalance: 0n, usdgBalance: 1000n }), deps)).rejects.toThrow("LP_INSUFFICIENT_GAS");
  });
  it("cannot count USDG that would only be bought later as spare funding", async () => {
    const deps = dependencies();
    await expect(planLiquidityFunding(input({ ethBalance: 40n, usdgBalance: 50n, requirements: [tokenNeed(100n), usdNeed(100n, 50n)] }), deps)).rejects.toThrow("LP_INSUFFICIENT_FUNDING");
    expect(deps.convertUsdg).not.toHaveBeenCalled();
  });
  it("keeps large raw amounts in exact bigint arithmetic", async () => {
    const deps = dependencies();
    const desired = parseUnits("12345678901234567890.123456789123456789", 18);
    const held = desired - 1n;
    await planLiquidityFunding(input({ ethBalance: parseEther("1"), requirements: [{ ...tokenNeed(), required: desired, held, decimals: 18 }] }), deps);
    expect(deps.buy).toHaveBeenCalledExactlyOnceWith(token, 1n);
  });
  it("keeps funding failures short enough for X", () => {
    expect(paginateLiquidityResponse([LIQUIDITY_RESPONSES.funding], "x")).toHaveLength(1);
    expect(paginateLiquidityResponse([LIQUIDITY_RESPONSES.fundingGas], "x")).toHaveLength(1);
  });
});
