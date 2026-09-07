import { describe, expect, it } from "vitest";
import { feeSnapshotIncludesReceipt } from "../lib/fee-inspection-retry";
describe("controller receipt read consistency", () => {
  it("does not use a pre-transaction snapshot to reject a successful transaction", () => {
    expect(feeSnapshotIncludesReceipt("100", 101n)).toBe(false);
  });
  it("accepts a snapshot of the receipt block or newer", () => {
    expect(feeSnapshotIncludesReceipt("101", 101n)).toBe(true);
    expect(feeSnapshotIncludesReceipt("102", 101n)).toBe(true);
  });
  it("fails closed on an invalid block response", () => {
    expect(() => feeSnapshotIncludesReceipt("unavailable", 101n)).toThrow();
  });
});
