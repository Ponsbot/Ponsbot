// Targeted historical repair. No wallet transactions or X publications.
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const file = ".deployment-private/missing-curve-volume-repair.json";
const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL);
if (process.argv.includes("--apply")) {
  const report = JSON.parse(await readFile(file, "utf8"));
  // Keep the deployed authorization value in memory, never in the report/logs.
  const secret = process.env.MARKET_INDEX_SECRET || execFileSync(process.execPath, ["--use-system-ca", "node_modules/convex/bin/main.js", "env", "get", "MARKET_INDEX_SECRET"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!secret) throw new Error("MARKET_INDEX_SECRET required");
  for (const entry of report.entries) console.log(await convex.mutation(api.lifetimeVolume.repairMissingCurveHistory, { secret, ...entry.import }));
  process.exit(0);
}
const query = `const rows=await ctx.db.query('tokenLifetimeVolumes').collect();const out=[];for(const row of rows.filter(r=>r.enabled!==false&&r.source==='bonding_curve'&&r.lastError?.includes('onchain historical'))){const launch=await ctx.db.query('tokenLaunches').filter(q=>q.eq(q.field('tokenAddress'),row.tokenAddress)).first();if(!launch?.transactionHash)throw new Error('launch receipt missing');out.push({row,tx:launch.transactionHash,symbol:launch.symbol});}return out;`;
const candidates = JSON.parse(execFileSync(process.execPath, ["--use-system-ca", "--env-file-if-exists=.env.local", "node_modules/convex/bin/main.js", "run", "--inline-query", query], { encoding: "utf8" }));
const rpc = createPublicClient({ transport: http(process.env.WEBSITE_PUBLIC_RPC_URL || process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { timeout: 30000, retryCount: 2 }) });
const HOUR = 3600000;
const cutoff = Math.floor(Date.now() / HOUR) * HOUR - 1;
const head = await rpc.getBlock();
let lo=0n, hi=head.number;
while(lo<hi){const mid=(lo+hi+1n)/2n;const b=await rpc.getBlock({blockNumber:mid});if(Number(b.timestamp)*1000<=cutoff)lo=mid;else hi=mid-1n;}
const endBlock=lo;
const BUY=parseAbiItem("event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 creatorTax)");
const SELL=parseAbiItem("event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 creatorTax)");
const report={cutoff,endBlock:String(endBlock),entries:[]};
const times=new Map();
for(const {row,tx,symbol} of candidates){
  const receipt=await rpc.getTransactionReceipt({hash:tx});
  const [pairSymbol,decimals]=await Promise.all([rpc.readContract({address:row.pairToken,abi:parseAbi(["function symbol() view returns(string)"]),functionName:"symbol"}),rpc.readContract({address:row.pairToken,abi:parseAbi(["function decimals() view returns(uint8)"]),functionName:"decimals"})]);
  const events=[];
  for(let start=receipt.blockNumber;start<=endBlock;start+=100000n){
    const end=start+99999n<endBlock?start+99999n:endBlock;
    const [buys,sells]=await Promise.all([rpc.getLogs({address:row.poolAddress,event:BUY,fromBlock:start,toBlock:end,strict:true}),rpc.getLogs({address:row.poolAddress,event:SELL,fromBlock:start,toBlock:end,strict:true})]);
    events.push(...buys.map(e=>({block:e.blockNumber,raw:e.args.quoteIn})),...sells.map(e=>({block:e.blockNumber,raw:e.args.quoteOut})));
  }
  const hourly=new Map();
  for(const e of events){if(!times.has(String(e.block)))times.set(String(e.block),Number((await rpc.getBlock({blockNumber:e.block})).timestamp)*1000);const hour=Math.floor(times.get(String(e.block))/HOUR)*HOUR;hourly.set(hour,(hourly.get(hour)||0n)+e.raw);}
  let candles=[];
  if(hourly.size){
    const start=Math.min(...hourly.keys());
    const response=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(pairSymbol)}?period1=${Math.floor((start-72*HOUR)/1000)}&period2=${Math.floor((cutoff+HOUR)/1000)}&interval=1h`);
    if(!response.ok)throw new Error(`Historical price HTTP ${response.status}`);
    const data=(await response.json()).chart?.result?.[0];
    const points=(data?.timestamp||[]).flatMap((t,i)=>{const price=data.indicators?.quote?.[0]?.close?.[i];return typeof price==='number'&&price>0?[[t*1000,price]]:[];});
    candles=[...hourly].map(([hour,raw])=>{const before=points.filter(p=>p[0]<=hour).sort((a,b)=>b[0]-a[0])[0];if(!before||hour-before[0]>72*HOUR)throw new Error(`Historical price gap ${pairSymbol}`);return [hour,Number(raw)/10**Number(decimals)*before[1]];});
  }
  const total=candles.reduce((s,c)=>s+c[1],0);
  report.entries.push({symbol,pairSymbol,eventCount:events.length,fromBlock:String(receipt.blockNumber),hourlyRaw:[...hourly].map(([h,r])=>[h,String(r)]),candles,priceMethod:"preceding_hourly_market_price",import:{tokenAddress:row.tokenAddress,poolAddress:row.poolAddress,expectedRevision:row.revision||0,through:cutoff,confirmedVolumeUsd:total}});
  console.log(JSON.stringify({symbol,pairSymbol,events:events.length,total}));
  await mkdir(".deployment-private",{recursive:true});await writeFile(file,JSON.stringify(report,null,2));
}
console.log(`Saved ${report.entries.length} scoped repairs to ${file}`);
