import { describe, expect, it } from "vitest";
import { botDirectionalSprites, facings } from "../lib/trading-agents/directional-sprite";
import { createBotSprite, botSpriteDataUrl } from "../lib/trading-agents/sprite";
import { nextWander, wanderingRandom, wanderPoint, walkingFacing, stableWalkingFacing, botMotionProfile } from "../lib/trading-agents/wander";

describe("directional yard sprites", () => {
  it("adds repeatable movement personality without modifying the saved sprite",()=>{
    const sprite=createBotSprite("Pons Bot Bot","nature-loving heart of gold");
    const saved=JSON.stringify(sprite), image=botSpriteDataUrl(sprite);
    expect(botMotionProfile(sprite)).toEqual(botMotionProfile(sprite));
    expect(botMotionProfile({...sprite,archetype:"jelly"}).style).toBe("float");
    expect(botMotionProfile({...sprite,archetype:"rover"}).style).toBe("roll");
    expect(botMotionProfile({...sprite,archetype:"plant"}).style).toBe("walk");
    expect(JSON.stringify(sprite)).toBe(saved);expect(botSpriteDataUrl(sprite)).toBe(image);
  });
  it("keeps the facing steady near an angular boundary but turns for clear direction changes",()=>{
    const at=(degrees:number)=>[Math.cos(degrees*Math.PI/180),Math.sin(degrees*Math.PI/180)];
    const [x,y]=at(24);
    expect(stableWalkingFacing(x,y,"e")).toBe("e");
    expect(stableWalkingFacing(x,y,"se")).toBe("se");
    expect(stableWalkingFacing(0,1,"e")).toBe("s");
    expect(stableWalkingFacing(0,0,"n")).toBe("n");
  });
  it("generates eight reusable angles and preserves the original front", () => {
    for (const sprite of [createBotSprite("Moss", "A garden bot"), { version: 1 as const, seed: 123, archetype: "robot" as const, palette: 0 }]) {
      const frames = botDirectionalSprites(sprite);
      expect(Object.keys(frames)).toEqual([...facings]);
      expect(new Set(Object.values(frames)).size).toBe(8);
      expect(frames.s).toBe(botSpriteDataUrl(sprite));
      expect(botDirectionalSprites(sprite)).toEqual(frames);
    }
  });
  it("maps movement to all eight facings", () => {
    const deltas = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    expect(deltas.map(([x, y]) => walkingFacing(x, y, "s"))).toEqual([...facings]);
    expect(walkingFacing(0, 0, "w")).toBe("w");
  });
  it("wanders beyond landmarks while retaining bounds and continuous segment endpoints", () => {
    const random = wanderingRandom(391), seen = new Set<string>();
    let position = { x: 50, y: 50 }, ordinary = 0;
    for (let n = 0; n < 100; n++) {
      const segment = nextWander(position, random);
      if (segment.stop) seen.add(segment.stop.key); else ordinary++;
      expect(wanderPoint(segment, 0)).toEqual(position);
      for (let t = 0; t <= 1; t += .1) {
        const point = wanderPoint(segment, t);
        expect(point.x).toBeGreaterThanOrEqual(12); expect(point.x).toBeLessThanOrEqual(88);
        expect(point.y).toBeGreaterThanOrEqual(24); expect(point.y).toBeLessThanOrEqual(84);
      }
      position = wanderPoint(segment, 1);
      expect(position.x).toBeCloseTo(segment.target.x); expect(position.y).toBeCloseTo(segment.target.y);
    }
    expect(ordinary).toBeGreaterThan(50); expect(seen.size).toBe(4);
  });
});
