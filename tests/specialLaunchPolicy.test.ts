import { describe, expect, it } from "vitest";
import { launchTickerAllowed, reservedLaunchTickerMessage } from "../lib/special-launch-policy";
import { replyQueuePriority } from "../lib/x-reply-queue-policy";
import { temporaryXReplySuppressionReason } from "../lib/x-temporary-reply-policy";

describe("reserved launch tickers", () => {
  it.each([
    ["PONS", "PONS"], ["$pons", "PONS"], [" pOnS ", "PONS"],
    ["PONSBOT", "PONSBOT"], ["$ponsbot", "PONSBOT"], [" pOnSbOt ", "PONSBOT"],
  ])("returns the exact reserved-ticker reply for %s without suppressing it", (symbol, expected) => {
    const command = { kind: "launch", launchMode: "pons", name: "Some name", symbol } as const;
    const message = reservedLaunchTickerMessage(command)!;
    expect(message).toBe(`Sorry, there's only one $${expected}`);
    expect(launchTickerAllowed("123", command)).toBe(false);
    expect(temporaryXReplySuppressionReason(message, true)).toBeUndefined();
    expect(replyQueuePriority(message, "launch", false)).toBe("B");
  });
  it("blocks PONS launches for every account", () => {
    const launch = { kind: "launch", launchMode: "pons", name: "Pons", symbol: "PONS" } as const;
    expect(launchTickerAllowed("123", launch)).toBe(false);
    expect(launchTickerAllowed("456", launch)).toBe(false);
  });

  it("blocks PONSBOT launches for every account after the official launch", () => {
    const launch = { kind: "launch", launchMode: "pons", name: "Pons Bot", symbol: "$ponsbot" } as const;
    expect(launchTickerAllowed("123", launch)).toBe(false);
    expect(launchTickerAllowed("456", launch)).toBe(false);
  });

  it("does not restrict unrelated launch tickers or non-launch commands", () => {
    expect(launchTickerAllowed("123", { kind: "launch", launchMode: "pons", name: "Other", symbol: "OTHER" })).toBe(true);
    expect(launchTickerAllowed("123", { kind: "show_wallet" })).toBe(true);
    expect(reservedLaunchTickerMessage({ kind: "launch", launchMode: "pons", name: "Other", symbol: "PONSBOY" })).toBeUndefined();
    expect(reservedLaunchTickerMessage({ kind: "show_wallet" })).toBeUndefined();
  });
});
