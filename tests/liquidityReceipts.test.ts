import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, parseAbi, zeroAddress, type Hex } from "viem";
import { deltaLiquidityAbi, liquidityPoolId, liquidityPoolKey } from "../lib/liquidity-contracts";
import { DELTA_LIQUIDITY as A } from "../lib/liquidity-workflow";
import { LIQUIDITY_TEST_OWNER, LIQUIDITY_TEST_WALLET } from "./liquidityFixtures";
const rpc = vi.hoisted(() => ({ getTransactionReceipt: vi.fn(), getTransaction: vi.fn(), getBlockNumber: vi.fn(), readContract: vi.fn(), request: vi.fn() }));
const service = vi.hoisted(() => ({ prepareUnsigned: vi.fn(), signPreparedEnvelope: vi.fn() }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => rpc }));
vi.mock("../lib/liquidity-markets", () => ({ liquidityRpc: () => rpc }));
vi.mock("../lib/wallet-signer/service", () => service);
vi.mock("../lib/token-market-cap", () => ({ quoteDetails: vi.fn() }));
vi.mock("../lib/wallet-signer/pricing", () => ({ ethUsdPrice: vi.fn(async () => 2000) }));
vi.mock("../lib/liquidity-payouts", () => ({ explorerLiquidityNativePayout: async () => undefined }));
import { inspectLiquidityReceipt, prepareLiquidityEnvelope, signLiquidityEnvelope, type LiquidityQuotePlan } from "../lib/wallet-signer/liquidity";
const secret = "private-offline-liquidity-quote-signature-key";
const owner = LIQUIDITY_TEST_WALLET, token = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07", hash: Hex = `0x${"a".repeat(64)}`;
const key = liquidityPoolKey(token, "ETH", 4, 3000, 60);
const nftAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"]);
function plan(operation = "open"): LiquidityQuotePlan {
  const data = operation === "open" ? encodeFunctionData({ abi: deltaLiquidityAbi, functionName: "openV4", args: [key, [{ tickLower: -600, tickUpper: 600, liquidity: 10n, amount0Max: 1n, amount1Max: 1n }], BigInt(Math.floor(Date.now() / 1000) + 1200)] }) : encodeFunctionData({ abi: deltaLiquidityAbi, functionName: "collectV4Batch", args: [[123n]] });
  const body = { owner, token, symbol: "PONSBOT", version: 4 as const, poolId: liquidityPoolId(key), operation, quoteId: hash, expiresAt: Date.now() + 600000, executionDeadline: Date.now() + 1200000,
    calls: [{ to: A.manager, data, value: "0", purpose: operation }], summary: [], priorLegs: [] };
  return { ...body, proof: createHmac("sha256", secret).update(`liquidity-quote-v1:${JSON.stringify(body)}`).digest("hex") };
}
function setupReceipt(p: LiquidityQuotePlan, logs: unknown[] = []) {
  rpc.getTransactionReceipt.mockResolvedValue({ status: "success", gasUsed: 100000n, blockNumber: 100n, logs });
  rpc.getTransaction.mockResolvedValue({ from: owner, to: A.manager, input: p.calls[0].data, value: 0n });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("LIQUIDITY_QUOTE_SIGNING_SECRET", secret); vi.stubEnv("WALLET_SIGNER_TOKEN", "different-access-key");
  rpc.getBlockNumber.mockResolvedValue(100n);
  rpc.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "ownerOfV4") return owner;
    if (functionName === "ownerOf") return A.manager;
    if (functionName === "getPositionLiquidity") return 10n;
    if (functionName === "getPoolAndPositionInfo") return [key, (BigInt.asUintN(24, -600n) << 8n) | (600n << 32n)];
    if (functionName === "getSlot0") return [1n << 96n, 0, 0, 0];
    if (functionName === "decimals") return 18;
    if (functionName === "symbol") return "PONSBOT";
    throw new Error(`Unexpected read ${functionName}`);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("LP receipt verification", () => {
  it("verifies every minted NFT, its pool/range, beneficial owner and custody", async () => {
    const p = plan(); setupReceipt(p, [{ address: A.v4Npm, topics: encodeEventTopics({ abi: nftAbi, eventName: "Transfer", args: { from: zeroAddress, to: A.manager, tokenId: 123n } }), data: "0x" }]);
    expect((await inspectLiquidityReceipt(hash, p)).legs).toEqual([{ tokenId: "123", tickLower: -600, tickUpper: 600, liquidity: "10" }]);
    expect(service.signPreparedEnvelope).not.toHaveBeenCalled();
  });
  it("propagates NFT read failures for durable reconciliation, never silently omits a band", async () => {
    const p = plan(); setupReceipt(p, [{ address: A.v4Npm, topics: encodeEventTopics({ abi: nftAbi, eventName: "Transfer", args: { from: zeroAddress, to: A.manager, tokenId: 123n } }), data: "0x" }]);
    rpc.readContract.mockRejectedValue(new Error("RPC unavailable"));
    await expect(inspectLiquidityReceipt(hash, p)).rejects.toThrow("RPC unavailable");
  });
  it("rejects an unrelated successful transaction", async () => {
    const p = plan(); setupReceipt(p); rpc.getTransaction.mockResolvedValue({ from: owner, to: A.manager, input: "0x1234", value: 0n });
    await expect(inspectLiquidityReceipt(hash, p)).rejects.toThrow("LP_RECEIPT_PLAN_MISMATCH");
  });
  it("reports actual receipt tokens and native transfers, not the old budget", async () => {
    const p = plan("claim"); setupReceipt(p, [{ address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: A.manager, to: owner } }), data: encodeAbiParameters([{ type: "uint256" }], [100000n * 10n ** 18n]) }]);
    rpc.request.mockResolvedValue({ type: "CALL", from: owner, to: A.manager, value: "0x0", calls: [{ type: "CALL", from: A.manager, to: owner, value: "1000000000000000" }, { type: "CALL", from: A.manager, to: owner, value: "5000000000000000", error: "reverted" }] });
    expect((await inspectLiquidityReceipt(hash, p)).received).toEqual(["0.00100000 ETH", "100000 PONSBOT"]);
  });
  it("does not misreport missing native trace data as a zero payout", async () => {
    const p = plan("claim"); setupReceipt(p); rpc.request.mockRejectedValue(new Error("unsupported"));
    const result = await inspectLiquidityReceipt(hash, p);
    expect(result.status).toBe("confirmed"); expect(result.received).toEqual(["ETH payout amount unavailable; see transaction"]);
  });
});
describe("persisted LP signature envelopes", () => {
  it("verifies the persisted payload and recovers the same exact signature request", async () => {
    const p = plan(), input = { ownerXUserId: LIQUIDITY_TEST_OWNER, walletRef: owner, plan: p, step: 0, idempotencyKey: "exact-same-request" };
    service.prepareUnsigned.mockResolvedValue({ unsignedTransaction: "0x1234", toAddress: A.manager, valueWei: "0", nonce: 12 });
    const envelope = await prepareLiquidityEnvelope(input);
    service.signPreparedEnvelope.mockResolvedValue({ transactionHash: hash, signedTransaction: "0xabcd" });
    await signLiquidityEnvelope({ ...input, envelope }); await signLiquidityEnvelope({ ...input, envelope });
    expect(service.signPreparedEnvelope.mock.calls[0]).toEqual(service.signPreparedEnvelope.mock.calls[1]);
    await expect(signLiquidityEnvelope({ ...input, envelope: { ...envelope, nonce: 13 } })).rejects.toThrow("Invalid envelope proof");
  });
});
