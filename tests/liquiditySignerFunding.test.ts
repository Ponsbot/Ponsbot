import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi, parseEther, zeroAddress, type Address } from "viem";
import { deltaLiquidityAbi, liquidityPoolKey, liquidityPoolId } from "../lib/liquidity-contracts";
import { validateLiquidityQuote } from "../lib/liquidity-wire";
import { liquidityClaimPositionSchema } from "../lib/liquidity-quote";
import { DELTA_LIQUIDITY as A, newLiquidityDraft } from "../lib/liquidity-workflow";
import { LIQUIDITY_TEST_OWNER, LIQUIDITY_TEST_WALLET, LIQUIDITY_TERMINAL_TEST_OWNER, LIQUIDITY_TERMINAL_TEST_WALLET } from "./liquidityFixtures";
import { liquiditySqrtTick, liquidityBands } from "../lib/liquidity-math";
const token: Address = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07";
const owner: Address = LIQUIDITY_TEST_WALLET;
const mock = vi.hoisted(() => ({
  readContract: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(), getChainId: vi.fn(), getBalance: vi.fn(), estimateMaxPriorityFeePerGas: vi.fn(), simulateCalls: vi.fn(),
  prepare: vi.fn(), purchase: vi.fn(), convert: vi.fn(), tokenValue: vi.fn(), pairPrice: vi.fn(), referencePrice: vi.fn(), inspectStatus: vi.fn(),
}));
vi.mock("../lib/liquidity-markets", () => ({ liquidityRpc: () => mock, liquidityReferencePrice: (...args: unknown[]) => mock.referencePrice(...args) }));
vi.mock("../lib/wallet-signer/pricing", () => ({ ethUsdPrice: async () => 2000 }));
vi.mock("../lib/token-market-cap", () => ({ quoteDetails: (...args: unknown[]) => mock.pairPrice(...args) }));
vi.mock("../lib/wallet-signer/service", () => ({
  prepareSigned: (...args: unknown[]) => mock.prepare(...args), tokenValueAtBlock: (...args: unknown[]) => mock.tokenValue(...args),
  quoteLiquidityPurchase: (...args: unknown[]) => mock.purchase(...args), quoteLiquidityUsdgToEth: (...args: unknown[]) => mock.convert(...args),
}));
vi.mock("../lib/wallet-signer/liquidity-status", () => ({ inspectLiquidityPosition: (...args: unknown[]) => mock.inspectStatus(...args) }));
import { assessLiquidityFunding, liquidityPriceConsensus, liquidityPriceConsensusBySource, liquidityWithdrawalMinimum, prepareLiquidityStep, prepareLiquidityEnvelope, signLiquidityEnvelope, quoteLiquidity } from "../lib/wallet-signer/liquidity";
let heldToken: bigint, heldUsdg: bigint, eth: bigint;
describe("new-pool price consensus", () => {
  it("uses the median of agreeing independent prices", () => expect(liquidityPriceConsensus([1, 1.05, 1.1])).toBe(1.05));
  it("rejects a single source", () => expect(() => liquidityPriceConsensus([1, null])).toThrow("LP_NEW_POOL_PRICE_UNVERIFIED"));
  it("rejects materially disagreeing sources", () => expect(() => liquidityPriceConsensus([1, 1.25])).toThrow("LP_REFERENCE_PRICE_DISAGREEMENT"));
  it("does not count duplicate observations from one provenance as independent", () => expect(() => liquidityPriceConsensusBySource([
    { source: "pons_onchain", value: 1 }, { source: "pons_onchain", value: 1.01 },
  ])).toThrow("LP_NEW_POOL_PRICE_UNVERIFIED"));
});

