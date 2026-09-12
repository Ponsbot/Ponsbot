import { createPublicClient, decodeEventLog, formatEther, formatUnits, parseAbi, parseTransaction, zeroAddress, type Address, type Hex, type TransactionReceipt } from "viem";
import { resilientRobinhoodHttp } from "../rpc-http";
import { DEFAULT_PONS_V2_FACTORY } from "../pons-runtime-defaults";
import { autonomousBotIntent, type BotEnvelope, type BotExecution } from "../trading-agents/execution";
import { agentPolicySchema } from "../trading-agents/policy";
import { isSecondaryAgentToken } from "../trading-agents/universe";
import { ponsPairInfo, tokenContractMetadata } from "./service";
import type { ExecutionRequest } from "./policy";

const erc20 = parseAbi(["function balanceOf(address) view returns(uint256)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const rpc = () => createPublicClient({ transport: resilientRobinhoodHttp(process.env.ROBINHOOD_RPC_URL) });
const routes = () => ({ fee: 10000 as const,
  routerAddress: "0xcaf681a66d020601342297493863e78c959e5cb2", quoterAddress: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  wethAddress: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", ponsFactoryAddress: process.env.PONS_V2_FACTORY_ADDRESS || DEFAULT_PONS_V2_FACTORY,
  v4QuoterAddress: process.env.PONS_V4_QUOTER_ADDRESS || "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  universalRouterAddress: process.env.PONS_V4_UNIVERSAL_ROUTER_ADDRESS || "0x8876789976decbfcbbbe364623c63652db8c0904",
  permit2Address: process.env.PONS_PERMIT2_ADDRESS || "0x000000000022D473030F116dDEE9F6B43aC78BA3" });

export async function liveBotOperation(job: BotExecution): Promise<{ operation: ExecutionRequest["operation"]; route: NonNullable<BotEnvelope["route"]> }> {
  if (!job.executionAllowed) throw new Error("LIVE_EXECUTION_NOT_AUTHORIZED");
  const intent = autonomousBotIntent.parse(JSON.parse(job.intentJson)), policy = agentPolicySchema.parse(JSON.parse(job.policyJson ?? ""));
  const pair = await ponsPairInfo(intent.token as Address, routes().ponsFactoryAddress as Address);
  if (!pair.isPons) {
    if (!isSecondaryAgentToken(intent.token) || (job.phase && job.phase !== "trade")) throw new Error("NOT_ALLOWED_AGENT_TOKEN");
    const common = { ...routes(), slippageBps: policy.maxSlippageBps };
    const operation: ExecutionRequest["operation"] = intent.kind === "buy"
      ? { ...common, type: "uniswap_v3_buy", token: intent.token, amount: formatEther(BigInt(intent.amount)), unit: "eth" }
      : { ...common, type: "uniswap_v3_sell", token: intent.token, amount: formatUnits(BigInt(intent.amount), (await tokenContractMetadata(intent.token as Address)).decimals), unit: "token" };
    return { operation, route: { phase: "trade", pairToken: zeroAddress, outputToken: intent.kind === "buy" ? intent.token : zeroAddress } };
  }
  const pairToken = pair.pairToken.toLowerCase();
  if (job.pairToken && job.pairToken !== pairToken) throw new Error("PAIR_CHANGED");
  const phase = job.phase ?? (intent.kind === "buy" && !pair.nativePair ? "funding" : "trade");
  const common = { ...routes(), slippageBps: policy.maxSlippageBps };
  if (phase === "funding") {
    if (intent.kind !== "buy" || pair.nativePair || job.pairAmount) throw new Error("INVALID_FUNDING_PHASE");
    return { operation: { ...common, type: "uniswap_v3_buy", token: pairToken, amount: formatEther(BigInt(intent.amount)), unit: "eth" }, route: { phase, pairToken, outputToken: pairToken } };
  }
  if (phase === "convert") {
    if (intent.kind !== "sell" || pair.nativePair || !job.pairAmount || BigInt(job.pairAmount) <= 0n) throw new Error("INVALID_CONVERSION_PHASE");
    const { decimals } = await tokenContractMetadata(pairToken as Address);
    return { operation: { ...common, type: "uniswap_v3_sell", token: pairToken, amount: formatUnits(BigInt(job.pairAmount), decimals), unit: "token" }, route: { phase, pairToken, outputToken: zeroAddress } };
  }
  if (intent.kind === "buy") {
    if (pair.nativePair) return { operation: { ...common, type: "uniswap_v3_buy", token: intent.token, amount: formatEther(BigInt(intent.amount)), unit: "eth" }, route: { phase, pairToken, outputToken: intent.token } };
    if (!job.pairAmount || BigInt(job.pairAmount) <= 0n) throw new Error("MISSING_CONFIRMED_FUNDING");
    const { decimals } = await tokenContractMetadata(pairToken as Address);
    return { operation: { ...common, type: "uniswap_v3_buy", token: intent.token, amount: formatUnits(BigInt(job.pairAmount), decimals), unit: "pair", pairAsset: pairToken }, route: { phase, pairToken, outputToken: intent.token } };
  }
  const { decimals } = await tokenContractMetadata(intent.token as Address);
  return { operation: { ...common, type: "uniswap_v3_sell", token: intent.token, amount: formatUnits(BigInt(intent.amount), decimals), unit: "token" }, route: { phase, pairToken, outputToken: pairToken } };
}

/** Recheck actual funds and the complete job's gas allowance immediately before signing. */
export async function assertLiveEnvelope(job: BotExecution, envelope: BotEnvelope) {
  if (!job.executionAllowed || !envelope.route || job.destination.toLowerCase() !== job.from.toLowerCase()) throw new Error("LIVE_EXECUTION_NOT_AUTHORIZED");
  const intent = autonomousBotIntent.parse(JSON.parse(job.intentJson)), policy = agentPolicySchema.parse(JSON.parse(job.policyJson ?? ""));
  const parsed = parseTransaction(envelope.unsignedTransaction as Hex);
  if (!parsed.gas || !parsed.maxFeePerGas) throw new Error("MISSING_GAS_CAP");
  const maximumGas = parsed.gas * parsed.maxFeePerGas;
  if (maximumGas + BigInt(job.gasSpentWei ?? "0") > BigInt(policy.maxGasPerTradeWei)) throw new Error("LIVE_GAS_LIMIT");
  const client = rpc(), cash = await client.getBalance({ address: job.from as Address });
  const value = BigInt(envelope.valueWei);
  if (value + maximumGas + BigInt(policy.reserveWei) > cash) throw new Error("INSUFFICIENT_GAS_RESERVE");
  if (intent.kind === "buy" && (envelope.route.phase === "funding" || envelope.route.pairToken === zeroAddress)) {
    if (BigInt(intent.amount) > cash / 5n || BigInt(intent.amount) > BigInt(policy.maxTradeWei)) throw new Error("LIVE_BUY_LIMIT");
    if (value > BigInt(intent.amount)) throw new Error("LIVE_VALUE_LIMIT");
  } else if (value !== 0n) throw new Error("UNEXPECTED_ETH_SPEND");
  if (envelope.approval && value !== 0n) throw new Error("APPROVAL_VALUE");
  const token = envelope.route.phase === "convert" || (intent.kind === "buy" && envelope.route.phase === "trade" && envelope.route.pairToken !== zeroAddress) ? envelope.route.pairToken : intent.kind === "sell" ? intent.token : undefined;
  if (token) {
    const required = token === intent.token ? intent.amount : job.pairAmount;
    const balance = await client.readContract({ address: token as Address, abi: erc20, functionName: "balanceOf", args: [job.from as Address] });
    if (!required || balance < BigInt(required)) throw new Error("INSUFFICIENT_LIVE_ASSET");
  }
}

/** Isolate this receipt's proceeds. Never sweep a pre-existing paired asset balance. */
export function liveReceiptOutput(receipt: TransactionReceipt, envelope: BotEnvelope, owner: string) {
  const output = envelope.route?.outputToken;
  if (!output || output === zeroAddress || envelope.approval) return undefined;
  let delta = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== output) continue;
    try {
      const event = decodeEventLog({ abi: erc20, data: log.data, topics: log.topics, eventName: "Transfer" });
      if (event.args.to.toLowerCase() === owner.toLowerCase()) delta += event.args.value;
      if (event.args.from.toLowerCase() === owner.toLowerCase()) delta -= event.args.value;
    } catch { /* Other events cannot contribute to the proceeds. */ }
  }
  return (delta > 0n ? delta : 0n).toString();
}
