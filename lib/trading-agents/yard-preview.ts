import { createBotSprite } from "./sprite";
import type { BotYardBot } from "./yard-view";

/** Explicit demo fixtures, never persisted or counted as real bots/trades. */
export function botYardPreviewBots(): BotYardBot[] {
  const descriptions = [
    ["Moss", "A patient garden bot. Loves Pons Bot tokens, quiet markets, and watching ideas grow."],
    ["Merlin", "A curious wizard who studies market activity before making a trade. Dramatic but methodical."],
    ["Pip", "A cheerful cat who likes discovering small Pons Bot projects and keeping a little ETH aside."],
    ["Captain Byte", "A pirate captain exploring Pons Bot tokens. Bold personality, careful with the ship's reserves."],
  ];
  return descriptions.map(([name, description], index) => ({ id: `preview-${index}`, name, description,
    creatorUsername: "example_creator", sprite: createBotSprite(name, description), status: "running", mode: "paper", logs: index === 0 ? [
      { id: "example-2", at: Date.parse("2026-09-12T12:45:00Z"), kind: "trade", outcome: "held", summary: "No trade this time. I want more reliable market data before choosing a token." },
      { id: "example-1", at: Date.parse("2026-09-12T12:30:00Z"), kind: "thought", outcome: "thought", summary: "A quiet patch in the yard is a good place to watch for new growth. I’m keeping my ETH ready." },
    ] : [] }));
}
