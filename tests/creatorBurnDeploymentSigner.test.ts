import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseTransaction,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployCreatorLayer } from "../lib/wallet-signer/creator-burn-enrollment";
const m = vi.hoisted(() => ({
  client: {
    getChainId: vi.fn(),
    getCode: vi.fn(),
    readContract: vi.fn(),
    call: vi.fn(),
    estimateGas: vi.fn(),
    getBalance: vi.fn(),
    getTransactionCount: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getTransaction: vi.fn(),
    getBlockNumber: vi.fn(),
    sendRawTransaction: vi.fn(),
  },
  role: vi.fn(),
  executionAccess: vi.fn(),
  cdp: { evm: { signTransaction: vi.fn() } },
}));
vi.mock("../lib/wallet-signer/service", () => ({
  creatorBurnSignerContext: () => m,
}));
vi.mock("../lib/wallet-signer/gas", async (original) => ({
  ...(await original<object>()),
  estimateResilientAutomationFees: async () => ({
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 1n,
  }),
}));
const a = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const admin = privateKeyToAccount(`0x${"12".repeat(32)}`);
const req = {
  vaultAddress: a(3),
  expectedOwner: a(4),
  idempotencyKey: "test-layer",
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries({
    CREATOR_SELF_BUYBACK_ENABLED: "true",
    CREATOR_SELF_BUYBACK_FACTORY_ADDRESS: a(1),
    CREATOR_SELF_BUYBACK_EXECUTOR_ADDRESS: a(2),
    CREATOR_SELF_BUYBACK_FACTORY_CODE_HASH: keccak256("0x1234"),
    CREATOR_SELF_BUYBACK_EXECUTOR_CODE_HASH: keccak256("0x1234"),
    AUTOMATED_FEE_VAULT_FACTORY_ADDRESS: a(5),
    AUTOMATED_FEE_CONTROL_ADDRESS: a(6),
  }))
    vi.stubEnv(k, v);
  m.client.getChainId.mockResolvedValue(4663);
  m.client.getCode.mockResolvedValue("0x1234");
  m.role.mockResolvedValue(admin);
  m.client.readContract.mockImplementation(
    async ({ functionName }) =>
      ({
        primaryFactory: a(5),
        feeControl: a(6),
        executor: a(2),
        registry: a(1),
        isVault: true,
        controller: a(4),
        beneficiary: a(4),
        active: true,
        layerOf: a(0),
      })[functionName as "active"],
  );
  m.client.estimateGas.mockResolvedValue(100000n);
  m.client.getBalance.mockResolvedValue(10n ** 18n);
  m.client.getTransactionCount.mockResolvedValue(1);
  m.cdp.evm.signTransaction.mockImplementation(async ({ transaction }) => ({
    signature: await admin.signTransaction(
      parseTransaction(transaction) as Parameters<
        typeof admin.signTransaction
      >[0],
    ),
  }));
  m.client.getBlockNumber.mockResolvedValue(101n);
});
afterEach(() => vi.unstubAllEnvs());
describe("creator layer deployment signer", () => {
  it("only prepares an exact factory call and never broadcasts preparation", async () => {
    const r = await deployCreatorLayer(req);
    expect(r.status).toBe("prepared");
    expect(m.client.sendRawTransaction).not.toHaveBeenCalled();
    const tx = parseTransaction(r.signedTransaction!);
    expect(tx.to?.toLowerCase()).toBe(a(1));
    expect(tx.data).toBe(
      encodeFunctionData({
        abi: parseAbi(["function create(address) returns(address)"]),
        functionName: "create",
        args: [a(3)],
      }),
    );
  });
  it("rejects a mismatching runtime pin before signing", async () => {
    m.client.getCode.mockResolvedValue("0x5678");
    await expect(deployCreatorLayer(req)).rejects.toThrow("CODE_PIN");
    expect(m.cdp.evm.signTransaction).not.toHaveBeenCalled();
  });
  it("rejects a changed fee owner", async () => {
    await expect(
      deployCreatorLayer({ ...req, expectedOwner: a(9) }),
    ).rejects.toThrow("OWNER_CHANGED");
  });
  it("reconciles confirmed signed envelopes while disabled without sending", async () => {
    const r = await deployCreatorLayer(req);
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "false");
    m.client.getTransactionReceipt.mockResolvedValue({
      status: "success",
      blockNumber: 100n,
    });
    expect(
      (
        await deployCreatorLayer({
          ...req,
          signedTransaction: r.signedTransaction,
        })
      ).status,
    ).toBe("confirmed");
    expect(m.client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("reports a reverted receipt rather than signing a replacement", async () => {
    const r = await deployCreatorLayer(req);
    m.client.getTransactionReceipt.mockResolvedValue({
      status: "reverted",
      blockNumber: 100n,
    });
    expect(
      (
        await deployCreatorLayer({
          ...req,
          signedTransaction: r.signedTransaction,
        })
      ).status,
    ).toBe("reverted");
    expect(m.cdp.evm.signTransaction).toHaveBeenCalledTimes(1);
  });
  it("rejects a saved envelope for another primary", async () => {
    const r = await deployCreatorLayer(req);
    await expect(
      deployCreatorLayer({
        ...req,
        vaultAddress: a(9),
        signedTransaction: r.signedTransaction,
      }),
    ).rejects.toThrow("envelope mismatch");
  });
});
