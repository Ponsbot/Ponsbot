import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi, parseEther, parseTransaction, zeroAddress, type Address } from "viem";

const mock = vi.hoisted(() => ({
  account: vi.fn(), sign: vi.fn(),
  rpc: { getChainId: vi.fn(), readContract: vi.fn(), simulateContract: vi.fn(), call: vi.fn(), estimateGas: vi.fn(),
    getBlock: vi.fn(), estimateMaxPriorityFeePerGas: vi.fn(), getTransactionCount: vi.fn(), getBalance: vi.fn(), sendRawTransaction: vi.fn() },
}));
vi.mock("@coinbase/cdp-sdk", () => ({ CdpClient: class { evm = { getOrCreateAccount: mock.account, signTransaction: mock.sign }; } }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => mock.rpc }));
vi.mock("../lib/shared-wallet-execution-cache", () => ({ walletExecutionCacheKey: (...parts: string[]) => parts.join(":"),
  sharedWalletExecutionCache: async () => undefined, rememberWalletExecutionCache: async () => undefined }));
vi.mock("../lib/token-market-cap", () => ({ tokenMarketCapUsd: vi.fn() }));
vi.mock("../lib/wallet-signer/pricing", () => ({ checkedUsdToEthWei: async (amount: string) => parseEther(String(Number(amount) / 2000)) }));

