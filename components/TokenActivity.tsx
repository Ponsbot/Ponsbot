"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { shortAddress } from "../lib/address-display";
import type { HolderTag } from "@/lib/holder-tags";
import { usePageRefreshSession } from "@/components/usePageRefreshSession";
import { TokenMarketSnapshotContext } from "@/components/TokenMarketSnapshot";
import { activityCacheOnly, activityNextRefreshDelay, type PageTrade, type PageHolder } from "../lib/token-activity-policy";

type Trade = PageTrade;
type Holder = PageHolder;

export function TokenActivity({ tokenAddress, poolAddress, symbol, currentMarketCapUsd, currentMarketCapUpdatedAt, volume24hUsd, graduated, artwork, summary, details }: {
  tokenAddress: string; poolAddress?: string; symbol: string; currentMarketCapUsd?: number; currentMarketCapUpdatedAt?: number; volume24hUsd?: number;
  artwork: ReactNode; summary: ReactNode; details: ReactNode;
  graduated?: boolean;
}) {
  const refreshSession = usePageRefreshSession();
  const { active, canRefresh } = refreshSession;
  const [trades, setTrades] = useState<Trade[]>([]); const [holders, setHolders] = useState<Holder[]>([]);
  const [liveMarketCapUsd, setLiveMarketCapUsd] = useState(currentMarketCapUsd);
  const [liveVolume24hUsd, setLiveVolume24hUsd] = useState(volume24hUsd);
  const [liveGraduated, setLiveGraduated] = useState(graduated);
  const [tab, setTab] = useState<"trades" | "holders">("trades");
  const [tradesUnavailable, setTradesUnavailable] = useState(false); const [holdersUnavailable, setHoldersUnavailable] = useState(false);
  const [holdersPartial, setHoldersPartial] = useState(false);
  const [tableLoading, setTableLoading] = useState(true);
  const observed = useRef({ trades: 0, holders: 0 });
  const initialRequested = useRef({ trades: false, holders: false });
  const explicitFirstLoad = useRef(false);
  const selectTab = (next: "trades" | "holders") => {
    if (next === tab) return;
    explicitFirstLoad.current = !initialRequested.current[next];
    setTab(next);
  };
  const liveMarketCapUpdatedAt = useRef(currentMarketCapUpdatedAt || 0);
  useEffect(() => {
    setTrades([]); setHolders([]); setHoldersPartial(false);
    setTradesUnavailable(false); setHoldersUnavailable(false);
    observed.current = { trades: 0, holders: 0 };
    initialRequested.current = { trades: false, holders: false };
  }, [tokenAddress]);
  useEffect(() => {
    if (!active) return;
    let stopped = false; let running = false; let controller: AbortController | null = null;
    let timer: number | undefined; let initialChecks = 0;
    const refresh = async () => {
      if (stopped || running || !canRefresh()) return;
      running = true; controller = new AbortController();
      try {
            const marketResponse = await fetch("/api/market/snapshot", {
              method: "POST", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tokenAddresses: [tokenAddress], surface: "token" }),
            }).catch(() => undefined);
            const marketPayload = marketResponse?.ok ? await marketResponse.json().catch(() => undefined) : undefined;
            const market = Array.isArray(marketPayload?.market) ? marketPayload.market.find((item: { tokenAddress?: string }) => item.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase()) : undefined;
            if (!stopped && canRefresh() && market) {
              const marketUpdatedAt = typeof market.marketCapUpdatedAt === "number" ? market.marketCapUpdatedAt : 0;
              if (typeof market.marketCapUsd === "number"
                && marketUpdatedAt >= liveMarketCapUpdatedAt.current) {
                liveMarketCapUpdatedAt.current = marketUpdatedAt;
                setLiveMarketCapUsd(market.marketCapUsd);
              }
              if (typeof market.volume24hUsd === "number") setLiveVolume24hUsd(market.volume24hUsd);
              if (market.graduated === true) setLiveGraduated(true);
            }
      } catch { /* Keep the last market snapshot during transient failures. */ }
      finally {
        running = false; controller = null;
        if (!stopped && canRefresh()) timer = window.setTimeout(refresh, initialChecks++ < 3 ? 5_000 : 60_000);
      }
    };
    void refresh();
    return () => { stopped = true; controller?.abort(); window.clearTimeout(timer); };
  }, [tokenAddress, active, canRefresh]);
  useEffect(() => {
    let stopped = false; let running = false; let controller: AbortController | null = null;
    let followup: number | undefined; let timer: number | undefined; let checks = 0;
    const scheduleNext = () => {
      if (!stopped && canRefresh()) { window.clearTimeout(timer); timer = window.setTimeout(() => {
        checks = 0; if (canRefresh()) void refresh();
      }, observed.current[tab] === 0 ? 5_000 : activityNextRefreshDelay(observed.current[tab])); }
    };
    setTableLoading(observed.current[tab] === 0);
    const refresh = async (cacheOnly = false) => {
      if (stopped || running) return;
      running = true; controller = new AbortController();
      try {
        const endpoint = tab === "trades" ? "gecko-trades" : "holders";
        // The session cutoff stops upstream work, not access to an existing snapshot.
        const readOnly = cacheOnly || activityCacheOnly(canRefresh(), explicitFirstLoad.current, document.visibilityState === "visible");
        explicitFirstLoad.current = false;
        if (!readOnly) initialRequested.current[tab] = true;
        const response = await fetch(`/api/market/${endpoint}?token=${encodeURIComponent(tokenAddress)}${readOnly ? "&cacheOnly=1" : ""}`, {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        const payload = response.ok ? await response.json() : undefined;
        if (stopped) return;
        if (payload?.available && typeof payload.observedAt === "number" && payload.observedAt >= observed.current[tab]) {
          observed.current[tab] = payload.observedAt;
          if (tab === "trades" && Array.isArray(payload.trades)) setTrades(payload.trades);
          if (tab === "holders" && Array.isArray(payload.holders)) { setHolders(payload.holders); setHoldersPartial(payload.partial === true); }
        }
        if (tab === "trades") setTradesUnavailable(!response.ok); else setHoldersUnavailable(!response.ok);
        setTableLoading(!payload?.available && payload?.refreshing === true);
        // A few cache-only reads deliver the completed background job promptly.
        // They can never start another provider request, even after the five-minute cutoff.
        if (payload?.refreshing && checks < 7 && document.visibilityState === "visible") {
          followup = window.setTimeout(() => { checks++; void refresh(true); }, checks < 2 ? 2_000 : 8_000);
        } else { setTableLoading(false); scheduleNext(); }
      } catch (error) {
        // Cleanup aborts belong to an old effect. Any failure in a live effect,
        // including an AbortError from a timed-out request, must keep polling.
        if (!stopped) { if (tab === "trades") setTradesUnavailable(true); else setHoldersUnavailable(true); setTableLoading(false); scheduleNext(); }
      } finally { running = false; controller = null; }
    };
    void refresh();
    return () => { stopped = true; controller?.abort(); window.clearTimeout(timer); window.clearTimeout(followup); };
  }, [tab, tokenAddress, active, canRefresh]);
  // The token embed redirects to GeckoTerminal's current primary pool. That
  // keeps the chart following the active venue after a Pons graduation. Leave
  // the embed mounted independently of our five-minute data polling session.
  const geckoUrl = poolAddress ? `https://www.geckoterminal.com/robinhood/tokens/${encodeURIComponent(tokenAddress)}?embed=1&info=0&swaps=0` : undefined;
  return <TokenMarketSnapshotContext.Provider value={{ marketCapUsd: liveMarketCapUsd, graduated: liveGraduated }}><section className="token-market-panel">
    <div className="token-page-columns"><div className="token-left-column">
    <div className="token-market-overview"><div className="token-market-artwork">{artwork}</div><div className="token-market-summary">{summary}</div></div>
    <div className="token-chart-column"><div className="market-chart-head"><div><small>Market Cap</small><strong>{liveMarketCapUsd === undefined ? "—" : formatMoney(liveMarketCapUsd)}</strong></div><div className="market-volume"><small>24h Volume</small><strong>{liveVolume24hUsd === undefined ? "—" : formatMoney(liveVolume24hUsd)}</strong></div></div>{geckoUrl ? <div className="gecko-chart-shell"><iframe src={geckoUrl} title={`${symbol} live chart on GeckoTerminal`} loading="lazy" referrerPolicy="strict-origin-when-cross-origin" allow="clipboard-write" /></div> : <div className="market-chart empty">Chart data is not available for this launch yet.</div>}</div>
  </div><div className="token-right-column"><div className="token-details-column">{details}</div><div className="token-activity-column">
    <div className="activity-tabs" role="tablist"><button type="button" role="tab" aria-selected={tab === "trades"} className={tab === "trades" ? "active" : ""} onClick={() => selectTab("trades")}>Recent Trades</button><button type="button" role="tab" aria-selected={tab === "holders"} className={tab === "holders" ? "active" : ""} onClick={() => selectTab("holders")}>Holders</button></div>
    {tableLoading && (tab === "trades" ? !trades.length : !holders.length) ? <p className="terminal-empty">Loading {tab === "trades" ? "recent trades" : "holders"}…</p> : null}
    {tab === "holders" && holdersPartial ? <p className="terminal-empty">Showing known holders while the full ranking updates.</p> : null}
    {tab === "holders" && !tableLoading && !holdersUnavailable && !holders.length ? <p className="terminal-empty">Holder data is being indexed.</p> : null}
    {tab === "trades" && tradesUnavailable && !trades.length ? <p className="terminal-empty">Recent trades are still loading.</p> : null}{tab === "holders" && holdersUnavailable && !holders.length ? <p className="terminal-empty">Holder data is still loading.</p> : null}
    <div className="activity-table-wrap"><table className="activity-table">{tab === "trades" ? <><thead><tr><th>Account</th><th>Type</th><th>Amount</th><th>Value</th><th>MCap</th><th>Time</th><th>Txn</th></tr></thead><tbody>{trades.map((trade) => <tr key={`${trade.source}:${trade.id}`}><td><a href={`https://robinhoodchain.blockscout.com/address/${trade.walletAddress}`} target="_blank" rel="noreferrer">{shortAddress(trade.walletAddress)}</a></td><td><span className={`activity-kind ${trade.kind}`}>{capitalize(trade.kind)}</span></td><td>{formatAmount(trade.tokenAmount)} ${symbol}</td><td>{trade.usdAmount === undefined ? "—" : formatMoney(trade.usdAmount)}</td><td>{trade.marketCapUsd === undefined ? "—" : formatMoney(trade.marketCapUsd)}</td><td>{relativeTime(trade.timestamp)}</td><td><a href={`https://robinhoodchain.blockscout.com/tx/${trade.transactionHash}`} target="_blank" rel="noreferrer">{shortHash(trade.transactionHash)}</a></td></tr>)}</tbody></> : <><thead><tr><th>Rank</th><th>Account</th><th>Holding</th><th>Value</th><th>Share</th></tr></thead><tbody>{holders.map((holder, index) => <tr key={holder.address}><td>{index + 1}</td><td><a href={`https://robinhoodchain.blockscout.com/address/${holder.address}`} target="_blank" rel="noreferrer">{shortAddress(holder.address)}</a>{holder.tag ? <span className={`holder-tag ${holderTagClass(holder.tag)}`}>{holder.tag}</span> : null}</td><td>{formatAmount(holder.amount)} ${symbol}</td><td>{liveMarketCapUsd === undefined || holder.percentage === undefined ? "—" : formatMoney(liveMarketCapUsd * holder.percentage / 100)}</td><td>{holder.percentage === undefined ? "—" : `${holder.percentage.toFixed(2)}%`}</td></tr>)}</tbody></>}</table></div>
  </div></div></div></section></TokenMarketSnapshotContext.Provider>;
}

function formatAmount(value: string) { const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6, notation: number >= 1_000_000 ? "compact" : "standard" }).format(number) : value; }
function formatMoney(value: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: value >= 1_000_000 ? "compact" : "standard", maximumFractionDigits: value < 1 ? 4 : 2 }).format(value); }
function relativeTime(value: number) { const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000)); return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`; }
function capitalize(value: string) { return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`; }
function shortHash(value: string) { return `${value.slice(0, 6)}…${value.slice(-4)}`; }
function holderTagClass(tag: HolderTag) { return tag === "Creator" ? "creator" : "liquidity"; }
