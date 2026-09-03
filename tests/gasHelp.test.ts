import { beforeEach, describe, expect, it, vi } from "vitest";
const ai = vi.hoisted(() => vi.fn());
vi.mock("../convex/llm", () => ({ openRouter: ai, isStructuredOutputAvailabilityError: () => false }));
import { decodePersistedXWalletIntent, explicitInformationalTopic, isContextualGasCostFollowup, isGasCostQuestion, parseXWalletIntent, walletHelpMessage } from "../convex/xWalletIntent";
import { walletIntentSchema } from "../convex/xWalletAiSchemas";
import { xWeightedLength } from "../convex/xText";

beforeEach(() => ai.mockReset());

describe("gas-cost help (no external actions)", () => {
  it.each([
    "@Ponsbotfamily how much gas is needed?",
    "Hey @ponsbotfamily, how much gas do I need to launch?",
    "How much ETH should I keep for gas?",
    "How much ETH does a launch need?",
    "How much does it cost to launch a token?",
    "What are the network fees?",
    "What's the gas fee for a buy?",
    "What is the minimum ETH needed to launch?",
    "How expensive is a launch?",
    "How do gas fees work?",
    "Is 0.002 ETH enough to launch?",
    "Can you explain gas fees?",
    "gas fees?",
    "launch cost?",
  ])("routes %s directly to gas help, never wallet execution", async text => {
    expect(isGasCostQuestion(text)).toBe(true);
    expect(explicitInformationalTopic(text)).toBe("gas");
    expect(await parseXWalletIntent(text, false)).toEqual({ kind: "help", topic: "gas" });
    expect(ai).not.toHaveBeenCalled();
  });
  it.each([
    "buy $10 of GAS", "send 0.001 ETH to 0x1111111111111111111111111111111111111111",
    'launch "Gas" ticker GAS description "How much gas is needed?"',
    "claim my fees", "show my balance", "What's my wallet? I need to add gas.",
    "What's my wallet balance? I need gas for a launch.",
    "Do I need ETH for gas?", "Can you explain how I add money for gas?",
  ])("does not hijack unrelated commands or funding help: %s", text => {
    expect(isGasCostQuestion(text)).toBe(false);
  });
  it("supports the gas topic in structured AI output and persisted X/terminal intent", () => {
    const schema = walletIntentSchema.schema as { properties: { topic: { enum: unknown[] } } };
    expect(schema.properties.topic.enum).toContain("gas");
    expect(decodePersistedXWalletIntent('{"kind":"help","topic":"gas"}')).toEqual({ kind: "help", topic: "gas" });
  });
  it.each([
    "how much?",
    "How much ETH?",
    "how much more do I need?",
    "what amount should I add?",
    "what do you recommend?",
    "@Ponsbotfamily how much should I fund it with?",
  ])("accepts a narrow contextual follow-up to an insufficient-ETH response: %s", text => {
    expect(isContextualGasCostFollowup(text)).toBe(true);
  });
  it.each(["thanks", "do it", "buy more", "where is my wallet?", "how much PONSBOT?"])(
    "does not treat unrelated reply text as contextual gas help: %s",
    text => expect(isContextualGasCostFollowup(text)).toBe(false),
  );
  it("prints the requested gas allowance and fits an X reply", () => {
    const message = walletHelpMessage("gas");
    expect(message).toBe("⛽ Gas costs vary by transaction. Attempt a transaction for a simulated gas cost.");
    expect(xWeightedLength(message)).toBeLessThanOrEqual(280);
    expect(message).not.toMatch(/costs can rise/i);
    expect(message).not.toContain("—");
  });
});
