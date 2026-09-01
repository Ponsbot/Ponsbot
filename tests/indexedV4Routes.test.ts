import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256 } from "viem";
import { indexedNativeV4Pools } from "../lib/indexed-v4-routes";

describe("indexed Uniswap V4 routes", () => {
  it("matches the live canonical cbBTC/WETH pool initialization", () => {
    const pools = indexedNativeV4Pools("0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4");
    const poolIds = pools.map((pool) => keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks],
    )));
    expect(poolIds).toEqual([
      "0x685818c6aa03ad808aa4a6b6087b91c8f070b3eb17739f9e5785ce6ec7bfcc1f",
      "0xa3ea8bcc4942ddb59a7a1fca1281bc9c869bcca3d99804d412f40b98bbebc80f",
    ]);
  });

  it("does not redirect unrelated indexed assets into the cbBTC pool", () => {
    expect(indexedNativeV4Pools("0xCceE82fE024c36fA15E1005edE3E9e4787e23D09")).toEqual([]);
  });
});
