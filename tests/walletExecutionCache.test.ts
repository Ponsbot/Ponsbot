import { describe, expect, it } from "vitest";
import { walletExecutionCacheKey } from "../lib/shared-wallet-execution-cache";

describe("wallet execution cache keys", () => {
  it("normalizes route endpoints so serverless instances share one route", () => {
    expect(walletExecutionCacheKey(
      "v3_route",
      "0xABCDEF0000000000000000000000000000000001",
      "0xabcdef0000000000000000000000000000000002",
    )).toBe("v3_route:0xabcdef0000000000000000000000000000000001:0xabcdef0000000000000000000000000000000002");
  });

  it("keeps token metadata and Pons pair entries in separate namespaces", () => {
    const token = "0xabcdef0000000000000000000000000000000001";
    expect(walletExecutionCacheKey("token_metadata", token)).not.toBe(walletExecutionCacheKey("pons_pair", token));
  });
});
