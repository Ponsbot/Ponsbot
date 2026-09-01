import { describe, expect, it } from "vitest";
import { emptyLegacyClaimMessage, EMPTY_CLAIM_MESSAGES } from "../convex/automatedFeeClaimInfo";
import { xWeightedLength } from "../convex/xText";
import { replyQueuePriority } from "../lib/x-reply-queue-policy";
const token = `0x${"ab".repeat(20)}`, vault = `0x${"cd".repeat(20)}`, wallet = `0x${"ef".repeat(20)}`;
function fixture(programPatch: Record<string, unknown> = {}, launchPatch: Record<string, unknown> = {}) {
  const records: Record<string, any> = { wallet: { address: wallet, ownerXUserId: "123" }, launch: { tokenAddress: token, normalizedTokenAddress: token, ownerXUserId: "123", publicPublished: true, creatorFeeRecipient: vault, symbol: "DAMPER", ...launchPatch } };
  const programs = [{ status: "enrolled", distributionMode: "wallet", launchId: "launch", normalizedTokenAddress: token, normalizedVaultAddress: vault, normalizedControllerAddress: wallet, ...programPatch }];
  const ctx: any = { db: {
    get: async (id: string) => records[id] ?? null,
    query: (table: string) => {
      let selected = table === "automatedFeePrograms" ? programs : Object.entries(records).filter(([id]) => id !== "wallet").map(([, r]) => r);
      const index: any = { eq: (k: string, v: unknown) => { selected = selected.filter(p => (p as any)[k] === v); return index; } };
      const q: any = { withIndex: (_: string, fn: any) => { fn(index); return q; }, collect: async () => selected };
      return q;
    },
  } };
  const addLegacy = (patch: Record<string, unknown> = {}) => records.legacy = {
    tokenAddress: legacyToken, normalizedTokenAddress: legacyToken, ownerXUserId: "123", publicPublished: true,
    creatorFeeRecipient: wallet, normalizedCreatorFeeRecipient: wallet, symbol: "OLDER", ...patch,
  };
  return { ctx, records, programs, addLegacy };
}
const legacyToken = `0x${"12".repeat(20)}`;
const guidance = (ctx: any, tokenAddress?: string) => (emptyLegacyClaimMessage as any)._handler(ctx, { walletId: "wallet", ...(tokenAddress ? { tokenAddress } : {}) });
const message = async (ctx: any, tokenAddress: string | undefined = token) => (await guidance(ctx, tokenAddress))?.message ?? null;
describe("empty legacy claim guidance for automated V2 fees", () => {
  it("explains a specific V2 token using its ticker, including case-varied addresses", async () => {
    const result = await message(fixture().ctx, token.toUpperCase());
    expect(result).toContain("$DAMPER"); expect(result).toContain("automated"); expect(result).toContain("5%");
    expect(result).not.toContain(token); expect(result).not.toContain(vault); expect(xWeightedLength(`@123456789012345 ${result}`)).toBeLessThanOrEqual(280);
  });
  it("supports claim-all without confusing a different user's launches", async () => {
    const { ctx } = fixture();
    expect(await message(ctx, "")).toBe(EMPTY_CLAIM_MESSAGES.v2);
    expect(await message(fixture({ normalizedControllerAddress: vault }).ctx, "")).toBeNull();
  });
  it.each(["prepared", "exited", "manual_review"])("preserves normal claim errors for %s programs", async status => expect(await message(fixture({ status }).ctx)).toBeNull());
  it("does not claim a paused vault is actively paying out", async () => expect(await message(fixture({ status: "paused" }).ctx)).toContain("currently paused"));
  it.each([
    [{ distributionMode: "holders" }, {}], [{ privateTest: true }, {}], [{}, { publicPublished: false }],
    [{}, { holderFeeSharing: true }], [{}, { tokenAddress: vault }],
  ])("requires current matching public vault assignment", async (p, l) => expect(await message(fixture(p, l).ctx)).toBeNull());
  it("never substitutes an unrelated automated launch for a specified legacy token", async () => expect(await message(fixture().ctx, vault)).toBeNull());
  it("gives V2-only accounts a no-manual-claim message without mentioning legacy tokens", async () => {
    expect(await guidance(fixture().ctx)).toEqual({ kind: "v2", message: EMPTY_CLAIM_MESSAGES.v2 });
    expect(EMPTY_CLAIM_MESSAGES.v2).not.toMatch(/legacy/i);
  });
  it("gives legacy-only accounts a manual claim message scoped to ETH", async () => {
    const f = fixture(); f.programs.length = 0; delete f.records.launch; f.addLegacy();
    expect(await guidance(f.ctx)).toEqual({ kind: "legacy", message: EMPTY_CLAIM_MESSAGES.legacy });
    expect(EMPTY_CLAIM_MESSAGES.legacy).not.toMatch(/automated|V2/);
  });
  it("explains both systems for mixed accounts", async () => {
    const f = fixture(); f.addLegacy();
    expect(await guidance(f.ctx)).toEqual({ kind: "mixed", message: EMPTY_CLAIM_MESSAGES.mixed });
  });
  it("does not substitute account-wide guidance for a specific legacy token", async () => {
    const f = fixture(); f.addLegacy();
    const result = await guidance(f.ctx, legacyToken);
    expect(result.kind).toBe("legacy");
    expect(result.message).toContain("$OLDER uses manual creator-fee claims");
    expect(result.message).toContain("paired asset");
    expect(result.message).not.toContain("automated");
  });
  it("treats an exited vault returned to the wallet as legacy, not V2", async () => {
    const f = fixture({ status: "exited" }, { creatorFeeRecipient: wallet });
    expect((await guidance(f.ctx)).kind).toBe("legacy");
  });
  it("counts legacy fee assignments received from another launcher", async () => {
    const f = fixture(); f.addLegacy({ ownerXUserId: "456" });
    expect((await guidance(f.ctx)).kind).toBe("mixed");
  });
  it("does not count historical launches whose fees went to someone else", async () => {
    const f = fixture(); f.addLegacy({ creatorFeeRecipient: vault, normalizedCreatorFeeRecipient: vault });
    expect((await guidance(f.ctx)).kind).toBe("v2");
  });
  it.each([{ holderFeeSharing: true }, { publicPublished: false }])("does not count holder/private legacy launches: %j", async patch => {
    const f = fixture(); f.addLegacy(patch);
    expect((await guidance(f.ctx)).kind).toBe("v2");
  });
  it("warns of paused processing for account-wide and mixed claims", async () => {
    const f = fixture({ status: "paused" });
    expect(await guidance(f.ctx)).toEqual({ kind: "v2", message: EMPTY_CLAIM_MESSAGES.pausedV2 });
    f.addLegacy();
    expect((await guidance(f.ctx)).message).toContain("paused");
    expect(xWeightedLength(`@123456789012345 ${(await guidance(f.ctx)).message}`)).toBeLessThanOrEqual(280);
  });
  it("does not invent a fee category for a wallet with no launches", async () => {
    const f = fixture(); f.programs.length = 0; delete f.records.launch;
    expect(await guidance(f.ctx)).toBeNull();
  });
  it.each(Object.entries(EMPTY_CLAIM_MESSAGES))("fits %s guidance within X's limit including a max-length username", (_, text) => {
    expect(xWeightedLength(`@123456789012345 ${text}`)).toBeLessThanOrEqual(280);
    // Changing wording must not promote read-only notices above real transactions.
    expect(replyQueuePriority(text, "claim_fees", true)).toBe("C");
  });
});
