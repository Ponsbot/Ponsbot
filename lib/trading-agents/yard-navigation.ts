/** Shared ground-plane map. Positions refer to feet, not heads or sprite centers. */
export type YardPoint = { x: number; y: number };
import { zoneObjects, type YardZone } from "./yard-zones";
export const yardObstacles = [
  { name: "garden", x1: 8, x2: 24, y1: 62, y2: 76 },
  { name: "pond", x1: 70, x2: 91, y1: 62, y2: 82 },
  { name: "board", x1: 73, x2: 88, y1: 28, y2: 34 },
  { name: "lookout", x1: 13, x2: 23, y1: 29, y2: 35 },
] as const;
export function yardWalkable(p: YardPoint, zone: YardZone = "center") {
  const obstacles = zone === "center" ? yardObstacles : zoneObjects[zone].map(o => ({ x1: o.x - (o.kind === "water" ? 12 : 8), x2: o.x + (o.kind === "water" ? 12 : 8), y1: o.y - (o.kind === "water" ? 12 : 5), y2: o.y + 2 }));
  return p.x >= 8 && p.x <= 92 && p.y >= 18 && p.y <= 90
    && !obstacles.some(o => p.x >= o.x1 && p.x <= o.x2 && p.y >= o.y1 && p.y <= o.y2);
}
const key = (p: YardPoint) => `${p.x},${p.y}`;
const maps = new Map<YardZone, YardPoint[]>();
for (const zone of ["center", "north", "east", "south", "west"] as const) {
  const cells: YardPoint[] = [];
  for (let y = 18; y <= 90; y += 2) for (let x = 8; x <= 92; x += 2) if (yardWalkable({ x, y }, zone)) cells.push({ x, y });
  maps.set(zone, cells);
}
export function nearestYardPoint(point: YardPoint, zone: YardZone = "center"): YardPoint {
  return maps.get(zone)!.reduce((best, p) => Math.hypot(p.x - point.x, p.y - point.y) < Math.hypot(best.x - point.x, best.y - point.y) ? p : best);
}
export function yardPath(from: YardPoint, to: YardPoint, zone: YardZone = "center"): YardPoint[] {
  const start = nearestYardPoint(from, zone), end = nearestYardPoint(to, zone), queue = [start];
  const previous = new Map<string, YardPoint | null>([[key(start), null]]);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (key(current) === key(end)) {
      const path: YardPoint[] = []; let p: YardPoint | null = current;
      while (p) { path.unshift(p); p = previous.get(key(p)) ?? null; }
      return path;
    }
    for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, 2], [2, -2], [-2, -2]]) {
      const next = { x: current.x + dx, y: current.y + dy };
      // No diagonal corner-cutting through furniture footprints.
      if (!yardWalkable(next, zone) || !yardWalkable({ x: current.x + dx, y: current.y }, zone) || !yardWalkable({ x: current.x, y: current.y + dy }, zone) || previous.has(key(next))) continue;
      previous.set(key(next), current); queue.push(next);
    }
  }
  return [start];
}
export function advanceYardPath(path: YardPoint[], distance: number): YardPoint {
  let point = path[0];
  for (const next of path.slice(1)) {
    const length = Math.hypot(next.x - point.x, next.y - point.y);
    if (length > distance) return { x: point.x + (next.x - point.x) * distance / length, y: point.y + (next.y - point.y) * distance / length };
    distance -= length; point = next;
  }
  return point;
}
