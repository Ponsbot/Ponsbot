import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeLaunchLinks, normalizeLaunchTelegram, normalizeOptionalTelegramUrl, parseWalletCommand, validateStructuredWalletCommand } from "../convex/walletCommands";
import { decodePersistedXWalletIntent, groundedCanonicalCommand, parameterExtractorPrompt, parseXWalletIntentWithDiagnostics } from "../convex/xWalletIntent";

const { model } = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock("../convex/llm", () => ({ openRouter: model, isStructuredOutputAvailabilityError: () => false }));
beforeEach(() => {
  model.mockReset();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network, X, or wallet execution allowed"); }));
});
afterEach(() => vi.unstubAllGlobals());

const base = { kind: "launch" as const, launchMode: "pons" as const, name: "Test", symbol: "TEST" };
const malformed = ["@test", "test", "example.com/test", "https://t.me/one/two", "https://t.me/", "https://t.me/test?ref=1", "https://t.me/test#foo", "https://user:pass@t.me/test", "https://t.me:99/test", "https://t.me.evil.example/test", "https://t.me/+invite", "http//t.me/test"];

describe("optional Telegram launch metadata", () => {
  it.each(malformed)("omits %s throughout parsing, structured validation and launch normalization", value => {
    expect(normalizeOptionalTelegramUrl(value)).toBeUndefined();
    const text = `launch Test ticker TEST tg ${value}`;
    const parsed = parseWalletCommand(text);
    expect(parsed).toMatchObject(base);
    expect(parsed).not.toHaveProperty("telegram");
    const structured = validateStructuredWalletCommand({ ...base, telegram: value });
    expect(structured).toEqual(base);
    expect(normalizeLaunchTelegram({ ...base, telegram: value })).toEqual(base);
    // Do not accept a model-invented valid replacement for bad original input.
    expect(normalizeLaunchTelegram({ ...base, telegram: "https://t.me/invented" }, text)).toEqual(base);
    expect(groundedCanonicalCommand(text)).toEqual(base);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["t.me/test", "https://t.me/test"],
    ["http://t.me/Test_Group", "https://t.me/Test_Group"],
    ["https://t.me/test/", "https://t.me/test"],
    ["http://telegram.me/test", "https://t.me/test"],
    ["www.t.me/test", "https://t.me/test"],
    ['"t.me/test"', "https://t.me/test"],
  ])("preserves valid Telegram link %s", (value, normalized) => {
    expect(normalizeOptionalTelegramUrl(value)).toBe(normalized);
    expect(normalizeLaunchTelegram({ ...base, telegram: value })).toEqual({ ...base, telegram: normalized });
    expect(validateStructuredWalletCommand({ ...base, telegram: value })).toEqual({ ...base, telegram: normalized });
  });
  it("preserves all other launch parameters and does not broaden website/X validation", () => {
    const command = { ...base, description: "A test token", website: "https://example.com", twitter: "https://x.com/test", pairToken: "MSFT", devBuy: { amount: "5", unit: "usd" as const }, feeRecipient: "@alice" };
    expect(normalizeLaunchTelegram({ ...command, telegram: "@test" })).toEqual(command);
    expect(() => normalizeLaunchLinks({ ...base, telegram: "@test", website: "http://localhost" })).toThrow();
    expect(() => normalizeLaunchLinks({ ...base, telegram: "@test", twitter: "https://example.com/test" })).toThrow();
    expect(normalizeLaunchTelegram({ kind: "show_wallet" })).toEqual({ kind: "show_wallet" });
  });
  it("drops missing, wrongly typed and oversized optional fields without truncating them into a new URL", () => {
    for (const telegram of [undefined, null, "", 42, {}, [], "t.me/" + "a".repeat(500)]) {
      expect(normalizeOptionalTelegramUrl(telegram)).toBeUndefined();
      expect(validateStructuredWalletCommand({ ...base, telegram })).toEqual(base);
    }
    expect(normalizeLaunchTelegram(base, "launch Test ticker TEST tg")).toEqual(base);
  });
  it("safely sanitizes a persisted launch intent when decoded", () => {
    expect(decodePersistedXWalletIntent(JSON.stringify({ kind: "command", command: { ...base, telegram: "@test" } })))
      .toEqual({ kind: "command", command: base });
  });
  it("instructs the model to omit invalid Telegram without invalidating the launch", () => {
    expect(parameterExtractorPrompt("launch", false)).toContain("omit telegram (use null if required by the schema) and continue extracting the launch normally");
  });
  it.each(["@test", "example.com/test", "https://t.me/one/two", "http//t.me/test"])("accepts first-attempt model extraction with malformed TG %s, no fallback needed", async telegram => {
    model.mockResolvedValueOnce(JSON.stringify({ kind: "command", operation: "launch" }))
      .mockResolvedValueOnce(JSON.stringify({ ...base, telegram }));
    const result = await parseXWalletIntentWithDiagnostics(`@Ponsbotfamily launch Test ticker TEST tg ${telegram}`, false);
    expect(result.intent).toEqual({ kind: "command", command: base });
    expect(result.diagnostics.source).toBe("ai_attempt_1");
    expect(result.diagnostics.extractionAttempts).toHaveLength(1);
    expect(result.diagnostics.extractionAttempts[0].accepted).toBe(true);
    expect(model).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
