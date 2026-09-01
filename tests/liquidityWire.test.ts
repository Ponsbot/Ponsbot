import { describe, expect, it } from "vitest";
import { keccak256, serializeTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { validateLiquidityEnvelope, validateLiquiditySignature, validateLiquidityFinalReceipt, validateLiquidityOpenRefresh } from "../lib/liquidity-wire";
import { deltaLiquidityAbi, liquidityPoolId, liquidityPoolKey } from "../lib/liquidity-contracts";
import { DELTA_LIQUIDITY } from "../lib/liquidity-workflow";
import { encodeFunctionData } from "viem";
import type { LiquidityQuotePlan } from "../lib/liquidity-quote";

// Deliberately public test keys; signatures are local and never broadcast.
const account = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const other = privateKeyToAccount(`0x${"2".padStart(64, "0")}`);
const transaction = { type: "eip1559" as const, chainId: 4663, to: "0x1111111111111111111111111111111111111111" as const, data: "0x12" as const, value: 25n, nonce: 2, gas: 100000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
const plan: Pick<LiquidityQuotePlan, "calls"> = { calls: [{ to: transaction.to, data: transaction.data, value: "25", purpose: "open" }] };
const envelope = { unsignedTransaction: serializeTransaction(transaction), toAddress: transaction.to, valueWei: "25", nonce: 2, envelopeProof: "test-proof" };
async function signature(tx: Omit<typeof transaction, "data"> & { data: `0x${string}` } = transaction, signer = account) {
  const signedTransaction = await signer.signTransaction(tx);
  return { signedTransaction, transactionHash: keccak256(signedTransaction), toAddress: tx.to, valueWei: tx.value.toString(), nonce: tx.nonce };
}

describe("liquidity prepared transaction boundary", () => {
  it("accepts exactly the expected Robinhood call and strips unexpected control fields", () => {
    expect(validateLiquidityEnvelope({ ...envelope, confirmed: true }, plan, 0, 2)).toEqual(envelope);
  });
  it.each([
    {}, { ...envelope, nonce: 3 }, { ...envelope, valueWei: "26" }, { ...envelope, unsignedTransaction: "0x1234" },
    { ...envelope, unsignedTransaction: serializeTransaction({ ...transaction, chainId: 1 }) },
    { ...envelope, unsignedTransaction: serializeTransaction({ ...transaction, data: "0x34" }) },
  ])("rejects a malformed or mismatched envelope %j", input => {
    expect(() => validateLiquidityEnvelope(input, plan, 0)).toThrow("LP_SIGNER_ENVELOPE_INVALID");
  });
  it("rejects stale nonces and nonexistent steps", () => {
    expect(() => validateLiquidityEnvelope(envelope, plan, 0, 3)).toThrow("LP_SIGNER_ENVELOPE_INVALID");
    expect(() => validateLiquidityEnvelope(envelope, plan, 1)).toThrow("LP_SIGNER_ENVELOPE_INVALID");
  });
  it("accepts the real matching signature but cannot inject confirmed/reverted state", async () => {
    const signed = await signature();
    expect(await validateLiquiditySignature({ ...signed, confirmed: true, reverted: true, envelope: {} }, envelope, account.address)).toEqual(signed);
  });
  it("accepts a new wallet's zero nonce and a zero-value approval", async () => {
    const tx = { ...transaction, nonce: 0, value: 0n };
    const prepared = { ...envelope, nonce: 0, valueWei: "0", unsignedTransaction: serializeTransaction(tx) };
    const approval: Pick<LiquidityQuotePlan, "calls"> = { calls: [{ ...plan.calls[0], value: "0", purpose: "approval" }] };
    expect(validateLiquidityEnvelope(prepared, approval, 0)).toEqual(prepared);
    const signed = await signature(tx);
    expect(await validateLiquiditySignature(signed, prepared, account.address)).toEqual(signed);
  });
  it("rejects wrong signer, transaction hash, gas, data, value, and nonce", async () => {
    const variants = [await signature(transaction, other), { ...await signature(), transactionHash: `0x${"0".repeat(64)}` },
      await signature({ ...transaction, gas: 200000n }), await signature({ ...transaction, value: 26n }),
      await signature({ ...transaction, nonce: 3 }), await signature({ ...transaction, maxFeePerGas: 20n }),
      await signature({ ...transaction, data: "0x34" })];
    for (const value of variants) await expect(validateLiquiditySignature(value, envelope, account.address)).rejects.toThrow("LP_SIGNER_SIGNATURE_INVALID");
  });
});

describe("liquidity final receipt boundary", () => {
  const leg = { tokenId: "12", tickLower: -600, tickUpper: 600, liquidity: "1234" };
  it("requires minted positions for open confirmations", () => {
    expect(() => validateLiquidityFinalReceipt({ status: "confirmed", legs: [] }, "open")).toThrow("LP_SIGNER_RECEIPT_INVALID");
    expect(validateLiquidityFinalReceipt({ status: "confirmed", legs: [leg] }, "open").legs).toEqual([leg]);
  });
  it("permits empty NFT results on claims and withdrawals", () => {
    for (const operation of ["claim", "withdraw"]) expect(validateLiquidityFinalReceipt({ status: "confirmed", legs: [], received: ["0.01 ETH"] }, operation).status).toBe("confirmed");
  });
  it.each([{}, { status: "confirmed" }, { status: "confirmed", legs: [leg, { ...leg, tokenId: "012" }] }, { status: "confirmed", legs: [{ ...leg, tickUpper: -700 }] }])("rejects incomplete or inconsistent confirmations %j", value => {
    expect(() => validateLiquidityFinalReceipt(value, "open")).toThrow("LP_SIGNER_RECEIPT_INVALID");
  });
});

describe("liquidity final-open refresh boundary", () => {
  const token = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07";
  const key = liquidityPoolKey(token, "ETH", 4, 3000, 60);
  const open = (amount0Max: bigint, amount1Max: bigint) => encodeFunctionData({ abi: deltaLiquidityAbi, functionName: "openV4", args: [key,
    [{ tickLower: -600, tickUpper: 0, liquidity: 10n, amount0Max, amount1Max }, { tickLower: 0, tickUpper: 600, liquidity: 20n, amount0Max, amount1Max }], 1234567n] });
  const oldPlan: LiquidityQuotePlan = {
    owner: account.address, token, symbol: "PONSBOT", version: 4, poolId: liquidityPoolId(key), operation: "open",
    quoteId: `0x${"1".repeat(64)}`, expiresAt: 1000, executionDeadline: 2_000_000,
    calls: [{ to: token, data: "0x1234", value: "0", purpose: "approval" }, { to: DELTA_LIQUIDITY.manager, data: open(100n, 200n), value: "200", purpose: "open" }],
    summary: ["fixed"], proof: "a".repeat(64), priorLegs: [], requestedBudgetUsd: 1000, minimumFillBps: 9500,
    slippageBps: 100, bandWeights: [1, 2], expectedDepositUsd: 1000, expectedFillBps: 10000, partialReprice: false,
  };
  it("allows only the final amounts and signed fill outcome to change", () => {
    const next = { ...oldPlan, quoteId: `0x${"2".repeat(64)}`, proof: "b".repeat(64),
      calls: [oldPlan.calls[0], { ...oldPlan.calls[1], data: open(40n, 80n), value: "80" }], expectedDepositUsd: 400, expectedFillBps: 4000, partialReprice: true };
    expect(validateLiquidityOpenRefresh(oldPlan, next)).toEqual(next);
  });
  it.each([
    (p: LiquidityQuotePlan) => ({ ...p, requestedBudgetUsd: 2000 }),
    (p: LiquidityQuotePlan) => ({ ...p, poolId: `0x${"3".repeat(64)}` }),
    (p: LiquidityQuotePlan) => ({ ...p, calls: [{ ...p.calls[0], data: "0xabcd" }, p.calls[1]] }),
    (p: LiquidityQuotePlan) => ({ ...p, calls: [p.calls[0], { ...p.calls[1], to: token }] }),
    (p: LiquidityQuotePlan) => ({ ...p, expectedFillBps: 7000 }),
    (p: LiquidityQuotePlan) => ({ ...p, calls: [p.calls[0], { ...p.calls[1], value: "80", data: encodeFunctionData({ abi: deltaLiquidityAbi, functionName: "openV4", args: [key, [{ tickLower: -540, tickUpper: 0, liquidity: 10n, amount0Max: 40n, amount1Max: 80n }, { tickLower: 0, tickUpper: 600, liquidity: 20n, amount0Max: 40n, amount1Max: 80n }], 1234567n] }) }] }),
    (p: LiquidityQuotePlan) => ({ ...p, calls: [p.calls[0], { ...p.calls[1], value: "80", data: encodeFunctionData({ abi: deltaLiquidityAbi, functionName: "openV4", args: [key, [{ tickLower: -600, tickUpper: 0, liquidity: 10n, amount0Max: 40n, amount1Max: 80n }, { tickLower: 0, tickUpper: 600, liquidity: 30n, amount0Max: 40n, amount1Max: 80n }], 1234567n] }) }] }),
  ])("rejects expansion or changes to authority-bearing settings", mutate => {
    const baseline = { ...oldPlan, quoteId: `0x${"2".repeat(64)}`, proof: "b".repeat(64), calls: [oldPlan.calls[0], { ...oldPlan.calls[1], data: open(40n, 80n), value: "80" }], expectedDepositUsd: 400, expectedFillBps: 4000, partialReprice: true };
    expect(() => validateLiquidityOpenRefresh(oldPlan, mutate(baseline))).toThrow("LP_REFRESHED_QUOTE_INVALID");
  });
});
