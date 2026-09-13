import type { BotPnl as Pnl } from "@/lib/trading-agents/pnl";
import styles from "./BotPnl.module.css";

export function BotPnl({ pnl }: { pnl?: Pnl }) {
  const pending=!pnl || pnl.pending;
  return <section className={styles.block} aria-label="Realized trading profit and loss">
    <div className={styles.grid}>{[["24h P&L",pnl?.dayUsd],["Lifetime P&L",pnl?.lifetimeUsd]].map(([label,raw])=>{
      const value=typeof raw==="number" && Number.isFinite(raw)?raw:null;
      return <div key={label as string}><span>{label}</span><strong className={pending || value===null || Math.abs(value)<.005?undefined:value>0?styles.gain:styles.loss}>{pending?"Calculating…":value===null?"Unavailable":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",signDisplay:Math.abs(value)<.005?"never":"exceptZero",maximumFractionDigits:2}).format(value)}</strong></div>;
    })}</div>
    <small>Realized gains/losses on sold tokens, before gas. Deposits, withdrawals and open holdings excluded.</small>
    {!pending && (pnl.dayUsd===null || pnl.lifetimeUsd===null) && <small>Some trades have an unverified purchase cost or payout value.</small>}
  </section>;
}
