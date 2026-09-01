import { describe, expect, it, vi } from "vitest";
import { formatPonsbotBurned, hasPublicFeeBuyback } from "../lib/burn-stats";
import { automatedFeeBurnStats, getLaunch } from "../convex/site";

const handler = (fn: unknown) => (fn as { _handler: (ctx: any, args: any) => Promise<any> })._handler;
const program = { status: "enrolled", buybackBps: 500, distributionMode: "wallet", beneficiaryAddress: "0xbeneficiary" };

describe("burn statistics presentation", () => {
  it.each([
    [undefined, "—"], [null, "—"], ["NaN", "—"], ["-1", "—"], ["1.5", "—"], ["", "—"],
    ["0", "0"], ["1", "<1"], ["10000000000000000", "<1"], ["999999999999999999", "<1"],
    ["1000000000000000000", "1"], ["1999999999999999999", "1"], ["1234500000000000000000", "1,234"],
    ["9007199254740993123450000000000000", "9,007,199,254,740,993"],
  ])("formats %s without NaN, scientific notation, or lost integer precision", (raw, expected) => {
    expect(formatPonsbotBurned(raw)).toBe(expected);
  });

  it("shows the strip only for active 5% wallet-distribution programs", () => {
    expect(hasPublicFeeBuyback(program)).toBe(true);
    expect(hasPublicFeeBuyback(null)).toBe(false);
    expect(hasPublicFeeBuyback(program, true)).toBe(false);
    for (const status of ["prepared", "exited", "paused", "manual_review"]) {
      expect(hasPublicFeeBuyback({ ...program, status })).toBe(false);
    }
    for (const override of [{ privateTest: true }, { distributionMode: "holders" },
      { flywheelExemptionReason: "holder_fee_sharing" }, { buybackBps: 0 }, { buybackBps: 1_000 }]) {
      expect(hasPublicFeeBuyback({ ...program, ...override })).toBe(false);
    }
  });
});

describe("public burn data", () => {
  it("exposes only the existing confirmed aggregate, not private engine details", async () => {
    const query = vi.fn(() => ({ withIndex: () => ({ unique: async () => ({
      lifetimePonsbotBurned: "123000000000000000000", leaseId: "private", lastDiagnosticCode: "private",
    }) }) }));
    expect(await handler(automatedFeeBurnStats)({ db: { query } }, {})).toEqual({ ponsbotBurned: "123000000000000000000" });
    expect(query).toHaveBeenCalledExactlyOnceWith("automatedFeeEngineState");
  });
  it("reports zero before any public fee cycle has completed", async () => {
    const db = { query: () => ({ withIndex: () => ({ unique: async () => null }) }) };
    expect(await handler(automatedFeeBurnStats)({ db }, {})).toEqual({ ponsbotBurned: "0" });
  });

  it.each([true, false])("keeps the beneficiary public and exposes the right strip flag (enrolled=%s)", async (enrolled) => {
    const token = `0x${"a".repeat(40)}`;
    const rows: Record<string, unknown> = {
      tokenLaunches: { tokenAddress: token, publicPublished: true, launcherUsername: "creator", name: "Test", symbol: "TEST",
        imageUri: "", transactionHash: "0xtx", requestId: "x:123:launch", creatorFeeRecipient: "0xoriginal", createdAt: 1 },
      automatedFeePrograms: { ...program, status: enrolled ? "enrolled" : "exited" },
      cryptoWallets: { xUsername: "recipient" },
    };
    const db = { get: async () => null, query: (table: string) => ({ withIndex: () => ({ unique: async () => rows[table] ?? null }) }) };
    const result = await handler(getLaunch)({ db }, { tokenAddress: token.toUpperCase() });
    expect(result.automatedFeeBuybackEnabled).toBe(enrolled);
    expect(result.creatorFeeRecipient).toBe(enrolled ? "0xbeneficiary" : "0xoriginal");
    expect(result.feeRecipientUsername).toBe("recipient");
    expect(result).not.toHaveProperty("vaultAddress");
  });
});
