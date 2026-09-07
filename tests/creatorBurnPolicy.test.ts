import { describe, expect, it } from "vitest";
import { creatorBurnEnabled, creatorBurnPercentageBps, creatorBurnQuoteDigest, creatorBurnSplit } from "../lib/creator-burn-policy";
import type { Address } from "viem";

describe("creator self-buyback policy", () => {
  it("is off by default and independent of existing automated fees", () => {
    expect(creatorBurnEnabled({ AUTOMATED_BUYBACK_BURN_ENABLED: "true" })).toBe(false);
    expect(creatorBurnEnabled({ CREATOR_SELF_BUYBACK_ENABLED: "true" })).toBe(true);
  });
  it.each([["0", 0], ["20%", 2000], ["0.25%", 25], ["100", 10000]])("parses %s exactly", (value, bps) => {
    expect(creatorBurnPercentageBps(String(value))).toBe(bps);
  });
  it.each(["101", "-1", "1.001", "1e2", "20 then send", "NaN"])("rejects %s", value => {
    expect(() => creatorBurnPercentageBps(value)).toThrow();
  });
  it("takes twenty percent of the remaining ninety-five percent", () => {
    expect(creatorBurnSplit(10n ** 18n, 2000)).toEqual({ ponsbot: 5n * 10n ** 16n, selfBuyback: 19n * 10n ** 16n, cash: 76n * 10n ** 16n });
  });
  it("conserves integer amounts for every supported percentage", () => {
    for (let bps = 0; bps <= 10000; bps++) {
      const s = creatorBurnSplit(123456789n, bps);
      expect(s.ponsbot + s.selfBuyback + s.cash).toBe(123456789n);
    }
  });
  it("binds quote nonce, beneficiary, token, chain and route", () => {
    const a = "0x1111111111111111111111111111111111111111" as Address;
    const b = "0x2222222222222222222222222222222222222222" as Address;
    const q = { chainId: 4663n, layer: a, upstream: a, token: a, asset: b, beneficiary: a,
      amount: 1n, minimumOut: 1n, deadline: 10n, executor: b, route: "0x" as const, configurationNonce: 0n, executionNonce: 0n };
    for (const changed of [{ chainId: 1n }, { layer: b }, { beneficiary: b }, { token: b },
      { configurationNonce: 1n }, { executionNonce: 1n }, { route: "0x12" as const }, { amount: 2n }]) {
      expect(creatorBurnQuoteDigest({ ...q, ...changed })).not.toBe(creatorBurnQuoteDigest(q));
    }
  });
});
