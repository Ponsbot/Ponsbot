import { describe, expect, it } from "vitest";
import { liquidityFundedRetryPrefix } from "../lib/liquidity-recovery";

describe("liquidity funded retry", () => {
  const plan = { operation: "open", calls: [
    { purpose: "funding_buy" }, { purpose: "approval" }, { purpose: "open" },
  ] };
  const confirmed = (hash: string) => ({ confirmed: true, transactionHash: hash });

  it("preserves confirmed purchases and approvals but removes the failed open", () => {
    const steps = [confirmed("0xbuy"), confirmed("0xapproval"), { reverted: true, transactionHash: "0xopen" }];
    expect(liquidityFundedRetryPrefix(plan, steps)).toEqual(steps.slice(0, 2));
  });

  it("never retries when a planned purchase was not confirmed", () => {
    expect(liquidityFundedRetryPrefix(plan, [{ reverted: true, transactionHash: "0xbuy" }])).toBeNull();
  });

  it("never treats a completed position as retryable", () => {
    expect(liquidityFundedRetryPrefix(plan, [confirmed("0xbuy"), confirmed("0xapproval"), confirmed("0xopen")])).toBeNull();
  });

  it("rejects a non-contiguous confirmation history", () => {
    expect(liquidityFundedRetryPrefix(plan, [confirmed("0xbuy"), { reverted: true }, confirmed("0xopen")])).toBeNull();
  });
});
