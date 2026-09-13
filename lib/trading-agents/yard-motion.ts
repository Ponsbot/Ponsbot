/** Decorative choreography only. Never used by trading or scheduling. */
export const YARD_STOPS = [
  { key: "garden", x: 24, y: 70, icon: "✿", label: "Tending the garden" },
  { key: "pond", x: 68, y: 72, icon: "≈", label: "Watching the pond" },
  { key: "board", x: 70, y: 32, icon: "▤", label: "Reading the noticeboard" },
  { key: "lookout", x: 11, y: 32, icon: "✧", label: "Looking through the telescope" },
] as const;

/** Feet coordinates beside the left eyepiece, outside the telescope footprint (x=13..23). */
export function centralYardActivity(point: {x:number;y:number}, walking: boolean) {
  if (walking) return undefined;
  return YARD_STOPS.find(place => place.key === "lookout"
    ? point.x < 13 && Math.hypot(place.x-point.x, place.y-point.y) <= 2.5
    : Math.hypot(place.x-point.x, place.y-point.y) < 10);
}

export function yardTour(seed: number) {
  const value = seed >>> 0, offset = value % YARD_STOPS.length;
  const direction = (value >>> 3) % 2 ? 1 : -1;
  const stops = Array.from({ length: 4 }, (_, i) => YARD_STOPS[(offset + direction * i + 4) % 4]);
  const jitter = (value >>> 5) % 7 - 3;
  return {
    duration: 64 + value % 29,
    delay: -(value % 89),
    stops: stops.map((stop, i) => ({ ...stop, x: stop.x + jitter, y: stop.y + ((value >>> (i + 8)) % 7 - 3) })),
  };
}
