import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const source = path.join(root, "public", "ponsbot.png");
const lime = "#c9ff4a";

async function icon(size) {
  const inset = Math.max(2, Math.round(size * 0.065));
  const inner = size - inset * 2;
  const circle = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${lime}"/></svg>`);
  const mask = Buffer.from(`<svg width="${inner}" height="${inner}" xmlns="http://www.w3.org/2000/svg"><circle cx="${inner / 2}" cy="${inner / 2}" r="${inner / 2}" fill="white"/></svg>`);
  const head = await sharp(source).extract({ left: 140, top: 110, width: 744, height: 744 }).resize(inner, inner, { fit: "cover" }).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: circle }, { input: head, left: inset, top: inset }]).png().toBuffer();
}

function ico(pngs) {
  const header = Buffer.alloc(6 + pngs.length * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, buffer }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2); header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(buffer.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += buffer.length;
  });
  return Buffer.concat([header, ...pngs.map(({ buffer }) => buffer)]);
}

const sizes = new Map();
for (const size of [16, 32, 48, 180, 192, 512]) sizes.set(size, await icon(size));
await Promise.all([
  writeFile(path.join(root, "public", "favicon.png"), sizes.get(32)),
  writeFile(path.join(root, "public", "faviconlarge.png"), sizes.get(192)),
  writeFile(path.join(root, "public", "favicon.ico"), ico([16, 32, 48].map((size) => ({ size, buffer: sizes.get(size) })))),
  writeFile(path.join(root, "app", "icon.png"), sizes.get(512)),
  writeFile(path.join(root, "app", "apple-icon.png"), sizes.get(180)),
]);

console.log("Generated Pons Bot favicon and app icons.");
