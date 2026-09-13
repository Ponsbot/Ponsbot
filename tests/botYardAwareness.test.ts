import {expect,it} from 'vitest';
import {yardAwareness} from '../lib/trading-agents/yard-awareness';
import {agentMarketContextSchema} from '../lib/trading-agents/eliza-bridge';
const now=1000000;
it('describes proximity to footprint edges, not sprite centers',()=>{
  const context=yardAwareness({zone:'south',x:90,y:74,at:now-10000},now);
  expect(context.nearby?.[0]).toEqual({name:'Lagoon',proximity:'beside'});
  expect(context.position?.region).toBe('southern eastern part');
});
it('knows central landmarks and does not invent nearby objects in open space',()=>{
  expect(yardAwareness({zone:'center',x:25,y:70,at:now},now).nearby?.[0]).toEqual({name:'Garden',proximity:'beside'});
  expect(yardAwareness({zone:'center',x:50,y:50,at:now},now).nearby).toEqual([]);
});
it('omits location claims if absent, stale, invalid or in the future',()=>{
  expect(yardAwareness(undefined,now)).toEqual({});
  for(const p of [{x:10,y:10,at:now-120001},{x:10,y:10,at:now+1},{x:NaN,y:10,at:now}]) expect(yardAwareness(p,now)).toEqual({});
});
it('accepts generated context for all five areas in the strict model schema',()=>{
  for(const zone of ['center','north','east','south','west'] as const) {
    const context={area:zone,places:[],neighbors:[],...yardAwareness({zone,x:25,y:38,at:now},now)};
    expect(agentMarketContextSchema.shape.yard.parse(context)).toEqual(context);
  }
});
