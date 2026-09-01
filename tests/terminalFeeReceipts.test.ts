import { describe, expect, it } from "vitest";
import { getAddress, zeroAddress } from "viem";
import { terminalFeeReceipts } from "../convex/lib/terminalFeeReceipts";
import { formatCreatorFeeAmount, mergeTerminalFeeReceipts, type TerminalFeeReceipt } from "../lib/terminal-fee-receipt";

const beneficiary = "0x1234567890abcdef1234567890abcdef12345678";
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
function fixture() {
  const rows: Record<string, any[]> = {
    cryptoWallets: [{ _id: "wallet", ownerXUserId: "owner", address: getAddress(beneficiary), chainId: 4663 }],
    automatedFeePrograms: [{ _id: "program", beneficiaryAddress: address(2), status: "enrolled" }],
    automatedFeeRuns: [],
    tokenLaunches: [{ _id: "launch", normalizedTokenAddress: address(11), symbol: "PONSBOT", publicPublished: true }],
    tokenRegistry: [],
  };
  const queries: string[] = [];
  const db: any = {
    get: async (id: string) => Object.values(rows).flat().find(r => r._id === id) ?? null,
    query: (table: string) => {
      queries.push(table);
      const filters: Array<(row: any) => boolean> = []; let order = "asc";
      const b: any = { eq: (key: string, value: unknown) => { filters.push(r => r[key] === value); return b; }, gte: (key: string, value: number) => { filters.push(r => r[key] >= value); return b; } };
      const results = () => (rows[table] || []).filter(r => filters.every(f => f(r))).sort((a, b) => (a.updatedAt - b.updatedAt) * (order === "asc" ? 1 : -1));
      const q: any = { withIndex: (_: string, builder: any) => { builder(b); return q; }, order: (value: string) => { order = value; return q; }, unique: async () => results()[0] ?? null, take: async (limit: number) => results().slice(0, limit) };
      return q;
    },
  };
  const run = (overrides: Record<string, unknown> = {}) => {
    const record = { _id: `run-${rows.automatedFeeRuns.length}`, programId: "program", tokenAddress: address(11), vaultAddress: address(20),
      beneficiaryAddress: beneficiary, controllerAddress: address(99), pairTokenAddress: zeroAddress, status: "confirmed",
      processingBlockNumber: "10", deliveryBlockNumber: "11", deliveryTransactionHash: hash(1), processingTransactionHash: hash(2),
      grossClaimed: "100000000000000000", beneficiaryAllocated: "95000000000000000", beneficiaryDelivered: "95000000000000000",
      createdAt: 1, updatedAt: 2000, ...overrides };
    rows.automatedFeeRuns.push(record); return record;
  };
  return { rows, queries, run, read: (after?: number, owner = "owner") => terminalFeeReceipts({ db } as any, owner, after) };
}

