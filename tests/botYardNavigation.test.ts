import { describe, expect, it } from "vitest";
import { yardPath, yardWalkable, advanceYardPath } from "../lib/trading-agents/yard-navigation";
import { botAmount, botBuyLabel } from "../lib/trading-agents/display";
import { yardZones, zoneExits, zoneGates, opposite, zoneObjects, type YardZone, type YardDirection } from "../lib/trading-agents/yard-zones";

describe("shared ground-plane navigation", () => {
  it("connects each outer area back to the center on the opposite edge", () => {
    expect(Object.keys(zoneExits("center"))).toHaveLength(4);
    for (const direction of ["north", "east", "south", "west"] as const) {
      expect(zoneExits("center")[direction]).toBe(direction);
      expect(zoneExits(direction)).toEqual({ [opposite[direction]]: "center" });
      expect(zoneObjects[direction]).toHaveLength(3);
    }
  });
  it("keeps every area's gates reachable and furniture footprints blocked", () => {
    for (const zone of Object.keys(yardZones) as YardZone[]) {
      for (const direction of Object.keys(zoneExits(zone)) as YardDirection[]) {
        const gate = zoneGates[direction];
        const path = yardPath({ x: 50, y: 54 }, gate, zone);
        expect(path.at(-1)).toEqual(gate);
        for (let i=1;i<path.length;i++) for(let t=0;t<=1;t+=.1) {
          expect(yardWalkable({x:path[i-1].x+(path[i].x-path[i-1].x)*t,y:path[i-1].y+(path[i].y-path[i-1].y)*t},zone)).toBe(true);
        }
      }
      if (zone !== "center") for (const object of zoneObjects[zone]) expect(yardWalkable(object, zone)).toBe(false);
    }
  });
  it("routes around every obstacle and does not cut diagonal corners", () => {
    for (const [from, to] of [[{ x: 10, y: 60 }, { x: 24, y: 80 }], [{ x: 68, y: 70 }, { x: 92, y: 86 }], [{ x: 78, y: 24 }, { x: 80, y: 40 }], [{ x: 18, y: 24 }, { x: 18, y: 40 }]]) {
      const path = yardPath(from, to);
      expect(path.length).toBeGreaterThan(1);
      for (let i = 1; i < path.length; i++) {
        for (let t = 0; t <= 1; t += .1) expect(yardWalkable({ x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t })).toBe(true);
      }
      expect(yardWalkable(advanceYardPath(path, 6))).toBe(true);
    }
  });
  it("formats ETH concisely and labels completed buys only", () => {
    expect(botAmount("79191298460125201")).toBe("0.079191");
    expect(botBuyLabel({ side: "buy", outcome: "live_filled", buyUsd: 12.345, tokenSymbol: "PONSBOT" })).toBe("Bought PONSBOT ($12.35)");
    expect(botBuyLabel({ side: "sell", outcome: "live_filled", tradeUsd: 25, amountIn:"123000000", tokenDecimals:6, tokenSymbol:"PONSBOT" })).toBe("Sold 123 PONSBOT ($25.00)");
    expect(botBuyLabel({ side:"buy", outcome:"live_filled", tradeUsd:20, buyUsd:30, amountOut:"1000000", tokenDecimals:6, tokenSymbol:"TEST" })).toBe("Bought 1 TEST ($20.00)");
    expect(botBuyLabel({ side:"sell", outcome:"live_filled", buyUsd:30, tokenSymbol:"TEST" })).toBe("Sold TEST");
    expect(botBuyLabel({ side:"sell", outcome:"live_filled", tradeUsd:NaN, tokenSymbol:"TEST" })).toBe("Sold TEST");
    expect(botBuyLabel({ side: "buy", outcome: "failed", buyUsd: 12 })).toBeNull();
  });
});
