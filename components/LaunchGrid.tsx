"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicLaunch } from "@/lib/site-data";
import { LaunchCard } from "@/components/LaunchCard";
import { usePageRefreshSession } from "@/components/usePageRefreshSession";

type Sort = "newest" | "oldest" | "mcap" | "volume";
type MarketUpdate = Pick<PublicLaunch, "tokenAddress" | "marketCapUsd" | "marketCapUpdatedAt" | "volume24hUsd" | "volume24hUpdatedAt" | "lastBuyAt" | "graduated" | "graduationUpdatedAt">;
const PAGE_SIZE = 20;

export function LaunchGrid({ launches, launchCount }: { launches: PublicLaunch[]; launchCount: number }) {
  const refreshSession = usePageRefreshSession();
  const [liveLaunches, setLiveLaunches] = useState(launches.slice(0, PAGE_SIZE));
  const [sort, setSort] = useState<Sort>("mcap");
  const [page, setPage] = useState(1);
  const [graduatedOnly, setGraduatedOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [loadingPage, setLoadingPage] = useState(false);
  const sortRequest = useRef<AbortController | null>(null);
  // The server supplies this list in MCap order on first entry. Keep that
  // initial top ten stable even if the user restores another session sort.
  const entryTopTenKey = useRef(launches.slice(0, 10).flatMap((launch) => launch.tokenAddress ? [launch.tokenAddress] : []).join(","));
  useEffect(() => setLiveLaunches(launches.slice(0, PAGE_SIZE)), [launches]);
  useEffect(() => () => sortRequest.current?.abort(), []);

  const visible = useMemo(() => liveLaunches.filter((launch) => !graduatedOnly || launch.graduated), [liveLaunches, graduatedOnly]);
  const pages = Math.max(1, Math.ceil(launchCount / PAGE_SIZE));
  const requestPage = useCallback(async (pageNumber: number, selectedSort: Sort, selectedSearch = "", signal?: AbortSignal) => {
    const params = new URLSearchParams({ count: String(PAGE_SIZE), sort: selectedSort, page: String(pageNumber) });
    if (selectedSearch) params.set("search", selectedSearch);
    const payload = await fetch(`/api/launches?${params}`, { cache: "no-store", signal }).then((response) => response.ok ? response.json() : undefined);
    return Array.isArray(payload?.page) ? payload.page as PublicLaunch[] : undefined;
  }, []);
  const goToPage = async (pageNumber: number) => {
    if (pageNumber === page || loadingPage || pageNumber < 1 || pageNumber > pages) return;
    sortRequest.current?.abort();
    const controller = new AbortController();
    sortRequest.current = controller;
    setLoadingPage(true);
    try {
      const selected = await requestPage(pageNumber, sort, activeSearch, controller.signal);
      if (!controller.signal.aborted && selected) { setLiveLaunches(selected); setPage(pageNumber); }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error("launch_page_failed", error);
    } finally {
      if (sortRequest.current === controller) { sortRequest.current = null; setLoadingPage(false); }
    }
  };
  const choose = async (next: Sort) => {
    sortRequest.current?.abort();
    const controller = new AbortController();
    sortRequest.current = controller;
    setSort(next); setPage(1); setLoadingPage(true);
    try { window.sessionStorage.setItem("ponsbot-launch-sort", next); } catch {}
    try {
      const selected = await requestPage(1, next, activeSearch, controller.signal);
      if (controller.signal.aborted) return;
      if (selected) setLiveLaunches(selected);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error("launch_sort_failed", error);
    } finally {
      if (sortRequest.current === controller) { sortRequest.current = null; setLoadingPage(false); }
    }
  };
  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.sessionStorage.getItem("ponsbot-launch-sort"); } catch {}
    if (stored && ["newest", "oldest", "mcap", "volume"].includes(stored) && stored !== sort) void choose(stored as Sort);
    else if (stored === "lastBuy") try { window.sessionStorage.removeItem("ponsbot-launch-sort"); } catch {}
    // This restores the user's choice once per page mount. Subsequent changes
    // are handled by choose() and persisted for refreshes in this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const selectedSearch = search.trim();
    const timer = window.setTimeout(async () => {
      sortRequest.current?.abort();
      const controller = new AbortController();
      sortRequest.current = controller;
      setActiveSearch(selectedSearch);
      setPage(1);
      setLoadingPage(true);
      try {
        const selected = await requestPage(1, sort, selectedSearch, controller.signal);
        if (!controller.signal.aborted && selected) setLiveLaunches(selected);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) console.error("launch_search_failed", error);
      } finally {
        if (sortRequest.current === controller) { sortRequest.current = null; setLoadingPage(false); }
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, sort, requestPage]);
  const updateMarket = useCallback((market: MarketUpdate[]) => setLiveLaunches((current) => current.map((launch) => {
    const update = market.find((item) => item.tokenAddress?.toLowerCase() === launch.tokenAddress?.toLowerCase());
    if (!update) return launch;
    const marketCapIsCurrent = sourceIsCurrent(launch.marketCapUpdatedAt, update.marketCapUpdatedAt);
    const volumeIsCurrent = sourceIsCurrent(launch.volume24hUpdatedAt, update.volume24hUpdatedAt);
    const graduationIsCurrent = sourceIsCurrent(launch.graduationUpdatedAt, update.graduationUpdatedAt);
    return {
      ...launch,
      lastBuyAt: Math.max(launch.lastBuyAt ?? 0, update.lastBuyAt ?? 0) || undefined,
      ...(marketCapIsCurrent && update.marketCapUsd !== undefined ? { marketCapUsd: update.marketCapUsd, marketCapUpdatedAt: update.marketCapUpdatedAt } : {}),
      ...(volumeIsCurrent && update.volume24hUsd !== undefined ? { volume24hUsd: update.volume24hUsd, volume24hUpdatedAt: update.volume24hUpdatedAt } : {}),
      ...(graduationIsCurrent && update.graduated !== undefined ? { graduated: update.graduated, graduationUpdatedAt: update.graduationUpdatedAt } : {}),
    };
  })), []);
  const updateLaunches = useCallback((incoming: PublicLaunch[]) => setLiveLaunches((current) => {
    if (activeSearch) return incoming.slice(0, PAGE_SIZE);
    const known = new Map(current.flatMap((launch) => launch.tokenAddress ? [[launch.tokenAddress.toLowerCase(), launch] as const] : []));
    const merged = incoming.map((launch) => {
      const prior = launch.tokenAddress ? known.get(launch.tokenAddress.toLowerCase()) : undefined;
      const incomingMarketCap = launch.marketCapUsd ?? launch.storedMarketCapUsd;
      const incomingIsAtLeastAsFresh = sourceIsCurrent(prior?.marketCapUpdatedAt, launch.marketCapUpdatedAt);
      const incomingVolumeIsCurrent = sourceIsCurrent(prior?.volume24hUpdatedAt, launch.volume24hUpdatedAt);
      const incomingGraduationIsCurrent = sourceIsCurrent(prior?.graduationUpdatedAt, launch.graduationUpdatedAt);
      return {
        ...prior,
        ...launch,
        marketCapUsd: incomingIsAtLeastAsFresh
          ? incomingMarketCap ?? prior?.marketCapUsd
          : prior?.marketCapUsd ?? incomingMarketCap,
        marketCapUpdatedAt: incomingIsAtLeastAsFresh
          ? launch.marketCapUpdatedAt ?? prior?.marketCapUpdatedAt
          : prior?.marketCapUpdatedAt ?? launch.marketCapUpdatedAt,
        volume24hUsd: incomingVolumeIsCurrent ? launch.volume24hUsd ?? prior?.volume24hUsd : prior?.volume24hUsd ?? launch.volume24hUsd,
        volume24hUpdatedAt: incomingVolumeIsCurrent ? launch.volume24hUpdatedAt ?? prior?.volume24hUpdatedAt : prior?.volume24hUpdatedAt ?? launch.volume24hUpdatedAt,
        lastBuyAt: Math.max(prior?.lastBuyAt ?? 0, launch.lastBuyAt ?? 0) || undefined,
        graduated: incomingGraduationIsCurrent ? launch.graduated ?? prior?.graduated : prior?.graduated ?? launch.graduated,
        graduationUpdatedAt: incomingGraduationIsCurrent ? launch.graduationUpdatedAt ?? prior?.graduationUpdatedAt : prior?.graduationUpdatedAt ?? launch.graduationUpdatedAt,
      };
    });
    const addresses = new Set(merged.flatMap((launch) => launch.tokenAddress ? [launch.tokenAddress.toLowerCase()] : []));
    return [...merged, ...current.filter((launch) => !launch.tokenAddress || !addresses.has(launch.tokenAddress.toLowerCase()))].slice(0, PAGE_SIZE);
  }), [activeSearch]);

  const monitored = visible;
  return <>
    <MarketViewer sort={sort} page={page} search={activeSearch} launches={monitored} entryTopTenKey={entryTopTenKey.current} onMarket={updateMarket} onLaunches={updateLaunches} active={refreshSession.active} canRefresh={refreshSession.canRefresh} />
    <div className="launch-toolbar" aria-label="Launch filters"><div className="launch-sort-buttons">{([['newest','Newest'],['oldest','Oldest'],['mcap','Highest MCap'],['volume','24h Volume']] as const).map(([value,label]) => <button key={value} className={sort === value ? "active" : ""} type="button" onClick={() => void choose(value)}>{label}</button>)}<button className={graduatedOnly ? "active" : ""} type="button" aria-pressed={graduatedOnly} onClick={() => { setGraduatedOnly((value) => !value); setPage(1); }}>Graduated</button></div><label className="launch-search"><span className="sr-only">Search launches by name or ticker</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or ticker" autoComplete="off" /></label></div>
    <div className="launch-grid" aria-busy={loadingPage}>{loadingPage ? <div className="launch-page-loading">Loading launches…</div> : visible.length ? visible.map((launch) => <LaunchCard key={launch.tokenAddress} launch={launch} />) : <div className="launch-search-empty">No launches match that search.</div>}</div>
    {!activeSearch && pages > 1 ? <nav className="launch-pagination" aria-label="Launch pages">{Array.from({ length: pages }, (_, i) => i + 1).map((number) => <button key={number} className={page === number ? "active" : ""} disabled={loadingPage} type="button" onClick={() => void goToPage(number)} aria-current={page === number ? "page" : undefined}>{number}</button>)}</nav> : null}
  </>;
}

