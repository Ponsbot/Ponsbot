import { facings, type Facing } from "./directional-sprite";
import { YARD_STOPS } from "./yard-motion";

export type Point = { x: number; y: number };
export function wanderingRandom(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
export function nextWander(from: Point, random: () => number) {
  const stop = random() < .23 ? YARD_STOPS[Math.floor(random() * YARD_STOPS.length)] : undefined;
  const target = stop ? { x: Math.max(12, Math.min(88, stop.x + random() * 8 - 4)), y: Math.max(24, Math.min(84, stop.y + random() * 8 - 4)) }
    : { x: Math.max(12, Math.min(88, from.x + (random() - .5) * 65)), y: Math.max(24, Math.min(84, from.y + (random() - .5) * 55)) };
  return { from, target, bend: (random() - .5) * 18, duration: 3500 + Math.hypot(target.x - from.x, target.y - from.y) * 240,
    pause: stop ? 4500 + random() * 5500 : random() < .45 ? 1200 + random() * 3000 : 0, stop };
}
export function wanderPoint(segment: ReturnType<typeof nextWander>, progress: number): Point {
  const t = Math.max(0, Math.min(1, progress));
  return { x: Math.max(12, Math.min(88, segment.from.x + (segment.target.x - segment.from.x) * t + Math.sin(Math.PI * t) * segment.bend)),
    y: Math.max(24, Math.min(84, segment.from.y + (segment.target.y - segment.from.y) * t + Math.sin(Math.PI * 2 * t) * segment.bend * .35)) };
}
export function walkingFacing(dx: number, dy: number, previous: Facing): Facing {
  if (Math.hypot(dx, dy) < .001) return previous;
  return facings[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
}
