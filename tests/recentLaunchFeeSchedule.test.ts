import { describe, expect, it } from "vitest";
import { nextFeeCheck, recentLaunchFeeDue } from "../lib/automated-fee-scheduling";

const minute = 60_000;
const launched = 1_000_000;
const p = { launchCreatedAt: launched, enrolledAt: launched + minute };
describe("recent launch fee cadence", () => {
  it("uses ten-minute launch-relative slots for four hours", () => {
    expect(nextFeeCheck(p, launched + minute)).toBe(launched + 10 * minute);
    expect(nextFeeCheck(p, launched + 27 * minute)).toBe(launched + 30 * minute);
    expect(nextFeeCheck(p, launched + 239 * minute)).toBe(launched + 240 * minute);
  });
  it("returns to the existing hourly anchor at four hours", () => {
    expect(nextFeeCheck(p, launched + 240 * minute)).toBe(launched + 241 * minute);
    expect(nextFeeCheck(p, launched + 242 * minute)).toBe(launched + 301 * minute);
  });
  it("does not grant a fresh four-hour window to an old upgraded token", () => {
    const now = launched + 48 * 60 * minute;
    expect(nextFeeCheck({ ...p, enrolledAt: now }, now)).toBe(now + 60 * minute);
    expect(nextFeeCheck({ enrolledAt: now }, now)).toBe(now + 60 * minute);
  });
  it("retroactively brings an idle hourly check forward without replaying missed slots", () => {
    const old = { ...p, lastCheckedAt: launched + 15 * minute, nextProcessAt: launched + 60 * minute };
    expect(recentLaunchFeeDue(old, launched + 35 * minute)).toBe(launched + 20 * minute);
    const completed = { ...old, lastCheckedAt: launched + 35 * minute };
    expect(recentLaunchFeeDue(completed, launched + 36 * minute)).toBe(launched + 40 * minute);
    expect(recentLaunchFeeDue(completed, launched + 39 * minute)).toBe(launched + 40 * minute);
  });
  it("never delays an existing earlier check or reschedules old launches", () => {
    expect(recentLaunchFeeDue({ ...p, nextProcessAt: launched + 2 * minute }, launched + minute)).toBe(launched + 2 * minute);
    expect(recentLaunchFeeDue({ ...p, nextProcessAt: launched + 300 * minute }, launched + 240 * minute)).toBe(launched + 300 * minute);
  });
  it("does not immediately repeat a cycle that took longer than a slot to pay out", () => {
    expect(recentLaunchFeeDue({ ...p, lastCheckedAt: launched + 10 * minute,
      lastPaidAt: launched + 35 * minute, nextProcessAt: launched + 40 * minute }, launched + 36 * minute)).toBe(launched + 40 * minute);
  });
});
