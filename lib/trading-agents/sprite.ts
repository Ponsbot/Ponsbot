/** Versioned, one-time pixel-art design. Store this at creation, never regenerate on page visits. */
export type BotSprite = { version: 1; seed: number; archetype: "robot" | "wizard" | "cat" | "plant" | "pirate"; palette: number };
const palettes = [["#216b48", "#a6de78"], ["#6945a3", "#e9bbff"], ["#9b5326", "#ffd783"], ["#245d90", "#a2deec"], ["#8e355d", "#ffb3bf"]];
export function createBotSprite(name: string, description: string): BotSprite {
  let seed = 2166136261;
  for (const point of `${name.normalize("NFC")}\n${description.normalize("NFC")}`) seed = Math.imul(seed ^ point.codePointAt(0)!, 16777619) >>> 0;
  const words = `${name} ${description}`.toLowerCase();
  const archetype = /wizard|magic|mage|witch/.test(words) ? "wizard" : /cat|kitten|feline/.test(words) ? "cat"
    : /plant|flower|garden|tree/.test(words) ? "plant" : /pirate|captain|sailor/.test(words) ? "pirate" : "robot";
  return { version: 1, seed, archetype, palette: seed % palettes.length };
}

/** SVG-native pixel art: no external images, user markup, model SVG, or per-view generation charge. */
export function botSpriteDataUrl(sprite: BotSprite): string {
  if (sprite.version !== 1 || !Number.isSafeInteger(sprite.seed) || sprite.seed < 0 || sprite.seed > 0xffffffff
    || !Number.isInteger(sprite.palette) || !palettes[sprite.palette] || !["robot", "wizard", "cat", "plant", "pirate"].includes(sprite.archetype)) throw new Error("INVALID_BOT_SPRITE");
  const [body, accent] = palettes[sprite.palette];
  const rect = (x: number, y: number, width: number, height: number, fill: string) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}"/>`;
  let pixels = rect(7, 27, 11, 2, "#283c3520") + rect(7, 20, 4, 7, body) + rect(14, 20, 4, 7, body)
    + rect(6, 13, 13, 9, body) + rect(3, 14, 3, 7, accent) + rect(19, 14, 3, 7, accent)
    + rect(5, 5, 15, 10, body) + rect(7, 7, 11, 6, accent)
    + rect(8, 8, 2, 2, "#17392d") + rect(15, 8, 2, 2, "#17392d")
    + rect(10, 12, 5, 1, "#17392d") + rect(10, 17, 5, 3, accent)
    + rect(7, 26, 5, 2, "#233c35") + rect(14, 26, 5, 2, "#233c35");
  if (sprite.archetype === "wizard") pixels += rect(8, 3, 9, 3, body) + rect(10, 1, 5, 3, body) + rect(5, 5, 15, 2, accent);
  else if (sprite.archetype === "cat") pixels += rect(5, 2, 4, 5, body) + rect(16, 2, 4, 5, body) + rect(22, 17, 2, 6, body);
  else if (sprite.archetype === "plant") pixels += rect(11, 1, 3, 5, body) + rect(6, 1, 6, 3, accent) + rect(14, 0, 6, 3, accent);
  else if (sprite.archetype === "pirate") pixels += rect(7, 2, 11, 4, "#233c35") + rect(4, 5, 17, 2, "#233c35") + rect(14, 8, 4, 3, "#233c35");
  else pixels += rect(11, 2, 3, 3, body) + rect(10, 0, 5, 2, accent);
  if (sprite.seed % 2) pixels += rect(10, 17, 2, 2, "#fff4cb");
  // Seeded detailing gives characters more combinations than palette alone.
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    if ((sprite.seed >>> (row * 3 + col + 4)) & 1) pixels += rect(10 + col, 17 + row, 1, 1, "#fff4cb");
  }
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="25" height="30" viewBox="0 0 25 30" shape-rendering="crispEdges">${pixels}</svg>`)}`;
}
