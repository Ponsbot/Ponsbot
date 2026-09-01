import { describe, expect, it } from "vitest";
import { mapWithConcurrency, nextTokenCursor, perTokenScanRange, transferAttributedWallet } from "../lib/bounded-concurrency";
import { isRetryableXReplyStatus, mentionPaginationProgress, paginationFailureState, shouldRecoverXInteraction, shouldSendBurstNotice, shouldSendCooldownNotice, shouldSendDailyNotice, xInteractionDispatchDelay } from "../lib/x-operational-policy";
import { marketEventKey, marketFieldsChanged, marketRefreshAllowed } from "../lib/market-index-policy";

describe("market index regressions", () => {
  it("enforces a true global refresh floor after a completed index", () => {
    expect(marketRefreshAllowed(undefined, 20_000)).toBe(true);
    expect(marketRefreshAllowed(15_000, 20_000)).toBe(false);
    expect(marketRefreshAllowed(10_000, 20_000)).toBe(false);
    expect(marketRefreshAllowed(10_000, 70_000)).toBe(true);
  });

  it("deduplicates normalized event keys and detects no-op market writes", () => {
    expect(marketEventKey("0xABC", 3)).toBe("0xabc:3");
    expect(marketFieldsChanged({ marketCapUsd: 10 }, { marketCapUsd: 10 })).toBe(false);
    expect(marketFieldsChanged({ marketCapUsd: 10 }, { marketCapUsd: 11 })).toBe(true);
    expect(marketFieldsChanged({ recentEventKeys: ["a", "b"] }, { recentEventKeys: ["a", "b"] })).toBe(false);
  });
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

  it("ends a mention backlog when X returns the same pagination token", () => {
    expect(mentionPaginationProgress("stuck", "stuck")).toEqual({ stalled: true, nextToken: undefined, visitedTokens: [] });
    expect(mentionPaginationProgress("old", "next")).toEqual({ stalled: false, nextToken: "next", visitedTokens: ["old"] });
    expect(mentionPaginationProgress(undefined, "next")).toEqual({ stalled: false, nextToken: "next", visitedTokens: [] });
  });

  it("ends a mention backlog when X cycles back to a recently visited token", () => {
    expect(mentionPaginationProgress("second", "first", ["first"]))
      .toEqual({ stalled: true, nextToken: undefined, visitedTokens: [] });
  });

  it("retries only explicit transient X response failures", () => {
    expect(isRetryableXReplyStatus(429)).toBe(true);
    expect(isRetryableXReplyStatus(503)).toBe(true);
    expect(isRetryableXReplyStatus(400)).toBe(false);
    expect(isRetryableXReplyStatus(403)).toBe(false);
  });

  it("recovers interrupted work without republishing ambiguous replies", () => {
    const now = 2_000_000;
    expect(shouldRecoverXInteraction({ status: "processing", updatedAt: now - 21 * 60_000, now })).toBe(true);
    expect(shouldRecoverXInteraction({ status: "processing", updatedAt: now - 21 * 60_000, now, publicationAttempted: true })).toBe(false);
    expect(shouldRecoverXInteraction({ status: "failed", updatedAt: now - 20 * 60_000, nextRetryAt: now - 11 * 60_000, now })).toBe(true);
    expect(shouldRecoverXInteraction({ status: "completed", updatedAt: 0, now })).toBe(false);
  });

  it("dispatches mentions in bounded batches instead of one simultaneous burst", () => {
    expect(Array.from({ length: 12 }, (_, index) => xInteractionDispatchDelay(index))).toEqual([
      0, 0, 0, 0, 0, 1_000, 1_000, 1_000, 1_000, 1_000, 2_000, 2_000,
    ]);
  });
});
