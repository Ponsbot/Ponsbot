/** Decorative choreography only. Never used by trading or scheduling. */
export const YARD_STOPS = [
  { key: "garden", x: 24, y: 70, icon: "✿", label: "Tending the garden" },
  { key: "pond", x: 68, y: 72, icon: "≈", label: "Watching the pond" },
  { key: "board", x: 70, y: 32, icon: "▤", label: "Reading the noticeboard" },
  { key: "lookout", x: 27, y: 32, icon: "✧", label: "Looking through the telescope" },
] as const;

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
