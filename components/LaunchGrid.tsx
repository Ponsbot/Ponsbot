"use client";

import { useMemo, useState } from "react";
import type { PublicLaunch } from "@/lib/site-data";
import { LaunchCard } from "@/components/LaunchCard";
type Sort = "newest" | "oldest" | "mcap";
const PAGE_SIZE = 12;

export function LaunchGrid({ launches }: { launches: PublicLaunch[] }) {
  const [sort, setSort] = useState<Sort>("newest"); const [page, setPage] = useState(1);
  const sorted = useMemo(() => [...launches].sort((a, b) => sort === "oldest" ? a.createdAt - b.createdAt : sort === "mcap" ? (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1) : b.createdAt - a.createdAt), [launches, sort]);
  const pages = Math.ceil(sorted.length / PAGE_SIZE); const visible = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  function choose(next: Sort) { setSort(next); setPage(1); }
  return <><div className="launch-toolbar" aria-label="Sort launches">{([['newest','Newest'],['oldest','Oldest'],['mcap','Highest MCap']] as const).map(([value,label]) => <button key={value} className={sort === value ? "active" : ""} type="button" onClick={() => choose(value)}>{label}</button>)}</div><div className="launch-grid">{visible.map((launch) => <LaunchCard key={launch.tokenAddress} launch={launch} />)}</div>{pages > 1 ? <nav className="launch-pagination" aria-label="Launch pages">{Array.from({ length: pages }, (_, i) => i + 1).map((number) => <button key={number} className={page === number ? "active" : ""} type="button" onClick={() => setPage(number)} aria-current={page === number ? "page" : undefined}>{number}</button>)}</nav> : null}</>;
}
