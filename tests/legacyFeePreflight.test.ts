import { describe, expect, it, vi } from "vitest";
import { type Address, type PublicClient } from "viem";
import { curveSweepIsEmpty } from "../lib/wallet-signer/legacy-fee-preflight";
import { canSkipUnsubmittedSweep } from "../lib/legacy-claim-workflow";

const curve = `0x${"1".repeat(40)}` as Address;
function fixture(values: Record<string, bigint> = {}) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => values[functionName] ?? 0n);
  const getBlockNumber = vi.fn(async () => 123n);
  return { client: { readContract, getBlockNumber } as unknown as PublicClient, readContract, getBlockNumber };
}
describe("legacy sweep preflight", () => {
  it("recognizes an empty curve without simulating, signing or sending", async () => {
    const f = fixture();
    expect(await curveSweepIsEmpty(f.client, curve)).toBe(true);
    expect(f.readContract).toHaveBeenCalledTimes(3);
    for (const [arg] of f.readContract.mock.calls) expect(arg).toMatchObject({ address: curve, blockNumber: 123n });
    expect(canSkipUnsubmittedSweep(new Error("nothing to sweep"))).toBe(true);
  });
  it.each(["quoteFeeBalance", "creatorTaxBalance", "buybackQuoteBalance"])("does not skip positive %s even if escrow is empty", async key => {
    expect(await curveSweepIsEmpty(fixture({ [key]: 1n }).client, curve)).toBe(false);
  });
  it("uses an explicitly pinned block and does not cache mutable balances", async () => {
    const f = fixture(); expect(await curveSweepIsEmpty(f.client, curve, 456n)).toBe(true);
    expect(f.getBlockNumber).not.toHaveBeenCalled();
    f.readContract.mockResolvedValue(1n);
    expect(await curveSweepIsEmpty(f.client, curve, 457n)).toBe(false);
  });
  it("does not interpret RPC failures or unsupported getters as zero", async () => {
    const f = fixture(); f.readContract.mockRejectedValue(new Error("getter unavailable"));
    expect(await curveSweepIsEmpty(f.client, curve)).toBe(false);
    f.getBlockNumber.mockRejectedValue(new Error("429"));
    expect(await curveSweepIsEmpty(f.client, curve)).toBe(false);
  });
});