describe("terminal creator-fee receipt history", () => {
  it("shows actual net delivery and its delivery transaction, not gross fees or the buyback transaction", async () => {
    const f = fixture(); f.run();
    const result = await f.read();
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({ amount: "0.095", assetSymbol: "ETH", tokenSymbol: "PONSBOT", transactionHash: hash(1), createdAt: 2000, tokenPageAvailable: true });
    expect(result.receipts[0]).not.toHaveProperty("signedTransaction");
    expect(result.updatedThrough).toBe(2000);
  });
  it("uses the historical beneficiary, not the launcher, controller, or current assignee", async () => {
    const f = fixture(); f.run();
    f.rows.cryptoWallets.push({ _id: "other", ownerXUserId: "other-owner", address: address(2), chainId: 4663 });
    expect((await f.read()).receipts).toHaveLength(1);
    expect((await f.read(undefined, "other-owner")).receipts).toEqual([]);
  });
  it("finds both normalized and checksummed beneficiary records", async () => {
    const f = fixture(); f.run(); f.run({ beneficiaryAddress: getAddress(beneficiary), deliveryTransactionHash: hash(3), updatedAt: 3000 });
    expect((await f.read()).receipts).toHaveLength(2);
  });
  it("does not expose another wallet's receipts or query runs when no wallet is linked", async () => {
    const f = fixture(); f.run({ beneficiaryAddress: address(2) });
    expect((await f.read()).receipts).toEqual([]);
    f.queries.length = 0;
    expect((await f.read(undefined, "unknown")).receipts).toEqual([]);
    expect(f.queries).not.toContain("automatedFeeRuns");
  });
  it.each(["submitted", "deferred", "uncertain", "manual_review", "reverted"])("does not call a %s cycle a received payment", async status => {
    const f = fixture(); f.run({ status }); expect((await f.read()).receipts).toEqual([]);
  });
  it.each([
    { beneficiaryDelivered: "0", beneficiaryAllocated: "0" },
    { beneficiaryDelivered: "NaN" }, { beneficiaryDelivered: "-1" },
    { beneficiaryAllocated: "999" }, { deliveryBlockNumber: undefined },
    { processingBlockNumber: undefined }, { deliveryTransactionHash: undefined },
  ])("rejects incomplete or inconsistent delivery evidence: %j", async fields => {
    const f = fixture(); f.run(fields); expect((await f.read()).receipts).toEqual([]);
  });
  it("formats asset-paired payouts using registry decimals even if the asset is no longer active", async () => {
    const f = fixture(); f.rows.tokenRegistry.push({ normalizedAddress: address(5), symbol: "USDG", decimals: 6, active: false });
    f.run({ pairTokenAddress: address(5), beneficiaryDelivered: "1234567", beneficiaryAllocated: "1234567" });
    expect((await f.read()).receipts[0]).toMatchObject({ amount: "1.234567", assetSymbol: "USDG" });
  });
  it("never guesses decimals for an unknown paired asset", async () => {
    const f = fixture(); f.run({ pairTokenAddress: address(5) });
    const receipt = (await f.read()).receipts[0];
    expect(receipt.amount).toBeUndefined(); expect(formatCreatorFeeAmount(receipt)).toBe("95000000000000000 base units");
  });
  it("keeps private tests hidden, but preserves real receipts after a program exits", async () => {
    const f = fixture(); f.run(); f.rows.automatedFeePrograms[0].privateTest = true;
    expect((await f.read()).receipts).toEqual([]);
    f.rows.automatedFeePrograms[0].privateTest = false; f.rows.automatedFeePrograms[0].status = "exited";
    f.rows.tokenLaunches[0].publicPublished = false;
    expect((await f.read()).receipts[0].tokenPageAvailable).toBe(false);
  });
  it("deduplicates a delivery transaction recorded twice", async () => {
    const f = fixture(); f.run(); f.run(); expect((await f.read()).receipts).toHaveLength(1);
  });
  it("has an independent incremental cursor with an inclusive timestamp boundary", async () => {
    const f = fixture(); f.run({ updatedAt: 1000 }); f.run({ updatedAt: 2000, deliveryTransactionHash: hash(3) });
    const result = await f.read(2000); expect(result.delta).toBe(true); expect(result.receipts).toHaveLength(1);
    f.run({ updatedAt: 2000, deliveryTransactionHash: hash(4) });
    expect((await f.read(result.updatedThrough)).receipts).toHaveLength(2);
  });
  it("returns the newest 40 on entry and drains newer receipts chronologically", async () => {
    const f = fixture(); for (let i = 1; i <= 50; i++) f.run({ updatedAt: i, deliveryTransactionHash: hash(i) });
    const initial = await f.read(); expect(initial.receipts).toHaveLength(40); expect(initial.receipts[0].updatedAt).toBe(50);
    const first = await f.read(1); expect(first.updatedThrough).toBe(40);
    const second = await f.read(first.updatedThrough); expect(second.updatedThrough).toBe(50);
  });
});

describe("terminal receipt display and merging", () => {
  const receipt: TerminalFeeReceipt = { id: "receipt", tokenAddress: address(11), tokenSymbol: "PONSBOT", tokenPageAvailable: true, assetAddress: zeroAddress, assetSymbol: "ETH", amount: "0.0000000123456789", rawAmount: "12345678900", transactionHash: hash(1), createdAt: 2000, updatedAt: 2000 };
  it("does not round a small payout to zero", () => expect(formatCreatorFeeAmount(receipt)).toBe("0.0000000123457 ETH"));
  it("uses friendly compact formatting for large payouts", () => expect(formatCreatorFeeAmount({ ...receipt, amount: "12345678", assetSymbol: "MSFT" })).toBe("12.3457M MSFT"));
  it("does not duplicate rows on repeated incremental refreshes", () => expect(mergeTerminalFeeReceipts([receipt], [receipt])).toEqual([receipt]));
  it("does not replace a newer receipt with an older refresh", () => expect(mergeTerminalFeeReceipts([receipt], [{ ...receipt, updatedAt: 1000, amount: "1" }])).toEqual([receipt]));
});
