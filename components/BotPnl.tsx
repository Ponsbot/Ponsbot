import type { BotPnl as Pnl } from "@/lib/trading-agents/pnl";
import styles from "./BotPnl.module.css";

export function BotPnl({ pnl }: { pnl?: Pnl }) {
  const pending=!pnl || pnl.pending;
  return <section className={styles.block} aria-label="Trading profit and loss">
    <div className={styles.grid}>{[["24h P&L",pnl?.dayUsd],["Lifetime P&L",pnl?.lifetimeUsd]].map(([label,raw])=>{
      const value=typeof raw==="number" && Number.isFinite(raw) && (!pending || (pnl && Date.now()-pnl.at<=900000))?raw:null;
      return <div key={label as string}><span>{label}</span><strong className={value===null || Math.abs(value)<.005?undefined:value>0?styles.gain:styles.loss}>{value===null?(pending?"Calculating…":"Unavailable"):new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",signDisplay:Math.abs(value)<.005?"never":"exceptZero",maximumFractionDigits:2}).format(value)}</strong></div>;
    })}</div>
    {!pending && (pnl.dayUsd===null || pnl.lifetimeUsd===null) && <small>A purchase cost, current valuation, or 24-hour price reference is not yet available.</small>}
    {pending && pnl && Date.now()-pnl.at<=900000 && (pnl.dayUsd!==null || pnl.lifetimeUsd!==null) && <small>Updating. Showing the last verified valuation.</small>}
  </section>;
}
