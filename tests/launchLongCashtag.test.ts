import { expect, it } from "vitest";
import { extractGroundedLaunchName, parseWalletCommand, validateStructuredWalletCommand, LAUNCH_TICKER_TOO_LONG } from "../convex/walletCommands";
import { groundedCanonicalCommand, parseXWalletIntent, decodePersistedXWalletIntent } from "../convex/xWalletIntent";

it.each(["Ponsvangelion", "ABCDEFGHIJKLM", "ABCDEFGHIJKLMNOP"])("separates long cashtag %s from the name and dev buy", ticker => {
  const text = `@ponsbotfamily launch Ponsvangelion $${ticker} dev buy $20`;
  expect(extractGroundedLaunchName(text)).toBe("Ponsvangelion");
  expect(groundedCanonicalCommand(text)).toMatchObject({ kind: "launch", name: "Ponsvangelion", symbol: ticker.toUpperCase(), devBuy: { amount: "20", unit: "usd" } });
});
it.each(["$ABCDEFGHIJKLMNOPQ", "ticker ABCDEFGHIJKLMNOPQ", "[ABCDEFGHIJKLMNOPQ]"])("rejects oversized explicit ticker %s instead of truncating", async ticker => {
  const text = `@ponsbotfamily launch Example ${ticker} dev buy $20`;
  expect(parseWalletCommand(text)).toEqual({ kind: "unknown", reason: LAUNCH_TICKER_TOO_LONG });
  expect(await parseXWalletIntent(text, false)).toMatchObject({ kind: "command", command: { kind: "unknown", reason: LAUNCH_TICKER_TOO_LONG } });
  expect(decodePersistedXWalletIntent(JSON.stringify(await parseXWalletIntent(text, false)))).toMatchObject({ command: {reason:LAUNCH_TICKER_TOO_LONG} });
});
it("rejects oversized structured symbols", () => {
  expect(validateStructuredWalletCommand({kind:"launch",name:"Example",symbol:"ABCDEFGHIJKLMNOPQ"})).toEqual({kind:"unknown",reason:LAUNCH_TICKER_TOO_LONG});
});
