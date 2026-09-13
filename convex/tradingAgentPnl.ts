import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { applyPnlFill, loadPnlState } from "../lib/trading-agents/pnl";
import { tradingAgentCapabilities } from "../lib/trading-agents/config";
import { z } from "zod";
import { feePriceBucket, FEE_PRICE_BUCKET_MS, historicalEthCandles } from "../lib/historical-fee-prices";

type Work = { id:Id<"tradingAgents">; stateJson?:string; jobs:Array<{id:Id<"tradingAgentExecutions">;cursor:number;state:string;withdraw:boolean;hasHashes:boolean}> };
export const lease = internalMutation({args:{},handler:async ctx => {
  if(!tradingAgentCapabilities().website) return null;
  const now=Date.now();
  const agent=await ctx.db.query("tradingAgents").withIndex("by_pnl_due",q=>q.eq("mode","live").lte("pnlNextAt",now)).first();
  if(!agent) return null;
  await ctx.db.patch(agent._id,{pnlNextAt:now+300000,pnlPending:true});
  const state=loadPnlState(agent.pnlStateJson);
  const jobs=await ctx.db.query("tradingAgentExecutions").withIndex("by_agent",q=>q.eq("agentId",agent._id).gt("_creationTime",state.cursor)).order("asc").take(3);
  return {id:agent._id,...(agent.pnlStateJson?{stateJson:agent.pnlStateJson}:{}),jobs:jobs.map(job=>({id:job._id,cursor:job._creationTime,state:job.state,withdraw:JSON.parse(job.intentJson).kind==="withdraw",hasHashes:job.hashes.length>0}))};
}});
export const price = internalQuery({args:{at:v.number()},handler:async(ctx,{at})=>{
  const price=await ctx.db.query("historicalEthPrices").withIndex("by_bucket",q=>q.eq("bucketAt",feePriceBucket(at))).unique();
  return price?.priceUsd && Number.isFinite(price.priceUsd) && price.priceUsd>0?price.priceUsd:null;
}});
export const savePrice=internalMutation({args:{bucketAt:v.number(),priceUsd:v.number()},handler:async(ctx,args)=>{
  if(!Number.isSafeInteger(args.bucketAt)||feePriceBucket(args.bucketAt)!==args.bucketAt||args.bucketAt<=0||args.bucketAt+FEE_PRICE_BUCKET_MS>Date.now()||!Number.isFinite(args.priceUsd)||args.priceUsd<=0) throw new Error("PNL_PRICE_INVALID");
  if(!await ctx.db.query("historicalEthPrices").withIndex("by_bucket",q=>q.eq("bucketAt",args.bucketAt)).unique()) await ctx.db.insert("historicalEthPrices",{...args,source:"coinbase-exchange:ETH-USD:300:open",fetchedAt:Date.now()});
}});
export const save = internalMutation({args:{agentId:v.id("tradingAgents"),expected:v.optional(v.string()),stateJson:v.string(),pending:v.boolean(),tradeValues:v.optional(v.array(v.object({jobId:v.id("tradingAgentExecutions"),usd:v.number()})))},handler:async(ctx,args)=>{
  const agent=await ctx.db.get(args.agentId);
  if(!agent || agent.pnlStateJson!==args.expected) return false;
  if(args.stateJson.length>500000) throw new Error("PNL_STATE_LIMIT");
  if((args.tradeValues?.length??0)>3) throw new Error("PNL_VALUE_LIMIT");
  for(const value of args.tradeValues??[]) {
    const job=await ctx.db.get(value.jobId);
    if(!job || job.agentId!==args.agentId || job.state==="active" || !Number.isFinite(value.usd) || value.usd<0) throw new Error("PNL_DISPLAY_VALUE_INVALID");
    await ctx.db.patch(job._id,{tradeUsd:value.usd});
  }
  await ctx.db.patch(agent._id,{pnlStateJson:args.stateJson,pnlAt:Date.now(),pnlPending:args.pending,pnlNextAt:Date.now()+(args.pending?60000:300000)});
  return true;
}});
const auditSchema=z.object({fill:z.object({token:z.string().regex(/^0x[0-9a-f]{40}$/),side:z.enum(["buy","sell"]),amount:z.string().regex(/^[1-9]\d*$/),at:z.number().positive(),cashWei:z.string().regex(/^\d+$/).nullable()}).nullable()});
/** Incremental backfill and ongoing accounting, one bot / three jobs per tick. No trading calls. */
export const tick=internalAction({args:{},handler:async ctx=>{
  if(!tradingAgentCapabilities().website || !process.env.WALLET_SIGNER_TOKEN) return;
  const work=await ctx.runMutation(makeFunctionReference<"mutation",Record<string,never>,Work|null>("tradingAgentPnl:lease"),{});
  if(!work) return;
  const state=loadPnlState(work.stateJson);
  const tradeValues:Array<{jobId:Id<"tradingAgentExecutions">;usd:number}>=[];
  let pending=work.jobs.length===3;
  for(const job of work.jobs) {
    if(job.state==="active") {pending=true;break;}
    try {
      if(!job.withdraw && job.hasHashes) {
        const base=new URL((process.env.WALLET_SIGNER_URL||`${process.env.NEXT_PUBLIC_SITE_URL}/api/wallet-signer`).replace(/\/$/,"")+"/v1/agents/pnl-audit");
        if(base.protocol!=="https:"||base.username||base.password) throw new Error("PNL_SIGNER_URL");
        const response=await fetch(base,{method:"POST",headers:{authorization:`Bearer ${process.env.WALLET_SIGNER_TOKEN}`,"content-type":"application/json"},body:JSON.stringify({jobId:job.id}),signal:AbortSignal.timeout(60000)});
        if(!response.ok) throw new Error("PNL_AUDIT_RETRY");
        const {fill}=auditSchema.parse(await response.json());
        if(fill) {
          let ethUsd=fill.cashWei===null?null:await ctx.runQuery(makeFunctionReference<"query",{at:number},number|null>("tradingAgentPnl:price"),{at:fill.at});
          if(fill.cashWei!==null && ethUsd===null) {
            const bucketAt=feePriceBucket(fill.at);
            if(bucketAt+FEE_PRICE_BUCKET_MS>Date.now()) throw new Error("PNL_CANDLE_NOT_CLOSED");
            const url=new URL("https://api.exchange.coinbase.com/products/ETH-USD/candles");
            url.search=new URLSearchParams({granularity:"300",start:new Date(bucketAt).toISOString(),end:new Date(bucketAt+FEE_PRICE_BUCKET_MS).toISOString()}).toString();
            const result=await fetch(url,{signal:AbortSignal.timeout(8000),headers:{Accept:"application/json"}});
            if(!result.ok) throw new Error("PNL_HISTORICAL_PRICE_RETRY");
            const candle=historicalEthCandles(await result.json(),bucketAt,bucketAt+FEE_PRICE_BUCKET_MS,Date.now()).find(p=>p.bucketAt===bucketAt);
            if(candle) { ethUsd=candle.priceUsd; await ctx.runMutation(makeFunctionReference<"mutation">("tradingAgentPnl:savePrice"),candle); }
          }
          if(fill.cashWei!==null && ethUsd===null) throw new Error("PNL_HISTORICAL_PRICE_RETRY");
          const cashUsd=fill.cashWei===null?null:Number(fill.cashWei)/1e18*ethUsd!;
          applyPnlFill(state,{...fill,cashUsd});
          if(cashUsd!==null) tradeValues.push({jobId:job.id,usd:cashUsd});
        }
      }
      state.cursor=job.cursor;
    } catch {pending=true;break;} // No accounting failure can interrupt or repeat a trade.
  }
  state.sales=state.sales.filter(s=>s.at>Date.now()-86400000);
  await ctx.runMutation(makeFunctionReference<"mutation">("tradingAgentPnl:save"),{agentId:work.id,...(work.stateJson?{expected:work.stateJson}:{}),stateJson:JSON.stringify(state),pending,tradeValues});
}});
