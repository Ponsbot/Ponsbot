import { describe, expect, it, vi } from "vitest";
import { zeroAddress } from "viem";
import { usdgReferencePrice } from "../lib/usdg-reference-price";

describe("USDG paired purchase valuation", () => {
  function client(liquidity = 100n, missing = false) {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getPool") return missing ? zeroAddress : "0x1111111111111111111111111111111111111111";
      if (functionName === "liquidity") return liquidity;
      return [BigInt(Math.floor(Math.sqrt(2000 / 1e12) * 2 ** 96))];
    });
    return { readContract };
  }
  it("converts the observed WETH/USDG price and pins every read to purchase block", async () => {
    const rpc = client();
    expect(await usdgReferencePrice(rpc as any, 2000, 123n)).toBeCloseTo(1, 8);
    expect(rpc.readContract.mock.calls.every(([args]) => (args as any).blockNumber === 123n)).toBe(true);
  });
  it("does not assume USDG is exactly one dollar", async () => {
    expect(await usdgReferencePrice(client() as any, 1980)).toBeCloseTo(.99, 8);
  });
  it("rejects empty and missing reference pools", async () => {
    await expect(usdgReferencePrice(client(0n) as any, 2000)).rejects.toThrow();
    await expect(usdgReferencePrice(client(100n, true) as any, 2000)).rejects.toThrow();
  });
});
