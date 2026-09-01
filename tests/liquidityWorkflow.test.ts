import { describe, expect, it, vi, beforeEach } from "vitest";
import { decodeFunctionData, zeroAddress } from "viem";
import { deltaLiquidityAbi, liquidityPoolKey, liquidityPoolId, prepareLiquidityClaim, prepareLiquidityClose, prepareLiquidityOpen, assertLiquidityOwnership } from "../lib/liquidity-contracts";
import { liquidityAmounts, liquidityBands, fundLiquidityBands, liquiditySqrtTick, liquidityTickAtSqrt, LIQUIDITY_Q96 } from "../lib/liquidity-math";
import { isIndependentLiquidityRead, isLiquidityMessage, liquidityControl, liquidityOpenInquirySelection, liquidityStatusSelection, liquidityStepFields, liquidityOwnerAllowed, newLiquidityDraft, liquidityNextPhase, normalizeLiquidityTokenAliases, updateLiquidityFields, selectLiquidityPool, liquidityReviewHash, validateLiquidityReview, type LiquidityCandidate, type LiquidityPhase } from "../lib/liquidity-workflow";
import { LIQUIDITY_TEST_OWNER, LIQUIDITY_TEST_WALLET } from "./liquidityFixtures";
import { liquidityFundingMessage, paginateLiquidityResponse, liquidityResponseLines, liquidityCompletionGuidance, liquidityOpenedDetails } from "../lib/liquidity-responses";
import { xWeightedLength } from "../convex/xText";
import { inheritLiquidityPositionFields, isOrdinaryWalletCommand } from "../lib/liquidity-workflow";
import { replyQueuePriority, replyQueueExpiresAt } from "../lib/x-reply-queue-policy";
import { LIQUIDITY_RESPONSES } from "../lib/liquidity-responses";
import { liquidityStepIdempotencyKey } from "../lib/liquidity-recovery";
vi.mock("../convex/llm", () => ({ openRouter: vi.fn() }));
import { openRouter } from "../convex/llm";
import { extractLiquidityFields, rankLiquidityPools, rankLiquidityPoolsWithDiagnostics, liquidityEvidenceMatches, liquidityReasonCandidates } from "../convex/liquidityAi";
const token = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07";
const owner = LIQUIDITY_TEST_WALLET;
const leg = { tokenId: "1226101", tickLower: -600, tickUpper: 600, liquidity: "1000000000" };
const candidate: LiquidityCandidate = { id: "0x1111111111111111111111111111111111111111", version: 3, pair: "ETH", token0: zeroAddress, token1: token, feePips: 3000, tickSpacing: 60, netLpFeePercent: .25, traderFeePercent: .3, tokenPriceUsd: .001, activeLiquidity: "10000", volumeHourUsd: 30, swapsHour: 4, activeDepthUsd: 183, reserveUsd: 74_000, observedAt: 1, marketObservedAt: 1, blockNumber: "123", reasons: ["active_trading", "range_risk"] };
function completeDraft() {
  const d = newLiquidityDraft("open", { token: "PONSBOT", amount: "100", unit: "usd", pair: "ETH", version: 4, feePips: 3000, tickSpacing: 60, downPercent: 25, upPercent: 25, shape: "bell", bands: 3 });
  d.custom = true; d.analyzed = true; d.tokenAddress = token; d.symbol = "PONSBOT"; d.phase = liquidityNextPhase(d); return d;
}
describe("liquidity conversation", () => {
  it("recognizes a ticker-scoped position status request", () => {
    expect(liquidityStatusSelection("check my $PONS position")).toEqual({ token: "PONS" });
    expect(liquidityStatusSelection("show my positions")).toEqual({});
  });
  it("normalizes X's chain-qualified PONS cashtag before status parsing", () => {
    const text = normalizeLiquidityTokenAliases("@Ponsbotfamily check my ethereum:0x07f5b6823751c2e2cd4560f28af75ff887102241 position");
    expect(liquidityStatusSelection(text)).toEqual({ token: "PONS" });
  });
  it("does not normalize unrelated chain-qualified token identifiers", () => {
    const text = "check my ethereum:0x1111111111111111111111111111111111111111 position";
    expect(normalizeLiquidityTokenAliases(text)).toBe(text);
  });
  it("shows the USD value of each deposited asset in opening confirmations", () => {
    const d = completeDraft();
    const text = liquidityOpenedDetails(d, [
      { symbol: "WETH", amount: "0.037420328087018037", usd: 90.48048229800526 },
      { symbol: "PONS", amount: "1885.251910450203414953", usd: 780.9208947766424 },
    ], 871.4013770746477).join("\n");
    expect(text).toContain("0.03742033 WETH ($90.48)");
    expect(text).toContain("1,885.252 PONS ($780.92)");
    expect(text).toContain("Total $871.40");
  });
  it("uses a distinct CDP idempotency generation for a repriced retry", () => {
    expect(liquidityStepIdempotencyKey("liquidity:execution", 2, 0)).toBe("liquidity:execution:2:r0");
    expect(liquidityStepIdempotencyKey("liquidity:execution", 2, 1)).toBe("liquidity:execution:2:r1");
  });
  it.each(["Check my $PONSBOT position", "show my positions", "View my $PONSBOT position NFTs", "list LP-1234ABCD"])("recognizes an independent read-only lookup: %s", text => {
    expect(isIndependentLiquidityRead(text)).toBe(true);
  });
  it.each(["claim LP fees", "withdraw my position", "add liquidity to LP-1234ABCD", "create a liquidity position"])("does not detach an executable liquidity request: %s", text => {
    expect(isIndependentLiquidityRead(text)).toBe(false);
  });
  it("keeps every LP response in priority A with no queue expiry", () => {
    for (const message of Object.values(LIQUIDITY_RESPONSES)) {
      expect(replyQueuePriority(message, "liquidity", false)).toBe("A");
      expect(replyQueueExpiresAt(replyQueuePriority(message, "liquidity"), 1000)).toBeUndefined();
    }
  });
  it("treats resume as a funding refresh and gives an actionable wallet link", () => {
    expect(liquidityControl("resume", "analysis")).toEqual({ kind: "refresh" });
    const message = liquidityFundingMessage(completeDraft(), owner);
    expect(message).toContain("don’t have enough ETH, USDG, or $PONSBOT for this position and gas");
    expect(message).toContain("Pons Bot will buy any other assets");
    expect(message).toContain(`/wallet/${owner}`);
    expect(message).toContain("reply resume");
  });
  it.each(["budget", "range"] as LiquidityPhase[])("keeps the requested examples on the %s setup response", phase => {
    const d = completeDraft(); d.phase = phase;
    expect(paginateLiquidityResponse(liquidityResponseLines(d, "LQ-1234ABCD"), "x", phase === "pool").join("\n")).toContain("Example:");
  });
  it.each(["buy $20 of LIQUIDITY", "sell my POOL tokens", "launch Liquidity ticker LP", "send $10 worth of POOL to @bob", "burn POSITION", "create my wallet", "swap all my ETH for LIQUIDITY", "deploy a pool token"])('keeps ordinary command "%s" out of LP routing', text => {
    expect(isOrdinaryWalletCommand(text)).toBe(true); expect(isLiquidityMessage(text)).toBe(false);
  });
  it("does not let funding/help wording override a clear LP request", () => {
    expect(isLiquidityMessage("create a position and buy missing assets")).toBe(true);
    expect(isLiquidityMessage("how do you buy missing liquidity assets?")).toBe(true);
  });
  it("never inherits the earlier spend amount for add/claim/withdraw", () => {
    const fields = inheritLiquidityPositionFields(completeDraft().fields, { position: "LP-11111111" });
    expect(fields.amount).toBeUndefined(); expect(fields.unit).toBeUndefined(); expect(fields.pair).toBe("ETH");
    expect(liquidityNextPhase(newLiquidityDraft("add", fields))).toBe("position");
  });
  it.each([{ feePips: 500 }, { version: 3 as const }, { pair: "USDG" as const }, { shape: "flat" as const }, { bands: 7 }, { downPercent: 40 }])("refuses to silently change a saved pool on add: %j", patch => {
    expect(() => inheritLiquidityPositionFields(completeDraft().fields, patch)).toThrow("LP_POSITION_SETTINGS_CONFLICT");
  });
  it("shows every selectable recommendation in one long X response", () => {
    const d = completeDraft(); d.phase = "pool"; d.candidates = Array.from({ length: 6 }, (_, i) => ({ ...candidate, id: `0x${String(i + 1).repeat(40)}` }));
    const pages = paginateLiquidityResponse(liquidityResponseLines(d, "LQ-11111111"), "x", true);
    expect(pages).toHaveLength(1); expect(xWeightedLength(pages[0])).toBeGreaterThan(280);
    for (let n = 1; n <= 6; n++) expect(pages[0]).toContain(`${n})`);
    expect(pages[0]).not.toContain("Reply next");
  });
  it.each(["x", "terminal"] as const)("explains existing pools, custom settings, and the next action on %s", source => {
    const d = completeDraft(); d.phase = "pool"; d.candidates = [candidate];
    const pages = paginateLiquidityResponse(liquidityResponseLines(d, "LQ-11111111"), source, true);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("pools I found");
    expect(pages[0]).not.toContain("Higher sustained volume takes priority");
    expect(pages[0]).toContain("1) V3 • ETH");
    expect(pages[0]).toContain("Volume: 1h");
    expect(pages[0]).toContain("Active depth (±1%): $183");
    expect(pages[0]).toContain("Total pool liquidity: $74.0k");
    expect(pages[0]).not.toContain("Stops earning fees outside your range");
    expect(pages[0]).not.toContain("Matching settings use the same pool");
    expect(pages[0]).toContain('respond "custom pool"');
    expect(pages[0]).not.toContain("LQ-");
    expect(pages[0]).not.toContain("Example: 1");
    expect(pages[0]).toContain("pools I found for $PONSBOT.\n\n1) V3");
  });
  it("uses a cached market snapshot without calling its populated data unavailable", () => {
    const d = completeDraft(); d.phase = "pool"; d.candidates = [candidate];
    d.analysis = { checkedAt: Date.now(), stage: "high", summaries: 20, checkedPools: 1, descriptorLookups: 1, verifiedPools: 1, diagnostics: ["GECKO_RECENT_CACHE_FALLBACK"] };
    const text = liquidityResponseLines(d, "LQ-11111111").join("\n");
    expect(text).not.toContain("cached snapshot");
    expect(text).not.toContain("Some data is unavailable");
    expect(text).toContain("Volume: 1h $30");
    expect(text).toContain("Total pool liquidity: $74.0k");
  });
  it("separates pool notices from the first pool and suppresses incomplete-data text when all displayed metrics exist", () => {
    const d = completeDraft(); d.phase = "pool"; d.candidates = [{ ...candidate, volumeDayUsd: 500 }];
    d.analysis = { checkedAt: Date.now(), stage: "limited", summaries: 20, checkedPools: 1, descriptorLookups: 1, verifiedPools: 1, diagnostics: ["GECKO_STALE_OR_INVALID", "PUBLIC_DESCRIPTOR_RPC_FAILED"] };
    const text = liquidityResponseLines(d, "LQ-11111111").join("\n");
    expect(text).toContain("quieter options are included.\n\n1) V3");
    expect(text).not.toContain("Some data is unavailable");
  });
  it("does not imply that pools were found when discovery returned no suitable candidates", () => {
    const d = completeDraft(); d.phase = "pool"; d.candidates = [];
    const text = liquidityResponseLines(d, "LQ-11111111").join("\n");
    expect(text).toContain("couldn’t verify a suitable pool");
    expect(text).not.toContain("pools I found");
    expect(text).not.toContain("Reply with an option number");
    expect(text).toContain("Reply custom pool to continue, or refresh to check again");
    expect(text).not.toContain("Example: custom pool");
  });
  it("does not show the original opening budget on a claim quote", () => {
    const d = completeDraft(); d.operation = "claim";
    expect(liquidityResponseLines(d, "LQ-11111111").join("\n")).not.toContain("Position budget");
  });
  it.each(["token", "budget", "analysis", "pair", "version", "fee", "spacing", "range", "shape", "bands", "position", "review"] as LiquidityPhase[])("keeps the concise %s step in one response", phase => {
    const d = completeDraft(); d.phase = phase;
    const lines = liquidityResponseLines(d, "LQ-11111111");
    expect(lines.length).toBeLessThanOrEqual(10);
    if (["budget", "range"].includes(phase)) expect(lines.at(-1)).toMatch(/^Example: /);
    if (phase === "position") expect(lines.join("\n")).not.toContain("Example:");
    for (const source of ["x", "terminal"] as const) {
      const pages = paginateLiquidityResponse(lines, source, true);
      expect(pages).toHaveLength(1); expect(pages[0]).not.toContain("Reply next");
      expect(pages[0]).not.toContain("—");
      expect(xWeightedLength(pages[0])).toBeLessThan(7900);
    }
  });
  it("explains range and shape choices without promising fees or automatic management", () => {
    const d = completeDraft(); d.phase = "range";
    expect(liquidityResponseLines(d, "LQ-11111111").join(" ")).toContain("only gathers fees when MCap is inside this range");
    d.phase = "shape";
    const text = liquidityResponseLines(d, "LQ-11111111").join(" ");
    for (const word of ["Flat: Earns fees", "Bell: Earns more fees", "Bid-ask: Earns more fees"]) expect(text).toContain(word);
    expect(text).not.toContain("Example: flat");
  });
  it("explains the outcome and management choices after successful actions", () => {
    expect(liquidityCompletionGuidance("open", "LP-11111111")).toContain("LP-11111111");
    expect(liquidityCompletionGuidance("open", "LP-11111111")).toContain("collect LP fees, or withdraw");
    expect(liquidityCompletionGuidance("claim")).toBe("");
    expect(liquidityCompletionGuidance("withdraw")).toContain("position is closed");
    expect(liquidityCompletionGuidance("withdraw")).toContain("available LP fees were collected");
  });
  it("accepts immutable numeric X identities for every user, never display names", () => {
    expect(liquidityOwnerAllowed(LIQUIDITY_TEST_OWNER)).toBe(true);
    expect(liquidityOwnerAllowed("2086128304545783808")).toBe(true);
    expect(liquidityOwnerAllowed("ponsboyfamily")).toBe(false);
    expect(liquidityOwnerAllowed("")).toBe(false);
    expect(liquidityOwnerAllowed("0")).toBe(false);
  });
  it.each(["Create a liquidity pool for $PONSBOT", "open a position for PONSBOT", "claim rewards for LP-AABB0011", "add $50 to my position", "turn auto compounding off"])("captures LP request %s before launch parsing", text => expect(isLiquidityMessage(text)).toBe(true));
  it.each(["buy $20 PONSBOT", "launch Blue Pool ticker BP", "claim my creator fees", "send 1 ETH to @bob"])("does not intercept existing commands %s", text => expect(isLiquidityMessage(text)).toBe(false));
  it.each([
    ["what Pons pools are there?", { token: "PONS" }],
    ["show me the pools for $PONSBOT", { token: "PONSBOT" }],
    ["which liquidity options are available for PONS?", { token: "PONS" }],
    ["does $PONS have any pools?", { token: "PONS" }],
    ["find me PONSBOT LP options", { token: "PONSBOT" }],
    ["$PONS pools", { token: "PONS" }],
    ["can I provide liquidity for PONSBOT?", { token: "PONSBOT" }],
    ["I want to LP $PONS", { token: "PONS" }],
    ["where can I add liquidity for PONS?", { token: "PONS" }],
    ["I am looking to provide liquidity on $PONSBOT", { token: "PONSBOT" }],
    ["how do I earn LP fees on PONS?", { token: "PONS" }],
    ["help me set up a liquidity position", {}],
    ["I want a liquidity position", {}],
    ["what pools are available?", {}],
  ])("starts setup from broad pool-discovery wording: %s", async (text, fields) => {
    expect(liquidityOpenInquirySelection(text)).toEqual(fields);
    expect(isLiquidityMessage(text)).toBe(true);
    expect(await extractLiquidityFields(text)).toEqual({ operation: "open", fields });
  });
  it.each([
    "buy $20 of PONS from a pool",
    "sell PONS into the liquidity pool",
    "send 1 ETH to the pool",
    "swap ETH for PONS using a pool",
    "burn the LP token",
    "launch Blue Pool ticker BP",
    "claim my creator fees for PONS",
  ])("does not let pool language override an ordinary command: %s", text => {
    expect(liquidityOpenInquirySelection(text)).toBeNull();
    expect(isLiquidityMessage(text)).toBe(false);
  });
  it.each(["what is a liquidity pool?", "I want to know what liquidity is", "what pools do I have?", "show my liquidity pools"])("does not turn explanation or owned-position wording into a new setup: %s", text => {
    expect(liquidityOpenInquirySelection(text)).toBeNull();
  });
  it("asks missing parameters in sequence", () => {
    let d = newLiquidityDraft(); expect(d.phase).toBe("token");
    d = updateLiquidityFields(d, { token: "$PONSBOT" }); expect(d.phase).toBe("budget");
    d = updateLiquidityFields(d, { amount: "100", unit: "usd" }); expect(d.phase).toBe("analysis");
    d.analyzed = true; d.candidates = [candidate]; d.phase = liquidityNextPhase(d); expect(d.phase).toBe("pool");
    d = selectLiquidityPool(d, 1); expect(d.phase).toBe("range");
    d = updateLiquidityFields(d, { downPercent: 25, upPercent: 25 }); expect(d.phase).toBe("shape");
    d = updateLiquidityFields(d, { shape: "flat" }); expect(d.phase).toBe("review");
    expect(d.fields.bands).toBe(1); expect(d.bandsDefaulted).toBe(true);
  });
  it("suggests bands by shape while retaining any explicit selection", () => {
    const flat = newLiquidityDraft("open", { shape: "flat" });
    expect(flat.fields.bands).toBe(1); expect(flat.bandsDefaulted).toBe(true);
    const bell = updateLiquidityFields(flat, { shape: "bell" });
    expect(bell.fields.bands).toBe(5); expect(bell.bandsDefaulted).toBe(true);
    const explicit = updateLiquidityFields(bell, { shape: "flat", bands: 4 });
    expect(explicit.fields.bands).toBe(4); expect(explicit.bandsDefaulted).toBe(false);
    expect(updateLiquidityFields(explicit, { shape: "flat" }).fields.bands).toBe(4);
  });
  it.each(["I want 4 bands", "use four bands please", "set bands to 4", "change it to 4 bands"])("accepts an explicit band count at review: %s", text => {
    const d = completeDraft(); d.phase = "review";
    expect(liquidityStepFields(text, d)).toEqual({ bands: 4 });
  });
  it("clears stale quote on any parameter change", () => {
    const d = completeDraft(); d.executionPlanJson = "old"; d.review = { hash: `0x${"a".repeat(64)}`, expiresAt: 10, executionReady: true };
    const next = updateLiquidityFields(d, { bands: 5 }); expect(next.review).toBeUndefined(); expect(next.executionPlanJson).toBeUndefined();
    expect(liquidityReviewHash("LQ-12345678", owner, 1, d)).not.toBe(liquidityReviewHash("LQ-12345678", owner, 1, next));
  });
  it("normalizes V3 spacing and rejects conflicting spacing", () => {
    expect(updateLiquidityFields(newLiquidityDraft(), { version: 3, feePips: 3000 }).fields.tickSpacing).toBe(60);
    expect(() => updateLiquidityFields(newLiquidityDraft(), { version: 3, feePips: 3000, tickSpacing: 20 })).toThrow();
  });
  it("only treats a stand-alone decision as confirmation", () => {
    expect(liquidityControl("@Ponsbotfamily yes")).toEqual({ kind: "confirm" });
    expect(liquidityControl("Confirm LQ-aabb0011")).toEqual({ kind: "confirm", id: "LQ-AABB0011" });
    expect(liquidityControl("yes but use $200")).toBeNull();
    expect(liquidityControl("cancel and buy ETH")).toBeNull();
    expect(liquidityControl("continue")).toEqual({ kind: "continue" });
  });
  it("treats numbers as pool choices only at the pool-selection step", () => {
    expect(liquidityControl("3", "pool")).toEqual({ kind: "choose", option: 3 });
    for (const phase of ["bands", "version", "fee", "spacing", "budget", "review"] as const) {
      expect(liquidityControl("3", phase)).toBeNull();
      const d = completeDraft(); d.phase = phase; d.candidates = [candidate];
      expect(() => selectLiquidityPool(d, 1)).toThrow("INVALID_OPTION_STEP");
    }
    expect(liquidityControl("3")).toBeNull();
  });
  it.each([
    "Pool 1", "pool number 1 please", "option #1", "choose pool 1", "pick option 1 please",
    "select number 1", "use pool 1", "take choice 1", "go with pool 1", "I want pool 1",
    "I'd like option 1", "I would like number 1", "let's do pool 1", "lets go with 1",
  ])("accepts a short conversational pool choice: %s", text => {
    expect(liquidityControl(text, "pool")).toEqual({ kind: "choose", option: 1 });
  });
  it.each([
    "Pool 1 or 2", "Pool 1 with $200", "buy pool 1", "1 ETH", "I want 1 band",
    "would pool 1 be better?", "the pool has 1 trade", "Pool 7",
  ])("does not turn an ambiguous or material number into a pool choice: %s", text => {
    expect(liquidityControl(text, "pool")).toBeNull();
  });
  it.each(["Pool 1", "choose pool 1", "I want pool 1"])("does not apply pool-choice language outside the pool step: %s", text => {
    for (const phase of ["bands", "version", "fee", "spacing", "budget", "review"] as const) {
      expect(liquidityControl(text, phase)).toBeNull();
    }
  });
  it.each([
    ["bands", "3", { bands: 3 }], ["bands", "@Ponsbotfamily use five bands please", { bands: 5 }],
    ["version", "4", { version: 4 }], ["version", "V3", { version: 3 }],
    ["fee", "1", { feePips: 10000 }], ["fee", ".3%", { feePips: 3000 }],
    ["spacing", "60", { tickSpacing: 60 }], ["percentage", "100", { withdrawPercent: 100 }],
  ] as const)("parses a straightforward %s answer: %s", (phase, text, expected) => {
    const d = completeDraft(); d.phase = phase;
    expect(liquidityStepFields(text, d)).toEqual(expected);
  });
  it.each([
    ["budget", "100"], ["bands", "would 3 bands be better?"], ["bands", "3 or 5"],
    ["bands", "buy 3 PONS"], ["bands", "21"], ["range", "25"], ["fee", ".00015%"],
    ["review", "3"], ["percentage", "$50"],
  ])("does not invent units or apply ambiguous %s answers: %s", (phase, text) => {
    const d = completeDraft(); d.phase = phase as LiquidityPhase;
    expect(liquidityStepFields(text, d)).toBeNull();
  });
  it("validates quotes and paginates without trimming financial terms", () => {
    const d = completeDraft(); validateLiquidityReview(d);
    d.quoteSummary = ["Maximum PONSBOT: 1000000.", "Maximum ETH: 0.01.", "Estimated gas reserve: 0.0005 ETH."];
    const lines = liquidityResponseLines(d, "LQ-AABB0011"), pages = paginateLiquidityResponse(lines, "x");
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(xWeightedLength(`@123456789012345 ${page}`)).toBeLessThanOrEqual(280);
    expect(pages.at(-1)).toContain("confirm to proceed");
    expect(pages.join("\n")).not.toContain("Estimated gas reserve");
    for (const line of lines) expect(pages.join("\n")).toContain(line);
  });
  it("omits the band summary while keeping change instructions in the quote", () => {
    const d = completeDraft(); d.fields.shape = "flat"; d.fields.bands = 1; d.bandsDefaulted = true;
    const text = liquidityResponseLines(d, "LQ-AABB0011").join("\n");
    expect(text).not.toMatch(/bands|Suggested bands/i);
    expect(d.fields.bands).toBe(1);
    expect(text).toContain("revised quote");
  });
  it("does not imply an earnings ranking when every pool lacks volume and dollar depth", () => {
    const d = completeDraft(); d.phase = "pool";
    d.candidates = [{ ...candidate, volumeHourUsd: null, activeDepthUsd: null, netLpFeePercent: .29985, traderFeePercent: .34985 }];
    const text = liquidityResponseLines(d, "LQ-AABB0011").join("\n");
    expect(text).toContain("Volume couldn't be determined, so these options are unranked");
    expect(text).toContain("LP fee 0.29985%"); expect(text).toContain("Swap fee 0.34985%");
    expect(text).not.toContain("Volume: 1h $0");
  });
  it("keeps removed quote wording out while preserving backend slippage", () => {
    const d = completeDraft();
    d.quoteSummary = ["Maximum WETH: 0.04 ($100).", "Wrap ETH for 0.04 WETH: 0.04 ETH maximum."];
    const text = liquidityResponseLines(d, "LQ-AABB0011").join("\n");
    for (const removed of ["Compounding is off", "Delta collects", "gas is additional", "gas are additional", "A stale quote must be refreshed"]) expect(text).not.toContain(removed);
    expect(text).not.toContain("Slippage:"); expect(d.fields.slippageBps).toBeUndefined(); expect(text).toContain("Total spend: $100"); expect(text).not.toContain("Wrap ETH"); expect(text).toContain("confirm to proceed");
  });
  it.each(["I want 20 bands", "use twenty bands please", "set bands to 20"])("accepts %s at review", async text => {
    const d = completeDraft();
    expect(await extractLiquidityFields(text, d)).toEqual({ operation: "open", fields: { bands: 20 } });
    expect(updateLiquidityFields(d, { bands: 20 }).fields.bands).toBe(20);
  });
  it("checks abbreviated LP IDs as status, never as an execution request", async () => {
    expect(isLiquidityMessage("check 760ef1a7")).toBe(true);
    expect(await extractLiquidityFields("check 760ef1a7")).toEqual({ operation: "status", fields: { position: "LP-760EF1A7" } });
  });
  it.each(["flat", "bell", "bid_ask"] as const)("funds and encodes 20 symmetric %s bands for V3 and V4", shape => {
    const d = updateLiquidityFields(completeDraft(), { shape, bands: 20 }); validateLiquidityReview(d);
    const bands = liquidityBands({ tick: 0, spacing: 10, down: 25, up: 25, count: 20, shape, tokenIs0: true });
    expect(bands).toHaveLength(20); expect(bands.map(b => b.weight)).toEqual(bands.map(b => b.weight).reverse());
    const funded = fundLiquidityBands(bands, LIQUIDITY_Q96, 10n ** 18n, 10n ** 18n, 100);
    expect(funded.reduce((n, b) => n + b.amount0Max, 0n)).toBeLessThanOrEqual(10n ** 18n);
    expect(funded.reduce((n, b) => n + b.amount1Max, 0n)).toBeLessThanOrEqual(10n ** 18n);
    for (const version of [3, 4] as const) {
      const key = liquidityPoolKey(token, "ETH", version, 500, 10);
      const call = prepareLiquidityOpen({ version, pool: candidate.id as `0x${string}`, key, bands: funded, deadline: 1000n, minimumTick: -50, maximumTick: 50, slippageBps: 100 });
      const decoded = decodeFunctionData({ abi: deltaLiquidityAbi, data: call.data });
      expect(decoded.functionName).toBe(`openV${version}`);
      expect(decoded.args[1]).toHaveLength(20);
    }
    expect(() => liquidityBands({ tick: 0, spacing: 10, down: 25, up: 25, count: 21, shape, tokenIs0: true })).toThrow("INVALID_BANDS");
  });
});
describe("verified Delta transaction recipes", () => {
  it.each([[3, "0xb44b5774", "0xffb94054"], [4, "0xb1c250ab", "0xf2c4fa40"]] as const)("matches V%s collect and close on-chain selectors", (version, collect, close) => {
    expect(prepareLiquidityClaim(version, [leg]).data.slice(0, 10)).toBe(collect);
    expect(prepareLiquidityClose(version, [leg], [{ amount0: "100", amount1: "200" }]).data.slice(0, 10)).toBe(close);
    expect(() => prepareLiquidityClose(version, [leg], [{ amount0: "100", amount1: "200" }], 25)).toThrow("DELTA_PARTIAL_WITHDRAWAL_UNVERIFIED");
  });
  it("retains per-NFT minima and rejects duplicate IDs", () => {
    const next = { ...leg, tokenId: "9007199254740999" }, call = prepareLiquidityClose(4, [leg, next], [{ amount0: "1", amount1: "2" }, { amount0: "3", amount1: "4" }]);
    const decoded = decodeFunctionData({ abi: deltaLiquidityAbi, data: call.data });
    expect(decoded.args).toEqual([[1226101n, 9007199254740999n], [1n, 3n], [2n, 4n]]);
    expect(() => prepareLiquidityClaim(3, [leg, leg])).toThrow();
  });
  it("requires both manager beneficial ownership and actual NFT custody", () => {
    const observation = { tokenId: leg.tokenId, beneficialOwner: owner, nftOwner: "0x5ca6214227d1195c4b7b4b96847b8966c688295d" };
    expect(() => assertLiquidityOwnership(owner, 4, [leg], [observation])).not.toThrow();
    expect(() => assertLiquidityOwnership(owner, 4, [leg], [{ ...observation, beneficialOwner: token }])).toThrow();
    expect(() => assertLiquidityOwnership(owner, 4, [leg], [{ ...observation, nftOwner: owner }])).toThrow();
  });
  it("matching parameters select the same V4 pool; range and bands are not pool identity", () => {
    const key = liquidityPoolKey(token, "ETH", 4, 3000, 60);
    expect(liquidityPoolId(key)).toBe(liquidityPoolId({ ...key }));
    expect(liquidityPoolId({ ...key, tickSpacing: 50 })).not.toBe(liquidityPoolId(key));
    expect(liquidityPoolKey(token, "ETH", 3, 3000, 60).currency0).not.toBe(zeroAddress);
  });
  it("builds open calls with exact caps rather than model-provided calldata", () => {
    const key = liquidityPoolKey(token, "ETH", 4, 3000, 60);
    const bands = fundLiquidityBands([{ tickLower: -600, tickUpper: 600, weight: 1 }], LIQUIDITY_Q96, 1000000000n, 1000000000n, 100);
    const call = prepareLiquidityOpen({ version: 4, pool: zeroAddress, key, bands, deadline: 1000n, minimumTick: -50, maximumTick: 50, slippageBps: 100 });
    expect(call.value).toBe(bands[0].amount0Max.toString());
    expect(decodeFunctionData({ abi: deltaLiquidityAbi, data: call.data }).functionName).toBe("openV4");
  });
});
describe("exact liquidity math", () => {
  it.each([-887271, -600, -1, 0, 1, 600, 887271])("round-trips tick %s without floating-point liquidity", tick => expect(liquidityTickAtSqrt(liquiditySqrtTick(tick))).toBe(tick));
  it("fits both asset caps and rounds mint up / withdrawal down", () => {
    const bands = liquidityBands({ tick: 0, spacing: 60, down: 25, up: 25, tokenIs0: true, count: 3, shape: "bell" });
    const rungs = fundLiquidityBands(bands, LIQUIDITY_Q96, 123456789123456789n, 9007199254740999n, 100);
    expect(rungs.reduce((n, b) => n + b.amount0Max, 0n)).toBeLessThanOrEqual(123456789123456789n);
    expect(rungs.reduce((n, b) => n + b.amount1Max, 0n)).toBeLessThanOrEqual(9007199254740999n);
    for (const rung of rungs) {
      const lower = liquidityAmounts(rung.liquidity, rung.tickLower, rung.tickUpper, LIQUIDITY_Q96, false);
      expect(lower[0]).toBeLessThanOrEqual(rung.amount0); expect(lower[1]).toBeLessThanOrEqual(rung.amount1);
    }
  });
  it("inverts token1 price range correctly", () => {
    const base = { tick: 0, spacing: 10, down: 10, up: 50, count: 1, shape: "flat" as const };
    const direct = liquidityBands({ ...base, tokenIs0: true }), inverse = liquidityBands({ ...base, tokenIs0: false });
    expect(direct[0].tickLower).toBe(-inverse[0].tickUpper);
    expect(direct[0].tickUpper).toBe(-inverse[0].tickLower);
  });
});
describe("structured liquidity AI (mocked, no API/wallet/X calls)", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    ["collect LP fees for PONSBOT", { token: "PONSBOT" }], ["claim LP fees for $PONSBOT", { token: "PONSBOT" }],
    ["collect all my LP fees", { allPositions: true }], ["collect liquidity fees for all my positions", { allPositions: true }],
    ["collect LP fees for LP-1234ABCD", { position: "LP-1234ABCD" }],
    [`collect LP fees for ${token}`, { token }],
    ["claim all LP fees for PONSBOT", { token: "PONSBOT" }],
    ["collect all LP fees from LP-1234ABCD", { position: "LP-1234ABCD" }],
    ["withdraw all my liquidity rewards on $PONSBOT please", { token: "PONSBOT" }],
    [`claim all liquidity fees for ${token}`, { token }],
    ["claim all LP fees", { allPositions: true }],
    ["claim LP fees for all my positions", { allPositions: true }],
    ["claim all LP fees for $ALL", { token: "ALL" }],
  ])("recognizes explicit LP selector %s without model ambiguity", async (text, fields) => {
    expect(isLiquidityMessage(text as string)).toBe(true);
    expect(await extractLiquidityFields(text as string)).toEqual({ operation: "claim", fields });
    expect(openRouter).not.toHaveBeenCalled();
  });
  it("bare all is accepted at the LP claim question only; creator claims remain separate", async () => {
    const d = newLiquidityDraft("claim");
    expect(await extractLiquidityFields("all", d)).toEqual({ operation: "claim", fields: { allPositions: true } });
    expect(isLiquidityMessage("claim my fees")).toBe(false); expect(isLiquidityMessage("claim all my creator fees")).toBe(false);
    expect(openRouter).not.toHaveBeenCalled();
  });
  it("model and draft updates cannot broaden an explicit token or ID to all positions", async () => {
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ operation: "claim", inquiryTopics: [], updates: [
      { field: "allPositions", value: "true", evidence: "all" }, { field: "token", value: "PONSBOT", evidence: "PONSBOT" },
    ] }));
    expect(await extractLiquidityFields("Please collect all the LP fees for PONSBOT now")).toEqual({ operation: "claim", fields: { token: "PONSBOT" } });
    expect(openRouter).toHaveBeenCalledTimes(1);
    const draft = newLiquidityDraft("claim", { allPositions: true });
    expect(updateLiquidityFields(draft, { token: "PONSBOT", allPositions: true }).fields).toEqual({ token: "PONSBOT" });
    expect(updateLiquidityFields(draft, { position: "LP-1234ABCD", token: "PONSBOT", allPositions: true }).fields).toEqual({ position: "LP-1234ABCD" });
    expect(updateLiquidityFields(newLiquidityDraft("claim", { token: "PONSBOT" }), { allPositions: true }).fields).toEqual({ allPositions: true });
  });
  it("does not need AI to resolve the meaning of a simple numeric answer", async () => {
    const d = completeDraft(); d.phase = "bands";
    expect(await extractLiquidityFields("3", d)).toEqual({ operation: "open", fields: { bands: 3 } });
    expect(openRouter).not.toHaveBeenCalled();
  });
  it("extracts specified fields with high reasoning, without changing the global model", async () => {
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ operation: "open", updates: [{ field: "token", value: "PONSBOT", evidence: "$PONSBOT" }, { field: "amount", value: "100", evidence: "$100" }, { field: "unit", value: "usd", evidence: "$100" }] }));
    expect(await extractLiquidityFields("create a $100 liquidity position for $PONSBOT")).toEqual({ operation: "open", fields: { token: "PONSBOT", amount: "100", unit: "usd" } });
    expect(vi.mocked(openRouter).mock.calls[0][1]).toBe(16384);
    expect(vi.mocked(openRouter).mock.calls[0][2]?.reasoningEffort).toBe("high");
  });
  it("rejects invented evidence or duplicate fields", async () => {
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ operation: "open", updates: [{ field: "amount", value: "1000", evidence: "$1000" }] }));
    await expect(extractLiquidityFields("create liquidity for PONSBOT")).rejects.toThrow();
  });
  it("does not accept a changed amount just because its evidence occurs in the message", () => {
    expect(liquidityEvidenceMatches("amount", "1000", "$100")).toBe(false);
    expect(liquidityEvidenceMatches("feePips", "3000", "0.3%")).toBe(true);
    expect(liquidityEvidenceMatches("token", "PONS", "$PONSBOT")).toBe(false);
    expect(liquidityEvidenceMatches("bands", "3", "three bands")).toBe(true);
    expect(liquidityEvidenceMatches("feePips", "3000", ".3%")).toBe(true);
    expect(liquidityEvidenceMatches("feePips", "3000", "3000 pips")).toBe(true);
    expect(liquidityEvidenceMatches("slippageBps", "100", "100 basis points")).toBe(true);
    expect(liquidityEvidenceMatches("amount", "0.01", ".01 ETH")).toBe(true);
    expect(liquidityEvidenceMatches("amount", "1", ".01 ETH")).toBe(false);
    expect(liquidityEvidenceMatches("amount", "100", "TOKEN100")).toBe(false);
    expect(liquidityEvidenceMatches("version", "4", "V4")).toBe(true);
  });
  it("ranks only actual candidates and renders no AI prose", async () => {
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ ranking: [{ id: candidate.id, reasons: ["active_trading", "low_trader_cost"] }] }));
    const rows = await rankLiquidityPools([candidate], "$100");
    expect(rows[0].reasons).toEqual(["active_trading", "low_trader_cost"]);
  });
  it("falls back to grounded reasons when ranking invents a pool", async () => {
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ ranking: [{ id: token, reasons: ["active_trading", "fee_paying"] }] }));
    expect((await rankLiquidityPools([candidate], "$100"))[0].id).toBe(candidate.id);
  });
  it("shows when activity thresholds were relaxed and does not print unknown volume as zero", () => {
    const d = completeDraft(); d.phase = "pool";
    d.candidates = [{ ...candidate, volumeHourUsd: null, volumeDayUsd: null, swapsHour: null, volumeTier: "limited" }];
    d.analysis = { checkedAt: Date.now(), stage: "limited", summaries: 1, checkedPools: 1, verifiedPools: 1, diagnostics: ["GECKO_BUDGET_DEFERRED"] };
    const text = liquidityResponseLines(d, "LQ-1234ABCD").join("\n");
    expect(text).toContain("quieter options are included"); expect(text).toContain("Volume couldn't be determined");
    expect(text).toContain("1h unknown"); expect(text).toContain("24h unknown");
    expect(text).not.toContain("1h volume $0");
  });
  it("passes multi-window activity and budget-share economics to the ranking model", async () => {
    vi.mocked(openRouter).mockRejectedValue(new Error("Offline ranking fallback"));
    const p = { ...candidate, volumeHourUsd: 1000, volumeSixHourUsd: 3000, volumeDayUsd: 12000, estimatedBudgetSharePercent: 1 };
    await rankLiquidityPools([p], "$100");
    const input = JSON.parse(vi.mocked(openRouter).mock.calls[0][0][1].content);
    expect(input.candidates[0].conservativeHourlyVolumeUsd).toBe(500);
    expect(input.candidates[0].feeOpportunityScore).toBeCloseTo(.0125);
    expect(vi.mocked(openRouter).mock.calls[0][1]).toBe(24576);
    expect(vi.mocked(openRouter).mock.calls[0][2]?.reasoningEffort).toBe("high");
  });
  it("does not invent thin depth for a pool with zero LP fees and unknown depth", async () => {
    vi.mocked(openRouter).mockRejectedValue(new Error("AI unavailable"));
    const pools = [{ ...candidate, netLpFeePercent: 0, activeDepthUsd: null, volumeHourUsd: null },
      { ...candidate, id: token, volumeHourUsd: 100 }];
    const originalOrder = pools.map(p => p.id);
    const ranked = await rankLiquidityPools(pools, "$100");
    expect(pools.map(p => p.id)).toEqual(originalOrder);
    for (const p of ranked) expect(p.reasons.every(r => liquidityReasonCandidates(p).includes(r))).toBe(true);
    expect(ranked.find(p => p.id === candidate.id)?.reasons).not.toContain("thin_depth");
  });
});
