import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, parseAbi, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { DELTA_LIQUIDITY as A } from "../lib/liquidity-workflow";
import { LIQUIDITY_TEST_WALLET } from "./liquidityFixtures";
const rpc = vi.hoisted(() => ({ readContract: vi.fn(), simulateContract: vi.fn() }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => rpc }));
vi.mock("../lib/shared-wallet-execution-cache", () => ({
  sharedWalletExecutionCache: async () => undefined, rememberWalletExecutionCache: async () => undefined,
  walletExecutionCacheKey: (...parts: unknown[]) => parts.join(":"),
}));
vi.mock("../lib/token-market-cap", () => ({ tokenMarketCapUsd: vi.fn() }));
import { quoteLiquidityPurchase, quoteLiquidityUsdgToEth } from "../lib/wallet-signer/service";
const token: Address = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07";
const owner: Address = LIQUIDITY_TEST_WALLET;
const curve: Address = "0x1111111111111111111111111111111111111111";
const router: Address = "0xcaf681a66d020601342297493863e78c959e5cb2";
const tradeAbi = parseAbi([
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns(uint256)",
  "function multicall(bytes[]) payable returns(bytes[])",
  "function unwrapWETH9(uint256,address) payable",
  "function buy(uint256,uint256,address) payable returns(uint256)",
]);
beforeEach(() => {
  vi.resetAllMocks();
  // No CDP setup: attempts to sign or send cannot succeed in these tests.
  vi.stubEnv("CDP_API_KEY_ID", ""); vi.stubEnv("CDP_API_KEY_SECRET", ""); vi.stubEnv("CDP_WALLET_SECRET", "");
  rpc.readContract.mockImplementation(async ({ address, functionName }: { address: string; functionName: string }) => {
    if (functionName === "getLaunchedToken") return { exists: false };
    if (functionName === "allowance") return 0n;
    if (functionName === "decimals") return address.toLowerCase() === A.usdg ? 6 : 18;
    if (functionName === "symbol") return "TEST";
    if (functionName === "name") return "Test";
    throw new Error(`Unexpected read ${functionName}`);
  });
  rpc.simulateContract.mockImplementation(async ({ functionName, args }: { functionName: string; args: readonly [Hex, bigint] }) => {
    if (functionName !== "quoteExactInput") throw new Error(`Unexpected simulation ${functionName}`);
    const input = args[0].slice(0, 42).toLowerCase();
    return { result: [input === A.usdg ? args[1] * 1_000_000_000n : args[1] / 1_000_000_000n, [], [], 100_000n] };
  });
});
describe("read-only LP funding route calldata", () => {
  it("routes native ETH into missing USDG, delivering output to the owner", async () => {
    const plan = await quoteLiquidityPurchase(owner, A.usdg, 10_000_000n, 100);
    expect(plan.calls).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: tradeAbi, data: plan.calls[0].data });
    if (decoded.functionName !== "exactInput") throw new Error("Wrong route");
    expect(decoded.args[0].recipient.toLowerCase()).toBe(owner);
    expect(decoded.args[0].amountOutMinimum).toBe(10_000_000n);
    expect(decoded.args[0].amountIn).toBe(plan.nativeInput);
    expect(BigInt(plan.calls[0].value)).toBe(plan.nativeInput);
  });
  it("routes only USDG into ETH and unwraps it to the owner", async () => {
    const minimum = parseEther("0.01");
    const plan = await quoteLiquidityUsdgToEth(owner, token, minimum, 100_000_000n, 100);
    expect(plan.usdgInput).toBeLessThanOrEqual(100_000_000n);
    expect(plan.calls.every(c => c.value === "0")).toBe(true);
    expect(plan.calls[0].to).toBe(A.usdg);
    const batch = decodeFunctionData({ abi: tradeAbi, data: plan.calls.at(-1)!.data });
    if (batch.functionName !== "multicall") throw new Error("Missing unwrap batch");
    const swap = decodeFunctionData({ abi: tradeAbi, data: batch.args[0][0] });
    const unwrap = decodeFunctionData({ abi: tradeAbi, data: batch.args[0][1] });
    if (swap.functionName !== "exactInput" || unwrap.functionName !== "unwrapWETH9") throw new Error("Wrong route");
    expect(swap.args[0].path.slice(0, 42).toLowerCase()).toBe(A.usdg);
    expect(swap.args[0].path.slice(-40).toLowerCase()).toBe(A.weth.slice(2));
    expect(swap.args[0].recipient.toLowerCase()).toBe(router);
    expect(unwrap.args).toEqual([minimum, expect.any(String)]);
    expect(unwrap.args[1].toLowerCase()).toBe(owner);
  });
  it("rejects attempts to use the position token USDG as a funding sale before RPC", async () => {
    await expect(quoteLiquidityUsdgToEth(owner, A.usdg, 1n, 1_000_000n, 100)).rejects.toThrow("position token cannot be sold");
    expect(rpc.readContract).not.toHaveBeenCalled(); expect(rpc.simulateContract).not.toHaveBeenCalled();
  });
  it("builds a native bonding-curve purchase with an enforced output minimum", async () => {
    const read = rpc.readContract.getMockImplementation()!;
    rpc.readContract.mockImplementation(async (request: { address: string; functionName: string }) => {
      if (request.functionName === "getLaunchedToken") return { exists: true, phase: 0, pairToken: zeroAddress, curve };
      if (request.functionName === "getReserves") return [parseEther("100"), parseEther("1000000")];
      if (request.functionName === "feeBps") return 100n;
      return read(request);
    });
    const plan = await quoteLiquidityPurchase(owner, token, parseEther("1000"), 100);
    expect(plan.calls).toHaveLength(1); expect(plan.calls[0].to).toBe(curve);
    const decoded = decodeFunctionData({ abi: tradeAbi, data: plan.calls[0].data });
    if (decoded.functionName !== "buy") throw new Error("Wrong curve call");
    expect(decoded.args[0]).toBe(plan.nativeInput); expect(decoded.args[1]).toBe(parseEther("1000"));
    expect(decoded.args[2].toLowerCase()).toBe(owner);
  });
  it("brackets and refines a large nonlinear graduated-token funding quote", async () => {
    const read = rpc.readContract.getMockImplementation()!;
    rpc.readContract.mockImplementation(async (request: { functionName: string }) => {
      if (request.functionName === "getLaunchedToken") return { exists: true, phase: 2, pairToken: zeroAddress, poolFee: 0, tickSpacing: 200 };
      if (request.functionName === "memeHook") return "0x2222222222222222222222222222222222222222";
      return read(request);
    });
    rpc.simulateContract.mockImplementation(async ({ functionName, args }: { functionName: string; args: readonly [{ exactAmount: bigint }] }) => {
      if (functionName !== "quoteExactInputSingle") throw new Error(`Unexpected simulation ${functionName}`);
      const amount = args[0].exactAmount;
      const output = amount * parseEther("5000000") / (parseEther("1") + amount);
      return { result: [output, 100_000n] };
    });
    const minimum = parseEther("3000000");
    const plan = await quoteLiquidityPurchase(owner, token, minimum, 100);
    expect(plan.nativeInput).toBeGreaterThan(parseEther("1.5"));
    expect(plan.calls.at(-1)?.purpose).toBe("funding_buy");
  });
  it("wraps only the requested missing WETH amount", async () => {
    const plan = await quoteLiquidityPurchase(owner, A.weth, 123n, 100);
    expect(plan.nativeInput).toBe(123n); expect(plan.calls[0]).toMatchObject({ to: A.weth, purpose: "funding_wrap", value: "123" });
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
});
