"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CopyAddress } from "@/components/CopyAddress";
import { ExternalTokenImage } from "@/components/ExternalTokenImage";
import { splitTerminalMessage } from "@/lib/terminal-message";

type Session = { authenticated: boolean; username?: string; walletAddress?: string; csrfToken?: string; expiresAt?: number };
type Holding = { address?: string; name: string; symbol: string; balance: string; iconUrl?: string; usdValue?: number };
type History = {
  messages: Array<{ role: "user" | "assistant"; messageType: string; text: string; requestId?: string; createdAt: number }>;
  actions: Array<{ requestId: string; kind: string; amount?: string; token?: string; status: string; source: string; transactionHash?: string; safeError?: string; createdAt: number; updatedAt: number }>;
  launches: Array<{ tokenAddress: string; symbol: string; name: string; pairToken?: string }>;
  tokenCatalog: Array<{ tokenAddress: string; symbol: string; name: string; pairToken?: string }>;
  catalogIncluded: boolean;
};
type TerminalData = { authenticated: boolean; username: string; walletAddress: string; holdings: Holding[]; history: History };

function eventId() { return `${Date.now().toString(36)}_${crypto.randomUUID().replaceAll("-", "")}`; }
function usd(value: number) { return value > 0 && value < .01 ? "<$0.01" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value); }
function shortContract(address?: string) { return address ? `${address.slice(0, 4)}…${address.slice(-3)}` : ""; }

export function TerminalClient() {
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<TerminalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const refreshing = useRef(false);

  const refresh = useCallback(async (includeHoldings = false, includeCatalog = false) => {
    if (refreshing.current || document.visibilityState === "hidden") return;
    refreshing.current = true;
    try {
      const endpoint = includeCatalog ? "/api/terminal" : includeHoldings ? "/api/terminal?scope=holdings" : "/api/terminal?scope=history";
      const response = await fetch(endpoint, { cache: "no-store" });
      if (response.ok) {
        const next = await response.json() as TerminalData;
        setData((current) => ({
          ...next,
          holdings: next.holdings ?? current?.holdings ?? [],
          history: {
            ...next.history,
            launches: next.history.catalogIncluded ? next.history.launches : current?.history.launches ?? [],
            tokenCatalog: next.history.catalogIncluded ? next.history.tokenCatalog : current?.history.tokenCatalog ?? [],
          },
        }));
      }
    } finally { refreshing.current = false; }
  }, []);
  useEffect(() => {
    fetch("/api/auth/x/session", { cache: "no-store" }).then((response) => response.json()).then(async (value: Session) => {
      setSession(value); if (value.authenticated) await refresh(true, true); setLoading(false);
    }).catch(() => setLoading(false));
  }, [refresh]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const historyTimer = window.setInterval(() => void refresh(false), 5_000);
    const holdingsTimer = window.setInterval(() => void refresh(true), 60_000);
    return () => { window.clearInterval(historyTimer); window.clearInterval(holdingsTimer); };
  }, [refresh, session?.authenticated]);
  useEffect(() => { const log = logRef.current; if (log) log.scrollTo({ top: log.scrollHeight, behavior: "smooth" }); }, [data?.history.messages.length]);

  const submit = async (payload: { channel: "terminal_chat" | "terminal_form"; text: string; command?: unknown }) => {
    if (!session?.csrfToken || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/terminal", { method: "POST", headers: { "content-type": "application/json", "x-pons-csrf": session.csrfToken }, body: JSON.stringify({ ...payload, eventId: eventId() }) });
      const result = await response.json().catch(() => ({ error: "The terminal request could not be completed." }));
      if (result.reauthRequired) { window.location.href = "/api/auth/x/start?returnTo=/terminal"; return; }
      await refresh(true);
      if (!response.ok) appendLocalAssistant(result.message || result.error || "The terminal request could not be completed.");
    } finally { setBusy(false); }
  };
  const submitChat = (event: FormEvent) => { event.preventDefault(); const text = chat.trim(); if (!text) return; setChat(""); void submit({ channel: "terminal_chat", text }); };

  if (loading) return <section className="terminal-shell"><div className="terminal-gate"><p>Connecting to your terminal…</p></div></section>;
  if (!session?.authenticated) return <section className="terminal-shell terminal-signed-out"><div className="terminal-connect-modal" role="dialog" aria-modal="true"><h2>Connect to X to use the terminal.</h2><a className="button button-dark" href="/api/auth/x/start?returnTo=/terminal">Connect X</a></div></section>;

  return <section className="terminal-shell">
    <header className="terminal-heading"><div><p className="eyebrow">Pons Bot Terminal</p><h1>Welcome, @{session.username}</h1><p>Buy, sell, swap, send, burn, and claim fees directly from your connected wallet.</p></div><Link className="button button-quiet" href={`/wallet/${session.walletAddress}`}>View Wallet</Link></header>
    <div className="terminal-layout">
      <div className="terminal-tools"><DirectActionForms busy={busy} holdings={data?.holdings || []} launches={data?.history.launches || []} tokenCatalog={data?.history.tokenCatalog || []} submit={submit} /></div>
      <div className="terminal-console">
        <div className="terminal-log" ref={logRef} aria-live="polite">
          {(data?.history.messages || []).map((message, index) => <div className={`terminal-line ${message.role}`} key={`${message.createdAt}-${index}`}><small>{message.role === "user" ? `@${session.username}` : "Pons Bot"}</small><p><TerminalMessageText text={message.text} /></p></div>)}
          {!data?.history.messages.length ? <div className="terminal-line assistant"><small>Pons Bot</small><p>Pons Bot terminal active. What would you like to do?</p></div> : null}
        </div>
        <form className="terminal-chat" onSubmit={submitChat}><input value={chat} maxLength={500} onChange={(event) => setChat(event.target.value)} placeholder="Ask me to buy, sell, swap, send, burn, claim fees, or check a balance!" /><button disabled={busy || !chat.trim()} type="submit">Send</button></form>
      </div>
    </div>
    <section className="terminal-holdings"><div className="terminal-section-head"><div><p className="eyebrow">Connected wallet</p><h2>Current Holdings</h2></div><CopyAddress address={session.walletAddress!} /></div><div className="terminal-holdings-grid">{(data?.holdings || []).map((holding) => <article key={`${holding.address || "eth"}-${holding.symbol}`}><span className="holding-icon">{holding.iconUrl ? <ExternalTokenImage src={holding.iconUrl} name={holding.name} /> : holding.symbol[0]}</span><div><strong>{holding.name}</strong><small>{holding.symbol}</small></div><p>{holding.balance} {holding.symbol}{holding.usdValue !== undefined ? <small> ({usd(holding.usdValue)})</small> : null}</p></article>)}</div>{data && !data.holdings.length ? <p className="terminal-empty">No holdings found yet.</p> : null}</section>
    <section className="terminal-actions"><div className="terminal-section-head"><div><h2>Recent Actions</h2></div></div><div className="activity-table-wrap"><table className="activity-table"><thead><tr><th>Action</th><th>Amount</th><th>Token</th><th>Source</th><th>Status</th><th>Time</th><th>Txn</th></tr></thead><tbody>{(data?.history.actions || []).map((action) => <tr key={action.requestId}><td>{action.kind.replaceAll("_", " ")}</td><td>{action.amount || "—"}</td><td>{action.token || "—"}</td><td>{action.source === "terminal" ? "Terminal" : "X"}</td><td>{action.status}</td><td>{new Date(action.createdAt).toLocaleString()}</td><td>{action.transactionHash ? <a href={`https://robinhoodchain.blockscout.com/tx/${action.transactionHash}`} target="_blank" rel="noreferrer">View ↗</a> : "—"}</td></tr>)}{data && !data.history.actions.length ? <tr><td colSpan={7}>No actions yet.</td></tr> : null}</tbody></table></div></section>
  </section>;

  function appendLocalAssistant(text: string) {
    setData((current) => current ? {
      ...current,
      history: {
        ...current.history,
        messages: [...current.history.messages, { role: "assistant", messageType: "result", text, createdAt: Date.now() }],
      },
    } : current);
  }
}

