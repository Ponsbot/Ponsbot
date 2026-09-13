import type { BotPnl as Pnl } from "@/lib/trading-agents/pnl";
import styles from "./BotPnl.module.css";

export function BotPnl({ pnl }: { pnl?: Pnl }) {
  const pending=!pnl || pnl.pending;
  return <section className={styles.block} aria-label="Unrealized trading profit and loss">
    <div className={styles.grid}>{[["24h P&L",pnl?.dayUsd],["Lifetime P&L",pnl?.lifetimeUsd]].map(([label,raw])=>{
      const value=typeof raw==="number" && Number.isFinite(raw)?raw:null;
      return <div key={label as string}><span>{label}</span><strong className={pending || value===null || Math.abs(value)<.005?undefined:value>0?styles.gain:styles.loss}>{pending?"Calculating…":value===null?"Unavailable":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",signDisplay:Math.abs(value)<.005?"never":"exceptZero",maximumFractionDigits:2}).format(value)}</strong></div>;
    })}</div>
    <small>Unrealized gains/losses on current token holdings. Lifetime compares with purchase cost; 24h compares with yesterday’s value or cost for newer buys. Excludes sold tokens and gas.</small>
    {!pending && (pnl.dayUsd===null || pnl.lifetimeUsd===null) && <small>A purchase cost, current valuation, or 24-hour price reference is not yet available.</small>}
  </section>;
}
