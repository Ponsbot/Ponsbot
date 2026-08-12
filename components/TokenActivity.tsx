"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { shortAddress } from "@/lib/site-data";

type Activity = { transactionHash: string; logIndex: number; kind: "buy" | "sell" | "burn"; walletAddress: string; tokenAmount: string; marketCapUsd?: number; timestamp: number };
type HolderTag = "Creator" | "Liquidity" | "Uniswap V3 Liquidity" | "Uniswap V4 Liquidity";
type Holder = { address: string; amount: string; percentage: number; tag?: HolderTag };
type Range = "1H" | "6H" | "1D";

export function TokenActivity({ tokenAddress, symbol, summary, details }: { tokenAddress: string; symbol: string; summary: ReactNode; details: ReactNode }) {
  const [activity, setActivity] = useState<Activity[]>([]); const [holders, setHolders] = useState<Holder[]>([]);
  const [tab, setTab] = useState<"trades" | "holders">("trades"); const [range, setRange] = useState<Range>("1D");
  const holdersFetchedAt = useRef(0);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      await fetch("/api/market/view", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenAddresses: [tokenAddress] }) }).catch(() => undefined);
      const payload = await fetch(`/api/market/activity?token=${encodeURIComponent(tokenAddress)}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : { activity: [] }).catch(() => ({ activity: [] }));
      if (!stopped) setActivity(payload.activity || []);
      if (tab === "holders" && Date.now() - holdersFetchedAt.current >= 60_000) {
        const holderPayload = await fetch(`/api/market/holders?token=${encodeURIComponent(tokenAddress)}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : { holders: [] }).catch(() => ({ holders: [] }));
        if (!stopped) { setHolders(holderPayload.holders || []); holdersFetchedAt.current = Date.now(); }
      }
    };
    void refresh(); const timer = window.setInterval(refresh, 10_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [tokenAddress, tab]);
  const points = useMemo(() => {
    const cutoff = Date.now() - (range === "1H" ? 3_600_000 : range === "6H" ? 21_600_000 : 86_400_000);
    return activity.filter((item) => item.marketCapUsd !== undefined && item.timestamp >= cutoff).sort((a, b) => a.timestamp - b.timestamp) as Array<Activity & { marketCapUsd: number }>;
  }, [activity, range]);
  return <section className="token-market-panel"><div className="token-market-top"><div className="token-market-summary">{summary}</div><div className="token-chart-column"><div className="market-chart-head"><div><small>Market cap</small><strong>{points.length ? formatMoney(points[points.length - 1].marketCapUsd) : "—"}</strong></div><div className="chart-ranges">{(["1H", "6H", "1D"] as const).map((value) => <button type="button" className={range === value ? "active" : ""} onClick={() => setRange(value)} key={value}>{value}</button>)}</div></div><MarketChart points={points} /></div></div><div className="token-market-bottom"><div className="token-details-column">{details}</div><div className="token-activity-column">
    <div className="activity-tabs" role="tablist"><button type="button" className={tab === "trades" ? "active" : ""} onClick={() => setTab("trades")}>Recent Trades</button><button type="button" className={tab === "holders" ? "active" : ""} onClick={() => setTab("holders")}>Holders</button></div>
    <div className="activity-table-wrap"><table className="activity-table">{tab === "trades" ? <><thead><tr><th>Account</th><th>Type</th><th>Amount</th><th>MCap</th><th>Time</th><th>Txn</th></tr></thead><tbody>{activity.map((item) => <tr key={`${item.transactionHash}-${item.logIndex}`}><td><a href={`https://robinhoodchain.blockscout.com/address/${item.walletAddress}`} target="_blank" rel="noreferrer">{shortAddress(item.walletAddress)}</a></td><td><span className={`activity-kind ${item.kind}`}>{capitalize(item.kind)}</span></td><td>{formatAmount(item.tokenAmount)} ${symbol}</td><td>{item.marketCapUsd === undefined ? "—" : formatMoney(item.marketCapUsd)}</td><td>{relativeTime(item.timestamp)}</td><td><a href={`https://robinhoodchain.blockscout.com/tx/${item.transactionHash}`} target="_blank" rel="noreferrer">{shortHash(item.transactionHash)}</a></td></tr>)}</tbody></> : <><thead><tr><th>Rank</th><th>Account</th><th>Holding</th><th>Share</th></tr></thead><tbody>{holders.map((holder, index) => <tr key={holder.address}><td>{index + 1}</td><td><a href={`https://robinhoodchain.blockscout.com/address/${holder.address}`} target="_blank" rel="noreferrer">{shortAddress(holder.address)}</a>{holder.tag ? <span className={`holder-tag ${holderTagClass(holder.tag)}`}>{holder.tag}</span> : null}</td><td>{formatAmount(holder.amount)} ${symbol}</td><td>{holder.percentage.toFixed(2)}%</td></tr>)}</tbody></>}</table></div></div></div></section>;
}

function MarketChart({ points }: { points: Array<Activity & { marketCapUsd: number }> }) {
  if (points.length < 2) return <div className="market-chart empty">Chart data will appear as trades are indexed.</div>;
  const values = points.map((point) => point.marketCapUsd); const min = Math.min(...values); const max = Math.max(...values); const spread = Math.max(max - min, 1);
  const path = points.map((point, index) => `${index ? "L" : "M"}${(index / (points.length - 1) * 1000).toFixed(1)},${(220 - (point.marketCapUsd - min) / spread * 190).toFixed(1)}`).join(" ");
  return <div className="market-chart"><svg viewBox="0 0 1000 240" preserveAspectRatio="none" role="img" aria-label="Market cap chart"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#78a82b" stopOpacity=".3"/><stop offset="1" stopColor="#78a82b" stopOpacity="0"/></linearGradient></defs><path d={`${path} L1000,240 L0,240 Z`} fill="url(#chart-fill)"/><path d={path} fill="none" stroke="#47751d" strokeWidth="4" vectorEffect="non-scaling-stroke"/></svg></div>;
}

function formatAmount(value: string) { const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 6, notation: number >= 1_000_000 ? "compact" : "standard" }).format(number) : value; }
function formatMoney(value: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value); }
function relativeTime(value: number) { const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000)); return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`; }
function capitalize(value: string) { return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`; }
function shortHash(value: string) { return `${value.slice(0, 6)}…${value.slice(-4)}`; }
function holderTagClass(tag: HolderTag) { return tag === "Creator" ? "creator" : "liquidity"; }
