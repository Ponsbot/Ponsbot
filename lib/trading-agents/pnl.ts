/** Realized USD trading P&L, weighted-average cost. Deposits, withdrawals and gas are excluded. */
export type BotPnl = { dayUsd: number | null; lifetimeUsd: number | null; at: number; pending: boolean };
export type PnlState = { version?: number; cursor: number; lots: Record<string, { amount: string; costUsd: number | null }>; lifetimeUsd: number; incomplete: boolean; sales: Array<{ at: number; usd: number | null; token?:string; proceeds?:number|null; pieces?:Array<{amount:string;costUsd:number|null;at:number}> }>; open: Array<{token:string;amount:string;costUsd:number|null;at:number}>; marks:Array<{at:number;prices:Record<string,number>}>; unrealized?:{dayUsd:number|null;lifetimeUsd:number|null;at:number}; total?:{dayUsd:number|null;lifetimeUsd:number|null;at:number} };
export const initialPnlState = (): PnlState => ({ version: 3, cursor: 0, lots: {}, lifetimeUsd: 0, incomplete: false, sales: [], open:[], marks:[] });
export function loadPnlState(json?:string):PnlState { const state=json?JSON.parse(json) as PnlState:undefined;return state?.version===3?state:initialPnlState(); }
export type PnlFill = { token: string; amount: string; cashUsd: number | null; side: "buy" | "sell"; at: number };
export function applyPnlFill(state: PnlState, fill: PnlFill) {
  const key = fill.token.toLowerCase(), quantity = BigInt(fill.amount);
  if (quantity <= 0n) throw new Error("INVALID_PNL_QUANTITY");
  if (fill.cashUsd !== null && (!Number.isFinite(fill.cashUsd) || fill.cashUsd < 0)) throw new Error("INVALID_PNL_VALUE");
  const lot = state.lots[key] ?? { amount: "0", costUsd: 0 }, held = BigInt(lot.amount);
  if (fill.side === "buy") {
    state.open.push({token:key,amount:quantity.toString(),costUsd:fill.cashUsd,at:fill.at});
    state.lots[key] = { amount: (held + quantity).toString(), costUsd: lot.costUsd === null || fill.cashUsd === null ? null : lot.costUsd + fill.cashUsd };
    return;
  }
  // An externally supplied holding has no known purchase basis; never assume it was free.
  const basis = held >= quantity && lot.costUsd !== null ? lot.costUsd * Number(quantity * 10n ** 18n / held) / 1e18 : null;
  const usd = basis === null || fill.cashUsd === null ? null : fill.cashUsd - basis;
  const remainder = held > quantity ? held - quantity : 0n;
  let left=remainder;
  const pieces=state.open.filter(p=>p.token===key);
  const soldPieces:Array<{amount:string;costUsd:number|null;at:number}>=[];
  pieces.forEach((piece,index)=>{
    const old=BigInt(piece.amount);
    const remaining=index===pieces.length-1?left:held>0n?old*remainder/held:0n;
    left-=remaining;
    soldPieces.push({amount:(old-remaining).toString(),costUsd:piece.costUsd===null?null:old>0n?piece.costUsd*Number(old-remaining)/Number(old):0,at:piece.at});
    piece.amount=remaining.toString();
    piece.costUsd=piece.costUsd===null?null:old>0n?piece.costUsd*Number(remaining)/Number(old):0;
  });
  state.open=state.open.filter(p=>BigInt(p.amount)>0n);
  state.lots[key] = { amount: remainder.toString(), costUsd: remainder === 0n ? 0 : basis === null || lot.costUsd === null ? null : lot.costUsd - basis };
  state.sales.push({ at: fill.at, usd, token:key, proceeds:fill.cashUsd, ...(held>=quantity && soldPieces.reduce((n,p)=>n+BigInt(p.amount),0n)===quantity?{pieces:soldPieces}:{} ) });
  if (usd === null) state.incomplete = true; else state.lifetimeUsd += usd;
}
export function pnlDisplay(stateJson: string | undefined, at: number | undefined, now: number, pending = false): BotPnl {
  if (!stateJson || !at) return { dayUsd: null, lifetimeUsd: null, at: 0, pending: true };
  const state = JSON.parse(stateJson) as PnlState;
  if(state.version!==3 || !state.unrealized) return {dayUsd:null,lifetimeUsd:null,at:0,pending:true};
  return state.total ? {...state.total,pending} : {dayUsd:null,lifetimeUsd:null,at:0,pending:true};
}

