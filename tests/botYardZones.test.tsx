import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { BotYard } from "../components/BotYard";
import { tick } from "../convex/tradingAgentPositions";
import { emptyZoneCounts, yardZones, type YardZone } from "../lib/trading-agents/yard-zones";
import { readFileSync } from "node:fs";

vi.stubGlobal("React", React);
afterEach(() => vi.unstubAllEnvs());

it("renders directional exits, hides zero badges and removes the interior sign", () => {
  const html = renderToStaticMarkup(<BotYard bots={[]} zoneCounts={{...emptyZoneCounts(),north:3}} />);
  expect(html.match(/aria-label="Go /g)).toHaveLength(4);
  expect(html).not.toContain(">BOT YARD<");
  expect(html).not.toContain('aria-label="Yard areas"');
  expect(html).not.toContain(">0</span>");
  expect(html).toContain(">3</span>");
});
it("gives each outer area distinct landmarks and one return exit", () => {
  for(const zone of Object.keys(yardZones).filter(z=>z!=="center") as Exclude<YardZone,"center">[]) {
    const html=renderToStaticMarkup(<BotYard bots={[]} zone={zone}/>);
    expect(html.match(/aria-label="Go /g)).toHaveLength(1);
    expect(html).toContain(yardZones[zone].places[0].toUpperCase());
  }
});
it("does not apply central scene hiding rules to outer landmarks",()=>{
  const css=readFileSync(new URL("../components/BotYard.module.css",import.meta.url),"utf8");
  expect(css).not.toContain(".scenery:not([data-scene-layer=ground])");
  expect(css).toContain(".scenery[data-scene-layer]:not([data-scene-layer=ground])");
  const spacing=readFileSync(new URL("../components/BotYardHowItWorks.module.css",import.meta.url),"utf8");
  expect(spacing).toContain("margin: 22px 0");
});
it("persists a crossed area with its local coordinates and counts only once on retry", async () => {
  vi.stubEnv("TRADING_AGENTS_ENABLED","true"); vi.stubEnv("TRADING_AGENTS_WEBSITE_ENABLED","true");
  const bot = { _id:"bot", sprite:{seed:123}, yardPosition:{x:50,y:18,goalX:50,goalY:18,at:10000,zone:"center",exitDirection:"north"} };
  const patch=vi.fn(async (_id:string, fields:object)=>Object.assign(bot,fields));
  const insert=vi.fn();
  const query=vi.fn((table:string)=>({withIndex:()=> table==="tradingAgents" ? {paginate:async()=>({page:[bot],isDone:true})} : {unique:async()=>null}}));
  const ctx={db:{query,patch,insert},scheduler:{runAfter:vi.fn()}};
  const invoke=(args:object)=>(tick as unknown as {_handler:(ctx:unknown,args:unknown)=>Promise<void>})._handler(ctx,args);
  await invoke({at:20000});
  expect(bot.yardPosition.zone).toBe("north");
  expect(bot.yardPosition.y).toBeGreaterThan(80);
  expect(bot.yardPosition.exitDirection).toBeUndefined();
  expect(insert).toHaveBeenLastCalledWith("tradingAgentYardCounts",expect.objectContaining({north:1,center:0}));
  await invoke({at:20000});
  expect(patch).toHaveBeenCalledTimes(1);
  expect(insert).toHaveBeenLastCalledWith("tradingAgentYardCounts",expect.objectContaining({north:1,center:0}));
});
