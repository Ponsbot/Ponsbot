import { describe, expect, it } from "vitest";
import { activityCacheOnly, activityDue, activityNextRefreshDelay, mergePageTrades, recentFromBlock, transferDeltas, type PageTrade } from "../lib/token-activity-policy";
import { normalizeGeckoTrades } from "../lib/token-activity-refresh";

const token = `0x${"1".repeat(40)}`, other = `0x${"2".repeat(40)}`, hash = `0x${"a".repeat(64)}`, now = Date.now();
const trade: PageTrade = { id: "one", transactionHash: hash, logIndex: 1, kind: "buy", walletAddress: other, tokenAmount: "1", timestamp: now, source: "rpc" };
describe("table refresh policy", () => {
  it("allows one explicitly opened tab to load after cutoff, but not automatic or hidden refreshes", () => {
    expect(activityCacheOnly(false, true, true)).toBe(false);
    expect(activityCacheOnly(false, false, true)).toBe(true);
    expect(activityCacheOnly(true, true, false)).toBe(true);
    expect(activityCacheOnly(true, false, true)).toBe(false);
  });
  it("refreshes at sixty seconds, excluding active jobs and backoff", () => {
    expect(activityDue(now - 60000, 0, 0, now)).toBe(true);
    expect(activityDue(now - 59999, 0, 0, now)).toBe(false);
    expect(activityDue(undefined, now + 1, 0, now)).toBe(false);
    expect(activityDue(undefined, 0, now + 1, now)).toBe(false);
  });
  it("does not turn a ten-second job into a two-minute refresh interval", () => {
    expect(activityNextRefreshDelay(now + 10000, now + 14000)).toBe(56250);
    expect(activityNextRefreshDelay(now - 70000, now)).toBe(60000);
  });
  it("adapts a five-minute tail to block timing and caps anomalies", () => {
    expect(recentFromBlock(50000n, 10000n, 49000n, 9900n)).toBe(46968n);
    expect(recentFromBlock(50000n, 10000n, 49000n, 9999n)).toBe(40000n);
    expect(recentFromBlock(10n, 100n, 0n, 99n)).toBe(0n);
  });
  it("retains two distinct swaps inside the same transaction", () => {
    expect(mergePageTrades([[trade, { ...trade, id: "two", logIndex: 2, tokenAmount: "3" }]], now)).toHaveLength(2);
  });
  it("enriches a unique matching RPC event with Gecko values", () => {
    const result = mergePageTrades([[trade], [{ ...trade, id: "gecko", logIndex: undefined, source: "gecko", usdAmount: 4, marketCapUsd: 100 }]], now);
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ logIndex: 1, usdAmount: 4, marketCapUsd: 100 });
  });
  it("never guesses which identical multi-swap event matches an aggregate provider row", () => {
    const result = mergePageTrades([[trade, { ...trade, id: "two", logIndex: 2 }], [{ ...trade, id: "g", logIndex: undefined, source: "gecko" }]], now);
    expect(result.filter(r => r.logIndex !== undefined)).toHaveLength(2);
  });
  it("does not lose a rich value to a sparse indexed replacement", () => {
    expect(mergePageTrades([[{ ...trade, usdAmount: 4 }], [{ ...trade, source: "index" }]], now)[0].usdAmount).toBe(4);
  });
  it("bounds rows to a day and a hundred events", () => {
    expect(mergePageTrades([[{ ...trade, timestamp: now - 86400001 }]], now)).toEqual([]);
    expect(mergePageTrades([Array.from({ length: 120 }, (_, i) => ({ ...trade, logIndex: i }))], now)).toHaveLength(100);
  });
  it("derives buy/sell relative to this token, not the pool's base token", () => {
    const result = normalizeGeckoTrades([{ id: "g", attributes: { tx_hash: hash, tx_from_address: other, kind: "buy", from_token_address: token, to_token_address: other, from_token_amount: "2", price_from_in_usd: "5", block_timestamp: new Date(now).toISOString() } }], token, 1000);
    expect(result[0]).toMatchObject({ kind: "sell", tokenAmount: "2", marketCapUsd: 5000 });
  });
  it("leaves valuation absent without metadata and rejects unrelated tokens", () => {
    const a = { tx_hash: hash, tx_from_address: other, from_token_address: token, to_token_address: other, from_token_amount: "2", block_timestamp: new Date(now).toISOString() };
    expect(normalizeGeckoTrades([{ attributes: a }], token)[0].marketCapUsd).toBeUndefined();
    expect(normalizeGeckoTrades([{ attributes: a }], `0x${"3".repeat(40)}`)).toEqual([]);
  });
  it("accounts for mint, transfer, self-transfer and burn without crediting zero address", () => {
    const zero = `0x${"0".repeat(40)}`;
    expect(transferDeltas([{ args: { from: zero, to: token, value: 10n } }, { args: { from: token, to: other, value: 3n } }, { args: { from: other, to: other, value: 2n } }, { args: { from: token, to: zero, value: 1n } }]))
      .toEqual([{ address: token, delta: "6" }, { address: other, delta: "3" }]);
  });
});
