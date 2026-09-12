import { z } from "zod";
import { units, tokenAddress } from "./policy";
import { tradingAgentCapabilities } from "./config";
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(a => !/^0x0{40}$/i.test(a));
export const ownerBotIntent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("withdraw"), amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/).max(60).refine(a => Number(a) > 0) }).strict(),
  z.object({ kind: z.literal("sell"), token: address }).strict(),
]);
export type OwnerBotIntent = z.infer<typeof ownerBotIntent>;
export const autonomousBotIntent = z.object({ kind: z.enum(["buy", "sell"]), token: tokenAddress, amount: units.refine(v => BigInt(v) > 0n) }).strict();
export type AutonomousBotIntent = z.infer<typeof autonomousBotIntent>;
export const botRouteSchema = z.object({ phase: z.enum(["funding", "trade", "convert"]), pairToken: tokenAddress, outputToken: tokenAddress }).strict();
export const botEnvelopeSchema = z.object({ unsignedTransaction: z.string().regex(/^0x[0-9a-fA-F]+$/).max(50000), toAddress: address,
  valueWei: z.string().regex(/^\d+$/), nonce: z.number().int().nonnegative(), approval: z.boolean(), route: botRouteSchema.optional() }).strict();
export type BotEnvelope = z.infer<typeof botEnvelopeSchema>;
export type BotExecution = {
  _id: string; agentId: string; ownerXUserId: string; from: string; destination: string; intentJson: string;
  state: "active" | "confirmed" | "failed"; step: number; envelopeJson?: string; signedJson?: string;
  hashes: string[]; minimumNonce?: number; confirmedBlock?: string; error?: string;
  cycleId?: string; policyJson?: string; policyVersion?: number; executionAllowed?: boolean;
  phase?: "funding" | "trade" | "convert"; pairToken?: string; pairAmount?: string; gasSpentWei?: string; outputAmount?: string;
};
export function ownerBotExecutionEnabled(env: Record<string, string | undefined> = process.env) {
  return env.TRADING_AGENTS_ENABLED === "true" && env.TRADING_AGENTS_OWNER_EXECUTION_ENABLED === "true";
}
export function anyBotExecutionEnabled() { return ownerBotExecutionEnabled() || tradingAgentCapabilities().liveTrading; }
