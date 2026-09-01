import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address, type PublicClient } from "viem";
import { inspectFeeAccumulation } from "../lib/wallet-signer/fee-accumulation";
import { FEE_ACCUMULATION_THRESHOLD_WEI, feeThresholdReached, nextFeeCheck, feeRetryDelay, netCreatorFees } from "../lib/automated-fee-scheduling";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const threshold = FEE_ACCUMULATION_THRESHOLD_WEI;
describe("fixed schedules and economic threshold", () => {
  it("requires 0.007 ETH of gross creator fees, not the 5% buyback", () => {
    expect(threshold).toBe(7_000_000_000_000_000n);
    expect(feeThresholdReached((threshold - 1n).toString())).toBe(false);
    expect(feeThresholdReached(threshold.toString())).toBe(true);
    expect(feeThresholdReached((threshold + 1n).toString())).toBe(true);
    expect(threshold * 500n / 10_000n).toBe(350_000_000_000_000n);
  });
  it.each([undefined, "", "NaN", "-1", "0.007", "1e18"])("does not treat invalid %s valuation as eligible", value => {
    expect(feeThresholdReached(value)).toBe(false);
  });
  it("retains enrollment slots when checks and transaction completion are late", () => {
    const p = { enrolledAt: 100_000 };
    expect(nextFeeCheck(p, 100_000)).toBe(1_000_000);
    expect(nextFeeCheck(p, 1_030_000)).toBe(1_900_000);
    expect(nextFeeCheck(p, 1_080_000)).toBe(1_900_000);
    expect(nextFeeCheck(p, 4_640_000)).toBe(5_500_000);
    expect(nextFeeCheck({ scheduleAnchorAt: 100_000, enrolledAt: 500_000 }, 1_080_000)).toBe(1_900_000);
  });
  it("bounds exponential retries and honors a longer Retry-After", () => {
    expect([0, 1, 2, 3, 4, 20].map(n => feeRetryDelay(n))).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(feeRetryDelay(0, 180_000)).toBe(180_000);
  });
  it("accounts for frozen protocol share, tax and already-earmarked Pons buybacks", () => {
    expect(netCreatorFees(10000n, 100n, 1000n, 2000n)).toBe(7100n);
    expect(netCreatorFees(3n, 7n, 9n, 5000n)).toBe(7n);
    expect(() => netCreatorFees(1n, 0n, 0n, 10001n)).toThrow();
  });
});

describe("read-only creator-fee assessment", () => {
  function fixture(phase = 0, pairToken: Address = zeroAddress) {
    const values: Record<string, any> = { quoteFeeBalance: threshold * 2n, creatorTaxBalance: 0n,
      buybackQuoteBalance: 0n, protocolFeeShareBps: 5000,
      memeHook: a(9), getLaunchFeePolicy: { protocolFeeShareBps: 5000 }, pendingFees: threshold * 2n,
      pendingCreatorTax: 0n, pendingBuyback: 0n };
    const readContract = vi.fn(async (req: any) => {
      expect(req.blockNumber).toBe(123n);
      if (req.functionName.startsWith("pending") && req.args[1] === a(1)) return 0n;
      if (!(req.functionName in values)) throw new Error("unexpected read");
      return values[req.functionName];
    });
    const input = { client: { readContract } as unknown as PublicClient, blockNumber: 123n,
      factory: a(2), escrow: 0n, launch: { token: a(1), curve: a(3), pairToken, phase, poolFee: 0, tickSpacing: 200 },
      quoteNative: vi.fn(async (amount: bigint) => amount) };
    return { input, values, readContract };
  }
  it("counts net unswept curve fees before sending a sweep", async () => {
    const { input } = fixture();
    const result = await inspectFeeAccumulation(input);
    expect(result.availableCreatorFeesEthWei).toBe(threshold.toString());
    expect(result.unsweptCreatorFees).toBe(threshold.toString());
    expect(input.quoteNative).not.toHaveBeenCalled();
  });
  it("adds existing escrow without counting reserves or protocol fees", async () => {
    const { input, values, readContract } = fixture();
    values.quoteFeeBalance = 0n; values.creatorTaxBalance = 50n; input.escrow = threshold - 50n;
    expect((await inspectFeeAccumulation(input)).availableCreatorFeesEthWei).toBe(threshold.toString());
    expect(readContract.mock.calls.some(([r]) => /balanceOf|Reserves|tracked/.test(r.functionName))).toBe(false);
  });
  it("does not estimate zero when a curve fee read fails", async () => {
    const { input, readContract } = fixture(); readContract.mockRejectedValueOnce(new Error("429"));
    await expect(inspectFeeAccumulation(input)).rejects.toThrow("429");
  });
  it("flags trusted-operator curve inventory without trying to sweep it", async () => {
    const { input, values } = fixture(); values.buybackQuoteBalance = 1n;
    expect(await inspectFeeAccumulation(input)).toMatchObject({ operatorRequired: true, availableCreatorFeesEthWei: "0" });
  });
  it("uses the existing approved route to value paired fees in ETH", async () => {
    const { input, values } = fixture(0, a(4)); values.quoteFeeBalance = 10_000_000n;
    input.quoteNative.mockImplementation(async amount => amount * 1_400_000_000n);
    expect((await inspectFeeAccumulation(input)).availableCreatorFeesEthWei).toBe(threshold.toString());
    expect(input.quoteNative).toHaveBeenCalledWith(5_000_000n);
  });
  it("does not request a price for a genuinely empty asset balance", async () => {
    const { input, values } = fixture(0, a(4)); values.quoteFeeBalance = 0n;
    expect((await inspectFeeAccumulation(input)).availableCreatorFeesEthWei).toBe("0");
    expect(input.quoteNative).not.toHaveBeenCalled();
  });
  it("does not turn a missing route or zero-output quote into an empty balance", async () => {
    const { input } = fixture(0, a(4)); input.quoteNative.mockRejectedValueOnce(new Error("no route"));
    await expect(inspectFeeAccumulation(input)).rejects.toThrow("no route");
    input.quoteNative.mockResolvedValueOnce(0n);
    await expect(inspectFeeAccumulation(input)).rejects.toThrow("QUOTE_UNAVAILABLE");
  });
  it("counts directly sweepable graduated quote fees using the launch policy", async () => {
    const { input } = fixture(2);
    expect(await inspectFeeAccumulation(input)).toMatchObject({ availableCreatorFeesEthWei: threshold.toString(), operatorRequired: false });
  });
  it("still allows graduated escrow when the hook needs Pons's operator", async () => {
    const { input, values } = fixture(2); values.pendingBuyback = 1n; input.escrow = threshold;
    expect(await inspectFeeAccumulation(input)).toMatchObject({ operatorRequired: true, availableCreatorFeesEthWei: threshold.toString(), unsweptCreatorFees: "0" });
  });
  it("never values unconvertible token-denominated hook inventory as available ETH", async () => {
    const { input, readContract } = fixture(2);
    readContract.mockImplementation(async req => req.functionName === "memeHook" ? a(9)
      : req.functionName === "getLaunchFeePolicy" ? { protocolFeeShareBps: 5000 }
        : req.functionName === "pendingFees" ? threshold * 10n : 0n);
    expect(await inspectFeeAccumulation(input)).toMatchObject({ availableCreatorFeesEthWei: "0", operatorRequired: true });
  });
});
