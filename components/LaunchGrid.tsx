"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicLaunch } from "@/lib/site-data";
import { LaunchCard } from "@/components/LaunchCard";

type Sort = "newest" | "oldest" | "mcap" | "lastBuy" | "volume";
type MarketUpdate = Pick<PublicLaunch, "tokenAddress" | "marketCapUsd" | "volume24hUsd" | "lastBuyAt" | "graduated">;
const PAGE_SIZE = 20;

export function LaunchGrid({ launches }: { launches: PublicLaunch[] }) {
  const [liveLaunches, setLiveLaunches] = useState(launches);
  const [sort, setSort] = useState<Sort>("newest");
  const [page, setPage] = useState(1);
  const [graduatedOnly, setGraduatedOnly] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const paginationStarted = useRef(false);
  const sortRequest = useRef<AbortController | null>(null);
  useEffect(() => setLiveLaunches(launches), [launches]);
  useEffect(() => () => sortRequest.current?.abort(), []);

  const sorted = useMemo(() => liveLaunches.filter((launch) => !graduatedOnly || launch.graduated).sort((a, b) => sort === "oldest" ? a.createdAt - b.createdAt : sort === "mcap" ? (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1) : sort === "volume" ? (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1) : sort === "lastBuy" ? (b.lastBuyAt ?? -1) - (a.lastBuyAt ?? -1) : b.createdAt - a.createdAt), [liveLaunches, sort, graduatedOnly]);
  const pages = Math.ceil(sorted.length / PAGE_SIZE);
  const visible = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const choose = async (next: Sort) => {
    sortRequest.current?.abort();
    const controller = new AbortController();
    sortRequest.current = controller;
    setSort(next); setPage(1); setLoadingMore(true); paginationStarted.current = false;
    try {
      const payload = await fetch(`/api/launches?count=40&sort=${next}`, { cache: "no-store", signal: controller.signal }).then((response) => response.ok ? response.json() : undefined);
      if (controller.signal.aborted) return;
      if (Array.isArray(payload?.page)) setLiveLaunches(payload.page);
      setNextCursor(payload?.isDone ? null : payload?.continueCursor || null);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error("launch_sort_failed", error);
    } finally {
      if (sortRequest.current === controller) { sortRequest.current = null; setLoadingMore(false); }
    }
  };
  const updateMarket = useCallback((market: MarketUpdate[]) => setLiveLaunches((current) => current.map((launch) => {
    const update = market.find((item) => item.tokenAddress?.toLowerCase() === launch.tokenAddress?.toLowerCase());
    return update ? { ...launch, ...update } : launch;
  })), []);
  const updateLaunches = useCallback((incoming: PublicLaunch[]) => setLiveLaunches((current) => {
    const known = new Map(current.flatMap((launch) => launch.tokenAddress ? [[launch.tokenAddress.toLowerCase(), launch] as const] : []));
    const merged = incoming.map((launch) => {
      const prior = launch.tokenAddress ? known.get(launch.tokenAddress.toLowerCase()) : undefined;
      return { ...prior, ...launch, marketCapUsd: launch.storedMarketCapUsd ?? launch.marketCapUsd ?? prior?.marketCapUsd };
    });
    const addresses = new Set(merged.flatMap((launch) => launch.tokenAddress ? [launch.tokenAddress.toLowerCase()] : []));
    return [...merged, ...current.filter((launch) => !launch.tokenAddress || !addresses.has(launch.tokenAddress.toLowerCase()))];
  }), []);
  const receiveRecent = useCallback((incoming: PublicLaunch[], cursor: string | null) => {
    updateLaunches(incoming);
    if (!paginationStarted.current) setNextCursor(cursor);
  }, [updateLaunches]);
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    paginationStarted.current = true;
    setLoadingMore(true);
    try {
      const payload = await fetch(`/api/launches?count=40&sort=${sort}&cursor=${encodeURIComponent(nextCursor)}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : undefined);
      if (Array.isArray(payload?.page)) updateLaunches(payload.page);
      setNextCursor(payload?.isDone ? null : payload?.continueCursor || null);
    } finally { setLoadingMore(false); }
  };

  return <>
    <MarketViewer sort={sort} tokenAddresses={visible.flatMap((launch) => launch.tokenAddress ? [launch.tokenAddress] : [])} onMarket={updateMarket} onLaunches={receiveRecent} />
    <div className="launch-toolbar" aria-label="Sort launches">{([['newest','Newest'],['oldest','Oldest'],['mcap','Highest MCap'],['volume','24h Volume'],['lastBuy','Last Buy']] as const).map(([value,label]) => <button key={value} className={sort === value ? "active" : ""} type="button" onClick={() => void choose(value)}>{label}</button>)}<button className={graduatedOnly ? "active" : ""} type="button" aria-pressed={graduatedOnly} onClick={() => { setGraduatedOnly((value) => !value); setPage(1); }}>Graduated</button></div>
    <div className="launch-grid">{visible.map((launch) => <LaunchCard key={launch.tokenAddress} launch={launch} />)}</div>
    {pages > 1 ? <nav className="launch-pagination" aria-label="Launch pages">{Array.from({ length: pages }, (_, i) => i + 1).map((number) => <button key={number} className={page === number ? "active" : ""} type="button" onClick={() => setPage(number)} aria-current={page === number ? "page" : undefined}>{number}</button>)}</nav> : null}
    {nextCursor ? <button className="button button-quiet launch-load-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more launches"}</button> : null}
  </>;
}

function MarketViewer({ sort, tokenAddresses, onMarket, onLaunches }: { sort: Sort; tokenAddresses: string[]; onMarket: (market: MarketUpdate[]) => void; onLaunches: (launches: PublicLaunch[], cursor: string | null) => void }) {
  const tokenKey = tokenAddresses.join(",");
  useEffect(() => {
    let stopped = false;
    const ping = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const [marketPayload, launchPayload] = await Promise.all([
        fetch("/api/market/view", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenAddresses: tokenKey ? tokenKey.split(",") : [] }) }).then((response) => response.ok ? response.json() : undefined).catch(() => undefined),
        fetch(`/api/launches?count=40&sort=${sort}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : undefined).catch(() => undefined),
      ]);
      if (!stopped && Array.isArray(marketPayload?.market)) onMarket(marketPayload.market);
      if (!stopped && Array.isArray(launchPayload?.page)) onLaunches(launchPayload.page, launchPayload.isDone ? null : launchPayload.continueCursor || null);
    };
    void ping();
    const timer = window.setInterval(ping, 10_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [tokenKey, sort, onMarket, onLaunches]);
  return null;
}
