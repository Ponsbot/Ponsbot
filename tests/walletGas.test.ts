import { describe, expect, it, vi } from "vitest";
import { bufferedActualCost, estimateActualFees, sendAllGasReserve, spendableEthAfterGas, sponsoredLaunchCost, transactionGasEnvelope, transactionMaximumCost } from "../lib/wallet-signer/gas";

describe("wallet gas envelope", () => {
  it("splits one 10% budget between gas units and gas price without stacking", () => {
    const envelope = transactionGasEnvelope(21_000n, 100n);

    expect(envelope).toEqual({ gas: 21_840n, maxFeePerGas: 105n });
    expect(sendAllGasReserve(21_000n, 100n)).toBe(2_310_000n);
    expect(envelope.gas * envelope.maxFeePerGas).toBeLessThanOrEqual(2_310_000n);
  });

  it("reserves the live buffered gas envelope before an all-ETH swap", () => {
    const result = spendableEthAfterGas(1_000_000n, 100_000n, 2n);
    expect(result.reserve).toBe(sendAllGasReserve(100_000n, 2n));
    expect(result.value + result.reserve).toBe(1_000_000n);
  });

  it("rejects an all-ETH swap when the gas envelope consumes the balance", () => {
    expect(() => spendableEthAfterGas(100n, 100_000n, 2n)).toThrow("insufficient ETH for gas");
  });

  it("keeps requested swap proceeds when separate ETH already covers gas", () => {
    const result = spendableEthAfterGas(1_000_000n, 100_000n, 2n, 100_000n);
    expect(result.value).toBe(100_000n);
  });

  it("caps swap proceeds only when spending them all would consume gas", () => {
    const result = spendableEthAfterGas(1_000_000n, 100_000n, 2n, 900_000n);
    expect(result.value).toBe(780_000n);
  });

  it("includes transaction value when checking the maximum signed liability", () => {
    expect(transactionMaximumCost(500n, 21_000n, 100n)).toBe(2_310_500n);
  });

  it("applies 10% once to launch fee plus raw gas, never to a buffered envelope", () => {
    const fee = 500_000_000_000_000n, gas = 3_500_000n, price = 190_000_000n;
    expect(sponsoredLaunchCost(fee, gas, price)).toBe(1_281_500_000_000_000n);
    expect(sponsoredLaunchCost(fee, gas, price)).toBe(bufferedActualCost(fee + gas * price));
    expect(sponsoredLaunchCost(fee, gas, price)).toBeGreaterThanOrEqual(transactionMaximumCost(fee, gas, price));
  });

  it("rounds only once and always covers the signed maximum, including low gas prices", () => {
    for (const gas of [1n, 19n, 21_000n, 3_523_336n, 999_999n]) {
      for (const price of [0n, 1n, 2n, 100n, 189_146_001n]) {
        const budget = bufferedActualCost(gas * price);
        const envelope = transactionGasEnvelope(gas, price);
        expect(envelope.gas).toBeGreaterThanOrEqual(gas);
        expect(envelope.maxFeePerGas).toBeGreaterThanOrEqual(price);
        expect(envelope.gas * envelope.maxFeePerGas).toBeLessThanOrEqual(budget);
        expect(budget * 100n - gas * price * 110n).toBeLessThan(100n);
        expect(sendAllGasReserve(gas, price)).toBe(budget);
      }
    }
    expect(bufferedActualCost(1n)).toBe(2n);
  });

  it("does not inflate send or purchase principal", () => {
    expect(transactionMaximumCost(1_000_000_000n, 21_000n, 100n)).toBe(1_002_310_000n);
  });

  it("rejects invalid estimates rather than producing underfunded envelopes", () => {
    expect(() => transactionGasEnvelope(0n, 1n)).toThrow();
    expect(() => transactionGasEnvelope(21_000n, -1n)).toThrow();
    expect(() => sponsoredLaunchCost(-1n, 21_000n, 1n)).toThrow();
  });

  it("reads current base plus priority without viem's built-in fee multiplier", async () => {
    const client = {
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 100n }),
      estimateMaxPriorityFeePerGas: vi.fn().mockResolvedValue(3n),
      estimateFeesPerGas: vi.fn(() => { throw new Error("must not use buffered fee estimator"); }),
    };
    expect(await estimateActualFees(client)).toEqual({ maxFeePerGas: 103n, maxPriorityFeePerGas: 3n });
    expect(client.estimateFeesPerGas).not.toHaveBeenCalled();
  });

  it("fails closed when current fee data is missing or invalid", async () => {
    await expect(estimateActualFees({ getBlock: async () => ({}), estimateMaxPriorityFeePerGas: async () => 1n })).rejects.toThrow("fees are unavailable");
    await expect(estimateActualFees({ getBlock: async () => ({ baseFeePerGas: 1n }), estimateMaxPriorityFeePerGas: async () => -1n })).rejects.toThrow("fees are unavailable");
  });
});
