"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PublicLaunch } from "@/lib/site-data";
import { LaunchCard } from "@/components/LaunchCard";
type Sort = "newest" | "oldest" | "mcap" | "lastBuy" | "volume";
type MarketUpdate = Pick<PublicLaunch, "tokenAddress" | "marketCapUsd" | "volume24hUsd" | "lastBuyAt" | "graduated">;
const PAGE_SIZE = 20;

export function LaunchGrid({ launches }: { launches: PublicLaunch[] }) {
  const [liveLaunches, setLiveLaunches] = useState(launches); const [sort, setSort] = useState<Sort>("newest");
  const [page, setPage] = useState(1); const [graduatedOnly, setGraduatedOnly] = useState(false);
  useEffect(() => setLiveLaunches(launches), [launches]);
  const sorted = useMemo(() => liveLaunches.filter((launch) => !graduatedOnly || launch.graduated).sort((a, b) => sort === "oldest" ? a.createdAt - b.createdAt : sort === "mcap" ? (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1) : sort === "volume" ? (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1) : sort === "lastBuy" ? (b.lastBuyAt ?? -1) - (a.lastBuyAt ?? -1) : b.createdAt - a.createdAt), [liveLaunches, sort, graduatedOnly]);
  const pages = Math.ceil(sorted.length / PAGE_SIZE); const visible = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  function choose(next: Sort) { setSort(next); setPage(1); }
  const updateMarket = useCallback((market: MarketUpdate[]) => { setLiveLaunches((current) => current.map((launch) => { const update = market.find((item) => item.tokenAddress?.toLowerCase() === launch.tokenAddress?.toLowerCase()); return update ? { ...launch, ...update } : launch; })); }, []);
  const updateLaunches = useCallback((incoming: PublicLaunch[]) => setLiveLaunches((current) => {
    const known = new Map(current.flatMap((launch) => launch.tokenAddress ? [[launch.tokenAddress.toLowerCase(), launch] as const] : []));
    const merged = incoming.map((launch) => {
      const prior = launch.tokenAddress ? known.get(launch.tokenAddress.toLowerCase()) : undefined;
      return { ...prior, ...launch, marketCapUsd: launch.storedMarketCapUsd ?? launch.marketCapUsd ?? prior?.marketCapUsd };
    });
    const addresses = new Set(merged.flatMap((launch) => launch.tokenAddress ? [launch.tokenAddress.toLowerCase()] : []));
    return [...merged, ...current.filter((launch) => !launch.tokenAddress || !addresses.has(launch.tokenAddress.toLowerCase()))];
  }), []);
  return <><MarketViewer tokenAddresses={visible.flatMap((launch) => launch.tokenAddress ? [launch.tokenAddress] : [])} onMarket={updateMarket} onLaunches={updateLaunches} /><div className="launch-toolbar" aria-label="Sort launches">{([['newest','Newest'],['oldest','Oldest'],['mcap','Highest MCap'],['volume','24h Volume'],['lastBuy','Last Buy']] as const).map(([value,label]) => <button key={value} className={sort === value ? "active" : ""} type="button" onClick={() => choose(value)}>{label}</button>)}<button className={graduatedOnly ? "active" : ""} type="button" aria-pressed={graduatedOnly} onClick={() => { setGraduatedOnly((value) => !value); setPage(1); }}>Graduated</button></div><div className="launch-grid">{visible.map((launch) => <LaunchCard key={launch.tokenAddress} launch={launch} />)}</div>{pages > 1 ? <nav className="launch-pagination" aria-label="Launch pages">{Array.from({ length: pages }, (_, i) => i + 1).map((number) => <button key={number} className={page === number ? "active" : ""} type="button" onClick={() => setPage(number)} aria-current={page === number ? "page" : undefined}>{number}</button>)}</nav> : null}</>;
}

function MarketViewer({ tokenAddresses, onMarket, onLaunches }: { tokenAddresses: string[]; onMarket: (market: MarketUpdate[]) => void; onLaunches: (launches: PublicLaunch[]) => void }) {
  const tokenKey = tokenAddresses.join(",");
  useEffect(() => {
    let stopped = false;
    const ping = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const payload = await fetch("/api/market/view", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenAddresses: tokenKey ? tokenKey.split(",") : [] }) }).then((response) => response.ok ? response.json() : undefined).catch(() => undefined);
      if (!stopped && Array.isArray(payload?.market)) onMarket(payload.market);
      if (!stopped && Array.isArray(payload?.launches)) onLaunches(payload.launches);
    };
    void ping(); const timer = window.setInterval(ping, 10_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [tokenKey, onMarket, onLaunches]);
  return null;
}
