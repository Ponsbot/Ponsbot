import { describe, expect, it } from "vitest";
import { isTokenIndexExcluded } from "../lib/token-index-exclusions";
import { removePrivateTestIndexes } from "../convex/registry";

const token = "0xe5d0aac01c27dcc95e8a787efd1b767b4945bb07";
const publicTest = "0x19f496cdf0989378b0a2e4aa98f709d0e8760b07";
const duplicatePdog = "0xdf1f5f5afce9ced806f753783d7103301708eb07";
function fixture() {
  const rows: Record<string, any[]> = {
    automatedFeePrograms: [{ _id: "program", normalizedTokenAddress: token, privateTest: true, status: "exited" }],
    walletTokenIndex: [{ _id: "private-index", normalizedTokenAddress: token }, { _id: "public-index", normalizedTokenAddress: publicTest }],
    walletHoldingSnapshots: [{ _id: "snapshot", tokenAddress: token.toUpperCase() }],
    tokenRegistry: [{ _id: "registry", normalizedAddress: token }],
  };
  const deleted: string[] = [];
  const ctx = { db: {
    query: (table: string) => {
      let filter = (_row: any) => true;
      const result: any = {
        withIndex: (_name: string, callback: any) => { callback({ eq: (key: string, value: string) => { filter = row => row[key] === value; } }); return result; },
        collect: async () => (rows[table] ?? []).filter(filter),
        unique: async () => (rows[table] ?? []).find(filter) ?? null,
      };
      return result;
    },
    delete: async (id: string) => { deleted.push(id); },
  } };
  return { ctx, rows, deleted };
}
describe("private TEST index removal", () => {
  it("excludes every address casing without excluding other TEST tokens", () => {
    expect(isTokenIndexExcluded(token.toUpperCase())).toBe(true);
    expect(isTokenIndexExcluded(duplicatePdog.toUpperCase())).toBe(true);
    expect(isTokenIndexExcluded(publicTest)).toBe(false);
  });
  it("previews before deleting and preserves private program/audit history", async () => {
    const { ctx, deleted } = fixture();
    const run = (removePrivateTestIndexes as any)._handler;
    const preview = await run(ctx, { tokenAddress: token });
    expect(preview.counts).toMatchObject({ wallets: 1, registry: 1, snapshots: 1 });
    expect(deleted).toEqual([]);
    await run(ctx, { tokenAddress: token, dryRun: false });
    expect(deleted.sort()).toEqual(["private-index", "registry", "snapshot"]);
  });
  it("refuses tokens outside the exclusion list and public/non-test programs", async () => {
    const { ctx, rows } = fixture(); const run = (removePrivateTestIndexes as any)._handler;
    await expect(run(ctx, { tokenAddress: publicTest, dryRun: false })).rejects.toThrow("explicitly excluded");
    rows.automatedFeePrograms[0].privateTest = false;
    await expect(run(ctx, { tokenAddress: token, dryRun: false })).rejects.toThrow("private test");
    rows.automatedFeePrograms[0].privateTest = true;
    rows.tokenLaunches = [{ _id: "launch", normalizedTokenAddress: token, publicPublished: true }];
    await expect(run(ctx, { tokenAddress: token, dryRun: false })).rejects.toThrow("public launch");
  });
});
