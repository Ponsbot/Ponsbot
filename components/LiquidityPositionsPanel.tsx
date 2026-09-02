"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type LiveAsset = { symbol: string; amount: string; usd: number | null; unclaimed: string | null; unclaimedUsd: number | null };
type Position = {
  id: string; status: "active" | "closed"; token: string; symbol: string; version: 3 | 4; poolId: string;
  pair?: "ETH" | "USDG"; shape?: "flat" | "bell" | "bid_ask"; feePercent?: number; bands?: number;
  lowerMarketCapUsd?: number; upperMarketCapUsd?: number; createdAt: number; updatedAt: number; nftIds: string[];
  feesClaimed: Array<{ symbol: string; amount: string }>;
  live: null | { assets: LiveAsset[]; marketCapRangeUsd?: { lower: number; upper: number } | null; range: { inRange: boolean } };
};

const money = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : value > 0 && value < .01 ? "<$0.01" : value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const amount = (value: string) => Number(value).toLocaleString("en-US", { maximumSignificantDigits: 7 });
const mcap = (value?: number) => value == null ? "—" : value >= 1e9 ? `$${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `$${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `$${(value / 1e3).toFixed(1)}K` : `$${value.toFixed(0)}`;
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

export function LiquidityPositionsPanel({ busy, submit, openTerminal }: {
  busy: boolean;
  submit: (payload: { channel: "terminal_chat"; text: string }) => Promise<void>;
  openTerminal: () => void;
}) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [tab, setTab] = useState<"active" | "closed">("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [acting, setActing] = useState<string>();
  const [token, setToken] = useState("");
  const [budget, setBudget] = useState("");
  const [unit, setUnit] = useState<"usd" | "eth">("usd");
  const [pair, setPair] = useState<"ETH" | "USDG">("ETH");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/terminal/liquidity", { cache: "no-store" });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Liquidity positions could not be loaded.");
      setPositions(Array.isArray(value.positions) ? value.positions : []);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Liquidity positions could not be loaded."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), acting ? 5_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [acting, refresh]);

  const build = (event: FormEvent) => {
    event.preventDefault();
    const symbol = token.trim();
    const value = budget.trim();
    if (!symbol || !value) return;
    const text = `create a ${unit === "usd" ? `$${value}` : `${value} ETH`} liquidity position for ${symbol} paired with ${pair}`;
    void submit({ channel: "terminal_chat", text }).then(openTerminal);
  };
  const act = async (position: Position, kind: "claim" | "withdraw") => {
    setActing(`${kind}:${position.id}`);
    await submit({ channel: "terminal_chat", text: kind === "claim" ? `claim LP fees for ${position.id}` : `withdraw ${position.id}` });
    window.setTimeout(() => { void refresh(); setActing(undefined); }, 5_000);
  };
  const visible = positions.filter(position => position.status === tab);

  return <section className="liquidity-positions-workspace">
    <form className="liquidity-builder" onSubmit={build}>
      <div><p className="eyebrow">Delta Liquidity</p><h2>Build a Position</h2><p>Start with the token and budget. Pons Bot will analyze available pools and guide you through the remaining choices.</p></div>
      <label>Token or contract<input value={token} onChange={event => setToken(event.target.value)} placeholder="PONSBOT or 0x…" required /></label>
      <label>Budget<div className="liquidity-budget-input"><input value={budget} inputMode="decimal" onChange={event => setBudget(event.target.value)} placeholder={unit === "usd" ? "100" : "0.05"} required /><select value={unit} onChange={event => setUnit(event.target.value as "usd" | "eth")}><option value="usd">USD</option><option value="eth">ETH</option></select></div></label>
      <label>Pool pair<select value={pair} onChange={event => setPair(event.target.value as "ETH" | "USDG")}><option>ETH</option><option>USDG</option></select></label>
      <button className="button button-dark" disabled={busy} type="submit">Analyze Pools</button>
    </form>

    <div className="liquidity-position-list">
      <div className="terminal-section-head"><div><p className="eyebrow">Your positions</p><h2>Liquidity Positions</h2></div><button className="button button-quiet" type="button" onClick={() => void refresh()} disabled={loading}>Refresh</button></div>
      <div className="liquidity-position-tabs"><button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")} type="button">Open ({positions.filter(position => position.status === "active").length})</button><button className={tab === "closed" ? "active" : ""} onClick={() => setTab("closed")} type="button">Closed ({positions.filter(position => position.status === "closed").length})</button></div>
      {error ? <p className="liquidity-position-error">{error}</p> : null}
      {loading ? <p className="terminal-empty">Loading your Delta Liquidity positions…</p> : null}
      {!loading && !visible.length ? <p className="terminal-empty">No {tab} liquidity positions.</p> : null}
      <div className="liquidity-position-cards">{visible.map(position => {
        const range = position.live?.marketCapRangeUsd ?? (position.lowerMarketCapUsd && position.upperMarketCapUsd ? { lower: position.lowerMarketCapUsd, upper: position.upperMarketCapUsd } : null);
        const liveFees = position.live?.assets.filter(asset => asset.unclaimed !== null) ?? [];
        return <article key={position.id} className="liquidity-position-card">
          <header><div><strong>{position.id}</strong><h3>${position.symbol}</h3><a href={`https://robinhoodchain.blockscout.com/token/${position.token}`} target="_blank" rel="noreferrer">{short(position.token)} ↗</a></div><span className={position.live?.range.inRange === false ? "out" : position.status}>{position.status === "closed" ? "Closed" : position.live?.range.inRange === false ? "Out of range" : "Active"}</span></header>
          <dl>
            <div><dt>Position value</dt><dd>{position.live?.assets.map(asset => `${amount(asset.amount)} ${asset.symbol} (${money(asset.usd)})`).join(" + ") || "Live value unavailable"}</dd></div>
            <div><dt>Unclaimed LP fees</dt><dd>{liveFees.length ? liveFees.map(asset => `${amount(asset.unclaimed!)} ${asset.symbol} (${money(asset.unclaimedUsd)})`).join(" + ") : position.status === "closed" ? "—" : "None currently"}</dd></div>
            <div><dt>Fees claimed so far</dt><dd>{position.feesClaimed.length ? position.feesClaimed.map(fee => `${amount(fee.amount)} ${fee.symbol}`).join(" + ") : "None"}</dd></div>
            <div><dt>MCap range</dt><dd>{range ? `${mcap(range.lower)} to ${mcap(range.upper)}` : "—"}</dd></div>
            <div><dt>Pool settings</dt><dd>V{position.version} · {position.pair || "—"} · {position.feePercent === undefined ? "—" : `${position.feePercent}% fee`} · {position.shape?.replace("_", "-") || "—"}{position.bands ? ` · ${position.bands} bands` : ""}</dd></div>
            <div><dt>Pool</dt><dd title={position.poolId}>{short(position.poolId)}</dd></div>
            <div><dt>{position.status === "closed" ? "Closed" : "Opened"}</dt><dd>{new Date(position.status === "closed" ? position.updatedAt : position.createdAt).toLocaleString()}</dd></div>
            <div><dt>NFTs</dt><dd>{position.nftIds.map(id => <a key={id} href={`https://robinhoodchain.blockscout.com/token/0x58daec3116aae6d93017baaea7749052e8a04fa7/instance/${id}`} target="_blank" rel="noreferrer">#{id} ↗</a>)}</dd></div>
          </dl>
          {position.status === "active" ? <footer><button className="button button-quiet" type="button" disabled={busy || Boolean(acting)} onClick={() => void act(position, "claim")}>{acting === `claim:${position.id}` ? "Collecting…" : "Claim LP Fees"}</button><button className="button button-dark" type="button" disabled={busy || Boolean(acting)} onClick={() => void act(position, "withdraw")}>{acting === `withdraw:${position.id}` ? "Withdrawing…" : "Withdraw"}</button></footer> : null}
        </article>;
      })}</div>
    </div>
  </section>;
}
