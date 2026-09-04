import { afterEach, describe, expect, it, vi } from "vitest";
import { retryTopFiveBroadcast } from "../convex/wallets";
import { confirmedTopFivePurchase, isTopFiveChild } from "../lib/top-five-recovery";
import { spendableEthRequestSchema } from "../lib/wallet-signer/policy";

const hash = `0x${"a".repeat(64)}`;
function fixture(step = "burn") {
  const requestId = `x:123:buy_top_five:top-five:1:${step}`;
  const request: any = { _id: "r", requestId, status: "prepared", transactionHash: hash };
  const transaction: any = { _id: "t", requestId, status: "prepared", transactionHash: hash, signedTransaction: "saved-envelope" };
  const ctx: any = { db: {
    query: (table: string) => ({ withIndex: () => ({ unique: async () => table === "walletRequests" ? request : transaction }) }),
    patch: async (id: string, patch: any) => Object.assign(id === "r" ? request : transaction, patch),
  }, scheduler: { runAfter: vi.fn() } };
  const run = () => (retryTopFiveBroadcast as any)._handler(ctx, { requestId, transactionHash: hash, diagnosticDetail: "RPC rejected the signed transaction parameters" });
  return { request, transaction, ctx, run };
}
afterEach(() => vi.useRealTimers());
describe("top-five durable broadcast retries", () => {
  it("accepts the expanded gas reserve but still bounds it", () => {
    const base = { chainId: 4663, walletRef: `0x${"1".repeat(40)}`, expectedAddress: `0x${"1".repeat(40)}`, ownerReference: "x:123", reservedGasUnits: 6_000_000 };
    expect(spendableEthRequestSchema.safeParse(base).success).toBe(true);
    expect(spendableEthRequestSchema.safeParse({ ...base, reservedGasUnits: 6_000_001 }).success).toBe(false);
  });
  it.each(["buy", "burn", "funding:pair-funding"])("retries %s with exactly the existing envelope", async step => {
    const f = fixture(step);
    expect(await f.run()).toBe(true);
    expect(f.request.topFiveBroadcastRetries).toBe(1);
    expect(f.transaction).toMatchObject({ status: "prepared", transactionHash: hash, signedTransaction: "saved-envelope" });
    expect(f.ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
    expect(await f.run()).toBe(true);
    expect(f.request.topFiveBroadcastRetries).toBe(1);
  });
  it("bounds retries and preserves nonce evidence when exhausted", async () => {
    vi.useFakeTimers();
    const f = fixture();
    for (let i = 0; i < 7; i++) { await f.run(); vi.advanceTimersByTime(120_001); }
    expect(f.request).toMatchObject({ status: "failed", diagnosticCode: "TOP_FIVE_BROADCAST_REVIEW" });
    expect(f.transaction.signedTransaction).toBe("saved-envelope");
    expect(f.transaction.status).toBe("prepared");
    expect(f.ctx.scheduler.runAfter).toHaveBeenCalledTimes(6);
  });
  it.each(["confirmed", "reverted", "invalid", "broadcast"])("never revives a %s transaction", async status => {
    const f = fixture(); f.transaction.status = status;
    expect(await f.run()).toBe(false);
    expect(f.ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("does not affect unrelated or old malformed requests", () => {
    expect(isTopFiveChild("x:123:burn")).toBe(false);
    expect(isTopFiveChild("x:123:buy_top_five:top-five:6:buy")).toBe(false);
  });
  it("restores original purchase output, skipping new paired-asset funding", () => {
    const request = { status: "confirmed", transactionHash: hash };
    const transaction = { status: "confirmed", transactionHash: hash, tradeOutputDisplay: "1234.567", blockNumber: "10" };
    expect(confirmedTopFivePurchase({ request, transaction })).toEqual({ transactionHash: hash, tradeOutputDisplay: "1234.567", blockNumber: "10" });
    expect(confirmedTopFivePurchase({ request, transaction: { ...transaction, status: "prepared" } })).toBeNull();
    expect(confirmedTopFivePurchase({ request: { ...request, transactionHash: "other" }, transaction })).toBeNull();
  });
});
