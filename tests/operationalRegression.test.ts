import { describe, expect, it } from "vitest";
import { mapWithConcurrency, nextTokenCursor, perTokenScanRange, transferAttributedWallet } from "../lib/bounded-concurrency";
import { paginationFailureState, shouldSendBurstNotice, shouldSendCooldownNotice, shouldSendDailyNotice } from "../lib/x-operational-policy";
import { PROTECTED_LAUNCH_X_USER_ID, applyProtectedLaunchProfile } from "../lib/special-launch-policy";

describe("market index regressions", () => {
  it("starts at the oldest per-token cursor without moving newer cursors backwards", () => {
    expect(perTokenScanRange(["20000", "10000", undefined], 8_000n, 30_000n)).toEqual({ from: 8_000n, to: 12_999n });
    expect(nextTokenCursor("20000", 12_999n)).toBe("20000");
    expect(nextTokenCursor("10000", 12_999n)).toBe("12999");
  });

  it("bounds concurrent enrichment work", async () => {
    let active = 0; let maximum = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 4, async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    });
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it("uses a unique token-transfer participant and falls back when ambiguous", () => {
    const infrastructure = new Set(["0xpool"]);
    expect(transferAttributedWallet("buy", [{ from: "0xpool", to: "0xUser" }], infrastructure, "0xfallback")).toBe("0xuser");
    expect(transferAttributedWallet("buy", [{ from: "0xpool", to: "0xA" }, { from: "0xpool", to: "0xB" }], infrastructure, "0xfallback")).toBe("0xfallback");
  });
});

describe("X operational regressions", () => {
  it("sends only one cooldown notice per accepted request period", () => {
    expect(shouldSendCooldownNotice(undefined, 100)).toBe(true);
    expect(shouldSendCooldownNotice(101, 100)).toBe(false);
    expect(shouldSendCooldownNotice(101, 200)).toBe(true);
  });

  it("limits daily and burst notices to their active periods", () => {
    const firstDay = Date.parse("2026-08-14T01:00:00Z");
    expect(shouldSendDailyNotice(firstDay, "2026-08-14")).toBe(false);
    expect(shouldSendDailyNotice(firstDay, "2026-08-15")).toBe(true);
    expect(shouldSendBurstNotice(500, 400)).toBe(false);
    expect(shouldSendBurstNotice(500, 600)).toBe(true);
  });

  it("resets a stale pagination token after three failures", () => {
    expect(paginationFailureState(undefined)).toEqual({ failures: 1, reset: false });
    expect(paginationFailureState(1)).toEqual({ failures: 2, reset: false });
    expect(paginationFailureState(2)).toEqual({ failures: 0, reset: true });
  });
});

describe("immutable protected launch identity", () => {
  it("does not apply the protected profile to the same username with another ID", () => {
    const command = { kind: "launch", launchMode: "pons", name: "Other", symbol: "OTHER" } as const;
    expect(applyProtectedLaunchProfile("999", command, "https://pbs.twimg.com/a.jpg")).toBe(command);
    expect(PROTECTED_LAUNCH_X_USER_ID).toBe("2085516993315188736");
  });
});
