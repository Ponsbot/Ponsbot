import { describe, expect, it } from "vitest";
import { botCreatedReply, botCreationSummary } from "../lib/trading-agents/messages";

describe("bot creation confirmation", () => {
  it("includes the name, short personality and canonical yard link", () => {
    expect(botCreatedReply("Moss", "A patient trader who loves discovering Pons Bot tokens.")).toBe(
      "🤖 Moss has been created!\n\nA patient trader who loves discovering Pons Bot tokens.\n\nMeet your bot in the Bot Yard:\nhttps://www.ponsbot.family/bot-yard");
  });
  it("bounds long descriptions without changing the stored input", () => {
    const original = "Patient and curious. ".repeat(100);
    expect(Array.from(botCreationSummary(original)).length).toBeLessThanOrEqual(180);
    expect(botCreationSummary(original)).toMatch(/…$/);
    expect(original).toBe("Patient and curious. ".repeat(100));
  });
  it("does not repeat user supplied links or turn descriptions into mentions", () => {
    const reply = botCreatedReply("Moss", "@Someone loves $TOKEN #trading https://evil.example/\nToday.");
    expect(reply).not.toContain("evil.example"); expect(reply).not.toMatch(/[@#$]/);
    expect(reply).toContain("https://www.ponsbot.family/bot-yard");
  });
});
