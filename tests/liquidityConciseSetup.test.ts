import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyLiquiditySpacingDefault, isLiquidityMessage, liquidityDraftSchema, liquidityFieldsSchema, liquidityNextPhase, liquidityStepFields, newLiquidityDraft, selectLiquidityPool, updateLiquidityFields, validateLiquidityReview, type LiquidityCandidate } from "../lib/liquidity-workflow";
import { LIQUIDITY_RESPONSES, liquidityResponseLines } from "../lib/liquidity-responses";
vi.mock("../convex/llm", () => ({ openRouter: vi.fn() }));
import { openRouter } from "../convex/llm";
import { extractLiquidityFields, liquidityEvidenceMatches } from "../convex/liquidityAi";

const token = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07";
const id = "LQ-1234ABCD";
function complete() {
  const d = newLiquidityDraft("open", { token: "PONSBOT", amount: "100", unit: "usd", pair: "ETH", version: 4, feePips: 3000, lowerMarketCapUsd: 50000, upperMarketCapUsd: 150000, shape: "bell" });
  d.custom = true; d.analyzed = true; d.tokenAddress = token; d.symbol = "PONSBOT"; d.phase = liquidityNextPhase(d); return d;
}
beforeEach(() => vi.clearAllMocks());
describe("concise liquidity setup", () => {
  it.each([
    ["token", "💧 What token would you like to create a liquidity position for? Provide a ticker or contract address."],
    ["budget", "💰 What is your position budget?\n\nExample: $100 or 0.1 ETH"],
    ["pair", "💧 Would you like to create an ETH or USDG pool?"],
  ] as const)("uses the requested %s question", (phase, expected) => {
    const d = complete(); d.phase = phase; expect(liquidityResponseLines(d, id).join("\n")).toBe(expected);
  });
  it.each(["token", "budget", "analysis", "pool", "pair", "version", "fee", "spacing", "range", "shape", "bands", "position", "percentage", "compound", "blocked"] as const)("omits quote IDs during %s", phase => {
    const d = complete(); d.phase = phase; expect(liquidityResponseLines(d, id).join("\n")).not.toContain("LQ-");
  });
  it("keeps final quote concise without modifying signed amounts or execution settings", () => {
    const d = complete(); d.executionPlanJson = "signed-unchanged"; d.fields.slippageBps = 100;
    d.quoteSummary = ["Maximum ETH: 0.006346067780123254 ($12.692135560246508).", "Maximum PONSBOT: 138322.050252610903192101 ($69.16102512630546).", "Maximum USDG: $6.464476.", "Estimated gas reserve: 0.0005 ETH.",
      "Current pool MCap: $100,000. Tick-rounded range: $49,999 to $150,001 MCap.", "Range ticks -600 to 600; 5 NFT band(s).",
      "MCap uses total supply, not circulating supply.", "Missing assets are bought as quoted.", "Slippage: 1%", "Pool: address", "Existing pool: 123", "Buy missing 22668.897035481936131232 PONSBOT: 0.006346067780123254 ETH maximum."];
    const before = structuredClone(d), text = liquidityResponseLines(d, id).join("\n");
    expect(text).toContain("Token: $PONSBOT (0xb1e9...2b07)"); expect(text).not.toContain(token);
    expect(text).toContain("MCap range: $50,000 to $150,000"); expect(text).toContain("Current MCap:");
    expect(text).not.toContain("Rounded range"); expect(text).not.toContain("Tick-rounded range");
    expect(text).not.toContain("confirm to proceed"); expect(text).not.toContain("Reply with changes");
    for (const hidden of ["Action:", "Missing assets", "Existing pool", "Pool:", "spacing", "Requested", "Slippage", "bands", "NFT band", "Suggested bands"]) expect(text).not.toContain(hidden);
    for (const shown of ["Maximum ETH: 0.0063461 ($12.69)", "Maximum PONSBOT: 138,320 ($69.16)", "Maximum USDG: $6.46", "Buy PONSBOT: 22,669 PONSBOT ($11.33), using up to 0.0063461 ETH ($12.69)."]) expect(text).toContain(shown);
    for (const hidden of ["138322.050252610903192101", "22668.897035481936131232", "0.006346067780123254"]) expect(text).not.toContain(hidden);
    expect(text).not.toContain("Estimated gas reserve");
    expect(d).toEqual(before); expect(d.fields.bands).toBe(5); expect(d.fields.slippageBps).toBe(100);
  });
  it("removes the boilerplate and invites the user to get started", () => {
    expect(LIQUIDITY_RESPONSES.help).toContain('Ask me to "create a $100 liquidity position for $PONSBOT" to get started.');
    for (const phrase of ["Earnings are not guaranteed.", "These are separate from token creator fees.", "Status lookups and questions never start transactions."]) expect(LIQUIDITY_RESPONSES.help).not.toContain(phrase);
  });
});
describe("automatic spacing", () => {
  it("never asks for spacing in a custom V4 setup", () => {
    let d = newLiquidityDraft("open", { token: "PONSBOT", amount: "100", unit: "usd" });
    d.analyzed = true; d.custom = true; d.tokenAddress = token; d.symbol = "PONSBOT";
    d = updateLiquidityFields(d, { pair: "ETH" }); expect(d.phase).toBe("version");
    d = updateLiquidityFields(d, { version: 4 }); expect(d.phase).toBe("fee");
    d = updateLiquidityFields(d, { feePips: 3000 }); expect(d.phase).toBe("range"); expect(d.fields.tickSpacing).toBe(60);
    d = updateLiquidityFields(d, { lowerMarketCapUsd: 50000, upperMarketCapUsd: 150000 }); expect(d.phase).toBe("shape");
    d = updateLiquidityFields(d, { shape: "bell" }); expect(d.phase).toBe("review"); validateLiquidityReview(d);
  });
  it.each([[100, 1], [500, 10], [3000, 60], [10000, 200]])("derives V3 fee %i spacing %i", (feePips, tickSpacing) => {
    expect(newLiquidityDraft("open", { version: 3, feePips }).fields.tickSpacing).toBe(tickSpacing);
    const d = updateLiquidityFields(complete(), { version: 3, feePips }); expect(d.fields.tickSpacing).toBe(tickSpacing); expect(d.phase).toBe("review");
  });
  it("retains explicit V4 spacing and actual selected-pool spacing", () => {
    expect(newLiquidityDraft("open", { version: 4, tickSpacing: 10 }).fields.tickSpacing).toBe(10);
    const d = complete(); d.phase = "pool";
    d.candidates = [{ id: token, version: 4, pair: "ETH", feePips: 3000, tickSpacing: 120 } as LiquidityCandidate];
    const selected = selectLiquidityPool(d, 1); expect(selected.fields.tickSpacing).toBe(120);
    expect(updateLiquidityFields(selected, { bands: 7 }).fields.tickSpacing).toBe(120);
  });
  it("advances saved spacing drafts and still rejects invalid ranges/bands", () => {
    const d = complete(); delete d.fields.tickSpacing; d.phase = "spacing";
    const restored = liquidityDraftSchema.parse(d); applyLiquiditySpacingDefault(restored);
    expect(liquidityNextPhase(restored)).toBe("review"); expect(restored.fields.tickSpacing).toBe(60);
    expect(() => validateLiquidityReview(updateLiquidityFields(restored, { lowerMarketCapUsd: 200000 }))).toThrow("LP_INVALID_MCAP_RANGE");
    expect(() => validateLiquidityReview(updateLiquidityFields(restored, { bands: 2 }))).toThrow("INVALID_BANDS");
  });
});
describe("prefixed and bare position IDs", () => {
  it.each(["LP-AABB0011", "lp-aabb0011", "aabb0011", "AABB0011"])("normalizes %s without calling the AI", async position => {
    expect(liquidityFieldsSchema.parse({ position }).position).toBe("LP-AABB0011");
    for (const [message, operation] of [[`withdraw ${position}`, "withdraw"], [`check ${position}`, "status"], [`show position ${position}`, "status"], [`claim LP fees for ${position}`, "claim"], [`claim fees for ${position}`, "claim"], [`claim rewards for ${position}`, "claim"], [`collect fees ${position}`, "claim"], [`show me the NFTs for position ${position}`, "status"]]) {
      expect(isLiquidityMessage(message)).toBe(true);
      expect(await extractLiquidityFields(message)).toMatchObject({ operation, fields: { position: "LP-AABB0011" } });
    }
    expect(openRouter).not.toHaveBeenCalled();
    const d = newLiquidityDraft("withdraw"); expect(liquidityStepFields(position, d)?.position).toBe("LP-AABB0011");
  });
  it("accepts a bare ID in a grounded AI management patch", async () => {
    for (const message of ["add $50 to aabb0011", "close aabb0011", "manage aabb0011"]) expect(isLiquidityMessage(message)).toBe(true);
    for (const message of ["buy $50 of AABB0011", "sell AABB0011", "launch AABB0011", "add to https://site.invalid/AABB0011", "close 0x00000000000000000000000000000000AABB0011"]) expect(isLiquidityMessage(message)).toBe(false);
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: "add", updates: [{ field: "position", value: "LP-AABB0011", evidence: "aabb0011" }] }));
    expect(await extractLiquidityFields("add to position aabb0011")).toMatchObject({ operation: "add", fields: { position: "LP-AABB0011" } });
  });
  it.each(["LQ-AABB0011", "0x00000000000000000000000000000000AABB0011", "$AABB0011", "https://site.invalid/AABB0011"])("does not turn %s into a position via clipped AI evidence", async target => {
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: "add", updates: [{ field: "position", value: "LP-AABB0011", evidence: "AABB0011" }] }));
    await expect(extractLiquidityFields(`add to position ${target}`)).rejects.toThrow("UNGROUNDED_LP_PARAMETER");
  });
  it("does not reinterpret a dollar-prefixed token or broaden targeted claims", async () => {
    expect((await extractLiquidityFields("claim LP fees for $DEADBEEF")).fields).toEqual({ token: "DEADBEEF" });
    expect((await extractLiquidityFields("claim all LP fees for aabb0011")).fields).toEqual({ position: "LP-AABB0011" });
    expect(liquidityEvidenceMatches("position", "LP-AABB0011", "LQ-AABB0011")).toBe(false);
    expect((await extractLiquidityFields("show NFTs for aabb0011 and bbcc0022")).fields).toEqual({});
  });
});