const owner: Address = "0x1111111111111111111111111111111111111111";
const recipient: Address = "0x2222222222222222222222222222222222222222";
const target: Address = "0x7777777777777777777777777777777777777777";
const pair: Address = "0x3333333333333333333333333333333333333333";
const factory: Address = "0x4444444444444444444444444444444444444444";
const curve: Address = "0x5555555555555555555555555555555555555555";
const weth: Address = "0x6666666666666666666666666666666666666666";
const cbbtc: Address = "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4";
const dead: Address = "0x000000000000000000000000000000000000dEaD";
const value = parseEther("0.0018");
let phase: number | undefined, paired: Address, held: bigint;

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in denomination tests"); }));
  for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "WALLET_SIGNER_IDEMPOTENCY_SECRET"]) vi.stubEnv(name, "offline-test-only");
  vi.stubEnv("ROBINHOOD_RPC_URL", "https://rpc.invalid");
  phase = undefined; paired = zeroAddress; held = parseEther("1000000");
  mock.account.mockResolvedValue({ address: owner }); mock.sign.mockResolvedValue({ signature: "0x1234" });
  mock.rpc.getChainId.mockResolvedValue(4663);
  // The wallet deliberately has less ETH than the token's ETH denomination.
  // It only needs gas because no purchase is being executed.
  mock.rpc.getBalance.mockResolvedValue(parseEther("0.0001"));
  mock.rpc.call.mockResolvedValue({ data: "0x" }); mock.rpc.estimateGas.mockResolvedValue(21000n);
  mock.rpc.getBlock.mockResolvedValue({ baseFeePerGas: 900000000n });
  mock.rpc.estimateMaxPriorityFeePerGas.mockResolvedValue(100000000n);
  mock.rpc.getTransactionCount.mockResolvedValue(3);
  mock.rpc.readContract.mockImplementation(async ({ functionName, args }: { functionName: string; args?: string[] }) => {
    if (functionName === "symbol") return "TEST";
    if (functionName === "name") return "Test";
    if (functionName === "decimals") return 18;
    if (functionName === "balanceOf") return held;
    if (functionName === "getLaunchedToken") return args?.[0].toLowerCase() === target.toLowerCase() ? argumentsForLaunch() : { exists: false };
    if (functionName === "getReserves") return [parseEther("10"), parseEther("1000000")];
    if (functionName === "feeBps") return 100n;
    if (functionName === "memeHook") return factory;
    throw new Error(`Unexpected contract read ${functionName}`);
  });
  mock.rpc.simulateContract.mockImplementation(async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
    if (functionName === "quoteExactInput") return { result: [(args[1] as bigint) * 1000n, [], [], 1n] };
    if (functionName === "quoteExactInputSingle") return { result: [(args[0] as { exactAmount: bigint }).exactAmount * 2000n, 1n] };
    throw new Error(`Unexpected simulation ${functionName}`);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function argumentsForLaunch() {
  return phase === undefined ? { exists: false } : { token: target, curve, deployer: owner, creatorFeeRecipient: owner,
    pairToken: paired, graduationThreshold: 1n, poolFee: 10000, tickSpacing: 200, creatorTaxBps: 100,
    buybackEnabled: false, phase, sweptQuote: 0n, sweptTokens: 0n, sweptAt: 0n, exists: true };
}
describe("native burn rejection before RPC or signing", () => {
  it.each(["ETH", "eth", zeroAddress])("rejects %s without running balances, valuation or signing", async token => {
    const { executeTransaction } = await import("../lib/wallet-signer/service");
    await expect(executeTransaction({ chainId: 4663, ownerReference: "x:123456789", expectedFrom: owner, walletRef: owner,
      idempotencyKey: "offline-native-rejection", requireSimulation: true,
      operation: { type: "erc20_burn_to_dead", deadAddress: dead, token, amount: "0.0001", unit: "usd", quoterAddress: recipient, wethAddress: weth, fee: 10000 },
    })).rejects.toThrow("BURN_TARGET_NATIVE_ETH");
    expect(mock.rpc.getBalance).not.toHaveBeenCalled(); expect(mock.rpc.readContract).not.toHaveBeenCalled();
    expect(mock.sign).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
async function execute(type: "erc20_transfer" | "erc20_burn_to_dead" = "erc20_transfer", token: Address = target, unit: "eth" | "usd" | "token" | "percent" = "eth", amount = "0.0018") {
  const { executeTransaction } = await import("../lib/wallet-signer/service");
  return executeTransaction({ chainId: 4663, ownerReference: "x:123456789", expectedFrom: owner, walletRef: owner,
    idempotencyKey: "offline-token-value", requireSimulation: true, operation: {
      ...(type === "erc20_transfer" ? { type, recipient } : { type, deadAddress: dead }), token, amount, unit,
      quoterAddress: recipient, wethAddress: weth, ponsFactoryAddress: factory, v4QuoterAddress: curve, fee: 10000,
    } });
}
function assertTransfer(amount: bigint, to: Address = recipient, token: Address = target) {
  expect(mock.sign).toHaveBeenCalledTimes(1);
  const tx = parseTransaction(mock.sign.mock.calls[0][0].transaction);
  expect(tx.to?.toLowerCase()).toBe(token.toLowerCase()); expect(tx.value ?? 0n).toBe(0n);
  const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
  expect(decoded.functionName).toBe("transfer");
  if (decoded.functionName !== "transfer") throw new Error("Expected only an ERC-20 transfer");
  expect(decoded.args[0].toLowerCase()).toBe(to.toLowerCase());
  expect(decoded.args[1]).toBe(amount);
  expect(mock.rpc.simulateContract.mock.calls.every(([args]) => args.functionName.startsWith("quote"))).toBe(true);
  expect(mock.rpc.readContract.mock.calls.some(([args]) => args.functionName === "allowance")).toBe(false);
  expect(mock.rpc.sendRawTransaction).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
}
const curveOutput = (input: bigint) => { const net = input * 9900n / 10000n; return parseEther("1000000") * net / (parseEther("10") + net); };

describe("signer token value quotes, RPC/CDP fully mocked", () => {
  it("sends V3 token holdings without spending the ETH denomination", async () => { await execute(); assertTransfer(value * 1000n); });
  it("values an ETH bonding curve without a funded buy simulation", async () => { phase = 0; await execute(); assertTransfer(curveOutput(value)); });
  it("values a custom-pair curve through its V3 pair route", async () => { phase = 0; paired = pair; await execute(); assertTransfer(curveOutput(value * 1000n)); });
  it("values a graduated Pons V4 token", async () => { phase = 2; await execute(); assertTransfer(value * 2000n); });
  it("values graduated custom-pair tokens in the right direction", async () => {
    phase = 2; paired = pair; await execute(); assertTransfer(value * 1000n * 2000n);
    expect(mock.rpc.simulateContract.mock.calls.find(([args]) => args.functionName === "quoteExactInputSingle")?.[0].args[0])
      .toMatchObject({ zeroForOne: true, poolKey: { currency0: pair, currency1: target }, exactAmount: value * 1000n });
  });
  it("supports cbBTC's indexed native V4 route", async () => { await execute("erc20_transfer", cbbtc); assertTransfer(value * 2000n, recipient, cbbtc); });
  it("supports cbBTC-paired curve tokens without a V3 route for cbBTC", async () => { phase = 0; paired = cbbtc; await execute(); assertTransfer(curveOutput(value * 2000n)); });
  it("burns the quoted quantity to the dead address and retains confirmation data", async () => {
    phase = 0; const result = await execute("erc20_burn_to_dead"); assertTransfer(curveOutput(value), dead);
    expect(result).toMatchObject({ tradeOutputTokenAddress: target, tradeOutputBalanceBefore: held.toString() });
  });
  it("also handles existing dollar-denominated Pons transfers", async () => { phase = 0; await execute("erc20_transfer", target, "usd", "3.6"); assertTransfer(curveOutput(value)); });
  it.each(["token", "percent"] as const)("does not quote exact %s amounts", async unit => {
    await execute("erc20_transfer", target, unit, "10"); assertTransfer(unit === "token" ? parseEther("10") : held / 10n);
    expect(mock.rpc.simulateContract).not.toHaveBeenCalled();
    expect(mock.rpc.readContract.mock.calls.some(([args]) => args.functionName === "getLaunchedToken")).toBe(false);
  });
  it("rejects insufficient tokens without signing", async () => { held = 1n; await expect(execute()).rejects.toThrow("insufficient token balance"); expect(mock.sign).not.toHaveBeenCalled(); });
  it("rejects unavailable quotes without falling back to an ETH send", async () => { mock.rpc.simulateContract.mockRejectedValue(new Error("offline unavailable quote")); await expect(execute()).rejects.toThrow(); expect(mock.sign).not.toHaveBeenCalled(); });
  it("does not guess a price during migration", async () => { phase = 1; await expect(execute()).rejects.toThrow("finalizing"); expect(mock.sign).not.toHaveBeenCalled(); });
  it("rejects cyclic pair routes", async () => { phase = 0; paired = target; await expect(execute()).rejects.toThrow("invalid token valuation route"); expect(mock.sign).not.toHaveBeenCalled(); });
  it("requires native gas before any pricing or signing", async () => {
    mock.rpc.getBalance.mockResolvedValue(0n); await expect(execute()).rejects.toThrow("zero native ETH");
    expect(mock.rpc.readContract).not.toHaveBeenCalled(); expect(mock.sign).not.toHaveBeenCalled();
  });
});
