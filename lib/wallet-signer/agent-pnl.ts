import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { createPublicClient, decodeEventLog, erc20Abi, type Hex } from "viem";
import { z } from "zod";
import { resilientRobinhoodHttp } from "../rpc-http";
import { tracedNativeDelta, type PnlTrace } from "../trading-agents/pnl";
import type { BotExecution } from "../trading-agents/execution";

/** Read-only receipt reconciliation. No signing, broadcasting, or balance-difference inference. */
export async function auditAgentPnl(raw: unknown) {
  const { jobId } = z.object({ jobId: z.string().regex(/^[a-zA-Z0-9]{10,64}$/) }).strict().parse(raw);
  if (!process.env.NEXT_PUBLIC_CONVEX_URL || !process.env.WALLET_SIGNER_TOKEN) throw new Error("PNL_STORE_UNAVAILABLE");
  const job = await new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL).query(makeFunctionReference<"query", {secret:string;jobId:string}, BotExecution|null>("tradingAgentExecution:read"), {secret:process.env.WALLET_SIGNER_TOKEN,jobId});
  if (!job || job.state === "active" || job.hashes.length > 14) throw new Error("PNL_JOB_NOT_READY");
  const intent = JSON.parse(job.intentJson) as {kind:string;token?:string};
  if (intent.kind === "withdraw" || !job.hashes.length) return { fill: null };
  if (!intent.token || !/^0x[0-9a-fA-F]{40}$/.test(intent.token)) throw new Error("PNL_INVALID_TOKEN");
  const rpc = createPublicClient({transport:resilientRobinhoodHttp(process.env.ROBINHOOD_RPC_URL,{timeout:20000})});
  if (await rpc.getChainId() !== 4663) throw new Error("PNL_WRONG_CHAIN");
  const deltas = new Map<string,bigint>(); let native = 0n, at=0;
  for (const hash of new Set(job.hashes)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("PNL_INVALID_HASH");
    const receipt = await rpc.getTransactionReceipt({hash:hash as Hex});
    if (receipt.from.toLowerCase() !== job.from.toLowerCase()) throw new Error("PNL_OWNER_MISMATCH");
    if (receipt.status !== "success") continue;
    const trace = await (rpc.request as unknown as (args:unknown)=>Promise<PnlTrace>)({method:"debug_traceTransaction",params:[hash,{tracer:"callTracer"}]});
    if (!trace.type || trace.error || trace.from?.toLowerCase() !== job.from.toLowerCase()) throw new Error("PNL_TRACE_UNAVAILABLE");
    native += tracedNativeDelta(trace,job.from);
    const block = await rpc.getBlock({blockNumber:receipt.blockNumber});
    at=Math.max(at,Number(block.timestamp)*1000);
    for(const log of receipt.logs) {
      try {
        const event=decodeEventLog({abi:erc20Abi,data:log.data,topics:log.topics,eventName:"Transfer"});
        const delta=(event.args.to.toLowerCase()===job.from.toLowerCase()?event.args.value:0n)-(event.args.from.toLowerCase()===job.from.toLowerCase()?event.args.value:0n);
        const token=log.address.toLowerCase();
        deltas.set(token,(deltas.get(token)??0n)+delta);
      } catch { /* Other events are not token cash flows. */ }
    }
  }
  const token=intent.token.toLowerCase(), amount=deltas.get(token)??0n;
  if (amount===0n) return {fill:null};
  const side=amount>0n?"buy":"sell";
  if (side!==intent.kind) throw new Error("PNL_DIRECTION_MISMATCH");
  const unknownCounterpart=[...deltas].some(([asset,delta])=>asset!==token&&delta!==0n);
  return {fill:{token,side,amount:(amount<0n?-amount:amount).toString(),at,
    // Never substitute today's price for an unvalued historical paired-asset payout.
    cashWei:unknownCounterpart || (side==="buy"?native>=0n:native<=0n)?null:(native<0n?-native:native).toString()}};
}
