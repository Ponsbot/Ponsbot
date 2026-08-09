import { describe, expect, it } from "vitest";
import { usdToEthWei } from "../lib/wallet-signer/pricing";

describe("USD to ETH conversion", () => {
  it("converts dollars to wei and rounds down", () => {
    expect(usdToEthWei("100", 2000)).toBe(50_000_000_000_000_000n);
    expect(usdToEthWei("1", 3000)).toBe(333_333_333_333_333n);
  });

  it("rejects invalid values", () => {
    expect(() => usdToEthWei("0", 2000)).toThrow();
    expect(() => usdToEthWei("10", 0)).toThrow();
  });
});
