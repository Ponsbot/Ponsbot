export const yardZones = {
  center: { name: "Central Yard", color: "#cbdcb0", places: ["Garden", "Pond", "Noticeboard", "Lookout"] },
  north: { name: "Whispering Woods", color: "#a8c79e", places: ["Ancient oak", "Mushroom circle", "Campfire"] },
  east: { name: "Tinker Terrace", color: "#ded3b7", places: ["Workbench", "Windmill", "Charging station"] },
  south: { name: "Sunset Shore", color: "#ecdcb0", places: ["Lagoon", "Sandcastle", "Hammock"] },
  west: { name: "Starlight Meadow", color: "#c7c6df", places: ["Observatory", "Crystal garden", "Moon dial"] },
} as const;
export type YardZone = keyof typeof yardZones;
export type YardDirection = "north" | "east" | "south" | "west";
export type ZoneCounts = Record<YardZone, number>;
export const emptyZoneCounts = (): ZoneCounts => ({ center: 0, north: 0, east: 0, south: 0, west: 0 });
export const opposite: Record<YardDirection, YardDirection> = { north: "south", south: "north", east: "west", west: "east" };
export const zoneGates = { north: { x: 50, y: 18 }, east: { x: 92, y: 54 }, south: { x: 50, y: 90 }, west: { x: 8, y: 54 } };
export function zoneExits(zone: YardZone): Partial<Record<YardDirection, YardZone>> {
  return zone === "center" ? { north: "north", east: "east", south: "south", west: "west" } : { [opposite[zone]]: "center" };
}
export const zoneObjects = {
  north: [{ kind: "tree", label: "ANCIENT OAK", x: 23, y: 39 }, { kind: "mushroom", label: "MUSHROOM CIRCLE", x: 76, y: 72 }, { kind: "fire", label: "CAMPFIRE", x: 72, y: 36 }],
  east: [{ kind: "bench", label: "WORKBENCH", x: 24, y: 72 }, { kind: "windmill", label: "WINDMILL", x: 77, y: 37 }, { kind: "charger", label: "CHARGING STATION", x: 24, y: 34 }],
  south: [{ kind: "water", label: "LAGOON", x: 76, y: 74 }, { kind: "castle", label: "SANDCASTLE", x: 24, y: 72 }, { kind: "hammock", label: "HAMMOCK", x: 23, y: 35 }],
  west: [{ kind: "dome", label: "OBSERVATORY", x: 24, y: 38 }, { kind: "crystals", label: "CRYSTAL GARDEN", x: 76, y: 72 }, { kind: "dial", label: "MOON DIAL", x: 74, y: 35 }],
} as const;
