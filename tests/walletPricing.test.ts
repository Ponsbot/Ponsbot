import { describe, expect, it, vi } from "vitest";
import { conservativeEthUsdPrice, ethUsdPrice, usdToEthWei } from "../lib/wallet-signer/pricing";

describe("USD to ETH conversion", () => {
  it("converts dollars to wei and rounds down", () => {
    expect(usdToEthWei("100", 2000)).toBe(50_000_000_000_000_000n);
    expect(usdToEthWei("1", 3000)).toBe(333_333_333_333_333n);
    expect(usdToEthWei("1000000", 2000)).toBe(500_000_000_000_000_000_000n);
  });

  it("rejects invalid values", () => {
    expect(() => usdToEthWei("0", 2000)).toThrow();
    expect(() => usdToEthWei("10", 0)).toThrow();
  });

  it("uses the conservative higher feed price so dollar requests cannot overspend", () => {
    expect(conservativeEthUsdPrice(2_000, 2_040)).toBe(2_040);
    expect(usdToEthWei("100", conservativeEthUsdPrice(2_000, 2_040))).toBeLessThan(usdToEthWei("100", 2_000));
  });

  it("does not start provider work after pricing is cancelled", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(); globalThis.fetch = fetchMock as typeof fetch;
    const controller = new AbortController(); controller.abort();
    await expect(ethUsdPrice(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });
});
