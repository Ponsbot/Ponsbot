import { describe, expect, it } from "vitest";
import { exceedsXReplyDepthLimit } from "../lib/x-reply-depth-policy";

const check = (overrides: Partial<Parameters<typeof exceedsXReplyDepthLimit>[0]> = {}) =>
  exceedsXReplyDepthLimit({
    replyDepth: 6,
    maximumDepth: 6,
    guidedWorkflow: false,
    liquidityRequest: false,
    contextualGasHelp: false,
    gasResume: false,
    ...overrides,
  });

describe("X reply-depth policy", () => {
  it("stops an ordinary reply at the anti-loop depth", () => {
    expect(check()).toBe(true);
  });

  it("does not apply the depth cutoff to an owner-bound guided workflow", () => {
    expect(check({ replyDepth: 50, guidedWorkflow: true })).toBe(false);
  });

  it("does not apply the depth cutoff to liquidity workflows", () => {
    expect(check({ replyDepth: 50, liquidityRequest: true })).toBe(false);
  });

  it("allows ordinary replies below the cutoff", () => {
    expect(check({ replyDepth: 5 })).toBe(false);
  });
});
