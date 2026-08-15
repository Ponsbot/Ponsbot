import { describe, expect, it } from "vitest";
import { applyProtectedLaunchProfile, launchTickerAllowed } from "../lib/special-launch-policy";

describe("protected Pons Bot launch profile", () => {
  it("does not alter launches from other wallets", () => {
    const command = { kind: "launch", launchMode: "pons", name: "Other", symbol: "OTHER" } as const;
    expect(applyProtectedLaunchProfile("123", command, undefined)).toBe(command);
  });

  it("overrides every fixed field while retaining separately supplied artwork", () => {
    expect(applyProtectedLaunchProfile("2085516993315188736", {
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
    expect(() => applyProtectedLaunchProfile("2085516993315188736", {
      kind: "launch", launchMode: "pons", name: "Pons Bot", symbol: "PONSBOT",
    }, undefined)).toThrow("protected launch image missing");
  });

  it("blocks PONS launches for every account", () => {
    const launch = { kind: "launch", launchMode: "pons", name: "Pons", symbol: "PONS" } as const;
    expect(launchTickerAllowed("123", launch)).toBe(false);
    expect(launchTickerAllowed("2085516993315188736", launch)).toBe(false);
  });

  it("reserves PONSBOT launches for the protected account", () => {
    const launch = { kind: "launch", launchMode: "pons", name: "Pons Bot", symbol: "$ponsbot" } as const;
    expect(launchTickerAllowed("123", launch)).toBe(false);
    expect(launchTickerAllowed("2085516993315188736", launch)).toBe(true);
  });

  it("does not restrict unrelated launch tickers or non-launch commands", () => {
    expect(launchTickerAllowed("123", { kind: "launch", launchMode: "pons", name: "Other", symbol: "OTHER" })).toBe(true);
    expect(launchTickerAllowed("123", { kind: "show_wallet" })).toBe(true);
  });
});