function sourceIsCurrent(existingAt?: number, incomingAt?: number) {
  if (incomingAt === undefined) return existingAt === undefined;
  return existingAt === undefined || incomingAt >= existingAt;
}

function MarketViewer({ sort, page, search, launches, entryTopTenKey, onMarket, onLaunches, active, canRefresh }: { sort: Sort; page: number; search: string; launches: PublicLaunch[]; entryTopTenKey: string; onMarket: (market: MarketUpdate[]) => void; onLaunches: (launches: PublicLaunch[]) => void; active: boolean; canRefresh: () => boolean }) {
  const tokenAddresses = launches.flatMap((launch) => launch.tokenAddress ? [launch.tokenAddress] : []);
  const tokenKey = tokenAddresses.join(",");
  const entryRefreshDone = useRef(false);
  useEffect(() => {
    if (!active || !canRefresh()) return;
    let stopped = false;
    let running = false;
    let controller: AbortController | null = null;
    let timer: number | undefined;
    let lastLaunchRefreshAt = 0;
    const ping = async () => {
      if (stopped || running || !canRefresh()) return;
      running = true; controller = new AbortController();
      const nextRefreshMs = 60_000;
      try {
        const refreshingEntryTopTen = page === 1 && !search && !entryRefreshDone.current && Boolean(entryTopTenKey);
        // Top ten first, then the rest of the visible page. Never refresh off-screen cards.
        const requestedTokenKey = refreshingEntryTopTen
          ? [...new Set([...entryTopTenKey.split(",").filter(t => tokenKey.split(",").includes(t)), ...tokenKey.split(",")])].filter(Boolean).slice(0, 20).join(",")
          : tokenKey;
        // Persist market changes before requesting the sorted launch page. A
        // concurrent launch request can contain the pre-index last-buy value
        // and overwrite the fresh update in React.
        const marketPayload = await fetch("/api/market/snapshot", { method: "POST", cache: "no-store", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenAddresses: requestedTokenKey ? requestedTokenKey.split(",") : [], surface: "launches" }) }).then((response) => response.ok ? response.json() : undefined).catch(() => undefined);
        if (refreshingEntryTopTen && marketPayload?.ok === true) entryRefreshDone.current = true;
        if (!stopped && canRefresh() && Array.isArray(marketPayload?.market)) onMarket(marketPayload.market);
        if (!stopped && canRefresh() && Date.now() - lastLaunchRefreshAt >= 60_000) {
          const params = new URLSearchParams({ count: String(PAGE_SIZE), sort, page: String(page) });
          if (search) params.set("search", search);
          const launchPayload = await fetch(`/api/launches?${params}`, { cache: "no-store", signal: controller.signal }).then((response) => response.ok ? response.json() : undefined).catch(() => undefined);
          if (!stopped && canRefresh() && Array.isArray(launchPayload?.page)) onLaunches(launchPayload.page);
          lastLaunchRefreshAt = Date.now();
        }
        // A CDN may still serve the launch page from its short stale window;
        // reapply this cycle's authoritative market snapshot after merging it.
        if (!stopped && canRefresh() && Array.isArray(marketPayload?.market)) onMarket(marketPayload.market);
      } finally {
        running = false; controller = null;
        if (!stopped && canRefresh()) timer = window.setTimeout(ping, nextRefreshMs);
      }
    };
    void ping();
    return () => { stopped = true; controller?.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [tokenKey, entryTopTenKey, sort, page, search, onMarket, onLaunches, active, canRefresh]);
  return null;
}