describe("liquidity withdrawal protection", () => {
  it("requires at least 98% of each quoted withdrawal asset", () => {
    expect(liquidityWithdrawalMinimum(1_000_000n)).toBe(980_000n);
  });
});
describe("public authenticated signer access", () => {
  const bot = { ownerXUserId: LIQUIDITY_TERMINAL_TEST_OWNER, walletRef: LIQUIDITY_TERMINAL_TEST_WALLET, expectedFrom: LIQUIDITY_TERMINAL_TEST_WALLET };
  it("quotes and prepares for an authenticated wallet through terminal or X provenance", async () => {
    const plan = await quoteLiquidity({ ...request(), ...bot, source: "terminal" });
    expect(plan.owner).toBe(LIQUIDITY_TERMINAL_TEST_WALLET);
    const prepare = { ownerXUserId: bot.ownerXUserId, walletRef: bot.walletRef, plan, step: 0, idempotencyKey: "terminal-bot-test" };
    mock.prepare.mockClear();
    await prepareLiquidityStep({ ...prepare, source: "terminal" });
    await prepareLiquidityStep({ ...prepare, source: "x" });
    await prepareLiquidityStep(prepare);
    expect(mock.prepare).toHaveBeenCalledTimes(3);
    expect(mock.prepare.mock.calls[0][0]).toMatchObject({ ownerReference: `x:${bot.ownerXUserId}`, expectedFrom: bot.expectedFrom });
  });
  it.each([undefined, "x"])("quotes for every authenticated user with source %s", async source => {
    const plan = await quoteLiquidity({ ...request(), ownerXUserId: "2086128304545783808", walletRef: owner, expectedFrom: owner, source });
    expect(plan.owner).toBe(owner);
  });
  it("rejects mismatched wallet fields and nonnumeric owner identities", async () => {
    await expect(quoteLiquidity({ ...request(), ...bot, source: "terminal", walletRef: owner })).rejects.toThrow("Wallet mismatch");
    await expect(quoteLiquidity({ ...request(), ...bot, source: "terminal", ownerXUserId: "unrelated" })).rejects.toThrow();
  });
});
function request(pair: "ETH" | "USDG" = "ETH") {
  const draft = newLiquidityDraft("open", { token: "PONSBOT", amount: "100", unit: "usd", pair, version: 4, feePips: 3000, tickSpacing: 60, downPercent: 25, upPercent: 25, shape: "bell", bands: 3 });
  draft.tokenAddress = token; draft.symbol = "PONSBOT"; draft.custom = true; draft.phase = "review";
  return { ownerXUserId: LIQUIDITY_TEST_OWNER, expectedFrom: owner, walletRef: owner, draft, legs: [] };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("WALLET_SIGNER_TOKEN", "offline-test-only-signature-secret");
  vi.stubEnv("LIQUIDITY_QUOTE_SIGNING_SECRET", "separate-offline-quote-signing-secret-at-least32");
  heldToken = 0n; heldUsdg = 0n; eth = parseEther("1");
  mock.getBlock.mockResolvedValue({ number: 100n, timestamp: BigInt(Math.floor(Date.now() / 1000)), baseFeePerGas: 1_000_000_000n });
  mock.getBlockNumber.mockResolvedValue(100n);
  mock.getChainId.mockResolvedValue(4663); mock.getBalance.mockImplementation(async () => eth);
  mock.estimateMaxPriorityFeePerGas.mockResolvedValue(0n);
  mock.readContract.mockImplementation(async ({ address, functionName }: { address: string; functionName: string }) => {
    if (functionName === "decimals") return address === A.usdg ? 6 : 18;
    if (functionName === "totalSupply") return 1_000_000_000n * 10n ** 18n;
    if (functionName === "balanceOf") return address === A.usdg ? heldUsdg : heldToken;
    if (functionName === "allowance") return 0n;
    if (functionName === "getSlot0") return [0n, 0, 0, 3000]; // Initializes quoted test pools.
    if (functionName === "getPool") return "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca";
    if (functionName === "slot0") return [liquiditySqrtTick(Math.floor(Math.log(2000 / 1e12) / Math.log(1.0001))), 0, 0, 0, 0, 0, true];
    if (functionName === "liquidity") return 10n ** 20n;
    if (functionName === "feeBps") return 100;
    throw new Error(`Unexpected read ${functionName}`);
  });
  mock.tokenValue.mockResolvedValue({ usdValue: .001 });
  mock.pairPrice.mockResolvedValue({ usd: .001 });
  mock.referencePrice.mockResolvedValue(.001);
  mock.purchase.mockImplementation(async (_owner: Address, asset: Address, minimum: bigint) => {
    const value = asset === A.usdg ? minimum * 10n ** 12n / 2000n + 1n : minimum / 2_000_000n + 1n;
    return { nativeInput: value, calls: [{ to: A.manager, data: "0xb0", value: value.toString(), purpose: "funding_buy" }] };
  });
  mock.simulateCalls.mockImplementation(async ({ calls }: { calls: unknown[] }) => ({ results: calls.map(() => ({ status: "success", gasUsed: 100_000n })) }));
  mock.inspectStatus.mockRejectedValue(new Error("advisory unavailable"));
});
describe("liquidity signer funding integration (mocked RPC, no wallet calls)", () => {
  it("uses combined ETH, USDG and held position-token value for the conservative budget gate", () => {
    expect(assessLiquidityFunding({ requiredUsd: 100, ethUsd: 20, usdgUsd: 30, positionAssetUsd: 49.99 }).sufficient).toBe(false);
    expect(assessLiquidityFunding({ requiredUsd: 100, ethUsd: 20, usdgUsd: 30, positionAssetUsd: 50 }).sufficient).toBe(true);
    expect(assessLiquidityFunding({ requiredUsd: 100, ethUsd: 0, usdgUsd: 0, positionAssetUsd: 0, pair: "USDG" })).toMatchObject({ sufficient: false, missing: "USDG" });
  });
  it("fails open when a held position token cannot be priced during the advisory check", () => {
    expect(assessLiquidityFunding({ requiredUsd: 100, ethUsd: 0, usdgUsd: 0, positionAssetUsd: undefined })).toMatchObject({ sufficient: true });
  });
  it.each(["flat", "bell", "bid_ask"] as const)("quotes 20 %s bands through the signer and validates the signed plan offline", async shape => {
    const input = request(); input.draft.fields.shape = shape; input.draft.fields.bands = 20;
    const plan = await quoteLiquidity(input);
    const decoded = decodeFunctionData({ abi: deltaLiquidityAbi, data: plan.calls.at(-1)!.data });
    expect(decoded.functionName).toBe("openV4"); expect(decoded.args[1]).toHaveLength(20);
    expect(validateLiquidityQuote(plan, { owner, draft: input.draft, legs: [] })).toBe(plan);
    expect(plan.summary.join(" ")).not.toContain("Delta collects"); expect(plan.summary.join(" ")).not.toContain("gas is additional");
    expect(plan.summary.join(" ")).not.toContain("Estimated gas reserve"); expect(mock.prepare).not.toHaveBeenCalled();
  });
  it.each(["ETH", "USDG"] as const)("binds dollar MCap bounds for a %s pair to signed calldata and refreshes without shifting them", async pair => {
    const input = request(pair);
    delete input.draft.fields.downPercent; delete input.draft.fields.upPercent;
    input.draft.fields.lowerMarketCapUsd = 750000; input.draft.fields.upperMarketCapUsd = 1250000;
    const plan = await quoteLiquidity(input);
    expect(plan.marketCapRange).toMatchObject({ lowerUsd: 750000, upperUsd: 1250000 });
    expect(plan.summary.join(" ")).toContain("Tick-rounded range:");
    expect(mock.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "totalSupply", blockNumber: 100n }));
    expect(validateLiquidityQuote(plan, { owner, draft: input.draft, legs: [] })).toBe(plan);
    expect(() => validateLiquidityQuote({ ...plan, marketCapRange: undefined }, { owner, draft: input.draft, legs: [] })).toThrow("LP_SIGNER_QUOTE_INVALID");
    expect(() => validateLiquidityQuote({ ...plan, marketCapRange: { ...plan.marketCapRange!, tickLower: plan.marketCapRange!.tickLower - 60 } }, { owner, draft: input.draft, legs: [] })).toThrow("LP_SIGNER_QUOTE_INVALID");
    // Real proof check, mocked preparation only. No CDP request is made.
    await prepareLiquidityStep({ ownerXUserId: LIQUIDITY_TEST_OWNER, walletRef: owner, plan, step: 0, idempotencyKey: "offline-mcap-proof" });
    expect(mock.prepare).toHaveBeenCalledTimes(1);
    await expect(prepareLiquidityStep({ ownerXUserId: LIQUIDITY_TEST_OWNER, walletRef: owner, plan: { ...plan, marketCapRange: { ...plan.marketCapRange!, lowerUsd: 800000 } }, step: 0, idempotencyKey: "offline-mcap-tamper" })).rejects.toThrow("Invalid liquidity quote");
  });
  function management() {
    const input = request(), original = mock.readContract.getMockImplementation()!;
    const legs = [{ tokenId: "123", tickLower: -600, tickUpper: 600, liquidity: "1000" }];
    mock.readContract.mockImplementation(async (arg: { functionName: string; args?: bigint[]; address?: string }) => {
      if (arg.functionName === "getSlot0" || arg.functionName === "slot0") return [liquiditySqrtTick(0), 0, 0, 3000];
      if (arg.functionName === "ownerOfV4" || arg.functionName === "ownerOfV3") return owner;
      if (arg.functionName === "ownerOf") return A.manager;
      if (arg.functionName === "getPositionLiquidity") return 1000n;
      if (arg.functionName === "feeAmountTickSpacing") return 60;
      if (arg.functionName === "positions") { const key = liquidityPoolKey(token, "ETH", 3, 3000, 60); return [0n, owner, key.currency0, key.currency1, 3000, -600, 600, 1000n]; }
      if (arg.functionName === "getPoolAndPositionInfo") return [liquidityPoolKey(token, "ETH", 4, 3000, 60), (BigInt.asUintN(24, -600n) << 8n) | (600n << 32n)];
      return original(arg);
    });
    input.draft.operation = "claim"; input.draft.fields.position = "LP-1234ABCD";
    return { ...input, legs };
  }
  it.each([3, 4] as const)("collects fees before full V%s withdrawal and simulates both calls together", async version => {
    const input = management(); input.draft.operation = "withdraw"; input.draft.fields.version = version; input.draft.fields.withdrawPercent = 100;
    const plan = await quoteLiquidity(input);
    expect(plan.calls.map(c => decodeFunctionData({ abi: deltaLiquidityAbi, data: c.data }).functionName)).toEqual([`collectV${version}Batch`, `closeV${version}Batch`]);
    expect(mock.simulateCalls.mock.calls.at(-1)![0].calls).toHaveLength(2);
    expect(validateLiquidityQuote(plan, { owner, draft: input.draft, legs: input.legs, poolId: plan.poolId })).toBe(plan);
    expect(mock.prepare).not.toHaveBeenCalled();
  });
  it("quotes mixed V3/V4 collections, signs the exact group list, and checks cumulative gas", async () => {
    const input = management(); input.draft.fields.allPositions = true; delete input.draft.fields.position;
    const groups = [3, 4].map((version, i) => liquidityClaimPositionSchema.parse({ positionId: `LP-1234ABC${i}`, token, symbol: "PONSBOT", version,
      poolId: version === 4 ? liquidityPoolId(liquidityPoolKey(token, "ETH", 4, 3000, 60)) : "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca", fields: { ...input.draft.fields, version }, legs: input.legs }));
    const plan = await quoteLiquidity({ ...input, claimPositions: groups });
    expect(plan.calls.map(c => decodeFunctionData({ abi: deltaLiquidityAbi, data: c.data }).functionName)).toEqual(["collectV3Batch", "collectV4Batch"]);
    expect(validateLiquidityQuote(plan, { owner, draft: input.draft, legs: [], claimPositions: groups })).toBe(plan);
    // Convex reorders nested object keys on the query/action boundary. That
    // changes neither the selected NFTs nor the original HMAC-signed plan.
    const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, reorder(value[key])])) : value;
    const convexGroups = reorder(groups);
    expect(JSON.stringify(convexGroups)).not.toBe(JSON.stringify(groups));
    expect(validateLiquidityQuote(plan, { owner, draft: input.draft, legs: [], claimPositions: convexGroups })).toBe(plan);
    expect(() => validateLiquidityQuote(plan, { owner, draft: input.draft, legs: [], claimPositions: [...convexGroups].reverse() })).toThrow("LP_SIGNER_QUOTE_INVALID");
    // Exercises real HMAC verification and live-owner preflight with mocked RPC.
    await prepareLiquidityStep({ ownerXUserId: LIQUIDITY_TEST_OWNER, walletRef: owner, plan, step: 1, idempotencyKey: "offline-batch-step" });
    expect(mock.prepare).toHaveBeenCalledTimes(1);
    await expect(prepareLiquidityStep({ ownerXUserId: LIQUIDITY_TEST_OWNER, walletRef: owner, plan: { ...plan, claimPositions: [...groups].reverse() }, step: 1, idempotencyKey: "offline-tampered-step" })).rejects.toThrow("Invalid liquidity quote");
    // One call is affordable but both together are not. Never rely on the
    // first claim paying for the second, or submit an underfunded batch.
    eth = parseEther("0.00015");
    await expect(quoteLiquidity({ ...input, claimPositions: groups })).rejects.toThrow("LP_INSUFFICIENT_GAS");
  });
  it("drops zero-fee positions from a mixed batch without producing empty signed summary rows", async () => {
    const input = management(); input.draft.fields.allPositions = true; delete input.draft.fields.position;
    const groups = Array.from({ length: 5 }, (_, i) => liquidityClaimPositionSchema.parse({ positionId: `LP-1234ABC${i}`, token, symbol: "PONSBOT", version: 4,
      poolId: liquidityPoolId(liquidityPoolKey(token, "ETH", 4, 3000, 60)), fields: input.draft.fields,
      legs: [{ ...input.legs[0], tokenId: String(123 + i) }] }));
    mock.inspectStatus.mockImplementation(async (raw: { legs: Array<{ tokenId: string }> }) => ({ assets: [{ unclaimed: raw.legs[0].tokenId === "123" ? "1" : "0" }] }));
    const plan = await quoteLiquidity({ ...input, claimPositions: groups });
    expect(plan.claimPositions?.map(position => position.positionId)).toEqual(["LP-1234ABC0"]);
    expect(plan.summary.every(Boolean)).toBe(true);
    expect(plan.calls).toHaveLength(1);
  });
  it.each([3, 4] as const)("omits the no-op fee collection from a zero-fee V%s withdrawal", async version => {
    const input = management(); input.draft.operation = "withdraw"; input.draft.fields.version = version; input.draft.fields.withdrawPercent = 100;
    mock.inspectStatus.mockResolvedValue({ assets: [{ unclaimed: "0" }, { unclaimed: "0" }] });
    const plan = await quoteLiquidity(input);
    expect(plan.calls.map(call => call.purpose)).toEqual(["withdraw"]);
    expect(validateLiquidityQuote(plan, { owner, draft: input.draft, legs: input.legs, poolId: plan.poolId })).toBe(plan);
  });
  it("rejects duplicate NFT collection across position groups", async () => {
    const input = management();
    const group = liquidityClaimPositionSchema.parse({ positionId: "LP-1234ABCD", token, symbol: "PONSBOT", version: 4,
      poolId: liquidityPoolId(liquidityPoolKey(token, "ETH", 4, 3000, 60)), fields: input.draft.fields, legs: input.legs });
    await expect(quoteLiquidity({ ...input, claimPositions: [group, { ...group, positionId: "LP-1234ABCE" }] })).rejects.toThrow("LP_DUPLICATE_CLAIM_LEG");
  });
  it("rejects adds rather than silently minting new matching NFTs", async () => {
    const input = request(); input.draft.operation = "add";
    const originalTick = Math.floor(Math.log(2_000_000) / Math.log(1.0001)), currentTick = originalTick + 300;
    const bands = liquidityBands({ tick: originalTick, spacing: 60, down: 25, up: 25, count: 3, shape: "bell", tokenIs0: false });
    const legs = bands.map((b, i) => ({ tokenId: String(i + 1), tickLower: b.tickLower, tickUpper: b.tickUpper, liquidity: "1000" }));
    const original = mock.readContract.getMockImplementation()!;
    mock.readContract.mockImplementation(async (arg: { functionName: string; args?: bigint[] }) => {
      if (arg.functionName === "getSlot0") return [liquiditySqrtTick(currentTick), currentTick, 0, 3000];
      if (arg.functionName === "ownerOfV4") return owner;
      if (arg.functionName === "ownerOf") return A.manager;
      if (arg.functionName === "getPositionLiquidity") return 1000n;
      if (arg.functionName === "getPoolAndPositionInfo") { const l = legs[Number(arg.args![0]) - 1]; return [liquidityPoolKey(token, "ETH", 4, 3000, 60), (BigInt.asUintN(24, BigInt(l.tickLower)) << 8n) | (BigInt.asUintN(24, BigInt(l.tickUpper)) << 32n)]; }
      return original(arg);
    });
    await expect(quoteLiquidity({ ...input, legs })).rejects.toThrow("DELTA_NATIVE_ADD_UNVERIFIED");
    expect(mock.purchase).not.toHaveBeenCalled(); expect(mock.prepare).not.toHaveBeenCalled();
  });
  it("uses one execution deadline and reserves time after quote expiry", async () => {
    const plan = await quoteLiquidity(request());
    const decoded = decodeFunctionData({ abi: deltaLiquidityAbi, data: plan.calls.at(-1)!.data });
    expect(decoded.functionName).toBe("openV4"); expect(Number(decoded.args?.[2]) * 1000).toBe(plan.executionDeadline);
    expect(plan.executionDeadline - plan.expiresAt).toBe(600000);
    expect(mock.purchase.mock.calls[0][5]).toBe(BigInt(plan.executionDeadline / 1000));
    vi.spyOn(Date, "now").mockReturnValueOnce(plan.executionDeadline + 1);
    await expect(prepareLiquidityStep({ ownerXUserId: LIQUIDITY_TEST_OWNER, walletRef: owner, plan, step: 1, idempotencyKey: "expired-step-key" })).rejects.toThrow("LIQUIDITY_QUOTE_EXPIRED");
    expect(mock.prepare).not.toHaveBeenCalled(); vi.restoreAllMocks();
  });
  it("refuses the shared bearer token as quote signing key", async () => {
    vi.stubEnv("LIQUIDITY_QUOTE_SIGNING_SECRET", process.env.WALLET_SIGNER_TOKEN!);
    await expect(quoteLiquidity(request())).rejects.toThrow("LP_QUOTE_SIGNING_NOT_CONFIGURED");
  });
  it("quotes purchase, approval and native LP deposit in that order, without signing", async () => {
    const plan = await quoteLiquidity(request());
    expect(plan.calls[0].purpose).toBe("funding_buy");
    expect(plan.calls.at(-1)?.purpose).toBe("open");
    expect(plan.calls.some(c => c.purpose === "approval")).toBe(true);
    expect(plan.calls.at(-1)?.value).not.toBe("0");
    expect(plan.summary.join("\n")).toContain("Buy missing");
    expect(plan.summary.join("\n")).toContain("never sold");
    expect(plan.summary.join("\n")).toMatch(/Maximum PONSBOT: [\d.]+ \(\$[\d.]+\)\./);
    expect(plan.summary.join("\n")).toMatch(/Maximum ETH: [\d.]+ \(\$[\d.]+\)\./);
    expect(mock.prepare).not.toHaveBeenCalled();
  });
  it("buys missing USDG and target token for USDG positions, without a native LP deposit", async () => {
    const plan = await quoteLiquidity(request("USDG"));
    expect(plan.summary.join("\n")).toMatch(/Maximum USDG: \$[\d.]+\./);
    expect(plan.summary.join("\n")).not.toMatch(/Maximum USDG: [\d.]+ \(\$/);
    expect(mock.purchase.mock.calls.map(call => call[1]).sort()).toEqual([A.usdg, token].sort());
    expect(plan.calls.at(-1)?.value).toBe("0");
    expect(mock.tokenValue.mock.calls.some(call => call[0] === A.usdg)).toBe(false);
    for (const call of plan.calls.filter(c => c.purpose === "approval")) {
      const approval = decodeFunctionData({ abi: erc20Abi, data: call.data });
      expect(approval.functionName).toBe("approve");
      expect(String(approval.args?.[0]).toLowerCase()).toBe(A.manager);
    }
  });
  it("uses held target tokens without buying or selling them", async () => {
    heldToken = parseEther("1000000");
    const plan = await quoteLiquidity(request());
    expect(mock.purchase).not.toHaveBeenCalled(); expect(mock.convert).not.toHaveBeenCalled();
    expect(plan.calls.some(c => c.purpose.startsWith("funding_"))).toBe(false);
  });
  it("rejects insufficient ETH with plentiful target tokens instead of selling any", async () => {
    heldToken = parseEther("1000000"); eth = 1n;
    await expect(quoteLiquidity(request())).rejects.toThrow("LP_INSUFFICIENT_FUNDING");
    expect(mock.convert).not.toHaveBeenCalled(); expect(mock.prepare).not.toHaveBeenCalled();
  });
  it("rejects a sequential funding/deposit simulation that reverted", async () => {
    mock.simulateCalls.mockImplementation(async ({ calls }: { calls: unknown[] }) => ({ results: calls.map((_, i) => i === 0 ? { status: "failure", gasUsed: 1n, error: new Error("price moved") } : { status: "success", gasUsed: 100_000n }) }));
    await expect(quoteLiquidity(request())).rejects.toThrow("LP_SIMULATION_FAILED:funding_buy");
    expect(mock.prepare).not.toHaveBeenCalled();
  });
  it("binds funding calldata to the approved quote and owner", async () => {
    const plan = await quoteLiquidity(request());
    plan.calls[0].value = parseEther("10").toString();
    await expect(prepareLiquidityStep({ ownerXUserId: LIQUIDITY_TEST_OWNER, walletRef: owner, plan, step: 0, idempotencyKey: "test-funding-key" })).rejects.toThrow("Invalid liquidity quote");
    expect(mock.prepare).not.toHaveBeenCalled();
  });
  it("does not grant an ERC-20 approval to a zero recipient", async () => {
    const plan = await quoteLiquidity(request("USDG"));
    expect(plan.calls.every(call => call.to !== zeroAddress)).toBe(true);
  });
});
