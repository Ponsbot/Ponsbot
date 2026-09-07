import { describe, expect, it } from "vitest";
import { creatorFeeBurnDisplay } from "../lib/creator-fee-display";

describe("creator fee recipient presentation", () => {
  it("replaces the recipient at 100%", () => {
    expect(creatorFeeBurnDisplay("TOKEN", { active: true, percentageBps: 10000 }))
      .toEqual({ fullAllocation: "Buyback and burn $TOKEN", suffix: null });
  });
  it("appends the percentage of the creator share, not gross fees", () => {
    expect(creatorFeeBurnDisplay("TOKEN", { active: true, percentageBps: 5000 }))
      .toEqual({ fullAllocation: null, suffix: "(50% buyback and burn $TOKEN)" });
  });
  it("preserves supported decimal percentages and international tickers", () => {
    expect(creatorFeeBurnDisplay("$日本", { active: true, percentageBps: 125 }))
      .toEqual({ fullAllocation: null, suffix: "(1.25% buyback and burn $日本)" });
  });
  it.each([0, -1, 10001, 1.5, NaN, Infinity])("does not advertise invalid or zero allocation %s", percentageBps => {
    expect(creatorFeeBurnDisplay("TOKEN", { active: true, percentageBps }))
      .toEqual({ fullAllocation: null, suffix: null });
  });
  it("leaves ordinary, exited and holder-sharing displays unchanged", () => {
    expect(creatorFeeBurnDisplay("TOKEN").suffix).toBeNull();
    expect(creatorFeeBurnDisplay("TOKEN", { active: false, percentageBps: 10000 }).fullAllocation).toBeNull();
    expect(creatorFeeBurnDisplay("TOKEN", { active: true, percentageBps: 5000 }, true).suffix).toBeNull();
  });
});