/** Prices are USD per raw token unit. No ETH deposits or realized sales enter these totals. */
export function markUnrealized(state:PnlState,prices:Record<string,number>,at:number,balances?:Record<string,string>) {
  let lifetime:number|null=0,day:number|null=0;
  const cutoff=at-86400000;
  for(const [token,lot] of Object.entries(state.lots)) {
    if(BigInt(lot.amount)===0n) continue;
    const price=prices[token];
    if(!Number.isFinite(price)||price<=0 || (balances && BigInt(balances[token]??'0')!==BigInt(lot.amount))) {lifetime=null;day=null;continue;}
    if(lot.costUsd===null) lifetime=null;
    else if(lifetime!==null) lifetime+=Number(lot.amount)*price-lot.costUsd;
    const baseline=[...state.marks].reverse().find(m=>m.at<=cutoff && cutoff-m.at<=600000 && m.prices[token]>0);
    for(const piece of state.open.filter(p=>p.token===token)) {
      const basis=piece.at>cutoff?piece.costUsd:baseline?Number(piece.amount)*baseline.prices[token]:null;
      if(basis===null) day=null;
      else if(day!==null) day+=Number(piece.amount)*price-basis;
    }
  }
  if(balances && Object.entries(balances).some(([t,a])=>BigInt(a)>0n && BigInt(state.lots[t]?.amount??'0')!==BigInt(a))) {lifetime=null;day=null;}
  state.unrealized={at,dayUsd:day!==null&&Number.isFinite(day)?day:null,lifetimeUsd:lifetime!==null&&Number.isFinite(lifetime)?lifetime:null};
  // Realized sales use the same rolling reference as remaining exposure, not lifetime
  // purchase cost for positions that already existed at the start of the 24h window.
  let realizedDay:number|null=0;
  for(const sale of state.sales.filter(s=>s.at>cutoff && s.at<=at)) {
    if(!sale.pieces || !sale.token || sale.proceeds==null) {realizedDay=null;break;}
    const baseline=[...state.marks].reverse().find(m=>m.at<=cutoff && cutoff-m.at<=600000 && m.prices[sale.token!]>0);
    let reference:number|null=0;
    for(const piece of sale.pieces) {
      if(BigInt(piece.amount)===0n) continue;
      const basis=piece.at>cutoff?piece.costUsd:baseline?Number(piece.amount)*baseline.prices[sale.token]:null;
      if(basis===null) {reference=null;break;}
      reference+=basis;
    }
    if(reference===null) {realizedDay=null;break;}
    realizedDay+=sale.proceeds-reference;
  }
  const totalDay=day===null||realizedDay===null?null:day+realizedDay;
  const totalLifetime=lifetime===null||state.incomplete?null:lifetime+state.lifetimeUsd;
  state.total={at,dayUsd:totalDay!==null&&Number.isFinite(totalDay)?totalDay:null,lifetimeUsd:totalLifetime!==null&&Number.isFinite(totalLifetime)?totalLifetime:null};
  state.marks=state.marks.filter(m=>m.at>=cutoff-600000);
  if(!state.marks.length || at-state.marks[state.marks.length-1].at>=60000) state.marks.push({at,prices});
  // Older purchases share the same daily reference; compact them to bound history size.
  const recent=state.open.filter(p=>p.at>cutoff), older=new Map<string,PnlState['open'][number]>();
  for(const p of state.open.filter(p=>p.at<=cutoff)) {
    const prior=older.get(p.token);
    older.set(p.token,{...p,at:Math.min(prior?.at??p.at,p.at),amount:(BigInt(prior?.amount??'0')+BigInt(p.amount)).toString(),costUsd:prior?.costUsd===null||p.costUsd===null?null:(prior?.costUsd??0)+p.costUsd});
  }
  state.open=[...older.values(),...recent];
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
