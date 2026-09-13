import { afterEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { tick, save } from "../convex/tradingAgentPnl";
import { initialPnlState } from "../lib/trading-agents/pnl";
import { geckoSharedFetch } from "../lib/gecko-shared";
vi.mock('../lib/gecko-shared',()=>({geckoSharedFetch:vi.fn()}));
const invoke=(fn:unknown,ctx:unknown,args:unknown)=>(fn as {_handler:(ctx:unknown,args:unknown)=>Promise<unknown>})._handler(ctx,args);
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
function enable(){vi.stubEnv("TRADING_AGENTS_ENABLED","true");vi.stubEnv("TRADING_AGENTS_WEBSITE_ENABLED","true");vi.stubEnv("WALLET_SIGNER_TOKEN","test-secret");vi.stubEnv("NEXT_PUBLIC_SITE_URL","https://example.com");}
function context(jobs:unknown[],stateJson?:string){
  const runMutation=vi.fn(async (ref:Parameters<typeof getFunctionName>[0])=>getFunctionName(ref).endsWith(":lease")?{id:"agent",jobs,stateJson}:true);
  return {runMutation,runQuery:vi.fn(async()=>2000)};
}
it("does not call the accounting endpoint for withdrawals or unbroadcast failures",async()=>{
  enable(); const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
  const ctx=context([{id:"one",cursor:1,state:"confirmed",withdraw:true,hasHashes:true},{id:"two",cursor:2,state:"failed",withdraw:false,hasHashes:false}]);
  await invoke(tick,ctx,{});
  expect(fetch).not.toHaveBeenCalled();
  const saved=ctx.runMutation.mock.calls.at(-1) as unknown as [unknown,{stateJson:string}];
  expect(JSON.parse(saved[1].stateJson)).toMatchObject({cursor:2,lifetimeUsd:0});
});
it("stops at a pending execution instead of skipping its purchase basis",async()=>{
  enable();const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
  const ctx=context([{id:"one",cursor:1,state:"active",withdraw:false,hasHashes:true},{id:"two",cursor:2,state:"confirmed",withdraw:false,hasHashes:true}]);
  await invoke(tick,ctx,{});
  expect(fetch).not.toHaveBeenCalled();
  const args=(ctx.runMutation.mock.calls.at(-1) as unknown as [unknown,{stateJson:string;pending:boolean}])[1];
  expect(JSON.parse(args.stateJson).cursor).toBe(0);expect(args.pending).toBe(true);
});
it("keeps its cursor on RPC failure and never invokes an execution or signer action",async()=>{
  enable();vi.stubGlobal("fetch",vi.fn(async()=>({ok:false})));
  const ctx=context([{id:"one",cursor:1,state:"confirmed",withdraw:false,hasHashes:true}]);
  await invoke(tick,ctx,{});
  const args=(ctx.runMutation.mock.calls.at(-1) as unknown as [unknown,{stateJson:string;pending:boolean}])[1];
  expect(JSON.parse(args.stateJson).cursor).toBe(0);expect(args.pending).toBe(true);
  expect(ctx.runMutation.mock.calls.map(call=>getFunctionName(call[0]))).toEqual(["tradingAgentPnl:lease","tradingAgentPnl:save"]);
});
it("records historical USD basis from an audited buy",async()=>{
  enable();vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,json:async()=>({fill:{token:"0x1111111111111111111111111111111111111111",side:"buy",amount:"100",cashWei:"10000000000000000",at:1000}})})));
  const ctx=context([{id:"one",cursor:1,state:"confirmed",withdraw:false,hasHashes:true}]);
  await invoke(tick,ctx,{});
  const args=(ctx.runMutation.mock.calls.at(-1) as unknown as [unknown,{stateJson:string}])[1];
  const state=JSON.parse(args.stateJson);expect(state.lifetimeUsd).toBe(0);expect(Object.values(state.lots)).toEqual([{amount:"100",costUsd:20}]);
});
it("rejects stale accounting commits so overlapping retries cannot double-count",async()=>{
  const patch=vi.fn();
  expect(await invoke(save,{db:{get:async()=>({pnlStateJson:"newer"}),patch}},{agentId:"agent",expected:"older",stateJson:JSON.stringify(initialPnlState()),pending:false})).toBe(false);
  expect(patch).not.toHaveBeenCalled();
});
it('prices new holdings even while an execution is pending accounting',async()=>{
  enable(); const token='0x39dbed3a2bd333467115de45665cc57f813c4571',now=Date.now();
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({complete:true,observedAt:now,tokens:[{token,amount:'100'}]})})));
  vi.mocked(geckoSharedFetch).mockResolvedValue(new Response(JSON.stringify({data:[{attributes:{address:token,decimals:0,price_usd:'0.6'}}]})));
  const runMutation=vi.fn(async(ref:Parameters<typeof getFunctionName>[0])=>getFunctionName(ref).endsWith(':lease')?{id:'agent',walletAddress:token,stateJson:JSON.stringify(initialPnlState()),jobs:[{id:'job',state:'active'}]}:true);
  await invoke(tick,{runMutation},{});
  const args=(runMutation.mock.calls.at(-1) as unknown as [unknown,{stateJson:string;pending:boolean}])[1];
  expect(args.pending).toBe(true);
  expect(JSON.parse(args.stateJson).marks.at(-1).prices[token]).toBe(0.6);
  expect(JSON.parse(args.stateJson).lots).toEqual({});
});
it('refreshes unrealized values without a new trade or signing request',async()=>{
  enable(); const token='0x1111111111111111111111111111111111111111',now=Date.now();
  const state=initialPnlState(); state.lots[token]={amount:'100',costUsd:20};
  state.open=[{token,amount:'100',costUsd:20,at:now-1000}];
  const fetch=vi.fn(async()=>({ok:true,json:async()=>({complete:true,observedAt:now,tokens:[{token,amount:'100'}]})}));
  vi.stubGlobal('fetch',fetch);
  vi.mocked(geckoSharedFetch).mockResolvedValue(new Response(JSON.stringify({data:[{attributes:{address:token,decimals:0,price_usd:'0.3'}}]}),{headers:{'x-market-observed-at':String(now)}}));
  const runMutation=vi.fn(async(ref:Parameters<typeof getFunctionName>[0])=>getFunctionName(ref).endsWith(':lease')?{id:'agent',walletAddress:token,stateJson:JSON.stringify(state),jobs:[]}:true);
  await invoke(tick,{runMutation},{});
  const args=(runMutation.mock.calls.at(-1) as unknown as [unknown,{stateJson:string}])[1];
  expect(JSON.parse(args.stateJson).unrealized).toMatchObject({dayUsd:10,lifetimeUsd:10});
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(expect.objectContaining({pathname:'/api/wallet-signer/v1/agents/live-balances'}),expect.anything());
});
