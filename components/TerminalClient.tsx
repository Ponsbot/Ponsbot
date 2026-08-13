"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CopyAddress } from "@/components/CopyAddress";
import { ExternalTokenImage } from "@/components/ExternalTokenImage";

type Session = { authenticated: boolean; username?: string; walletAddress?: string; csrfToken?: string; expiresAt?: number };
type Holding = { address?: string; name: string; symbol: string; balance: string; iconUrl?: string; usdValue?: number };
type History = {
  messages: Array<{ role: "user" | "assistant"; messageType: string; text: string; requestId?: string; createdAt: number }>;
  actions: Array<{ requestId: string; kind: string; status: string; source: string; transactionHash?: string; safeError?: string; createdAt: number; updatedAt: number }>;
};
type TerminalData = { authenticated: boolean; username: string; walletAddress: string; holdings: Holding[]; history: History };

function eventId() { return `${Date.now().toString(36)}_${crypto.randomUUID().replaceAll("-", "")}`; }
function usd(value: number) { return value > 0 && value < .01 ? "<$0.01" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value); }

export function TerminalClient() {
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<TerminalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/terminal", { cache: "no-store" });
    if (response.ok) setData(await response.json());
  }, []);
  useEffect(() => {
    fetch("/api/auth/x/session", { cache: "no-store" }).then((response) => response.json()).then(async (value: Session) => {
      setSession(value); if (value.authenticated) await refresh(); setLoading(false);
    }).catch(() => setLoading(false));
  }, [refresh]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh, session?.authenticated]);

  const submit = async (payload: { channel: "terminal_chat" | "terminal_form"; text: string; command?: unknown }) => {
    if (!session?.csrfToken || busy) return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/terminal", { method: "POST", headers: { "content-type": "application/json", "x-pons-csrf": session.csrfToken }, body: JSON.stringify({ ...payload, eventId: eventId() }) });
      const result = await response.json();
      if (result.reauthRequired) { window.location.href = "/api/auth/x/start?returnTo=/terminal"; return; }
      setNotice(result.message || result.error || "Request completed.");
      await refresh();
    } finally { setBusy(false); }
  };
  const submitChat = (event: FormEvent) => { event.preventDefault(); const text = chat.trim(); if (!text) return; setChat(""); void submit({ channel: "terminal_chat", text }); };

  if (loading) return <section className="terminal-shell"><div className="terminal-gate"><p>Connecting to your terminal…</p></div></section>;
  if (!session?.authenticated) return <section className="terminal-shell"><div className="terminal-gate"><span>TERMINAL</span><h1>Connect your X account</h1><p>You must connect your X account to use the terminal.</p><a className="button button-dark" href="/api/auth/x/start?returnTo=/terminal">Connect X</a></div></section>;

  return <section className="terminal-shell">
    <header className="terminal-heading"><div><p className="eyebrow">Pons Bot Terminal</p><h1>Welcome, @{session.username}</h1><p>Buy, sell, send, and burn directly from your connected wallet. Launches remain available through X posts only.</p></div><Link className="button button-quiet" href={`/wallet/${session.walletAddress}`}>View Wallet</Link></header>
    <div className="terminal-layout">
      <div className="terminal-tools"><DirectActionForms busy={busy} holdings={data?.holdings || []} submit={submit} /></div>
      <div className="terminal-console">
        <div className="terminal-log" aria-live="polite">
          {(data?.history.messages || []).map((message, index) => <div className={`terminal-line ${message.role}`} key={`${message.createdAt}-${index}`}><small>{message.role === "user" ? `@${session.username}` : "Pons Bot"}</small><p>{message.text}</p></div>)}
          {!data?.history.messages.length ? <div className="terminal-line assistant"><small>Pons Bot</small><p>Your terminal is ready. Enter a request below or use a direct action form.</p></div> : null}
        </div>
        <form className="terminal-chat" onSubmit={submitChat}><input value={chat} maxLength={500} onChange={(event) => setChat(event.target.value)} placeholder="Ask for a balance or enter a buy, sell, send, or burn request…" /><button disabled={busy || !chat.trim()} type="submit">Send</button></form>
        {notice ? <p className="terminal-notice">{notice}</p> : null}
      </div>
    </div>
    <section className="terminal-holdings"><div className="terminal-section-head"><div><p className="eyebrow">Connected wallet</p><h2>Current Holdings</h2></div><CopyAddress address={session.walletAddress!} /></div><div className="terminal-holdings-grid">{(data?.holdings || []).map((holding) => <article key={`${holding.address || "eth"}-${holding.symbol}`}><span className="holding-icon">{holding.iconUrl ? <ExternalTokenImage src={holding.iconUrl} name={holding.name} /> : holding.symbol[0]}</span><div><strong>{holding.name}</strong><small>{holding.symbol}</small></div><p>{holding.balance} {holding.symbol}{holding.usdValue !== undefined ? <small> ({usd(holding.usdValue)})</small> : null}</p></article>)}</div>{data && !data.holdings.length ? <p className="terminal-empty">No holdings found yet.</p> : null}</section>
    <section className="terminal-actions"><div className="terminal-section-head"><div><p className="eyebrow">All sources</p><h2>Recent Actions</h2></div></div><div className="activity-table-wrap"><table className="activity-table"><thead><tr><th>Action</th><th>Source</th><th>Status</th><th>Time</th><th>Txn</th></tr></thead><tbody>{(data?.history.actions || []).map((action) => <tr key={action.requestId}><td>{action.kind.replaceAll("_", " ")}</td><td>{action.source === "terminal" ? "Terminal" : "X"}</td><td>{action.status}</td><td>{new Date(action.createdAt).toLocaleString()}</td><td>{action.transactionHash ? <a href={`https://robinhoodchain.blockscout.com/tx/${action.transactionHash}`} target="_blank" rel="noreferrer">View ↗</a> : "—"}</td></tr>)}{data && !data.history.actions.length ? <tr><td colSpan={5}>No actions yet.</td></tr> : null}</tbody></table></div></section>
  </section>;
}

