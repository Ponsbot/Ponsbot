import {afterEach,expect,it,vi} from "vitest";
import {getFunctionName} from "convex/server";
vi.mock('../convex/llm',()=>({openRouter:vi.fn()}));
import {inventoryTokens,refreshAfterExecution} from "../convex/tradingAgentLive";
import {initialPnlState} from "../lib/trading-agents/pnl";
const invoke=(fn:unknown,ctx:unknown,args:unknown)=>(fn as {_handler:(ctx:unknown,args:unknown)=>Promise<unknown>})._handler(ctx,args);
const a='0x'+'1'.repeat(40),b='0x'+'2'.repeat(40),c='0x'+'3'.repeat(40);
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('recovers a previously omitted holding from trade accounting without retaining sold lots',async()=>{
  const s=initialPnlState();s.lots[b]={amount:'20',costUsd:1};s.lots[c]={amount:'0',costUsd:0};
  expect(await invoke(inventoryTokens,{db:{get:async()=>({liveHoldings:{tokens:[{token:a,amount:'10'}]},pnlStateJson:JSON.stringify(s)})}},{agentId:'agent'})).toEqual([a,b]);
});
it('post-trade refresh rechecks previous holdings plus the traded token before replacing inventory',async()=>{
  vi.stubEnv('TRADING_AGENTS_ENABLED','true');vi.stubEnv('TRADING_AGENTS_LIVE_ENABLED','true');vi.stubEnv('WALLET_SIGNER_TOKEN','test');vi.stubEnv('WALLET_SIGNER_URL','https://example.test/api/wallet-signer');
  const fetch=vi.fn(async()=>({ok:true,json:async()=>({snapshot:{cashWei:'10',tokens:[{token:a,amount:'10'},{token:b,amount:'20'},{token:c,amount:'30'}],complete:true,observedAt:Date.now()}})}));vi.stubGlobal('fetch',fetch);
  const runQuery=vi.fn(async(ref:Parameters<typeof getFunctionName>[0])=>getFunctionName(ref).endsWith(':inventoryTokens')?[a,b]:{agentId:'agent',from:a,state:'confirmed',intentJson:JSON.stringify({token:c}),confirmedBlock:'123'});
  const runMutation=vi.fn();await invoke(refreshAfterExecution,{runQuery,runMutation},{jobId:'job'});
  const calls=fetch.mock.calls as unknown as Array<[URL,{body:string}]>;
  expect(JSON.parse(calls[0][1].body).tokens).toEqual([a,b,c]);
  expect(runMutation).toHaveBeenCalledTimes(1);
});
