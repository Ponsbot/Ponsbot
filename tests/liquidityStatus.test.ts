import { beforeEach, describe, expect, it, vi } from "vitest";
import { zeroAddress, toHex } from "viem";
import { DELTA_LIQUIDITY as A, newLiquidityDraft } from "../lib/liquidity-workflow";
import { LIQUIDITY_TEST_OWNER, LIQUIDITY_TEST_WALLET } from "./liquidityFixtures";
import { liquidityPoolKey } from "../lib/liquidity-contracts";
import { liquiditySqrtTick } from "../lib/liquidity-math";
import { liquidityAccruedFees, liquidityInsideGrowth, liquidityStatusMessage } from "../lib/liquidity-status";
const rpc = vi.hoisted(() => ({ readContract: vi.fn(), getBlockNumber: vi.fn() }));
const price = vi.hoisted(() => vi.fn());
vi.mock("../lib/liquidity-markets", () => ({ liquidityRpc: () => rpc }));
vi.mock("../lib/wallet-signer/pricing", () => ({ ethUsdPrice: price }));
vi.mock("../lib/wallet-signer/service", () => ({}));
vi.mock("../lib/token-market-cap", () => ({}));
import { inspectLiquidityPosition } from "../lib/wallet-signer/liquidity-status";
const token = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07", owner = LIQUIDITY_TEST_WALLET;
const Q128 = 1n << 128n, L = 10n ** 18n;
let version: 3 | 4, pair: "ETH" | "USDG", tick: number, currentTick: number;
function request() {
  const draft = newLiquidityDraft("status", { version, pair, feePips: 3000, tickSpacing: 60 }); draft.tokenAddress = token; draft.symbol = "PONSBOT";
  return { ownerXUserId: LIQUIDITY_TEST_OWNER, walletRef: owner, expectedFrom: owner, draft, legs: [{ tokenId: "123", liquidity: "1", tickLower: tick - 600, tickUpper: tick + 600 }] };
}
beforeEach(() => {
  vi.resetAllMocks(); version = 4; pair = "ETH"; tick = 145080; currentTick = tick;
  rpc.getBlockNumber.mockResolvedValue(100n); price.mockResolvedValue(2000);
  rpc.readContract.mockImplementation(async ({ address, functionName }: { address: string; functionName: string }) => {
    const key = liquidityPoolKey(token, pair, version, 3000, 60);
    if (functionName === "getPool") return "0x1111111111111111111111111111111111111111";
    if (functionName === "slot0" || functionName === "getSlot0") return [liquiditySqrtTick(currentTick), currentTick, 0, 3000, 0, 0, true];
    if (functionName === "symbol") return address === A.usdg ? "USDG" : address === A.weth ? "WETH" : "PONSBOT";
    if (functionName === "decimals") return address === A.usdg ? 6 : 18;
    if (functionName === "totalSupply") return 1_000_000_000n * 10n ** 18n;
    if (functionName === "ownerOf") return A.manager;
    if (functionName === "ownerOfV3" || functionName === "ownerOfV4") return owner;
    if (functionName === "getPositionLiquidity" || functionName === "liquidity") return L;
    if (functionName === "getPoolAndPositionInfo") return [key, (BigInt.asUintN(24, BigInt(tick - 600)) << 8n) | (BigInt.asUintN(24, BigInt(tick + 600)) << 32n)];
    if (functionName === "getPositionInfo") return [L, Q128, Q128];
    if (functionName === "getFeeGrowthInside") return [Q128 * 2n, Q128 * 3n];
    if (functionName === "feeGrowthGlobal0X128" || functionName === "feeGrowthGlobal1X128") return Q128 * 2n;
    if (functionName === "ticks") return [L, 0n, 0n, 0n, 0n, 0n, 0, true];
    if (functionName === "positions") return [0n, zeroAddress, key.currency0, key.currency1, key.fee, tick - 600, tick + 600, L, Q128, Q128, 10n, 20n];
    throw new Error(`Unexpected ${functionName}`);
  });
});
describe("position status, no transactions", () => {
  it("reads V4 amounts and growth at one block using NPM ownership and NFT salt", async () => {
    const status = await inspectLiquidityPosition(request());
    expect(status.assets.map(a => a.symbol)).toEqual(["ETH", "PONSBOT"]);
    expect(status.assets.every(a => a.usd! > 0)).toBe(true);
    expect(status.assets.map(a => a.unclaimed)).toEqual(["1", "2"]);
    expect(status.range.inRange).toBe(true); expect(status.range.lower).toBeLessThan(status.range.upper);
    expect(status.marketCapRangeUsd!.lower).toBeLessThan(status.marketCapRangeUsd!.upper);
    expect(liquidityStatusMessage("LP-12345678", "PONSBOT", status)).toContain("Range (MCap): $");
    const reads = rpc.readContract.mock.calls.map(([arg]) => arg);
    expect(reads.every(r => r.blockNumber === 100n)).toBe(true);
    expect(reads.find(r => r.functionName === "getPositionInfo").args.slice(1)).toEqual([A.v4Npm, tick - 600, tick + 600, toHex(123n, { size: 32 })]);
  });
  it("includes newly accrued V3 fees in addition to stored tokensOwed", async () => {
    version = 3; const status = await inspectLiquidityPosition(request());
    expect(status.assets[0].unclaimed).toBe("1.00000000000000001");
    expect(status.assets[1].unclaimed).toBe("1.00000000000000002");
  });
  it("handles a six-decimal USDG pair and signed negative tick ranges", async () => {
    pair = "USDG"; tick = -80040; currentTick = tick;
    const status = await inspectLiquidityPosition(request());
    expect(status.assets.map(a => a.symbol)).toEqual(["USDG", "PONSBOT"]);
    expect(status.assets[0].unclaimed).toBe("1000000000000");
    expect(status.range.unit).toBe("USDG"); expect(status.range.lower).toBeLessThan(status.range.upper);
  });
  it("warns outside the range and shows one-sided holdings", async () => {
    currentTick += 1200; const status = await inspectLiquidityPosition(request());
    expect(status.range.inRange).toBe(false); expect(status.assets[0].amount).toBe("0");
    expect(liquidityStatusMessage("LP-12345678", "PONSBOT", status)).toContain("Outside the funded range");
  });
  it("uses the exclusive upper tick boundary even when sqrt equals a boundary", async () => {
    currentTick += 600; expect((await inspectLiquidityPosition(request())).range.inRange).toBe(false);
  });
  it("pricing failures do not discard amounts or fees and are not shown as $0", async () => {
    price.mockRejectedValue(new Error("price unavailable")); const status = await inspectLiquidityPosition(request());
    expect(status.assets.every(a => a.usd === null)).toBe(true);
    expect(status.assets[0].unclaimed).toBe("1");
    expect(liquidityStatusMessage("LP-12345678", "PONSBOT", status)).toContain("value unavailable");
  });
  it("fee-read failures do not discard position inventory or report zero fees", async () => {
    const original = rpc.readContract.getMockImplementation()!;
    rpc.readContract.mockImplementation(arg => arg.functionName === "getFeeGrowthInside" ? Promise.reject(new Error("RPC")) : original(arg));
    const status = await inspectLiquidityPosition(request());
    expect(status.assets.every(a => a.usd! > 0 && a.unclaimed === null)).toBe(true);
  });
  it("rejects mismatched owner, pair, and custody", async () => {
    await expect(inspectLiquidityPosition({ ...request(), walletRef: zeroAddress })).rejects.toThrow("Wallet mismatch");
    const original = rpc.readContract.getMockImplementation()!;
    rpc.readContract.mockImplementation(arg => arg.functionName === "ownerOfV4" ? zeroAddress : original(arg));
    await expect(inspectLiquidityPosition(request())).rejects.toThrow("OWNER_MISMATCH");
  });
  it("does not display versions, band counts, totals or P/L", async () => {
    const message = liquidityStatusMessage("LP-12345678", "PONSBOT", await inspectLiquidityPosition(request()));
    expect(message).toContain("LP-12345678"); expect(message).toMatch(/ETH: [\d,.]+ ETH \(~\$/);
    expect(message).toContain("LP-12345678 • $PONSBOT\n\nETH:");
    expect(message).toMatch(/PONSBOT: [\d,.]+ PONSBOT \(~\$/);
    expect(message).toContain("Unclaimed fees"); expect(message).toContain("Range (MCap):");
    expect(message).not.toMatch(/V[34]|band|total|profit|loss|P\/L/i);
  });
  it("retains the position ID if live reads fail", () => {
    const message = liquidityStatusMessage("LP-12345678", "PONSBOT");
    expect(message).toContain("LP-12345678");
    expect(message).toContain("$PONSBOT\n\nAsset values:");
  });
});
describe("exact fee accounting", () => {
  it("handles uint256 wraparound and rounds down", () => {
    expect(liquidityAccruedFees(5n, 0n, (1n << 256n) - Q128, 3n)).toBe(8n);
    expect(liquidityAccruedFees(1n, Q128 - 1n, 0n)).toBe(0n);
  });
  it("computes growth below, inside and above a V3 range", () => {
    expect(liquidityInsideGrowth(100n, 30n, 10n, 0, -10, 10)).toBe(60n);
    expect(liquidityInsideGrowth(100n, 30n, 10n, -11, -10, 10)).toBe(20n);
    expect(liquidityInsideGrowth(100n, 10n, 30n, 10, -10, 10)).toBe(20n);
  });
});
