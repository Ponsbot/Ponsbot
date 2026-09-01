import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Address } from "viem";
import { deltaLiquidityAbi, liquidityPoolId, liquidityPoolKey, prepareLiquidityClaim, prepareLiquidityClose, prepareLiquidityOpen, type LiquidityLeg } from "../lib/liquidity-contracts";
import { DELTA_LIQUIDITY, newLiquidityDraft } from "../lib/liquidity-workflow";
import type { LiquidityQuotePlan } from "../lib/liquidity-quote";
import { validateLiquidityOpenRefresh, validateLiquidityQuote } from "../lib/liquidity-wire";

const now = 1_800_000_000_000;
const owner = "0x1111111111111111111111111111111111111111";
const token = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07";
const v3Pool = "0x2222222222222222222222222222222222222222";
function fixture(version: 3 | 4 = 4, pair: "ETH" | "USDG" = "ETH", operation: "open" | "claim" | "withdraw" = "open") {
  const draft = newLiquidityDraft(operation, { token: "PONSBOT", amount: "50", unit: "usd", pair, version,
    feePips: 3000, tickSpacing: 60, bands: 1, shape: "flat", downPercent: 25, upPercent: 25,
    ...(operation === "withdraw" ? { withdrawPercent: 100 } : {}) });
  draft.tokenAddress = token; draft.symbol = "PONSBOT"; draft.custom = true; draft.phase = "review";
  const key = liquidityPoolKey(token, pair, version, 3000, 60);
  const poolId = version === 3 ? v3Pool : liquidityPoolId(key);
  const executionDeadline = now + 1_200_000;
  const legs: LiquidityLeg[] = operation === "open" ? [] : [{ tokenId: "123", tickLower: -600, tickUpper: 600, liquidity: "1000" }];
  const call = operation === "claim" ? prepareLiquidityClaim(version, legs) : operation === "withdraw"
    ? prepareLiquidityClose(version, legs, [{ amount0: "10", amount1: "20" }], 100)
    : prepareLiquidityOpen({ version, pool: v3Pool, key,
      bands: [{ tickLower: -600, tickUpper: 600, liquidity: 1000n, amount0: 10n, amount1: 20n, amount0Max: 11n, amount1Max: 21n }],
      deadline: BigInt(executionDeadline / 1000), minimumTick: -60, maximumTick: 60, slippageBps: 100 });
  const body = { owner, token, symbol: "PONSBOT", version, poolId, operation, quoteId: `0x${"1".repeat(64)}`,
    expiresAt: now + 600_000, executionDeadline, calls: operation === "withdraw" ? [prepareLiquidityClaim(version, legs), call] : [call], summary: ["Review the position and gas."], priorLegs: legs };
  const proof = createHmac("sha256", "offline-quote-fixture-not-a-real-secret").update(`liquidity-quote-v1:${JSON.stringify(body)}`).digest("hex");
  const plan: LiquidityQuotePlan = { ...body, proof };
  return { plan, expected: { owner, draft, legs, ...(operation !== "open" ? { poolId } : {}) } };
}

