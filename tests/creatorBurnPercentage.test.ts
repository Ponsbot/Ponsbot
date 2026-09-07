import { describe, it, expect } from "vitest";
import { creatorBurnExecutionBps } from "../lib/creator-burn-percentage";
import { creatorBurnSplit } from "../lib/creator-burn-policy";
import { creatorBurnConfiguredMessage } from "../lib/creator-burn-messages";
import { creatorFeeBurnDisplay } from "../lib/creator-fee-display";
const token = "0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07";
describe("canonical PONSBOT half-total exception", () => {
  it("uses the closest representable creator allocation", () => {
    expect(creatorBurnExecutionBps(token, 5000)).toBe(4737);
    expect(creatorBurnExecutionBps(token.toLowerCase(), 5000)).toBe(4737);
    const split = creatorBurnSplit(100000000n, 4737);
    expect(split.ponsbot + split.selfBuyback).toBe(50001500n);
  });
  it("leaves other percentages and contracts unchanged", () => {
    for (const bps of [0, 2500, 10000]) expect(creatorBurnExecutionBps(token, bps)).toBe(bps);
    expect(creatorBurnExecutionBps("0x" + "1".repeat(40), 5000)).toBe(5000);
  });
  it("shows 50 total on X and the website, not 47.37 of the creator share", () => {
    expect(creatorBurnConfiguredMessage("PONSBOT", 5000, token, 4737)).toBe("✅ 50% of total creator fees from $PONSBOT buy back and burn $PONSBOT starting with the next Pons fee sweep.");
    expect(creatorFeeBurnDisplay("PONSBOT", {active:true, percentageBps:4737}, false, token).suffix).toBe("(50% buyback and burn $PONSBOT)");
    expect(creatorFeeBurnDisplay("PONSBOT", {active:true, percentageBps:4737}).suffix).toContain("47.37%");
    expect(creatorFeeBurnDisplay("PONSBOT", {active:true, percentageBps:0}, false, token).suffix).toBeNull();
    expect(creatorBurnConfiguredMessage("PONSBOT", 5000, token)).toContain("your creator-fee share");
  });
});
