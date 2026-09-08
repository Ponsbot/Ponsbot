import { describe, expect, it } from "vitest";
import { liquidityDiagnostic, liquidityExecutionWindowOpen, liquidityRecoveryDue, liquidityRecoveryStopped, liquiditySignerResponse, LIQUIDITY_TOTAL_ATTEMPTS } from "../lib/liquidity-recovery";
import { retryLiquidityQuote } from "../lib/liquidity-recovery";

describe('read-only quote retries', () => {
  it('recovers an intermittent internal quote failure without a manual refresh', async () => {
    let calls = 0;
    const result = await retryLiquidityQuote(async () => { if (++calls < 3) throw Error('SIGNER_INTERNAL_FAILURE'); return 'quote'; }, () => 0, async () => {});
    expect(result).toBe('quote'); expect(calls).toBe(3);
  });
  it.each(['INSUFFICIENT_FUNDS', 'SIMULATION_OR_REVERT', 'LP_INVALID_POOL_SPACING', 'LP_SIGNER_HTTP_401', 'LP_QUOTE_SIGNING_NOT_CONFIGURED'])('does not retry a deterministic rejection: %s', code => {
    let calls = 0;
    return expect(retryLiquidityQuote(async () => { calls++; throw Error(code); }, () => 0, async () => {})).rejects.toThrow(code).then(() => expect(calls).toBe(1));
  });
  it('stops at three attempts on a persistent provider failure', async () => {
    let calls = 0;
    await expect(retryLiquidityQuote(async () => { calls++; throw Error('LP_SIGNER_RPC_UNAVAILABLE'); }, () => 0, async () => {})).rejects.toThrow('LP_SIGNER_RPC_UNAVAILABLE');
    expect(calls).toBe(3);
  });
  it('shares one two-minute deadline instead of multiplying timeouts', async () => {
    let time = 0, calls = 0;
    await expect(retryLiquidityQuote(async remaining => { expect(remaining).toBe(120000); calls++; time += 115000; throw Error('SIGNER_INTERNAL_FAILURE'); }, () => time, async () => {})).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

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