describe("liquidity quote response boundary (offline)", () => {
  it.each([3, 4] as const)("accepts V%s ETH/USDG open, collect and full withdrawal plans without changing signed JSON", version => {
    for (const pair of ["ETH", "USDG"] as const) for (const operation of ["open", "claim", "withdraw"] as const) {
      const { plan, expected } = fixture(version, pair, operation), original = JSON.stringify(plan);
      const accepted = validateLiquidityQuote(plan, expected, now);
      expect(accepted).toBe(plan); expect(JSON.stringify(accepted)).toBe(original);
      const { proof, ...body } = accepted;
      expect(createHmac("sha256", "offline-quote-fixture-not-a-real-secret").update(`liquidity-quote-v1:${JSON.stringify(body)}`).digest("hex")).toBe(proof);
    }
  });
  it.each([3, 4] as const)("accepts a full V%s withdrawal without a no-op collection call", version => {
    const { plan, expected } = fixture(version, "ETH", "withdraw");
    plan.calls = [plan.calls[1]];
    expect(validateLiquidityQuote(plan, expected, now)).toBe(plan);
  });
  it("allows only a signed, same-pool, same-range replacement open during operator recovery", () => {
    const { plan } = fixture(4), decodedKey = liquidityPoolKey(token, "ETH", 4, 3000, 60);
    Object.assign(plan, { requestedBudgetUsd: 50, minimumFillBps: 9500, slippageBps: 100, bandWeights: [1], expectedDepositUsd: 50, expectedFillBps: 10000, partialReprice: false });
    const replacement = { ...plan, calls: [...plan.calls.slice(0, -1), prepareLiquidityOpen({ version: 4, pool: v3Pool, key: decodedKey,
      bands: [{ tickLower: -600, tickUpper: 600, liquidity: 900n, amount0: 9n, amount1: 18n, amount0Max: 10n, amount1Max: 19n }],
      deadline: BigInt(plan.executionDeadline / 1000), minimumTick: -60, maximumTick: 60, slippageBps: 100 })],
      expectedDepositUsd: 45, expectedFillBps: 9000, partialReprice: true };
    expect(validateLiquidityOpenRefresh(plan, replacement)).toBe(replacement);
    expect(() => validateLiquidityOpenRefresh(plan, { ...replacement, poolId: `0x${"9".repeat(64)}` })).toThrow("LP_REFRESHED_QUOTE_INVALID");
  });
  it("accepts planned funding and approval calls before opening", () => {
    const { plan, expected } = fixture();
    plan.calls.unshift({ to: DELTA_LIQUIDITY.usdg, data: "0x1234", value: "0", purpose: "funding" });
    expect(validateLiquidityQuote(plan, expected, now)).toBe(plan);
  });
  it.each([
    { owner: v3Pool }, { token: v3Pool }, { symbol: "OTHER" }, { version: 3 }, { operation: "withdraw" },
    { operation: "add" }, { operation: "compound" }, { poolId: v3Pool }, { quoteId: "missing" }, { proof: "" },
    { calls: [] }, { summary: null }, { summary: ["x".repeat(301)] }, { summary: Array(21).fill("text") },
    { confirmed: true }, { expiresAt: now }, { expiresAt: Number.POSITIVE_INFINITY },
    { executionDeadline: now }, { executionDeadline: now + 614_999 },
  ])("rejects malformed, stale or mismatched quote %j", update => {
    const { plan, expected } = fixture();
    expect(() => validateLiquidityQuote({ ...plan, ...update }, expected, now)).toThrow("LP_SIGNER_QUOTE_INVALID");
  });
  it("binds a chosen V3 pool but allows the predicted address of a newly initialized V3 pool", () => {
    const { plan, expected } = fixture(3);
    expect(validateLiquidityQuote(plan, expected, now)).toBe(plan);
    expect(() => validateLiquidityQuote(plan, { ...expected, poolId: owner }, now)).toThrow("LP_SIGNER_QUOTE_INVALID");
  });
  it("binds V4 pair, fee and tick spacing, including for custom pools", () => {
    for (const fields of [{ pair: "USDG" as const }, { feePips: 500 }, { tickSpacing: 10 }]) {
      const { plan, expected } = fixture();
      Object.assign(expected.draft.fields, fields);
      expect(() => validateLiquidityQuote(plan, expected, now)).toThrow("LP_SIGNER_QUOTE_INVALID");
    }
  });
  it("rejects a different final target, operation selector, purpose, band count, or calldata deadline", () => {
    const { plan, expected } = fixture();
    for (const final of [
      { ...plan.calls[0], to: owner as Address }, { ...plan.calls[0], data: "0x1" },
      { ...plan.calls[0], purpose: "claim" }, prepareLiquidityClaim(4, [{ tokenId: "123", tickLower: -600, tickUpper: 600, liquidity: "1000" }]),
    ]) expect(() => validateLiquidityQuote({ ...plan, calls: [final] }, expected, now)).toThrow("LP_SIGNER_QUOTE_INVALID");
    expect(() => validateLiquidityQuote({ ...plan, executionDeadline: plan.executionDeadline + 1000 }, expected, now)).toThrow("LP_SIGNER_QUOTE_INVALID");
    expected.draft.fields.bands = 3;
    expect(() => validateLiquidityQuote(plan, expected, now)).toThrow("LP_SIGNER_QUOTE_INVALID");
  });
  it.each([3, 4] as const)("rejects other owners' NFT IDs in V%s claims and closes", version => {
    for (const operation of ["claim", "withdraw"] as const) {
      const { plan, expected } = fixture(version, "ETH", operation);
      expect(() => validateLiquidityQuote({ ...plan, priorLegs: [{ ...plan.priorLegs[0], tokenId: "456" }] }, expected, now)).toThrow("LP_SIGNER_QUOTE_INVALID");
      const wrong = operation === "claim"
        ? prepareLiquidityClaim(version, [{ ...expected.legs[0], tokenId: "456" }])
        : prepareLiquidityClose(version, [{ ...expected.legs[0], tokenId: "456" }], [{ amount0: "10", amount1: "20" }], 100);
      expect(() => validateLiquidityQuote({ ...plan, calls: [wrong] }, expected, now)).toThrow("LP_SIGNER_QUOTE_INVALID");
    }
  });
  it("rejects partial withdrawal, duplicate NFT IDs and oversized plans", () => {
    const { plan, expected } = fixture(4, "ETH", "withdraw");
    expected.draft.fields.withdrawPercent = 50;
    expect(() => validateLiquidityQuote(plan, expected, now)).toThrow("LP_SIGNER_QUOTE_INVALID");
    expected.draft.fields.withdrawPercent = 100;
    const duplicate = [...plan.priorLegs, { ...plan.priorLegs[0], tokenId: "0123" }];
    expect(() => validateLiquidityQuote({ ...plan, priorLegs: duplicate }, { ...expected, legs: duplicate }, now)).toThrow("LP_SIGNER_QUOTE_INVALID");
    expect(() => validateLiquidityQuote({ ...plan, calls: [{ ...plan.calls[0], data: `0x${"00".repeat(30001)}` }] }, expected, now)).toThrow("LP_SIGNER_QUOTE_INVALID");
  });
  it("rejects final calldata that names a different V3 pool", () => {
    const { plan, expected } = fixture(3);
    plan.calls[0].data = encodeFunctionData({ abi: deltaLiquidityAbi, functionName: "openV3", args: [owner, [], -60, 60, BigInt(plan.executionDeadline / 1000)] });
    expect(() => validateLiquidityQuote(plan, expected, now)).toThrow("LP_SIGNER_QUOTE_INVALID");
  });
});
