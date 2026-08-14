import { describe, expect, it } from "vitest";
import { applyProtectedLaunchProfile } from "../lib/special-launch-policy";

describe("protected Pons Bot launch profile", () => {
  it("does not alter launches from other wallets", () => {
    const command = { kind: "launch", launchMode: "pons", name: "Other", symbol: "OTHER" } as const;
    expect(applyProtectedLaunchProfile("someoneelse", command, undefined)).toBe(command);
  });

  it("overrides every fixed field while retaining separately supplied artwork", () => {
    expect(applyProtectedLaunchProfile("@PonsBoyFamily", {
      kind: "launch", launchMode: "pons", name: "Wrong", symbol: "WRONG",
      description: "wrong", website: "https://wrong.example", twitter: "https://x.com/wrong",
      telegram: "https://t.me/wrong", pairToken: "MSFT", devBuy: { amount: "1", unit: "pair" },
    }, "https://pbs.twimg.com/media/image.jpg")).toEqual({
      kind: "launch", launchMode: "pons", name: "Pons Bot", symbol: "PONSBOT",
      description: "Swap, send, and launch on Pons V2 with just one X post.",
      website: "https://www.ponsbot.family", twitter: "https://x.com/ponsbotfamily",
      pairToken: "ETH", devBuy: { amount: "100", unit: "usd" },
    });
  });

  it("rejects the protected launch when its X-post artwork is absent", () => {
    expect(() => applyProtectedLaunchProfile("ponsboyfamily", {
      kind: "launch", launchMode: "pons", name: "Pons Bot", symbol: "PONSBOT",
    }, undefined)).toThrow("protected launch image missing");
  });
});
