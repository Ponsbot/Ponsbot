"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { PublicLaunch } from "@/lib/site-data";
import { LaunchCard } from "@/components/LaunchCard";
type Sort = "newest" | "oldest" | "mcap" | "lastBuy" | "volume";
// Five cards per desktop row, with four rows available before pagination.
const PAGE_SIZE = 20;

export function LaunchGrid({ launches }: { launches: PublicLaunch[] }) {
  const [sort, setSort] = useState<Sort>("newest"); const [page, setPage] = useState(1); const [graduatedOnly, setGraduatedOnly] = useState(false);
  const sorted = useMemo(() => launches.filter((launch) => !graduatedOnly || launch.graduated).sort((a, b) => sort === "oldest" ? a.createdAt - b.createdAt : sort === "mcap" ? (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1) : sort === "volume" ? (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1) : sort === "lastBuy" ? (b.lastBuyAt ?? -1) - (a.lastBuyAt ?? -1) : b.createdAt - a.createdAt), [launches, sort, graduatedOnly]);
  const pages = Math.ceil(sorted.length / PAGE_SIZE); const visible = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  function choose(next: Sort) { setSort(next); setPage(1); }
  return <><MarketViewer tokenAddresses={visible.flatMap((launch) => launch.tokenAddress ? [launch.tokenAddress] : [])} /><div className="launch-toolbar" aria-label="Sort launches">{([['newest','Newest'],['oldest','Oldest'],['mcap','Highest MCap'],['volume','24h Volume'],['lastBuy','Last Buy']] as const).map(([value,label]) => <button key={value} className={sort === value ? "active" : ""} type="button" onClick={() => choose(value)}>{label}</button>)}<button className={graduatedOnly ? "active" : ""} type="button" aria-pressed={graduatedOnly} onClick={() => { setGraduatedOnly((value) => !value); setPage(1); }}>Graduated</button></div><div className="launch-grid">{visible.map((launch) => <LaunchCard key={launch.tokenAddress} launch={launch} />)}</div>{pages > 1 ? <nav className="launch-pagination" aria-label="Launch pages">{Array.from({ length: pages }, (_, i) => i + 1).map((number) => <button key={number} className={page === number ? "active" : ""} type="button" onClick={() => setPage(number)} aria-current={page === number ? "page" : undefined}>{number}</button>)}</nav> : null}</>;
}

function MarketViewer({ tokenAddresses }: { tokenAddresses: string[] }) {
  const router = useRouter();
  const tokenKey = tokenAddresses.join(",");
  useEffect(() => {
    let stopped = false;
    const ping = async () => { if (!stopped && document.visibilityState === "visible") { await fetch("/api/market/view", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenAddresses: tokenKey ? tokenKey.split(",") : [] }) }).catch(() => undefined); router.refresh(); } };
    ping(); const timer = window.setInterval(ping, 10_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [router, tokenKey]);
  return null;
}
