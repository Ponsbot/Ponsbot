import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWalletCommand } from "../convex/walletCommands";
import { groundedCanonicalCommand, intentClassifierPrompt, parameterExtractorPrompt, parseXWalletIntent, straightforwardCommandOperation } from "../convex/xWalletIntent";

vi.mock("../convex/llm", () => ({ openRouter: vi.fn(), isStructuredOutputAvailabilityError: () => false }));
import { openRouter } from "../convex/llm";

afterEach(() => vi.resetAllMocks());

const tickerOnly = [
  "@Ponsbotfamily @Ponsbotfamily launch my token ticker $RR",
  "launch ticker RR",
  'Launch token ticker "rr"',
  "Deploy coin symbol ‘$rr’",
  "Create a token with symbol RR",
  "hey @Ponsbotfamily, launch my token ticker: $RR please",
  "Launch my token, ticker $RR @Ponsbotfamily",
];

describe("ticker-only launch names", () => {
  it.each(tickerOnly)("uses the supplied ticker as the name: %s", (post) => {
    expect(parseWalletCommand(post)).toMatchObject({ kind: "launch", name: "RR", symbol: "RR" });
    expect(groundedCanonicalCommand(post)).toMatchObject({ kind: "launch", name: "RR", symbol: "RR" });
    expect(straightforwardCommandOperation(post)).toBe("launch");
  });

  it("keeps explicit names and optional parameters", () => {
    expect(groundedCanonicalCommand("launch my token ticker RR pair with MSFT dev buy $5 website example.com")).toMatchObject({
      kind: "launch", name: "RR", symbol: "RR", pairToken: "MSFT", devBuy: { amount: "5", unit: "usd" }, website: "https://example.com",
    });
    expect(groundedCanonicalCommand('launch ticker RR, name "Rain Room"')).toMatchObject({ kind: "launch", name: "Rain Room", symbol: "RR" });
    expect(groundedCanonicalCommand('launch "Rain Room" ticker RR')).toMatchObject({ kind: "launch", name: "Rain Room", symbol: "RR" });
    expect(groundedCanonicalCommand("launch token $MUMU on robinhood pair with NVDA")).toMatchObject({ kind: "launch", name: "MUMU", symbol: "MUMU", pairToken: "NVDA" });
  });

  it.each(["launch ticker", "launch my token ticker", "launch ticker pair with MSFT", "launch ticker https://example.com", "launch ticker ABCDEFGHIJKLMNOPQ"])("does not invent a ticker for incomplete input: %s", (post) => {
    expect(parseWalletCommand(post).kind).toBe("unknown");
    expect(groundedCanonicalCommand(post)).toBeNull();
  });

  it.each([null, "", "my token", "ticker RR"])("repairs missing or syntax-contaminated AI names (%s) in both stages", async (name) => {
    vi.mocked(openRouter).mockResolvedValueOnce('{"kind":"unknown_wallet"}')
      .mockResolvedValueOnce(JSON.stringify({ kind: "launch", name, symbol: "$rr" }));
    await expect(parseXWalletIntent(tickerOnly[0], false)).resolves.toMatchObject({
      kind: "command", command: { kind: "launch", name: "RR", symbol: "RR" },
    });
    expect(openRouter).toHaveBeenCalledTimes(2);
  });

  it("recovers ticker-only launches if AI extraction is unavailable", async () => {
    vi.mocked(openRouter).mockResolvedValueOnce('{"kind":"command","operation":"launch"}').mockResolvedValue("{}");
    await expect(parseXWalletIntent(tickerOnly[0], false)).resolves.toMatchObject({ kind: "command", command: { kind: "launch", name: "RR", symbol: "RR" } });
  });

  it.each(["Do not launch ticker RR", "For example: launch ticker RR", 'Can you translate this: "launch ticker RR"'])("does not turn non-executable content into a launch: %s", async (post) => {
    await expect(parseXWalletIntent(post, false)).resolves.toEqual({ kind: "irrelevant" });
    expect(openRouter).not.toHaveBeenCalled();
  });

  it("does not execute a quoted ticker-only command even if AI treats it as a launch", async () => {
    vi.mocked(openRouter).mockResolvedValueOnce('{"kind":"command","operation":"launch"}').mockResolvedValue('{"kind":"launch","name":"RR","symbol":"RR"}');
    await expect(parseXWalletIntent('Translate this: "launch ticker RR"', false)).resolves.toEqual({ kind: "unknown_wallet" });
  });

  it("keeps multiple launch specifications rejected", async () => {
    vi.mocked(openRouter).mockResolvedValueOnce('{"kind":"command","operation":"launch"}').mockResolvedValue('{"kind":"launch","name":"RR","symbol":"RR"}');
    await expect(parseXWalletIntent("launch ticker RR and launch ticker OTHER", false)).resolves.toEqual({ kind: "unknown_wallet" });
  });

  it("teaches the same default in both AI prompts", () => {
    expect(intentClassifierPrompt()).toContain("only an explicit ticker");
    expect(parameterExtractorPrompt("launch", false)).toContain('"Launch ticker ONLY" is valid');
    expect(parameterExtractorPrompt("launch", false)).not.toContain("no name was supplied");
  });
});
