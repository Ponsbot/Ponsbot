/** Realized USD trading P&L, weighted-average cost. Deposits, withdrawals and gas are excluded. */
export type BotPnl = { dayUsd: number | null; lifetimeUsd: number | null; at: number; pending: boolean };
export type PnlState = { version?: number; cursor: number; lots: Record<string, { amount: string; costUsd: number | null }>; lifetimeUsd: number; incomplete: boolean; sales: Array<{ at: number; usd: number | null }> };
export const initialPnlState = (): PnlState => ({ version: 2, cursor: 0, lots: {}, lifetimeUsd: 0, incomplete: false, sales: [] });
export function loadPnlState(json?:string):PnlState { const state=json?JSON.parse(json) as PnlState:undefined;return state?.version===2?state:initialPnlState(); }
export type PnlFill = { token: string; amount: string; cashUsd: number | null; side: "buy" | "sell"; at: number };
export function applyPnlFill(state: PnlState, fill: PnlFill) {
  const key = fill.token.toLowerCase(), quantity = BigInt(fill.amount);
  if (quantity <= 0n) throw new Error("INVALID_PNL_QUANTITY");
  if (fill.cashUsd !== null && (!Number.isFinite(fill.cashUsd) || fill.cashUsd < 0)) throw new Error("INVALID_PNL_VALUE");
  const lot = state.lots[key] ?? { amount: "0", costUsd: 0 }, held = BigInt(lot.amount);
  if (fill.side === "buy") {
    state.lots[key] = { amount: (held + quantity).toString(), costUsd: lot.costUsd === null || fill.cashUsd === null ? null : lot.costUsd + fill.cashUsd };
    return;
  }
  // An externally supplied holding has no known purchase basis; never assume it was free.
  const basis = held >= quantity && lot.costUsd !== null ? lot.costUsd * Number(quantity * 10n ** 18n / held) / 1e18 : null;
  const usd = basis === null || fill.cashUsd === null ? null : fill.cashUsd - basis;
  const remainder = held > quantity ? held - quantity : 0n;
  state.lots[key] = { amount: remainder.toString(), costUsd: remainder === 0n ? 0 : basis === null || lot.costUsd === null ? null : lot.costUsd - basis };
  state.sales.push({ at: fill.at, usd });
  if (usd === null) state.incomplete = true; else state.lifetimeUsd += usd;
}
export function pnlDisplay(stateJson: string | undefined, at: number | undefined, now: number, pending = false): BotPnl {
  if (!stateJson || !at) return { dayUsd: null, lifetimeUsd: null, at: 0, pending: true };
  const state = JSON.parse(stateJson) as PnlState;
  const sales = state.sales.filter(s => s.at > now - 86400000 && s.at <= now);
  return { dayUsd: sales.some(s => s.usd === null) ? null : sales.reduce((sum, s) => sum + (s.usd ?? 0), 0), lifetimeUsd: state.incomplete ? null : state.lifetimeUsd, at, pending };
}

export type PnlTrace = { type?: string; from?: string; to?: string; value?: string; error?: string; calls?: PnlTrace[] };
export function tracedNativeDelta(frame: PnlTrace, owner: string): bigint {
  if (frame.error) return 0n;
  const type = frame.type?.toUpperCase();
  // DELEGATECALL and STATICCALL do not transfer value, even when a tracer includes a value field.
  const transfers = type === "CALL" || type === "CREATE" || type === "CREATE2" || type === "SELFDESTRUCT";
  const value = BigInt(frame.value || "0");
  return (transfers ? (frame.to?.toLowerCase() === owner.toLowerCase() ? value : 0n) - (frame.from?.toLowerCase() === owner.toLowerCase() ? value : 0n) : 0n)
    + (frame.calls ?? []).reduce((sum, child) => sum + tracedNativeDelta(child, owner), 0n);
}