export function TerminalMessageText({ text }: { text: string }) {
  const parts = splitTerminalMessage(text);
  return <>{parts.map((part, index) => typeof part === "string" ? part : <span key={`${part.url}-${index}`}><a href={part.url} target="_blank" rel="noopener noreferrer">{part.url}</a>{part.suffix}</span>)}</>;
}

function DirectActionForms({ busy, holdings, launches, tokenCatalog, submit }: { busy: boolean; holdings: Holding[]; launches: History["launches"]; tokenCatalog: History["tokenCatalog"]; submit: (payload: { channel: "terminal_form"; text: string; command: unknown }) => Promise<void> }) {
  const [tab, setTab] = useState<"buy" | "sell" | "send" | "burn" | "claim_fees">("buy");
  const [token, setToken] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    if (action === "buy" || action === "sell") setTab(action);
    if (params.get("token")) setToken(params.get("token")!);
  }, []);
  const key = token.toLowerCase();
  const launch = tokenCatalog.find((item) => item.tokenAddress.toLowerCase() === key || item.symbol.toLowerCase() === key);
  const holding = holdings.find((item) => item.address?.toLowerCase() === key || item.symbol.toLowerCase() === key);
  const pairAsset = launch?.pairToken ? tokenCatalog.find((item) => item.tokenAddress.toLowerCase() === launch.pairToken?.toLowerCase()) : undefined;
  const pairHolding = launch?.pairToken ? holdings.find((item) => item.address?.toLowerCase() === launch.pairToken?.toLowerCase()) : undefined;
  const pairLabel = !launch?.pairToken || /^0x0{40}$/i.test(launch.pairToken) ? "ETH" : pairAsset?.symbol || pairHolding?.symbol || "Unknown asset";
  const options = new Map<string, { address?: string; symbol: string; name: string }>();
  for (const item of tokenCatalog) options.set(item.tokenAddress.toLowerCase(), { address: item.tokenAddress, symbol: item.symbol, name: item.name });
  for (const item of holdings) options.set((item.address || item.symbol).toLowerCase(), { address: item.address, symbol: item.symbol, name: item.name });

  const execute = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (tab === "claim_fees") {
      const selected = String(form.get("claimToken") || "").trim();
      const label = launches.find((item) => item.tokenAddress === selected)?.symbol || selected || "all eligible launches";
      if (!window.confirm(`Confirm CLAIM FEES request\n\nToken: ${label}${selected ? `\nContract address: ${selected}` : ""}`)) return;
      void submit({ channel: "terminal_form", text: selected ? `claim fees for ${label}` : "claim all my fees", command: { kind: "claim_fees", ...(selected ? { token: selected } : {}) } });
      return;
    }
    const amount = String(form.get("amount") || "").trim();
    const unit = String(form.get("unit") || "");
    const command: Record<string, unknown> = { kind: tab, amount, unit, token };
    if (tab === "buy" && unit === "pair" && launch?.pairToken) command.pairAsset = launch.pairToken;
    if (tab === "buy" || tab === "sell") command.slippageBps = Math.round(Number(form.get("slippage") || 2.5) * 100);
    if (tab === "send") {
      const recipient = String(form.get("recipient") || "").trim();
      command.recipient = /^0x[a-fA-F0-9]{40}$/.test(recipient) || recipient.startsWith("@") ? recipient : `@${recipient}`;
    }
    const contract = launch?.tokenAddress || holding?.address;
    if (!window.confirm(`Confirm ${tab.toUpperCase()} request\n\nAmount: ${amount} ${unit}\nToken: ${launch?.symbol || holding?.symbol || token || "ETH"}${contract ? `\nContract address: ${contract}` : ""}${tab === "send" ? `\nDestination: ${command.recipient}` : ""}`)) return;
    void submit({ channel: "terminal_form", text: `${tab} ${amount} ${unit} ${token}`.trim(), command });
  };

  const tabs = ["buy", "sell", "send", "burn", "claim_fees"] as const;
  return <div className="direct-panel">
    <div className="terminal-tabs">{tabs.map((item) => <button className={tab === item ? "active" : ""} type="button" key={item} onClick={() => setTab(item)}>{item === "claim_fees" ? "Claim fees" : item}</button>)}</div>
    <form onSubmit={execute}>{tab === "claim_fees" ? <>
      <label className="terminal-wide">Token from your launches<select name="claimToken" defaultValue=""><option value="">All eligible launches</option>{launches.map((item) => <option key={item.tokenAddress} value={item.tokenAddress}>{item.symbol} — {item.name}</option>)}</select></label>
      <p className="terminal-claim-note">Tokens paired with assets other than ETH must be claimed individually.</p>
      <button className="button button-dark" disabled={busy} type="submit">Review fee claim</button>
    </> : <>
      <label>Amount<input required name="amount" inputMode="decimal" placeholder="25" /></label>
      <label>Unit<select name="unit" defaultValue={tab === "buy" || tab === "sell" || tab === "burn" ? "usd" : "token"} key={tab}>{tab === "buy" ? <><option value="usd">USD</option><option value="eth">ETH</option>{launch && pairLabel !== "ETH" ? <option value="pair">{pairLabel}</option> : null}</> : tab === "sell" ? <><option value="usd">USD</option><option value="token">Token</option><option value="percent">Percent</option></> : tab === "burn" ? <><option value="usd">USD</option><option value="token">Token</option><option value="percent">Percent</option></> : <><option value="token">Token</option><option value="eth">ETH</option><option value="usd">USD</option><option value="percent">Percent</option></>}</select></label>
      <label>Token or contract<input list="terminal-token-options" name="token" value={token} onChange={(event) => setToken(event.target.value)} required={tab !== "send"} placeholder={tab === "send" ? "ETH or contract" : "Search ticker or enter contract"} /></label>
      <datalist id="terminal-token-options"><option value="ETH" label="ETH — Ethereum" />{[...options.values()].filter((item) => item.symbol !== "ETH").map((item) => <option key={`${item.address}-${item.symbol}`} value={item.address || item.symbol} label={`${item.symbol} ${shortContract(item.address)} — ${item.name}`} />)}</datalist>
      {tab === "buy" || tab === "sell" ? <div className="terminal-pair-display"><span>Paired asset</span><strong>{launch ? pairLabel : "—"}</strong></div> : null}
      {tab === "send" ? <label>Destination<input required name="recipient" autoCapitalize="none" spellCheck={false} placeholder="Address or X" /></label> : null}
      {tab === "buy" || tab === "sell" ? <label>Slippage (%)<input name="slippage" type="number" min="0.1" max="20" step="0.1" defaultValue="2.5" /></label> : null}
      <button className="button button-dark" disabled={busy} type="submit">Review {tab}</button>
    </>}</form>
  </div>;
}
