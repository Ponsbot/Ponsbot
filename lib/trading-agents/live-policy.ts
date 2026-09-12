import { agentDecisionSchema, agentPolicySchema, units, type AgentPolicy } from "./policy";
export type LiveSnapshot = { cashWei: string; tokens: Array<{ token: string; amount: string }>; observedAt: number; complete: boolean };
export type LiveBudget = { day: string; buyWei: string; gasReservedWei: string; trades: number };
export function reserveLiveDecision(raw: unknown, policyValue: AgentPolicy, snapshot: LiveSnapshot, previous: LiveBudget | undefined, now: number) {
  const decision = agentDecisionSchema.parse(raw), policy = agentPolicySchema.parse(policyValue);
  if (!snapshot.complete || snapshot.observedAt > now || now - snapshot.observedAt > 60000) throw new Error("LIVE_BALANCES_UNAVAILABLE");
  const cash = BigInt(units.parse(snapshot.cashWei)), day = new Date(now).toISOString().slice(0, 10);
  if (previous && day < previous.day) throw new Error("CLOCK_ROLLBACK");
  const budget = previous?.day === day ? { ...previous } : { day, buyWei: "0", gasReservedWei: "0", trades: 0 };
  if (decision.action === "hold") return { decision, budget };
  const quantity = BigInt(decision.amount), gas = BigInt(policy.maxGasPerTradeWei), reserve = BigInt(policy.reserveWei);
  if (cash < gas + reserve) throw new Error("INSUFFICIENT_GAS_RESERVE");
  if (budget.trades >= policy.maxTradesPerDay || BigInt(budget.gasReservedWei) + gas > BigInt(policy.maxDailyGasWei)) throw new Error("LIVE_DAILY_LIMIT");
  if (decision.action === "buy") {
    if (quantity > cash / 5n || quantity > BigInt(policy.maxTradeWei) || quantity + gas + reserve > cash) throw new Error("LIVE_BUY_LIMIT");
    if (!snapshot.tokens.some(t => t.token === decision.token) && snapshot.tokens.filter(t => BigInt(t.amount) > 0n).length >= policy.maxPositions) throw new Error("POSITION_LIMIT");
    if (BigInt(budget.buyWei) + quantity > BigInt(policy.maxDailyTurnoverWei)) throw new Error("LIVE_DAILY_LIMIT");
    budget.buyWei = (BigInt(budget.buyWei) + quantity).toString();
  } else if (quantity > BigInt(snapshot.tokens.find(t => t.token === decision.token)?.amount ?? "0")) throw new Error("INSUFFICIENT_TOKEN_BALANCE");
  budget.trades++; budget.gasReservedWei = (BigInt(budget.gasReservedWei) + gas).toString();
  return { decision, budget };
}
