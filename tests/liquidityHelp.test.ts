import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIQUIDITY_EXPLANATIONS, LIQUIDITY_HELP_TOPICS, liquidityExplanation, liquidityStepTopic, obviousLiquidityInquiry } from "../lib/liquidity-help";
import { liquidityDraftSchema, newLiquidityDraft, type LiquidityDraft } from "../lib/liquidity-workflow";
import { xWeightedLength } from "../convex/xText";
vi.mock("../convex/llm", () => ({ openRouter: vi.fn() }));
import { openRouter } from "../convex/llm";
import { extractLiquidityFields, liquidityExtractionSchema } from "../convex/liquidityAi";

function draft(phase: LiquidityDraft["phase"] = "shape") {
  const d = newLiquidityDraft("open", { token: "PONSBOT", amount: "100", unit: "usd", pair: "ETH", version: 4, feePips: 3000, tickSpacing: 60, downPercent: 25, upPercent: 25 });
  d.tokenAddress = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07"; d.symbol = "PONSBOT"; d.custom = true; d.analyzed = true; d.phase = phase;
  return d;
}
beforeEach(() => vi.resetAllMocks());
describe("context-aware LP explanations", () => {
  it.each(["what does this mean?", "@Ponsbotfamily explain this", "tell me more", "I don't understand", "I'm confused"])("routes straightforward inquiry without model latency: %s", async text => {
    expect(await extractLiquidityFields(text, draft())).toMatchObject({ operation: "open", fields: {}, inquiryTopics: ["step"] });
    expect(openRouter).not.toHaveBeenCalled();
  });
  it.each([
    ["What are the different shape distributions?", "shape"], ["Is bell safer?", "shape"], ["How do bands work?", "bands"],
    ["What happens below my range?", "range"], ["Explain impermanent loss", "risk"], ["Why do I need ETH for gas?", "gas"],
    ["What is slippage?", "slippage"], ["What does USDG mean?", "pair"], ["What happens if I confirm?", "review"],
  ])("recognizes the subject without selecting parameters: %s", async (text, topic) => {
    const result = await extractLiquidityFields(text, draft()); expect(result.inquiryTopics).toContain(topic); expect(result.fields).toEqual({});
  });
  it("leaves polite parameter selections to the actual extractor", async () => {
    expect(obviousLiquidityInquiry("Can you use bell?")).toBeUndefined();
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ operation: null, inquiryTopics: [], updates: [{ field: "shape", value: "bell", evidence: "bell" }] }));
    expect(await extractLiquidityFields("Can you use bell?", draft())).toEqual({ operation: "open", fields: { shape: "bell" } });
  });
  it.each([["spot", "flat"], ["curve", "bell"]])("accepts Delta terminology %s as %s", async (text, shape) => {
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ operation: null, inquiryTopics: [], updates: [{ field: "shape", value: shape, evidence: text }] }));
    expect((await extractLiquidityFields(text, draft())).fields.shape).toBe(shape);
  });
  it("handles less formulaic questions through structured topic selection", async () => {
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ operation: null, inquiryTopics: ["shape", "fees"], updates: [] }));
    expect((await extractLiquidityFields("Help me weigh the alternatives before I pick one", draft())).inquiryTopics).toEqual(["shape", "fees"]);
    expect(liquidityExtractionSchema.required).toContain("inquiryTopics");
  });
  it("ignores updates returned with a question, even an attempted amount change", async () => {
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ operation: "withdraw", inquiryTopics: ["risk"], updates: [{ field: "amount", value: "999999", evidence: "irrelevant" }] }));
    expect(await extractLiquidityFields("Help me weigh those alternatives", draft())).toEqual({ operation: "open", fields: {}, inquiryTopics: ["risk"] });
  });
  it("turns legacy help classification into an explanation instead of ending the draft", async () => {
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ operation: "help", updates: [] }));
    expect((await extractLiquidityFields("Say it more simply", draft())).inquiryTopics).toEqual(["step"]);
  });
  it("does not display invented model prose or unsupported topic codes", async () => {
    vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ operation: null, inquiryTopics: ["guaranteed_returns"], updates: [] }));
    await expect(extractLiquidityFields("Help me weigh those alternatives", draft())).rejects.toThrow();
  });
  it("explains shapes in Delta's terms then repeats the choice", () => {
    const d = draft(), before = structuredClone(d), result = liquidityExplanation(d, "LQ-12345678", ["step"], "terminal");
    expect(result.message).toContain("spot"); expect(result.message).toContain("curve"); expect(result.message).toContain("Bid-ask");
    expect(result.message).toContain("Choose flat");
    expect(result.message.split("\n").at(-1)).toBe("Choose flat, bell, or bid-ask.");
    expect(result.draft.fields).toEqual(before.fields); expect(result.draft.phase).toBe("shape"); expect(d).toEqual(before);
  });
  it("preserves the exact quote, expiry, and unviewed financial pages", () => {
    const d = draft("review");
    d.review = { hash: `0x${"a".repeat(64)}`, expiresAt: Date.now() + 50000, executionReady: true }; d.executionPlanJson = "unchanged-signed-plan";
    d.remainingPages = ["Unviewed funding amount", "Unviewed final quote"];
    const result = liquidityExplanation(d, "LQ-12345678", ["gas"], "x");
    expect(result.draft.review).toEqual(d.review); expect(result.draft.executionPlanJson).toBe(d.executionPlanJson);
    expect(result.draft.remainingPages).toEqual(d.remainingPages); expect(result.draft.explanationPages.length).toBeGreaterThan(0);
    expect(result.draft.explanationPages.at(-1)).toContain("resume the remaining");
  });
  it("does not extend an expired quote while answering a question", () => {
    const d = draft("review"); d.review = { hash: `0x${"a".repeat(64)}`, expiresAt: 1, executionReady: true };
    expect(liquidityExplanation(d, "LQ-12345678", ["step"], "terminal").message).toContain("Reply refresh");
  });
  it.each(LIQUIDITY_HELP_TOPICS)("keeps topic %s within X and persisted-page limits", topic => {
    const result = liquidityExplanation(draft(), "LQ-12345678", [topic], "x");
    expect(() => liquidityDraftSchema.parse(result.draft)).not.toThrow();
    for (const page of [result.message, ...result.draft.explanationPages]) expect(xWeightedLength(`@123456789012345 ${page}`)).toBeLessThanOrEqual(280);
  });
  it.each(["token", "budget", "pool", "pair", "version", "fee", "spacing", "range", "shape", "bands", "position", "percentage", "compound", "review"] as const)("has contextual help at the %s step", phase => {
    const topic = liquidityStepTopic(draft(phase)); expect(topic).not.toBe("step"); expect(LIQUIDITY_HELP_TOPICS).toContain(topic);
  });
  it("does not advertise unimplemented management and accurately explains one-sided setup", () => {
    expect(LIQUIDITY_EXPLANATIONS.management.join(" ")).toContain("not available");
    expect(LIQUIDITY_EXPLANATIONS.one_sided.join(" ")).toContain("begins one-sided");
    expect(LIQUIDITY_EXPLANATIONS.risk.join(" ")).toContain("pool itself can exchange");
  });
});
