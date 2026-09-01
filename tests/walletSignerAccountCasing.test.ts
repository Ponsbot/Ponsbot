import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTransaction, type Address } from "viem";

const mock = vi.hoisted(() => ({
  getOrCreateAccount: vi.fn(), signTransaction: vi.fn(),
  rpc: {
    getChainId: vi.fn(), call: vi.fn(), estimateGas: vi.fn(),
    getBlock: vi.fn(), estimateMaxPriorityFeePerGas: vi.fn(), getTransactionCount: vi.fn(),
    getBalance: vi.fn(), sendRawTransaction: vi.fn(),
  },
}));
vi.mock("@coinbase/cdp-sdk", () => ({ CdpClient: class {
  evm = { getOrCreateAccount: mock.getOrCreateAccount, signTransaction: mock.signTransaction };
} }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => mock.rpc }));
vi.mock("../lib/token-market-cap", () => ({ quoteDetails: vi.fn() }));
import { executeTransaction, prepareSigned, prepareUnsigned, signPreparedEnvelope } from "../lib/wallet-signer/service";
import { sendAllGasReserve, transactionMaximumCost } from "../lib/wallet-signer/gas";

const cdpAddress: Address = "0xc965ae6227d470D6862929BCb7cF57d6e2D699ad";
const destination: Address = "0x1111111111111111111111111111111111111111";
const request = {
  chainId: 4663 as const, ownerReference: "x:2077857030769885184",
  walletRef: cdpAddress, expectedFrom: cdpAddress, requireSimulation: true as const,
  idempotencyKey: "offline-regression-evacoin", minimumNonce: 9,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden in signer regression"); }));
  for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "WALLET_SIGNER_IDEMPOTENCY_SECRET"])
    vi.stubEnv(name, "offline-test-only");
  vi.stubEnv("ROBINHOOD_RPC_URL", "https://rpc.invalid");
  mock.getOrCreateAccount.mockResolvedValue({ address: cdpAddress });
  mock.signTransaction.mockImplementation(async ({ address }) => {
    if (address !== cdpAddress) throw Error("EVM account with the given address not found.");
    return { signature: "0x1234" };
  });
  mock.rpc.getChainId.mockResolvedValue(4663);
  mock.rpc.call.mockResolvedValue({ data: "0x" });
  mock.rpc.estimateGas.mockResolvedValue(21000n);
  mock.rpc.getBlock.mockResolvedValue({ baseFeePerGas: 900000000n });
  mock.rpc.estimateMaxPriorityFeePerGas.mockResolvedValue(100000000n);
  mock.rpc.getTransactionCount.mockResolvedValue(3);
  mock.rpc.getBalance.mockResolvedValue(10n ** 18n);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("verified CDP account address is preserved at signing", () => {
  it.each([cdpAddress, cdpAddress.toLowerCase(), `0x${cdpAddress.slice(2).toUpperCase()}`])("accepts request casing %s but signs with CDP's exact address", async expectedFrom => {
    const result = await prepareSigned({ ...request, expectedFrom }, destination, "0xabcd", 123n);
    expect(result.status).toBe("prepared");
    expect(mock.getOrCreateAccount).toHaveBeenCalledTimes(1);
    expect(mock.signTransaction).toHaveBeenCalledWith({ address: cdpAddress, transaction: expect.any(String), idempotencyKey: request.idempotencyKey });
    const tx = parseTransaction(mock.signTransaction.mock.calls[0][0].transaction);
    expect(tx).toMatchObject({ to: destination, data: "0xabcd", value: 123n, nonce: 9, chainId: 4663 });
    expect(mock.rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("still rejects a different owner's address before simulation or signing", async () => {
    await expect(prepareSigned({ ...request, expectedFrom: destination }, destination, "0x", 0n)).rejects.toThrow("wallet owner mismatch");
    expect(mock.rpc.call).not.toHaveBeenCalled();
    expect(mock.signTransaction).not.toHaveBeenCalled();
  });
  it("still rejects insufficient gas funds before signing", async () => {
    mock.rpc.getBalance.mockResolvedValue(0n);
    await expect(prepareSigned(request, destination, "0x", 0n)).rejects.toThrow("zero native ETH");
    expect(mock.rpc.estimateGas).not.toHaveBeenCalled();
    expect(mock.signTransaction).not.toHaveBeenCalled();
  });
  it("does not change persisted LP envelopes or let them choose the signing account", async () => {
    const envelope = await prepareUnsigned(request, destination, "0x", 0n);
    expect(Object.keys(envelope).sort()).toEqual(["nonce", "toAddress", "unsignedTransaction", "valueWei"]);
    expect(mock.signTransaction).not.toHaveBeenCalled();
    await signPreparedEnvelope({ ...request, expectedFrom: cdpAddress.toLowerCase() }, envelope);
    expect(mock.signTransaction.mock.calls[0][0].address).toBe(cdpAddress);
  });

  it("accepts exactly the single-budget balance and does not add an implicit fee multiplier", async () => {
    const value = 123n;
    const required = transactionMaximumCost(value, 21000n, 1000000000n);
    mock.rpc.getBalance.mockResolvedValue(required);
    await prepareSigned(request, destination, "0x", value);
    const tx = parseTransaction(mock.signTransaction.mock.calls[0][0].transaction);
    expect(tx.gas! * tx.maxFeePerGas! + tx.value!).toBeLessThanOrEqual(required);
    expect(required - value).toBe(23_100_000_000_000n);
    expect(tx.maxPriorityFeePerGas).toBe(100000000n);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reserves and signs a send-all using ONE quote, with no second-price race", async () => {
    // A second quote would spike. It must not be fetched between reserving
    // ETH and building this same transaction's envelope.
    mock.rpc.getBlock.mockResolvedValueOnce({ baseFeePerGas: 900000000n }).mockResolvedValue({ baseFeePerGas: 9_000_000_000n });
    const result = await executeTransaction({ ...request, operation: { type: "eth_transfer", recipient: destination, amount: "100", unit: "percent" } });
    const tx = parseTransaction(mock.signTransaction.mock.calls[0][0].transaction);
    const reserve = sendAllGasReserve(21000n, 1000000000n);
    expect(BigInt(result.valueWei)).toBe(10n ** 18n - reserve);
    expect(tx.value! + tx.gas! * tx.maxFeePerGas!).toBeLessThanOrEqual(10n ** 18n);
    expect(mock.rpc.getBlock).toHaveBeenCalledTimes(1);
    expect(mock.rpc.estimateGas).toHaveBeenCalledTimes(1);
    expect(mock.rpc.estimateGas.mock.calls[0][0].stateOverride).toBeDefined();
    // The execution simulation and balance check still use the real wallet.
    expect(mock.rpc.call.mock.calls[0][0].stateOverride).toBeUndefined();
    expect(mock.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("keeps an explicit ETH send amount unchanged", async () => {
    const result = await executeTransaction({ ...request, operation: { type: "eth_transfer", recipient: destination, amount: "0.001", unit: "eth" } });
    expect(result.valueWei).toBe("1000000000000000");
  });

  it("does not fall back to a fabricated 21,000 gas estimate for a failing recipient", async () => {
    mock.rpc.estimateGas.mockRejectedValue(new Error("recipient reverted"));
    await expect(executeTransaction({ ...request, operation: { type: "eth_transfer", recipient: destination, amount: "100", unit: "percent" } })).rejects.toThrow("recipient reverted");
    expect(mock.signTransaction).not.toHaveBeenCalled();
  });
});
