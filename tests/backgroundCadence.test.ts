import { describe, expect, it } from "vitest";
import { backgroundInterval, CREATOR_BURN_CHECK_MS, CREATOR_BURN_HISTORY_MS } from "../lib/background-cadence";
import { FEE_CHECK_INTERVAL_MS, NEW_LAUNCH_FEE_INTERVAL_MS, FEE_WORK_LEASE_MS, feeRetryDelay } from "../lib/automated-fee-scheduling";

describe("reduced routine monitoring rates", () => {
  it("uses 5%, 20%, and 30% of the previous check frequencies", () => {
    expect(CREATOR_BURN_CHECK_MS).toBe(15 * 60_000 / 0.05);
    expect(CREATOR_BURN_HISTORY_MS).toBe(60_000 / 0.05);
    expect(FEE_CHECK_INTERVAL_MS).toBe(60 * 60_000 / 0.2);
    expect(NEW_LAUNCH_FEE_INTERVAL_MS).toBe(10 * 60_000 / 0.2);
    expect(backgroundInterval(60_000)).toBe(200_000);
  });
  it("does not lengthen transaction leases or active fee retries", () => {
    expect(FEE_WORK_LEASE_MS).toBe(300_000);
    expect(feeRetryDelay(0)).toBe(30_000);
  });
});
