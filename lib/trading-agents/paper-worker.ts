import { tradingAgentCapabilities } from "./config";
import { agentDecisionSchema, type AgentDecision, type PaperQuote } from "./policy";
import { agentMarketContextSchema, type AgentMarketContext } from "./eliza-bridge";
import { botThoughtSchema } from "./bot-yard";

export type PaperCycleLease = { agentId: string; cycleId: string; policyVersion: number; leaseUntil: number; kind?: "thought" | "trade" };
export interface PaperWorkerPorts {
  /** Adapter owns authenticated worker identity and durable, atomic leasing. */
  lease(): Promise<PaperCycleLease | null>;
  loadContext(lease: PaperCycleLease, signal: AbortSignal): Promise<AgentMarketContext>;
  decide(context: AgentMarketContext, signal: AbortSignal): Promise<unknown>;
  think?(context: AgentMarketContext, signal: AbortSignal): Promise<unknown>;
  /** Trusted market adapter, not a quote returned by the language model. */
  quote(lease: PaperCycleLease, decision: Exclude<AgentDecision, { action: "hold" }>, signal: AbortSignal): Promise<PaperQuote>;
  /** Adapter rechecks current policy, public launch membership, lease and balances atomically. */
  finish(lease: PaperCycleLease, decisionJson: string, quoteJson?: string): Promise<{ status: string; cycleId: string }>;
}

/** One bounded paper cycle. Importing this does not schedule work or contact any API. */
export async function runPaperAgentCycle(ports: PaperWorkerPorts, env: Record<string, string | undefined> = process.env) {
  if (!tradingAgentCapabilities(env).paperTrading) return { status: "disabled" };
  const lease = await ports.lease();
  if (!lease) return { status: "idle" };
  const timeoutMs = Math.min(90_000, lease.leaseUntil - Date.now() - 5_000);
  if (timeoutMs <= 0) return { status: "lease_expired" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const prepare = async (): Promise<{ decision: AgentDecision | { thought: string }; quote?: PaperQuote }> => {
      const context = agentMarketContextSchema.parse(await ports.loadContext(lease, controller.signal));
      if (context.agentId !== lease.agentId || context.cycleId !== lease.cycleId || context.policyVersion !== lease.policyVersion
        || context.observedAt > Date.now() || context.observedAt < Date.now() - 60_000) throw new Error("STALE_AGENT_CONTEXT");
      if (controller.signal.aborted) throw new Error("PAPER_CYCLE_TIMEOUT");
      if (lease.kind === "thought") {
        if (!ports.think) throw new Error("BOT_THOUGHT_ADAPTER_MISSING");
        const thought = botThoughtSchema.parse(await ports.think(context, controller.signal));
        return { decision: thought };
      }
      const decision = agentDecisionSchema.parse(await ports.decide(context, controller.signal));
      if (controller.signal.aborted) throw new Error("PAPER_CYCLE_TIMEOUT");
      if (decision.action === "hold") return { decision };
      if (!context.tokens.some(t => t.address.toLowerCase() === decision.token)) throw new Error("NOT_PONS_BOT_PLATFORM_TOKEN");
      const quote = await ports.quote(lease, decision, controller.signal);
      return { decision, quote };
    };
    const result = await Promise.race([
      prepare(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("PAPER_CYCLE_TIMEOUT")); }, timeoutMs); }),
    ]);
    if (controller.signal.aborted) return { status: "timed_out" };
    return await ports.finish(lease, JSON.stringify(result.decision), result.quote ? JSON.stringify(result.quote) : undefined);
  } catch {
    // No raw provider errors persisted. Expired work is recoverable by the next lease attempt.
    // Never retry a decision or completion in this process; reconcile the durable cycle first.
    return { status: "needs_reconciliation", cycleId: lease.cycleId };
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
