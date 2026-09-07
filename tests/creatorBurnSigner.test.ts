import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseTransaction,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  creatorBurnQuoteDigest,
  creatorBurnVaultAbi,
} from "../lib/creator-burn-policy";
import {
  creatorBurnRequest,
  inspectCreatorBurn,
  prepareCreatorBurn,
  reconcileCreatorDelivery,
  replaceCreatorBurn,
  creatorBurnHistory,
} from "../lib/wallet-signer/creator-burn";

const mocks = vi.hoisted(() => ({
  client: {
    getChainId: vi.fn(),
    getBlockNumber: vi.fn(),
    getCode: vi.fn(),
    readContract: vi.fn(),
    getBlock: vi.fn(),
    simulateCalls: vi.fn(),
    call: vi.fn(),
    estimateGas: vi.fn(),
    getTransactionCount: vi.fn(),
    getBalance: vi.fn(),
    sendRawTransaction: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getLogs: vi.fn(),
  },
  cdp: { evm: { signHash: vi.fn(), signTransaction: vi.fn() } },
  role: vi.fn(),
  executionAccess: vi.fn(),
  launch: vi.fn(),
}));
vi.mock("../lib/wallet-signer/service", () => ({
  creatorBurnSignerContext: () => mocks,
}));
vi.mock("../lib/token-market-cap", () => ({
  tokenUnitPriceUsd: vi.fn(async () => 1),
}));
vi.mock("../lib/wallet-signer/pricing", () => ({
  ethUsdPrice: vi.fn(async () => 2000),
}));
vi.mock("../lib/wallet-signer/gas", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  estimateResilientAutomationFees: vi.fn(async () => ({
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 1n,
  })),
}));
const a = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
function fixture() {
  vi.stubEnv("CREATOR_SELF_BUYBACK_FACTORY_ADDRESS", a(1));
  vi.stubEnv("CREATOR_SELF_BUYBACK_EXECUTOR_ADDRESS", a(2));
  vi.stubEnv("AUTOMATED_FEE_CONTROL_ADDRESS", a(3));
  vi.stubEnv("AUTOMATED_FEE_VAULT_FACTORY_ADDRESS", a(4));
  vi.stubEnv("CREATOR_SELF_BUYBACK_FACTORY_CODE_HASH", keccak256("0x1234"));
  vi.stubEnv("CREATOR_SELF_BUYBACK_EXECUTOR_CODE_HASH", keccak256("0x1234"));
  mocks.client.getChainId.mockResolvedValue(4663);
  mocks.client.getBlockNumber.mockResolvedValue(100n);
  mocks.client.getCode.mockResolvedValue("0x1234");
  const values: Record<string, unknown> = {
    layerOf: a(6),
    isLayer: true,
    isVault: true,
    primaryFactory: a(4),
    feeControl: a(3),
    executor: a(2),
    registry: a(1),
    ponsFactory: a(7),
    upstream: a(5),
    owner: a(8),
    asset: zeroAddress,
    token: a(9),
    active: true,
    exited: false,
    selfBurnBps: 5000,
    configurationNonce: 1n,
    executionNonce: 2n,
    MAX_QUOTE_LIFETIME: 600n,
    controller: a(6),
    beneficiary: a(6),
    pairAsset: zeroAddress,
  };
  mocks.client.readContract.mockImplementation(
    async ({ functionName }) => values[functionName],
  );
  return values;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("permissionless collection recovery", () => {
  const hash = (n: number) =>
    `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
  function history(cash = 50n, reserve = 50n, paid = true) {
    fixture();
    const allocation = {
      address: a(6),
      topics: encodeEventTopics({
        abi: creatorBurnVaultAbi,
        eventName: "Allocation",
        args: { owner: a(8) },
      }),
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [cash + reserve, cash, reserve],
      ),
      logIndex: 1,
      transactionHash: hash(1),
      blockNumber: 96n,
    };
    const payout = {
      address: a(6),
      topics: encodeEventTopics({
        abi: creatorBurnVaultAbi,
        eventName: "Paid",
        args: { owner: a(8) },
      }),
      data: encodeAbiParameters([{ type: "uint256" }], [cash]),
      logIndex: 2,
      transactionHash: hash(2),
      blockNumber: 97n,
    };
    mocks.client.getLogs.mockResolvedValue(
      paid ? [allocation, payout] : [allocation],
    );
    mocks.client.getTransactionReceipt.mockImplementation(
      async ({ hash: h }) => ({
        status: "success",
        to: a(6),
        blockNumber: h === hash(1) ? 96n : 97n,
        gasUsed: 100n,
        effectiveGasPrice: 1n,
        logs: [h === hash(1) ? allocation : payout],
      }),
    );
  }
  it("recovers an externally collected and paid allocation from actual receipts", async () => {
    history();
    expect(
      await reconcileCreatorDelivery(a(5), a(6), "100", "95", a(8)),
    ).toMatchObject({
      complete: true,
      creatorCashDelivered: "50",
      creatorReserveAllocated: "50",
      transactionHash: hash(2),
    });
  });
  it("does not call an external collection a completed payout", async () => {
    history(50n, 50n, false);
    expect(
      await reconcileCreatorDelivery(a(5), a(6), "100", "95", a(8)),
    ).toMatchObject({ complete: false, creatorCashDelivered: "0" });
  });
  it("accepts a 100% reserve without inventing a cash transfer", async () => {
    history(0n, 100n, false);
    expect(
      await reconcileCreatorDelivery(a(5), a(6), "100", "95", a(8)),
    ).toMatchObject({
      complete: true,
      creatorCashDelivered: "0",
      creatorReserveAllocated: "100",
    });
  });
  it("rejects another owner's allocation", async () => {
    history();
    await expect(
      reconcileCreatorDelivery(a(5), a(6), "100", "95", a(99)),
    ).rejects.toThrow("ALLOCATION_NOT_FINAL");
  });
  it("bounds each history request and returns a durable next block", async () => {
    fixture();
    mocks.client.getBlockNumber.mockResolvedValue(5000n);
    mocks.client.getLogs.mockResolvedValue([]);
    expect(
      await creatorBurnHistory({
        vaultAddress: a(5),
        layerAddress: a(6),
        fromBlock: "100",
      }),
    ).toMatchObject({ nextBlock: "2100", complete: false });
    expect(mocks.client.getLogs).toHaveBeenCalledWith({
      address: a(6),
      fromBlock: 100n,
      toBlock: 2099n,
    });
  });
});

describe("same nonce replacement", () => {
  it("only increases fees, keeping the exact nonce, recipient and call", async () => {
    fixture();
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
    vi.stubEnv("AUTOMATED_FEE_KEEPER_ADDRESS", account.address);
    const data = encodeFunctionData({
      abi: creatorBurnVaultAbi,
      functionName: "collectAndPay",
    });
    const signed = await account.signTransaction({
      chainId: 4663,
      type: "eip1559",
      to: a(6),
      data,
      value: 0n,
      nonce: 7,
      gas: 100000n,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 1n,
    });
    mocks.client.getBalance.mockResolvedValue(10n ** 18n);
    mocks.cdp.evm.signTransaction.mockResolvedValue({ signature: "0x1234" });
    await replaceCreatorBurn({
      vaultAddress: a(5),
      layerAddress: a(6),
      transactionHash: keccak256(signed),
      signedTransaction: signed,
    });
    const tx = parseTransaction(
      mocks.cdp.evm.signTransaction.mock.calls[0][0].transaction,
    );
    expect(tx).toMatchObject({ nonce: 7, to: a(6), data });
    expect(tx.maxFeePerGas).toBeGreaterThan(100n);
    expect(mocks.client.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("creator layer transaction preparation", () => {
  function setup() {
    const values = fixture();
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    Object.assign(values, {
      payableTo: 0n,
      burnReserve: 10n ** 18n,
      claimable: 100n,
      decimals: 18,
    });
    mocks.role.mockResolvedValue({ address: a(10) });
    mocks.executionAccess.mockResolvedValue(undefined);
    mocks.client.call.mockResolvedValue({});
    mocks.client.estimateGas.mockResolvedValue(100000n);
    mocks.client.getTransactionCount.mockResolvedValue(2);
    mocks.client.getBalance.mockResolvedValue(10n ** 18n);
    mocks.client.getBlock.mockResolvedValue({
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    });
    mocks.launch.mockResolvedValue({ phase: 0 });
    mocks.client.simulateCalls.mockImplementation(async ({ calls }) => ({
      results: calls.map(() => ({
        status: "success",
        data: encodeAbiParameters([{ type: "uint256" }], [1000n * 10n ** 18n]),
      })),
    }));
    mocks.cdp.evm.signHash.mockResolvedValue({
      signature: `0x${"11".repeat(64)}1b`,
    });
    mocks.cdp.evm.signTransaction.mockResolvedValue({ signature: "0x123456" });
    mocks.client.readContract.mockImplementation(
      async ({ functionName, args }) => {
        if (functionName !== "burnDigest") return values[functionName];
        const [beneficiary, amount, minimumOut, issuedAt, deadline] = args;
        return creatorBurnQuoteDigest({
          chainId: 4663n,
          layer: a(6),
          upstream: a(5),
          token: a(9),
          asset: values.asset as `0x${string}`,
          beneficiary,
          amount,
          minimumOut,
          issuedAt,
          deadline,
          executor: a(2),
          route: encodeAbiParameters([{ type: "uint8" }], [0]),
          configurationNonce: 1n,
          executionNonce: 2n,
        });
      },
    );
    return values;
  }
  it.each(["collect", "payout"] as const)(
    "prepares %s without broadcasting or doing a buy",
    async (stage) => {
      const values = setup();
      values.payableTo = 100n;
      await prepareCreatorBurn({
        vaultAddress: a(5),
        stage,
        idempotencyKey: "test-key",
      });
      const tx = parseTransaction(
        mocks.cdp.evm.signTransaction.mock.calls[0][0].transaction,
      );
      expect(tx.to).toBe(a(6));
      expect(
        decodeFunctionData({ abi: creatorBurnVaultAbi, data: tx.data! })
          .functionName,
      ).toBe(stage === "collect" ? "collectAndPay" : "withdrawFor");
      expect(mocks.client.sendRawTransaction).not.toHaveBeenCalled();
      expect(mocks.cdp.evm.signHash).not.toHaveBeenCalled();
    },
  );
  it("signs a simulated native burn with a bounded quote and output minimum", async () => {
    setup();
    await prepareCreatorBurn({
      vaultAddress: a(5),
      stage: "burn",
      idempotencyKey: "test-key",
    });
    const tx = parseTransaction(
      mocks.cdp.evm.signTransaction.mock.calls[0][0].transaction,
    );
    const call = decodeFunctionData({
      abi: creatorBurnVaultAbi,
      data: tx.data!,
    });
    expect(call.functionName).toBe("executeBurn");
    if (call.functionName !== "executeBurn") throw new Error("wrong call");
    expect(call.args[1]).toBe(10n ** 18n);
    expect(call.args[2]).toBe(970n * 10n ** 18n);
    expect(call.args[4] - call.args[3]).toBe(300n);
    expect(mocks.client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("approves the paired asset inside simulation, never as a live funding transaction", async () => {
    const values = setup();
    values.asset = a(11);
    values.pairAsset = a(11);
    await prepareCreatorBurn({
      vaultAddress: a(5),
      stage: "burn",
      idempotencyKey: "test-key",
    });
    expect(mocks.client.simulateCalls.mock.calls[0][0].calls).toHaveLength(2);
    expect(mocks.client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("defers a sub-dollar reserve without signing a keeper transaction", async () => {
    const values = setup();
    values.burnReserve = 1n;
    expect(
      await prepareCreatorBurn({
        vaultAddress: a(5),
        stage: "burn",
        idempotencyKey: "test-key",
      }),
    ).toMatchObject({ deferred: true });
    expect(mocks.cdp.evm.signTransaction).not.toHaveBeenCalled();
  });
});
describe("creator layer signer provenance boundary", () => {
  it("does not affect normal vaults when no layer configuration exists", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_FACTORY_ADDRESS", "");
    expect(await inspectCreatorBurn(a(5))).toBeNull();
    expect(mocks.client.getChainId).not.toHaveBeenCalled();
  });
  it("rejects all writes while disabled", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "false");
    await expect(
      prepareCreatorBurn({
        vaultAddress: a(5),
        stage: "collect",
        idempotencyKey: "test-test",
      }),
    ).rejects.toThrow("DISABLED");
    expect(mocks.cdp.evm.signTransaction).not.toHaveBeenCalled();
  });
  it("verifies the registry, code hashes, upstream and effective owner at one block", async () => {
    fixture();
    expect(await inspectCreatorBurn(a(5))).toMatchObject({
      layer: a(6),
      owner: a(8),
      bps: 5000,
      active: true,
    });
    for (const [request] of mocks.client.readContract.mock.calls)
      expect(request.blockNumber).toBe(100n);
  });
  it.each(["isLayer", "isVault"])(
    "rejects a false %s registration",
    async (field) => {
      const values = fixture();
      values[field] = false;
      await expect(inspectCreatorBurn(a(5))).rejects.toThrow();
    },
  );
  it.each([
    "upstream",
    "controller",
    "beneficiary",
    "executor",
    "feeControl",
    "registry",
  ])("rejects mismatched %s", async (field) => {
    const values = fixture();
    values[field] = a(99);
    await expect(inspectCreatorBurn(a(5))).rejects.toThrow();
  });
  it("rejects the old contract version and changed bytecode", async () => {
    const values = fixture();
    values.MAX_QUOTE_LIFETIME = 0n;
    await expect(inspectCreatorBurn(a(5))).rejects.toThrow("BINDING");
    values.MAX_QUOTE_LIFETIME = 600n;
    mocks.client.getCode.mockResolvedValue("0x5678");
    await expect(inspectCreatorBurn(a(5))).rejects.toThrow("CODE_PIN");
  });
  it("rejects caller-supplied calldata, signer or arbitrary method names", () => {
    for (const extra of [
      { data: "0x1234" },
      { owner: a(8) },
      { stage: "reassign" },
    ])
      expect(
        creatorBurnRequest.safeParse({ vaultAddress: a(5), ...extra }).success,
      ).toBe(false);
  });
});
