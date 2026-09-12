import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { createPublicClient, keccak256, parseEther, parseTransaction, recoverTransactionAddress, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import { z } from "zod";
import { resilientRobinhoodHttp } from "../rpc-http";
import { DEFAULT_PONS_V2_FACTORY } from "../pons-runtime-defaults";
import { botEnvelopeSchema, anyBotExecutionEnabled, ownerBotExecutionEnabled, ownerBotIntent, type BotExecution, type BotEnvelope } from "../trading-agents/execution";
import { tradingAgentCapabilities } from "../trading-agents/config";
import { assertLiveEnvelope, liveBotOperation, liveReceiptOutput } from "./agent-live-execution";
import { broadcastTransaction, prepareExecutionEnvelope, provisionWallet, signPreparedEnvelope } from "./service";
import type { ExecutionRequest } from "./policy";

const requestSchema = z.object({ jobId: z.string().regex(/^[a-zA-Z0-9]{10,64}$/) }).strict();
export type ExecutionStore = { read(): Promise<BotExecution | null>; save(step: number, kind: "envelope" | "signed" | "receipt" | "failure", value: string): Promise<unknown> };
export type ExecutionDependencies = {
  prepare(job: BotExecution): Promise<BotEnvelope>;
  sign(job: BotExecution, envelope: BotEnvelope): Promise<{ transactionHash: string; signedTransaction: string }>;
  broadcast(job: BotExecution, envelope: BotEnvelope, signed: { transactionHash: string; signedTransaction: string }): Promise<unknown>;
  receipt(job: BotExecution, signed: { transactionHash: string; signedTransaction: string }): Promise<{ success: boolean; block: string; outputAmount?: string; gasWei?: string } | null>;
};
/** Every stage re-reads the journal. An uncertain write/sign/broadcast never creates a replacement spend. */
export async function runBotExecution(store: ExecutionStore, deps: ExecutionDependencies) {
  let job = await store.read();
  if (!job || job.state !== "active") return;
  if (!job.envelopeJson) {
    let envelope: BotEnvelope;
    try { envelope = await deps.prepare(job); }
    catch (error) {
      // A temporarily lagging provider after approval is retryable, not a trade failure.
      if (error instanceof Error && error.message === "AGENT_RPC_BEHIND") return;
      await store.save(job.step, "failure", "preparation_failed"); return;
    }
    await store.save(job.step, "envelope", JSON.stringify(envelope));
  }
  job = await store.read();
  if (!job || job.state !== "active" || !job.envelopeJson) return;
  const signingStep = job.step;
  if (!job.signedJson) {
    const envelope = botEnvelopeSchema.parse(JSON.parse(job.envelopeJson));
    const signed = await deps.sign(job, envelope);
    await store.save(job.step, "signed", JSON.stringify(signed));
  }
  job = await store.read();
  if (!job || job.state !== "active" || job.step !== signingStep || !job.signedJson || !job.envelopeJson) return;
  const signed = JSON.parse(job.signedJson) as { transactionHash: string; signedTransaction: string };
  let receipt = await deps.receipt(job, signed);
  if (!receipt) {
    await deps.broadcast(job, botEnvelopeSchema.parse(JSON.parse(job.envelopeJson)), signed);
    receipt = await deps.receipt(job, signed);
  }
  if (receipt) await store.save(job.step, "receipt", JSON.stringify(receipt));
}

function identity(job: BotExecution): Omit<ExecutionRequest, "operation"> {
  if (!/^[a-zA-Z0-9]{10,64}$/.test(job.agentId)) throw new Error("INVALID_AGENT_ID");
  return { idempotencyKey: `agent:${job._id}:${job.step}`, chainId: 4663, ownerReference: `agent:${job.agentId}`,
    walletRef: job.from, expectedFrom: job.from, requireSimulation: true, minimumNonce: job.minimumNonce };
}
async function verifyWallet(job: BotExecution) {
  const bot = await provisionWallet(`agent:${job.agentId}`);
  if (bot.address.toLowerCase() !== job.from.toLowerCase()) throw new Error("BOT_WALLET_MISMATCH");
  if (job.cycleId) {
    if (!tradingAgentCapabilities().liveTrading || job.destination.toLowerCase() !== job.from.toLowerCase()) throw new Error("LIVE_DISABLED");
    return;
  }
  const owner = await provisionWallet(`x:${job.ownerXUserId}`);
  if (owner.address.toLowerCase() !== job.destination.toLowerCase() || owner.address.toLowerCase() === bot.address.toLowerCase()) throw new Error("BOT_OWNER_WALLET_MISMATCH");
}
function operation(job: BotExecution): ExecutionRequest["operation"] {
  const intent = ownerBotIntent.parse(JSON.parse(job.intentJson));
  if (intent.kind === "withdraw") return { type: "eth_transfer", recipient: job.destination, amount: intent.amount, unit: "eth" };
  return { type: "uniswap_v3_sell", token: intent.token, amount: "100", unit: "percent", slippageBps: 300, fee: 10000,
    routerAddress: "0xcaf681a66d020601342297493863e78c959e5cb2", quoterAddress: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    wethAddress: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", ponsFactoryAddress: process.env.PONS_V2_FACTORY_ADDRESS || DEFAULT_PONS_V2_FACTORY,
    v4QuoterAddress: process.env.PONS_V4_QUOTER_ADDRESS || "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    universalRouterAddress: process.env.PONS_V4_UNIVERSAL_ROUTER_ADDRESS || "0x8876789976decbfcbbbe364623c63652db8c0904",
    permit2Address: process.env.PONS_PERMIT2_ADDRESS || "0x000000000022D473030F116dDEE9F6B43aC78BA3" };
}
export async function executeAgentWalletJob(raw: unknown) {
  if (!anyBotExecutionEnabled()) throw new Error("AGENT_EXECUTION_DISABLED");
  const { jobId } = requestSchema.parse(raw);
  if (!process.env.NEXT_PUBLIC_CONVEX_URL || !process.env.WALLET_SIGNER_TOKEN) throw new Error("AGENT_STORE_NOT_CONFIGURED");
  const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL);
  const auth = { secret: process.env.WALLET_SIGNER_TOKEN, jobId };
  const store: ExecutionStore = {
    read: async () => {
      const job = await client.query(makeFunctionReference<"query", typeof auth, BotExecution | null>("tradingAgentExecution:read"), auth);
      if (job && (job.cycleId ? !tradingAgentCapabilities().liveTrading : !ownerBotExecutionEnabled())) throw new Error("AGENT_EXECUTION_DISABLED");
      return job;
    },
    save: (step, kind, value) => client.mutation(makeFunctionReference<"mutation", typeof auth & { step: number; kind: string; value: string }>("tradingAgentExecution:save"), { ...auth, step, kind, value }),
  };
  const rpc = createPublicClient({ transport: resilientRobinhoodHttp(process.env.ROBINHOOD_RPC_URL) });
  if (await rpc.getChainId() !== 4663) throw new Error("AGENT_WRONG_CHAIN");
  await runBotExecution(store, {
    prepare: async job => {
      await verifyWallet(job);
      if (job.confirmedBlock && await rpc.getBlockNumber({ cacheTime: 0 }) < BigInt(job.confirmedBlock)) throw new Error("AGENT_RPC_BEHIND");
      if (job.cycleId) {
        const live = await liveBotOperation(job);
        const envelope = { ...await prepareExecutionEnvelope({ ...identity(job), operation: live.operation }), route: live.route };
        await assertLiveEnvelope(job, envelope);
        return envelope;
      }
      return prepareExecutionEnvelope({ ...identity(job), operation: operation(job) });
    },
    sign: async (job, envelope) => {
      await verifyWallet(job);
      const parsed = parseTransaction(envelope.unsignedTransaction as Hex);
      if (parsed.chainId !== 4663 || parsed.nonce !== envelope.nonce || parsed.to?.toLowerCase() !== envelope.toAddress.toLowerCase() || (parsed.value ?? 0n).toString() !== envelope.valueWei) throw new Error("BOT_ENVELOPE_MISMATCH");
      const intent = job.cycleId ? null : ownerBotIntent.parse(JSON.parse(job.intentJson));
      if (job.cycleId) await assertLiveEnvelope(job, envelope);
      if (intent?.kind === "withdraw" && (envelope.toAddress.toLowerCase() !== job.destination.toLowerCase() || envelope.approval
        || BigInt(envelope.valueWei) !== parseEther(intent.amount) || (parsed.data && parsed.data !== "0x"))) throw new Error("BOT_WITHDRAWAL_MISMATCH");
      if (!envelope.unsignedTransaction.startsWith("0x02")) throw new Error("BOT_ENVELOPE_TYPE");
      return signPreparedEnvelope(identity(job), { ...envelope, unsignedTransaction: envelope.unsignedTransaction as `0x02${string}`, toAddress: envelope.toAddress as Address });
    },
    broadcast: async (job, envelope, signed) => broadcastTransaction({ ...identity(job), expectedTo: envelope.toAddress,
      expectedValueWei: envelope.valueWei, operationType: "agent_owner", transactionHash: signed.transactionHash, signedTransaction: signed.signedTransaction }),
    receipt: async (job, signed) => {
      const bytes = signed.signedTransaction as Hex;
      if (!bytes.startsWith("0x02") || keccak256(bytes).toLowerCase() !== signed.transactionHash.toLowerCase() || (await recoverTransactionAddress({ serializedTransaction: bytes as `0x02${string}` })).toLowerCase() !== job.from.toLowerCase()) throw new Error("BOT_SIGNATURE_MISMATCH");
      try {
        const receipt = await rpc.getTransactionReceipt({ hash: signed.transactionHash as Hex });
        if (receipt.from.toLowerCase() !== job.from.toLowerCase()) throw new Error("BOT_RECEIPT_MISMATCH");
        return { success: receipt.status === "success", block: receipt.blockNumber.toString(), gasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
          ...(job.cycleId && job.envelopeJson ? { outputAmount: liveReceiptOutput(receipt, botEnvelopeSchema.parse(JSON.parse(job.envelopeJson)), job.from) } : {}) };
      } catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
    },
  });
  return { status: "checked" };
}
