import { describe, it, expect } from "vitest";
import { creatorBurnConfiguredMessage, creatorBurnLaunchReply } from "../lib/creator-burn-messages";
describe("creator configuration publication", () => {
  it("waits for a durable request, then acknowledges a pending launch configuration", () => {
    expect(creatorBurnLaunchReply(null, 1000)).toBeNull();
    expect(creatorBurnLaunchReply({ status: "pending", bps: 5000 }, 1000)).toContain("starting with the next Pons fee sweep");
  });
  it("reports an unsuccessful configuration without denying the launch", () => {
    expect(creatorBurnLaunchReply({ status: "manual_review", bps: 5000 }, 100)).toContain("The token launched");
  });
  it("announces only the confirmed allocation", () => {
    expect(creatorBurnLaunchReply({ status: "confirmed", bps: 2500 }, 100)).toContain("25%");
  });
  it("uses an off message at zero", () => {
    expect(creatorBurnConfiguredMessage("TEST", 0)).toContain("is off");
    expect(creatorBurnConfiguredMessage("TEST", 0)).not.toContain("0%");
    expect(creatorBurnConfiguredMessage("TEST", 5000)).not.toMatch(/https|allocation/);
  });
});
