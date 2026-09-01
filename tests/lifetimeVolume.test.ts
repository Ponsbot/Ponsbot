import { describe, expect, it } from "vitest";
import { lifetimeVolumeSummary, parseOhlcvCandles, parseRecentHours, ponsV4PoolId, serializeRecentHours } from "../lib/lifetime-volume";

describe("lifetime volume accounting helpers", () => {
  it("normalizes, validates, deduplicates, and sorts Gecko hourly candles", () => {
    expect(parseOhlcvCandles([
      [1_700_003_600, 1, 2, 1, 2, "25.5"],
      [1_700_000_000, 1, 2, 1, 2, "10"],
      [1_700_000_000, 1, 2, 1, 2, "12"],
      ["bad", 1, 2, 1, 2, 99],
      [1_700_007_200, 1, 2, 1, 2, -1],
    ])).toEqual([
      { hourStartedAt: 1_700_002_800_000, volumeUsd: 25.5 },
      { hourStartedAt: 1_699_999_200_000, volumeUsd: 12 },
    ]);
  });

  it("round trips the bounded correction window", () => {
    const hours = new Map<number, number>();
    for (let index = 0; index < 80; index += 1) hours.set(index, index + 0.5);
    const parsed = parseRecentHours(serializeRecentHours(hours));
    expect(parsed.size).toBe(72);
    expect(parsed.get(79)).toBe(79.5);
    expect(parsed.has(0)).toBe(false);
  });

  it("treats corrupt persisted correction data as empty", () => {
    expect(parseRecentHours("not json").size).toBe(0);
  });

  it("adds bonding-curve and V4 sources while counting token coverage once", () => {
    expect(lifetimeVolumeSummary([
      { normalizedTokenAddress: "0xtoken", confirmedVolumeUsd: 125, provisionalVolumeUsd: 5, lastSuccessAt: 1 },
      { normalizedTokenAddress: "0xtoken", confirmedVolumeUsd: 220, provisionalVolumeUsd: 10, lastSuccessAt: 2 },
      { normalizedTokenAddress: "0xother", confirmedVolumeUsd: 999, provisionalVolumeUsd: 0 },
    ])).toEqual({ totalUsd: 360, tokenCoverage: 1 });
  });

  it("derives the same V4 pool ID regardless of token/pair input order", () => {
    const token = "0x1111111111111111111111111111111111111111";
    const pair = "0x2222222222222222222222222222222222222222";
    const hook = "0x3333333333333333333333333333333333333333";
    expect(ponsV4PoolId(token, pair, 10_000, 200, hook))
      .toBe(ponsV4PoolId(pair, token, 10_000, 200, hook));
  });
});
