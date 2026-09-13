import { botSpriteDataUrl, type BotSprite } from "./sprite";
import { spriteDesigns } from "./sprite-designs";

export const facings = ["e", "se", "s", "sw", "w", "nw", "n", "ne"] as const;
export type Facing = typeof facings[number];

/** Eight reusable pixel views, generated from the saved design, never from user markup. */
export function botDirectionalSprites(sprite: BotSprite): Record<Facing, string> {
  const front = botSpriteDataUrl(sprite); // Validates the saved descriptor.
  const svg = decodeURIComponent(front.slice(front.indexOf(",") + 1));
  const grid: (string | undefined)[][] = Array.from({ length: 30 }, () => Array(25));
  const rows = spriteDesigns[sprite.archetype];
  const scale = sprite.version === 2 ? 1.4 : 1;
  const left = sprite.version === 2 ? (25 - Math.max(...rows.map(row => row.length)) * scale) / 2 : 0;
  const top = sprite.version === 2 ? 28 - rows.length * scale : 0;
  for (const match of svg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)" fill="(#[\da-fA-F]+)"\/>/g)) {
    const [, x, y, w, h, color] = match;
    for (let gy = 0; gy < 30; gy++) for (let gx = 0; gx < 25; gx++) {
      const sx = sprite.version === 2 && (sprite.seed & 16) ? 24 - gx : gx;
      if (sx + .5 >= left + Number(x) * scale && sx + .5 < left + (Number(x) + Number(w)) * scale
        && gy + .5 >= top + Number(y) * scale && gy + .5 < top + (Number(y) + Number(h)) * scale) grid[gy][gx] = color;
    }
  }
  const palettes = ["#216b48", "#6945a3", "#9b5326", "#245d90", "#8e355d"];
  return Object.fromEntries(facings.map(direction => {
    if (direction === "s") return [direction, front];
    const rear = direction.includes("n"), profile = direction === "e" || direction === "w";
    const side = direction.includes("e") ? 1 : direction.includes("w") ? -1 : 0;
    const compression = profile ? .58 : side ? .82 : 1;
    const pixels: string[] = [];
    for (let y = 0; y < 30; y++) {
      const occupied = grid[y].flatMap((color, x) => color ? [x] : []);
      if (!occupied.length) continue;
      const min = occupied[0], max = occupied[occupied.length - 1];
      for (let x = min; x <= max; x++) {
        let color = grid[y][x];
        if (!color) continue;
        // Hide front-facing eyes/panels on back views and turn the face into a profile.
        const upperFace = y > 7 && y < 19 && x > min + 1 && x < max - 1;
        if (rear && upperFace) color = palettes[sprite.palette];
        if (profile && upperFace) color = palettes[sprite.palette];
        const px = Math.round(12 + (x - 12) * compression + side * (y < 18 ? 1 : 0));
        pixels.push(`<rect x="${px}" y="${y}" width="1" height="1" fill="${color}"/>`);
      }
    }
    if (profile) {
      // A single forward eye rather than two eyes on a squeezed frontal face.
      const eyeY = sprite.version === 1 ? 9 : Math.round(top + rows.findIndex(row => row.includes("E")) * scale);
      if (eyeY >= 0 && eyeY < 25) pixels.push(`<rect x="${side > 0 ? 16 : 8}" y="${eyeY}" width="1" height="2" fill="#122b30"/>`);
    }
    if (rear && (sprite.archetype === "robot" || sprite.archetype === "astronaut")) pixels.push('<rect x="10" y="18" width="5" height="5" fill="#233c35"/><rect x="11" y="19" width="3" height="3" fill="#8da6a0"/>');
    return [direction, `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 30" width="25" height="30" shape-rendering="crispEdges">${pixels.join("")}</svg>`)}`];
  })) as Record<Facing, string>;
}
