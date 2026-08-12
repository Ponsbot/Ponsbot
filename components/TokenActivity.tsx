"use client";

import { useEffect, useState } from "react";
import { shortAddress } from "@/lib/site-data";

type Activity = { transactionHash: string; logIndex: number; kind: "buy" | "sell" | "burn"; walletAddress: string; tokenAmount: string; marketCapUsd?: number; timestamp: number };

export function TokenActivity({ tokenAddress, symbol }: { tokenAddress: string; symbol: string }) {
  const [activity, setActivity] = useState<Activity[]>([]);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      await fetch("/api/market/view", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenAddresses: [tokenAddress] }) }).catch(() => undefined);
      const payload = await fetch(`/api/market/activity?token=${encodeURIComponent(tokenAddress)}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : { activity: [] }).catch(() => ({ activity: [] }));
      if (!stopped) setActivity(payload.activity || []);
    };
    void refresh(); const timer = window.setInterval(refresh, 10_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [tokenAddress]);
  return <section className="token-activity"><div className="section-heading"><p className="eyebrow">On-chain activity</p><h2>Buys, sells &amp; burns</h2></div>{activity.length ? <div className="activity-table-wrap"><table className="activity-table"><thead><tr><th>Action</th><th>Amount</th><th>MCap</th><th>Wallet</th><th>Time</th></tr></thead><tbody>{activity.map((item) => <tr key={`${item.transactionHash}-${item.kind}`}><td><span className={`activity-kind ${item.kind}`}>{item.kind}</span></td><td>{formatAmount(item.tokenAmount)} ${symbol}</td><td>{item.marketCapUsd === undefined ? "—" : formatMoney(item.marketCapUsd)}</td><td><a href={`https://robinhoodchain.blockscout.com/address/${item.walletAddress}`} target="_blank" rel="noreferrer">{shortAddress(item.walletAddress)}</a></td><td><a href={`https://robinhoodchain.blockscout.com/tx/${item.transactionHash}`} target="_blank" rel="noreferrer">{relativeTime(item.timestamp)}</a></td></tr>)}</tbody></table></div> : <p className="activity-empty">No indexed buys, sells, or burns yet.</p>}</section>;
}

function formatAmount(value: string) { const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(number) : value; }
function formatMoney(value: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value); }
function relativeTime(value: number) { const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000)); return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`; }
