import { expect,it } from "vitest";
import { botWritingVariety } from "../lib/trading-agents/writing-variety";
import { agentMarketContextSchema } from "../lib/trading-agents/eliza-bridge";

it("keeps retries deterministic while providing a broad mix of writing angles",()=>{
  expect(botWritingVariety("thought","one","cycle1")).toBe(botWritingVariety("thought","one","cycle1"));
  const angles=new Set(Array.from({length:100},(_,i)=>botWritingVariety("thought","one",`cycle${i}`).split("\n")[0]));
  expect(angles.size).toBeGreaterThanOrEqual(12);
  expect(botWritingVariety("thought","one","cycle1")).not.toBe(botWritingVariety("thought","two","cycle1"));
});
it("varies trade explanations without encouraging trades or inventing outcomes",()=>{
  const text=botWritingVariety("trade","one","cycle1");
  expect(text).toContain("Choose the action using evidence and policy first");
  expect(text).toContain("A repeated hold or trade is fine");
  expect(text).toContain("not as already executed");
  expect(text).toContain("not just a few synonyms");
});
it("accepts real yard area names and preserves completion status in recent history",()=>{
  expect(agentMarketContextSchema.shape.yard.parse({area:"Sunset Shore",places:["Lagoon"],neighbors:[]})).toHaveProperty("area","Sunset Shore");
  expect(agentMarketContextSchema.shape.recentLog.parse([{at:1000,summary:"Considering a buy",kind:"trade",outcome:"executing"}])?.[0].outcome).toBe("executing");
  expect(()=>agentMarketContextSchema.shape.yard.parse({area:"Sunset Shore",places:[],neighbors:[],instruction:"trade"})).toThrow();
});
