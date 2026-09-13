import { z } from "zod";
import { agentDecisionSchema, agentPolicySchema, tokenAddress, units, type AgentDecision } from "./policy";
import { botCharacterPrompt } from "./bot-yard";

/** A curated, bounded snapshot from Pons, not arbitrary URLs supplied by an agent. */
export const agentMarketContextSchema = z.object({
  agentId: z.string().min(1).max(128), cycleId: z.string().min(1).max(200),
  policyVersion: z.number().int().positive().safe(), observedAt: z.number().int().positive().safe(),
  ethUsd: z.number().finite().positive().optional(),
  holdingsAvailable: z.boolean().optional(),
  strategy: z.string().min(1).max(2000), policy: agentPolicySchema,
  character: z.object({ name: z.string().min(1).max(60), description: z.string().min(1).max(2000) }).strict().optional(),
  recentLog: z.array(z.object({ at: z.number().int().positive().safe(), summary: z.string().max(600) }).strict()).max(15).optional(),
  yard: z.object({
    places: z.array(z.string().max(80)).max(8),
    neighbors: z.array(z.object({ name: z.string().max(60), description: z.string().max(300), thought: z.string().max(600).optional() }).strict()).max(8),
  }).strict().optional(),
  tokens: z.array(z.object({ address: tokenAddress, symbol: z.string().min(1).max(100),
    decimals: z.number().int().min(0).max(255).optional(),
    priceUsd: z.number().finite().positive().optional(), priceObservedAt: z.number().int().positive().optional(), volume24hUsd: z.number().finite().nonnegative().optional() }).strict()).max(100),
  cashWei: units, holdings: z.array(z.object({ token: tokenAddress, amount: units }).strict()).max(20),
}).strict();
export type AgentMarketContext = z.infer<typeof agentMarketContextSchema>;

/** Staged Eliza action/provider boundary. No SDK, runtime, public route or signer is started here. */
export function createPonsAgentBridge(binding: {
  runtimeAgentId: string;
  ponsAgentId: string;
  loadContext: () => Promise<AgentMarketContext>;
  submitPaperDecision: (context: AgentMarketContext, decision: AgentDecision) => Promise<{ cycleId: string; status: string }>;
}) {
  const authorized = (runtime: { agentId: string }) => runtime.agentId === binding.runtimeAgentId;
  const loadContext = async () => {
    const context = agentMarketContextSchema.parse(await binding.loadContext());
    if (context.agentId !== binding.ponsAgentId) throw new Error("AGENT_SCOPE_MISMATCH");
    if (context.observedAt > Date.now() || Date.now() - context.observedAt > 60_000) throw new Error("STALE_AGENT_CONTEXT");
    return context;
  };
  return {
    name: "pons-platform-paper-trading",
    description: "Paper trading for Pons Bot launches, with PONS and supported pairing assets collectively capped at 20% of trades. No real transactions.",
    providers: [{
      name: "PONS_PLATFORM_MARKETS", description: "Current permitted tokens and paper holdings", dynamic: true,
      get: async (runtime: { agentId: string }) => {
        if (!authorized(runtime)) throw new Error("AGENT_SCOPE_MISMATCH");
        const context = await loadContext();
        const character = context.character ? botCharacterPrompt(context.character.name, context.character.description) : "";
        return { text: `${character}\nMARKET_CONTEXT_JSON: ${JSON.stringify(context)}`, data: context, values: { mode: "paper" } };
      },
    }],
    actions: [{
      name: "PONS_PAPER_DECISION", similes: [], examples: [],
      description: "Submit buy, sell, or hold. Buy amount is ETH wei; sell amount is token base units. No transfers or external tokens.",
      validate: async (runtime: { agentId: string }) => authorized(runtime),
      handler: async (runtime: { agentId: string }, _message: unknown, _state: unknown, options?: { proposal?: unknown; cycleId?: string; policyVersion?: number }) => {
        if (!authorized(runtime)) return { success: false, text: "AGENT_SCOPE_MISMATCH" };
        const parsed = agentDecisionSchema.safeParse(options?.proposal);
        if (!parsed.success) return { success: false, text: "INVALID_AGENT_DECISION" };
        // Re-fetch context here: the model cannot supply another owner, cycle, policy, quote, or recipient.
        const context = await loadContext();
        if (options?.cycleId !== context.cycleId || options.policyVersion !== context.policyVersion) {
          return { success: false, text: "STALE_AGENT_CYCLE" };
        }
        const decision = parsed.data;
        if (decision.action !== "hold" && !context.tokens.some(t => t.address.toLowerCase() === decision.token)) {
          return { success: false, text: "NOT_PONS_BOT_PLATFORM_TOKEN" };
        }
        const result = await binding.submitPaperDecision(context, decision);
        return { success: result.status === "paper_filled" || result.status === "held", data: result };
      },
    }],
  };
}