function DirectActionForms({ busy, holdings, submit }: { busy: boolean; holdings: Holding[]; submit: (payload: { channel: "terminal_form"; text: string; command: unknown }) => Promise<void> }) {
  const [tab, setTab] = useState<"buy" | "sell" | "send" | "burn">("buy");
  const execute = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const amount = String(form.get("amount") || "").trim(); const token = String(form.get("token") || "").trim(); const unit = String(form.get("unit") || "");
    const command: Record<string, unknown> = { kind: tab, amount, unit, token };
    const pairAsset = String(form.get("pairAsset") || "").trim();
    if (tab === "buy" && pairAsset) command.pairAsset = pairAsset;
    if (tab === "buy" || tab === "sell") command.slippageBps = Number(form.get("slippage") || 250);
    if (tab === "send") command.recipient = String(form.get("recipient") || "").trim();
    if (!window.confirm(`Confirm ${tab.toUpperCase()} request\n\nAmount: ${amount} ${unit}\nAsset: ${token || "ETH"}${tab === "send" ? `\nDestination: ${command.recipient}` : ""}`)) return;
    void submit({ channel: "terminal_form", text: `${tab} ${amount} ${unit} ${token}`.trim(), command });
  };
  return <div className="direct-panel"><div className="terminal-tabs">{(["buy", "sell", "send", "burn"] as const).map((item) => <button className={tab === item ? "active" : ""} type="button" key={item} onClick={() => setTab(item)}>{item}</button>)}</div><form onSubmit={execute}><label>Amount<input required name="amount" inputMode="decimal" placeholder="25" /></label><label>Unit<select name="unit" defaultValue={tab === "buy" ? "usd" : tab === "sell" ? "token" : "token"} key={tab}>{tab === "buy" ? <><option value="usd">USD</option><option value="eth">ETH</option><option value="pair">Paired asset</option></> : tab === "sell" ? <><option value="token">Token</option><option value="percent">Percent</option></> : tab === "burn" ? <><option value="token">Token</option><option value="usd">USD</option><option value="percent">Percent</option></> : <><option value="token">Token</option><option value="eth">ETH</option><option value="usd">USD</option><option value="percent">Percent</option></>}</select></label><label>Token or contract<input list="terminal-token-options" name="token" required={tab !== "send"} placeholder={tab === "send" ? "ETH or PONSBOT" : "PONSBOT"} /></label><datalist id="terminal-token-options"><option value="ETH" />{holdings.filter((holding) => holding.symbol !== "ETH").map((holding) => <option key={`${holding.address}-${holding.symbol}`} value={holding.symbol}>{holding.name}</option>)}</datalist>{tab === "buy" ? <label>Spend asset (pair unit)<input name="pairAsset" placeholder="MSFT" /></label> : null}{tab === "send" ? <label>Destination<input required name="recipient" placeholder="@user or 0x…" /></label> : null}{tab === "buy" || tab === "sell" ? <label>Slippage (bps)<input name="slippage" type="number" min="10" max="2000" defaultValue="250" /></label> : null}<button className="button button-dark" disabled={busy} type="submit">Review {tab}</button></form></div>;
}
