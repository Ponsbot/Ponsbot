import { describe, expect, it } from "vitest";
import { liquidityDiagnostic, liquidityExecutionWindowOpen, liquidityRecoveryDue, liquidityRecoveryStopped, liquiditySignerResponse, LIQUIDITY_TOTAL_ATTEMPTS } from "../lib/liquidity-recovery";

describe("liquidity execution windows and private diagnostics", () => {
  it("leaves time for inclusion and rejects missing or non-finite deadlines", () => {
    expect(liquidityExecutionWindowOpen({ executionDeadline: 100_000 }, 84_999)).toBe(true);
    expect(liquidityExecutionWindowOpen({ executionDeadline: 100_000 }, 85_000)).toBe(false);
    for (const executionDeadline of [NaN, Infinity, 0]) expect(liquidityExecutionWindowOpen({ executionDeadline }, 1000)).toBe(false);
  });
  it.each([
    "RPC timeout Authorization: Bearer private-token",
    "malformed response {signedTransaction: 0xdeadbeef}",
    "CDP failed correlationId private-data at https://provider.invalid/key",
    "[private model output]",
  ])("does not save free-form diagnostics: %s", message => {
    expect(liquidityDiagnostic(new Error(message), "LP_EXECUTION_FAILED")).toBe("LP_EXECUTION_FAILED");
    expect(liquidityDiagnostic(new Error(message), "LP_WORKFLOW_FAILED")).toBe("LP_WORKFLOW_FAILED");
  });
  it("keeps safe codes and normalizes known permanent failures", () => {
    expect(liquidityDiagnostic(new Error("LP_SIGNER_HTTP_429"), "LP_EXECUTION_FAILED")).toBe("LP_SIGNER_HTTP_429");
    expect(liquidityDiagnostic(new Error("Wallet is not active"), "LP_EXECUTION_FAILED")).toBe("LP_WALLET_INACTIVE");
    expect(liquidityDiagnostic(new Error("insufficient funds, private payload"), "LP_EXECUTION_FAILED")).toBe("LP_INSUFFICIENT_FUNDS");
  });
});

describe("liquidity provider responses", () => {
  it.each([429, 502, 503, 504])("reports HTTP %s rather than saving an HTML body or JSON parser error", async status => {
    await expect(liquiditySignerResponse(new Response("<html>private provider URL and request details</html>", { status })))
      .rejects.toThrow(`LP_SIGNER_HTTP_${status}_INVALID_JSON`);
  });
  it("retains a specific trusted diagnostic code but not diagnostic details", async () => {
    await expect(liquiditySignerResponse(new Response(JSON.stringify({ diagnosticCode: "LP_INSUFFICIENT_GAS", diagnosticDetail: "private payload" }), { status: 400 })))
      .rejects.toThrow("LP_INSUFFICIENT_GAS");
  });
  it("does not expose free-form errors or invalid diagnostic codes", async () => {
    await expect(liquiditySignerResponse(new Response(JSON.stringify({ diagnosticCode: "https://secret.invalid/key", error: "raw signed envelope" }), { status: 500 })))
      .rejects.toThrow("LP_SIGNER_HTTP_500");
  });
  it.each([null, "unexpected", 0, []])("rejects malformed successful results: %j", async value => {
    await expect(liquiditySignerResponse(new Response(JSON.stringify(value)))).rejects.toThrow("LP_SIGNER_INVALID_RESPONSE");
  });
  it("preserves valid structured results", async () => {
    expect(await liquiditySignerResponse(new Response('{"status":"confirmed"}'))).toEqual({ status: "confirmed" });
  });
});
describe("liquidity retry timing", () => {
  it("does not retry before the persisted due time", () => {
    expect(liquidityRecoveryDue({ status: "running", nextAttemptAt: 200 }, 199)).toBe(false);
    expect(liquidityRecoveryDue({ status: "running", nextAttemptAt: 200 }, 200)).toBe(true);
  });
  it("stops automatic manual-review polling at the retry ceiling", () => {
    const state = { status: "manual_review", retryCount: LIQUIDITY_TOTAL_ATTEMPTS };
    expect(liquidityRecoveryStopped(state)).toBe(true);
    expect(liquidityRecoveryDue(state, 999999)).toBe(false);
  });
});
