import { afterEach, describe, expect, it, vi } from "vitest";
import { explorerLiquidityNativePayout } from "../lib/liquidity-payouts";
const hash = `0x${"a".repeat(64)}`, owner = `0x${"1".repeat(40)}`, manager = `0x${"2".repeat(40)}`;
function row(index: number, value: string, success = true) { return { index, value, success, type: "call", from: { hash: manager }, to: { hash: owner }, transaction_hash: hash }; }
afterEach(() => vi.unstubAllGlobals());
describe("transaction-scoped liquidity payouts", () => {
  it("sums complete pages without including failed value transfers", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [row(1, "100"), row(2, "900", false)], next_page_params: { index: 2 } }))).mockResolvedValueOnce(new Response(JSON.stringify({ items: [row(3, "200")], next_page_params: null })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await explorerLiquidityNativePayout(hash, owner)).toBe(300n); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([{ items: [] }, { items: [row(1, "100"), row(1, "100")] }, { items: [{ ...row(1, "100"), transaction_hash: `0x${"b".repeat(64)}` }] }])("does not invent an amount from missing/duplicate/unrelated data", async ({ items }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ items, next_page_params: null }))));
    expect(await explorerLiquidityNativePayout(hash, owner)).toBeUndefined();
  });
});
