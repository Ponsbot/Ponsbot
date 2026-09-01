import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";
import { requireWalletNativeGas } from "../lib/wallet-native-gas";
const mock = vi.hoisted(() => ({ readContract: vi.fn(), getBlockNumber: vi.fn(), account: vi.fn(), sign: vi.fn() }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => mock }));
vi.mock("@coinbase/cdp-sdk", () => ({ CdpClient: class { evm = { getOrCreateAccount: mock.account, signTransaction: mock.sign }; } }));
vi.mock("../lib/wallet-native-gas", () => ({ requireWalletNativeGas: vi.fn(), requireNativeGasBalance: vi.fn() }));
vi.mock("../lib/shared-wallet-execution-cache", () => ({ walletExecutionCacheKey: (...args: string[]) => args.join(":"),
  sharedWalletExecutionCache: async () => undefined, rememberWalletExecutionCache: async () => undefined }));
vi.mock("../lib/token-market-cap", () => ({ tokenMarketCapUsd: vi.fn() }));
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const owner = a(1), token = a(2), factory = a(3), curve = a(4);
let recipient: Address, pair: Address, amount: bigint, escrowAmount: bigint;
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
  vi.stubEnv("ROBINHOOD_RPC_URL", "https://rpc.invalid");
  recipient = owner; pair = zeroAddress; amount = 0n; escrowAmount = 0n;
  mock.getBlockNumber.mockResolvedValue(123n);
  mock.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "getLaunchedToken") return { exists: true, curve, creatorFeeRecipient: recipient, pairToken: pair, phase: 0 };
    if (functionName === "quoteFeeBalance") return amount;
    if (functionName === "creatorTaxBalance" || functionName === "buybackQuoteBalance") return 0n;
    if (functionName === "feeEscrow") return a(5);
    if (functionName === "balanceOf" || functionName === "balanceOfToken") return escrowAmount;
    if (functionName === "symbol") return "TEST";
    if (functionName === "decimals") return 18;
    throw new Error(`unexpected read ${functionName}`);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("legacy fee signer wiring", () => {
  it("omits empty native sweeps and retains funded curves", async () => {
    const { feeClaimPlan } = await import("../lib/wallet-signer/service");
    expect(await feeClaimPlan([token, token.toUpperCase() as Address], owner, factory)).toEqual({ tokenAddresses: [] });
    amount = 1n;
    expect(await feeClaimPlan([token], owner, factory)).toEqual({ tokenAddresses: [token] });
    expect(mock.sign).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("rechecks fee authority and excludes paired launches from claim-all", async () => {
    const { feeClaimPlan } = await import("../lib/wallet-signer/service"); amount = 1n;
    expect((await feeClaimPlan([token], owner, factory)).tokenAddresses).toEqual([token]);
    recipient = a(9);
    expect((await feeClaimPlan([token], owner, factory)).tokenAddresses).toEqual([]);
    recipient = owner; pair = a(8);
    expect((await feeClaimPlan([token], owner, factory)).tokenAddresses).toEqual([]);
  });
  it("retains simulation eligibility when fee reads fail", async () => {
    const { feeClaimPlan } = await import("../lib/wallet-signer/service"); mock.getBlockNumber.mockRejectedValue(new Error("429"));
    expect((await feeClaimPlan([token], owner, factory)).tokenAddresses).toEqual([token]);
  });
  it("stops an empty specific-token sweep before CDP/signing", async () => {
    const { executeTransaction } = await import("../lib/wallet-signer/service");
    await expect(executeTransaction({ chainId: 4663, ownerReference: "x:123", expectedFrom: owner, walletRef: owner,
      idempotencyKey: "offline-empty-sweep", requireSimulation: true,
      operation: { type: "pons_v2_sweep_fees", token, factoryAddress: factory, minBuybackTokensOut: "0" },
    })).rejects.toThrow("nothing to sweep");
    expect(requireWalletNativeGas).not.toHaveBeenCalled();
    expect(mock.account).not.toHaveBeenCalled(); expect(mock.sign).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("reports an empty creator-fee escrow before requiring gas", async () => {
    const { executeTransaction } = await import("../lib/wallet-signer/service");
    await expect(executeTransaction({ chainId: 4663, ownerReference: "x:123", expectedFrom: owner, walletRef: owner,
      idempotencyKey: "offline-empty-claim", requireSimulation: true,
      operation: { type: "pons_v2_claim_fees", factoryAddress: factory },
    })).rejects.toThrow("no claimable creator fees");
    expect(requireWalletNativeGas).not.toHaveBeenCalled();
    expect(mock.account).not.toHaveBeenCalled(); expect(mock.sign).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("reports claimability before a legacy claim needs gas", async () => {
    const { feeClaimPlan } = await import("../lib/wallet-signer/service");
    expect(await feeClaimPlan([token], owner, factory, undefined, true)).toMatchObject({
      tokenAddresses: [], hasClaimableFees: false, escrowBalance: "0",
    });
    escrowAmount = 7n;
    expect(await feeClaimPlan([token], owner, factory, undefined, true)).toMatchObject({
      tokenAddresses: [], hasClaimableFees: true, escrowBalance: "7",
    });
    escrowAmount = 0n; amount = 1n;
    expect(await feeClaimPlan([token], owner, factory, undefined, true)).toMatchObject({
      tokenAddresses: [token], hasClaimableFees: true,
    });
  });
});
