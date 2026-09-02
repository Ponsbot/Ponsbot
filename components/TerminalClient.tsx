"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CopyAddress } from "@/components/CopyAddress";
import { ExternalTokenImage } from "@/components/ExternalTokenImage";
import { HoudiniSwapPanel } from "@/components/HoudiniSwapPanel";
import { LiquidityPositionsPanel } from "@/components/LiquidityPositionsPanel";
import { CreatorFeeReceiptRow } from "@/components/CreatorFeeReceiptRow";
import { TerminalActionToken } from "@/components/TerminalActionToken";
import { mergeTerminalFeeReceipts, type TerminalFeeReceipt } from "@/lib/terminal-fee-receipt";
import { mergeTerminalMessages, splitTerminalMessage, type TerminalMessageRecord } from "@/lib/terminal-message";

type Session = { authenticated: boolean; username?: string; walletAddress?: string; csrfToken?: string; expiresAt?: number; reauthAt?: number; houdiniPreviewEnabled?: boolean };
type Holding = { address?: string; name: string; symbol: string; balance: string; iconUrl?: string; isPonsbotLaunch?: boolean; usdValue?: number };
type History = {
  feeReceipts?: TerminalFeeReceipt[];
  feesUpdatedThrough?: number;
  feesDelta?: boolean;
  messages: TerminalMessageRecord[];
  actions: Array<{ requestId: string; kind: string; amount?: string; unit?: string; pairAsset?: string; token?: string; lpIdentifiers?: string[]; status: string; source: string; transactionHash?: string; orderId?: string; safeError?: string; createdAt: number; updatedAt: number }>;
  houdiniSwaps: Array<{ reviewId: string; kind: "multi_chain_swap" | "private_swap"; amount: string; unit: "eth"; token: string; sourceToken: string; status: string; displayStatus?: string; statusLabel?: string; orderId?: string; transactionHash?: string; safeError?: string; createdAt: number; updatedAt: number }>;
  launches: Array<{ tokenAddress: string; symbol: string; name: string; pairToken?: string }>;
  tokenCatalog: Array<{ tokenAddress: string; symbol: string; name: string; pairToken?: string }>;
  catalogIncluded: boolean;
  delta?: boolean;
  updatedThrough?: number;
};
type TerminalData = { authenticated: boolean; username: string; walletAddress: string; holdings: Holding[]; history: History; houdiniPreviewEnabled?: boolean };

function eventId() { return `${Date.now().toString(36)}_${crypto.randomUUID().replaceAll("-", "")}`; }
function usd(value: number) { return value > 0 && value < .01 ? "<$0.01" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value); }
function shortContract(address?: string) { return address ? `${address.slice(0, 4)}…${address.slice(-3)}` : ""; }
function houdiniOrderUrl(orderId: string) { return `https://app.houdiniswap.com/order-details?houdiniId=${encodeURIComponent(orderId)}`; }

export function TerminalClient() {
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<TerminalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [awaitingLiquidityResult, setAwaitingLiquidityResult] = useState(false);
  const [chat, setChat] = useState("");
  const [workspace, setWorkspace] = useState<"terminal" | "houdini" | "liquidity">("terminal");
  const logRef = useRef<HTMLDivElement>(null);
  const refreshing = useRef(false);
  const pendingCatalogRefresh = useRef(false);
  const holdingsRefreshing = useRef(false);
  const lastHoldingsRefreshAt = useRef(0);
  const signingOut = useRef(false);
  const submitInFlight = useRef(false);
  const historyCursor = useRef(0);
  const feeHistoryCursor = useRef(0);
  const liquidityPendingSince = useRef(0);

  const expireSession = useCallback(async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    try { await fetch("/api/auth/x/session", { method: "DELETE", cache: "no-store" }); }
    finally {
      setSession({ authenticated: false });
      setData(null);
      feeHistoryCursor.current = 0;
      setLoading(false);
      signingOut.current = false;
    }
  }, []);

  // Chat/action history must never wait behind a slow holdings lookup. LP
  // completions are written asynchronously and need their own short poll.
  const refresh = useCallback(async (includeCatalog = false) => {
    if (document.visibilityState === "hidden") return;
    if (refreshing.current) {
      pendingCatalogRefresh.current ||= includeCatalog;
      return;
    }
    refreshing.current = true;
    try {
      const params = new URLSearchParams();
      params.set("scope", includeCatalog ? "catalog" : "history");
      if (!includeCatalog && historyCursor.current > 0) params.set("updatedAfter", String(historyCursor.current));
      if (!includeCatalog && feeHistoryCursor.current > 0) params.set("feesUpdatedAfter", String(feeHistoryCursor.current));
      const endpoint = `/api/terminal${params.size ? `?${params}` : ""}`;
      const response = await fetch(endpoint, { cache: "no-store" });
      if (response.ok) {
        const next = await response.json() as TerminalData;
        if (liquidityPendingSince.current && next.history.messages.some(message =>
          message.role === "assistant" && message.createdAt >= liquidityPendingSince.current
          && message.requestId?.startsWith("liquidity-result:"))) {
          liquidityPendingSince.current = 0;
          setAwaitingLiquidityResult(false);
        }
        if (typeof next.history.updatedThrough === "number") historyCursor.current = Math.max(historyCursor.current, next.history.updatedThrough);
        if (typeof next.history.feesUpdatedThrough === "number") feeHistoryCursor.current = Math.max(feeHistoryCursor.current, next.history.feesUpdatedThrough);
        setData((current) => {
          const feeReceipts = next.history.feesDelta
            ? mergeTerminalFeeReceipts(current?.history.feeReceipts || [], next.history.feeReceipts || [])
            : next.history.feeReceipts ?? current?.history.feeReceipts ?? [];
          if (!current || !next.history.delta) return {
            ...next,
            holdings: next.holdings ?? current?.holdings ?? [],
            history: {
              ...next.history,
              feeReceipts,
              launches: next.history.catalogIncluded ? next.history.launches : current?.history.launches ?? [],
              tokenCatalog: next.history.catalogIncluded ? next.history.tokenCatalog : current?.history.tokenCatalog ?? [],
            },
          };
          const messages = mergeTerminalMessages(current.history.messages, next.history.messages);
          const actions = [...new Map([...current.history.actions, ...next.history.actions]
            .map((item) => [item.requestId, item])).values()]
            .sort((left, right) => right.createdAt - left.createdAt).slice(0, 40);
          const houdiniSwaps = [...new Map([...current.history.houdiniSwaps, ...next.history.houdiniSwaps]
            .map((item) => [item.reviewId, item])).values()]
            .sort((left, right) => right.createdAt - left.createdAt).slice(0, 40);
          return {
            ...next,
            holdings: next.holdings ?? current.holdings,
            history: {
              ...next.history,
              messages,
              feeReceipts,
              actions,
              houdiniSwaps,
              launches: current.history.launches,
              tokenCatalog: current.history.tokenCatalog,
            },
          };
        });
      } else if (response.status === 401) await expireSession();
    } finally {
      refreshing.current = false;
      const pendingCatalog = pendingCatalogRefresh.current;
      pendingCatalogRefresh.current = false;
      if (pendingCatalog) window.setTimeout(() => void refresh(true), 0);
    }
  }, [expireSession]);

  const refreshHoldings = useCallback(async () => {
    if (document.visibilityState === "hidden" || holdingsRefreshing.current) return;
    holdingsRefreshing.current = true;
    try {
      const response = await fetch("/api/terminal?scope=holdings", { cache: "no-store" });
      if (response.ok) {
        const next = await response.json() as TerminalData;
        if (Array.isArray(next.holdings)) {
          lastHoldingsRefreshAt.current = Date.now();
          setData(current => current ? { ...current, holdings: next.holdings } : current);
        }
      } else if (response.status === 401) await expireSession();
    } finally { holdingsRefreshing.current = false; }
  }, [expireSession]);
  useEffect(() => {
    fetch("/api/auth/x/session", { cache: "no-store" }).then((response) => response.json()).then(async (value: Session) => {
      setSession(value);
      if (value.authenticated) { await refresh(true); void refreshHoldings(); }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [refresh, refreshHoldings]);
  const hasActiveTerminalWork = Boolean(
    awaitingLiquidityResult ||
    data?.history.actions.some((action) => !["confirmed", "completed", "failed", "rejected", "skipped"].includes(action.status)) ||
    data?.history.houdiniSwaps.some((swap) => !["completed", "failed"].includes(swap.status)),
  );
  useEffect(() => {
    if (!session?.authenticated) return;
    const timer = window.setInterval(() => {
      void refresh();
      if (Date.now() - lastHoldingsRefreshAt.current >= 60_000) void refreshHoldings();
    }, hasActiveTerminalWork ? 5_000 : 15_000);
    return () => window.clearInterval(timer);
  }, [hasActiveTerminalWork, refresh, refreshHoldings, session?.authenticated]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
      if (Date.now() - lastHoldingsRefreshAt.current >= 60_000) void refreshHoldings();
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [refresh, refreshHoldings, session?.authenticated]);
  useEffect(() => {
    if (!session?.authenticated || !session.expiresAt) return;
    // Fund-moving terminal actions require a fresh X authorization. End the
    // browser session at that earlier boundary instead of surprising the user
    // with a rejected transaction while the UI still appears connected.
    const terminalExpiry = Math.min(session.expiresAt, session.reauthAt || session.expiresAt);
    const remaining = terminalExpiry * 1_000 - Date.now();
    if (remaining <= 0) { void expireSession(); return; }
    const timer = window.setTimeout(() => void expireSession(), remaining);
    return () => window.clearTimeout(timer);
  }, [expireSession, session?.authenticated, session?.expiresAt, session?.reauthAt]);
  useEffect(() => { const log = logRef.current; if (log) log.scrollTo({ top: log.scrollHeight, behavior: "smooth" }); }, [data?.history.messages.length]);
  const activeHoudiniReviewIds = (data?.history.houdiniSwaps || [])
    .filter((swap) => swap.orderId && !["completed", "failed"].includes(swap.status))
    .slice(0, 3).map((swap) => swap.reviewId).join(",");
  useEffect(() => {
    if (workspace !== "terminal" || !session?.authenticated || !session.csrfToken || !activeHoudiniReviewIds) return;
    let stopped = false;
    const update = async () => {
      await Promise.all(activeHoudiniReviewIds.split(",").map((reviewId) => fetch(`/api/houdini/status?reviewId=${encodeURIComponent(reviewId)}`, {
        cache: "no-store", headers: { "x-pons-csrf": session.csrfToken! },
      }).catch(() => undefined)));
      if (!stopped) await refresh();
    };
    const timer = window.setInterval(() => void update(), 30_000);
    void update();
    return () => { stopped = true; window.clearInterval(timer); };
  }, [activeHoudiniReviewIds, refresh, session?.authenticated, session?.csrfToken, workspace]);

  const submit = async (payload: { channel: "terminal_chat" | "terminal_form"; text: string; command?: unknown }) => {
    // React state updates are not synchronous, so a fast double click or Enter
    // press can reach this function twice before `busy` is rendered. Keep an
    // immediate ref guard as well so one user gesture creates one event ID and
    // one wallet request.
    if (!session?.csrfToken || submitInFlight.current) return;
    submitInFlight.current = true;
    const requestEventId = eventId();
    if (payload.channel === "terminal_chat") appendLocalUser(payload.text, requestEventId);
    setBusy(true);
    try {
      const response = await fetch("/api/terminal", { method: "POST", headers: { "content-type": "application/json", "x-pons-csrf": session.csrfToken }, body: JSON.stringify({ ...payload, eventId: requestEventId }) });
      const result = await response.json().catch(() => ({ error: "The terminal request could not be completed." }));
      if (result.reauthRequired || response.status === 401) { await expireSession(); return; }
      if (result.pending && typeof result.message === "string" && /liquidity request/i.test(result.message)) {
        // Allow for small browser/server clock differences. The active-action
        // record also keeps fast polling enabled if an earlier result matches.
        liquidityPendingSince.current = Date.now() - 5 * 60_000;
        setAwaitingLiquidityResult(true);
      }
      await refresh();
      void refreshHoldings();
      if (!response.ok) appendLocalAssistant(result.message || result.error || "The terminal request could not be completed.");
    } finally { submitInFlight.current = false; setBusy(false); }
  };
  const submitChat = (event: FormEvent) => { event.preventDefault(); const text = chat.trim(); if (!text) return; setChat(""); void submit({ channel: "terminal_chat", text }); };

  if (loading) return <section className="terminal-shell"><div className="terminal-gate"><p>Connecting to your terminal…</p></div></section>;
  if (!session?.authenticated) return <section className="terminal-shell terminal-signed-out"><div className="terminal-connect-modal" role="dialog" aria-modal="true"><h2>Connect to X to use the terminal.</h2><a className="button button-dark" href="/api/auth/x/start?returnTo=/terminal">Connect X</a></div></section>;

  return <section className="terminal-shell">
    <header className="terminal-heading"><div><p className="eyebrow">Pons Bot Terminal</p><h1>Welcome, @{session.username}</h1><p>{workspace === "houdini" ? "Cross-chain and private swaps from your Pons Bot wallet." : workspace === "liquidity" ? "Build and manage Delta Liquidity positions from your Pons Bot wallet." : "Buy, sell, swap, send, burn, claim creator fees, and manage Delta Liquidity positions directly from your connected wallet."}</p></div><div className="terminal-heading-actions"><div className="terminal-workspace-toggle" aria-label="Terminal workspace"><button type="button" className={workspace === "terminal" ? "active" : ""} onClick={() => setWorkspace("terminal")}>Terminal</button>{session.houdiniPreviewEnabled ? <button type="button" className={workspace === "houdini" ? "active" : ""} onClick={() => setWorkspace("houdini")}>Multi-Chain and Private Swaps</button> : null}<button type="button" className={workspace === "liquidity" ? "active" : ""} onClick={() => setWorkspace("liquidity")}>Liquidity Positions</button></div></div></header>
    {workspace === "terminal" ? <div className="terminal-layout">
      <div className="terminal-tools"><DirectActionForms busy={busy} holdings={data?.holdings || []} launches={data?.history.launches || []} tokenCatalog={data?.history.tokenCatalog || []} submit={submit} /></div>
      <div className="terminal-console">
        <div className="terminal-log" ref={logRef} aria-live="polite">
          {(data?.history.messages || []).map((message, index) => <div className={`terminal-line ${message.role}`} key={`${message.createdAt}-${index}`}><small>{message.role === "user" ? `@${session.username}` : "Pons Bot"}</small><p><TerminalMessageText text={message.text} /></p></div>)}
          {!data?.history.messages.length ? <div className="terminal-line assistant"><small>Pons Bot</small><p>Pons Bot terminal active. What would you like to do?</p></div> : null}
        </div>
        <form className="terminal-chat" onSubmit={submitChat}><input value={chat} maxLength={500} onChange={(event) => setChat(event.target.value)} placeholder="Ask me to buy, sell, swap, send, burn, claim fees, manage liquidity, or check a balance!" /><button disabled={busy || !chat.trim()} type="submit">Send</button></form>
      </div>
    </div> : workspace === "houdini" ? <HoudiniSwapPanel enabled={Boolean(session.houdiniPreviewEnabled)} csrfToken={session.csrfToken || ""} />
      : <LiquidityPositionsPanel busy={busy} submit={submit} messages={data?.history.messages || []} username={session.username || "you"} />}
    <section className="terminal-holdings"><div className="terminal-section-head"><div><p className="eyebrow">Connected wallet</p><h2>Current Holdings</h2></div><CopyAddress address={session.walletAddress!} /></div><div className="terminal-holdings-grid">{(data?.holdings || []).map((holding) => {
      const tokenHref = holding.address && holding.isPonsbotLaunch ? `/launch/${holding.address}` : undefined;
      const icon = <span className="holding-icon">{holding.iconUrl ? <ExternalTokenImage src={holding.iconUrl} name={holding.name} /> : holding.symbol[0]}</span>;
      return <article key={`${holding.address || "eth"}-${holding.symbol}`}>
        {tokenHref ? <Link className="terminal-holding-token-link terminal-holding-icon-link" href={tokenHref} aria-label={`View $${holding.symbol} token page`}>{icon}</Link> : icon}
        <div>
          <strong>{tokenHref ? <Link className="terminal-holding-token-link" href={tokenHref}>{holding.name}</Link> : holding.name}</strong>
          <small>{holding.symbol}</small>
          {holding.address ? <CopyAddress address={holding.address} displayAddress={shortContract(holding.address)} compact /> : null}
        </div>
        <p>{holding.balance} {holding.symbol}{holding.usdValue !== undefined ? <small> ({usd(holding.usdValue)})</small> : null}</p>
      </article>;
    })}</div>{data && !data.holdings.length ? <p className="terminal-empty">No holdings found yet.</p> : null}</section>
    <section className="terminal-actions"><div className="terminal-section-head"><div><h2>Recent Actions</h2></div></div><div className="activity-table-wrap"><table className="activity-table"><thead><tr><th>Action</th><th>Amount</th><th>Token</th><th>Source</th><th>Status</th><th>Time</th><th>Record</th></tr></thead><tbody>{[
      ...(data?.history.actions || []).map((action) => ({ type: "wallet" as const, createdAt: action.createdAt, action })),
      ...(data?.history.houdiniSwaps || []).map((swap) => ({ type: "houdini" as const, createdAt: swap.createdAt, swap })),
      ...(data?.history.feeReceipts || []).map((receipt) => ({ type: "fees" as const, createdAt: receipt.createdAt, receipt })),
    ].sort((left, right) => right.createdAt - left.createdAt).slice(0, 60).map((entry) => entry.type === "fees"
      ? <CreatorFeeReceiptRow key={entry.receipt.id} receipt={entry.receipt} />
      : entry.type === "wallet"
      ? <tr key={`wallet-${entry.action.requestId}`}><td><span>{entry.action.kind.replaceAll("_", " ")}</span>{entry.action.lpIdentifiers?.length ? <small className="terminal-action-lp">{entry.action.lpIdentifiers.join(", ")}</small> : null}</td><td>{formatActionAmount(entry.action, data?.history.tokenCatalog || [])}</td><td><TerminalActionToken token={entry.action.token} /></td><td>{entry.action.source === "terminal" ? "Terminal" : "X"}</td><td>{entry.action.status}</td><td>{new Date(entry.action.createdAt).toLocaleString()}</td><td>{entry.action.transactionHash || entry.action.orderId ? <div className="terminal-action-links">{entry.action.transactionHash ? <a href={`https://robinhoodchain.blockscout.com/tx/${entry.action.transactionHash}`} target="_blank" rel="noreferrer">View TXN ↗</a> : null}{entry.action.orderId ? <a href={houdiniOrderUrl(entry.action.orderId)} target="_blank" rel="noreferrer"><small>Order {entry.action.orderId} ↗</small></a> : null}</div> : "—"}</td></tr>
      : <tr key={`houdini-${entry.swap.reviewId}`}><td>{entry.swap.kind.replaceAll("_", " ")}</td><td>{entry.swap.amount} ETH</td><td><TerminalActionToken token={entry.swap.token} /></td><td>Terminal</td><td>{houdiniStatus(entry.swap)}</td><td>{new Date(entry.swap.createdAt).toLocaleString()}</td><td><div className="terminal-action-links">{entry.swap.transactionHash ? <a href={`https://robinhoodchain.blockscout.com/tx/${entry.swap.transactionHash}`} target="_blank" rel="noreferrer">Funding TXN ↗</a> : null}{entry.swap.orderId ? <a href={houdiniOrderUrl(entry.swap.orderId)} target="_blank" rel="noreferrer"><small>Order {entry.swap.orderId} ↗</small></a> : <small>Attempt recorded</small>}</div></td></tr>)}{data && !data.history.actions.length && !data.history.houdiniSwaps?.length && !data.history.feeReceipts?.length ? <tr><td colSpan={7}>No actions yet.</td></tr> : null}</tbody></table></div></section>
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

  function appendLocalUser(text: string, requestId: string) {
    setData((current) => current ? {
      ...current,
      history: {
        ...current.history,
        messages: mergeTerminalMessages(current.history.messages, [{
          role: "user",
          messageType: "chat",
          text,
          requestId,
          createdAt: Date.now(),
        }]),
      },
    } : current);
  }
}

function houdiniStatus(swap: History["houdiniSwaps"][number]) {
  const raw = (swap.displayStatus || swap.statusLabel || swap.status).trim().toUpperCase().replace(/[\s-]+/g, "_");
  const statuses: Record<string, string> = {
    SUBMITTING: "Creating swap order", INITIALIZING: "Preparing swap", NEW: "Waiting for ETH", WAITING: "Waiting for ETH",
    WAITING_FOR_DEPOSIT: "Waiting for ETH", AWAITING_FUNDING: "Waiting for ETH", FUNDING: "Waiting for ETH confirmation",
    FUNDED: "ETH received", CONFIRMING: "Confirming ETH deposit", EXCHANGING: "Swap in progress",
    ANONYMIZING: "Private routing in progress", SENDING_TO_INTERMEDIARY: "Private routing in progress",
    SENDING_TO_RECEIVER: "Sending to receiving wallet", FINISHED: "Completed", COMPLETED: "Completed",
    EXPIRED: "Expired", FAILED: "Failed", REFUNDED: "Refunded", DELETED: "Closed", UNCERTAIN: "Checking submission",
  };
  return statuses[raw] || raw.toLowerCase().replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function formatActionAmount(action: History["actions"][number], catalog: History["tokenCatalog"]) {
  if (!action.amount) return "—";
  if (action.unit === "usd") return `$${action.amount}`;
  if (action.unit === "eth") return `${action.amount} ETH`;
  if (action.unit === "percent") return `${action.amount}%`;
  const identifier = action.unit === "pair" ? action.pairAsset : action.token;
  if (!identifier) return action.amount;
  const normalized = identifier.replace(/^\$/, "").toLowerCase();
  const known = catalog.find((item) => item.tokenAddress.toLowerCase() === normalized || item.symbol.toLowerCase() === normalized);
  return `${action.amount} ${known?.symbol || identifier.replace(/^\$/, "").toUpperCase()}`;
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
    const requestedUnit = String(form.get("unit") || "");
    const unit = tab === "send" && requestedUnit === "token" && /^eth$/i.test(token) ? "eth" : requestedUnit;
    const command: Record<string, unknown> = { kind: tab, amount, unit, token };
    if (tab === "buy" && unit === "pair" && launch?.pairToken) command.pairAsset = launch.pairToken;
    if (tab === "buy" || tab === "sell") command.slippageBps = Math.round(Number(form.get("slippage") || 2.5) * 100);
    if (tab === "send") {
      const recipient = String(form.get("recipient") || "").trim();
      command.recipient = /^0x[a-fA-F0-9]{40}$/.test(recipient) || recipient.startsWith("@") ? recipient : `@${recipient}`;
    }
    const contract = launch?.tokenAddress || holding?.address;
    const tokenLabel = launch?.symbol || holding?.symbol || token || "ETH";
    const displayAmount = unit === "usd" ? `$${amount}` : unit === "percent" ? `${amount}%` : unit === "eth" ? `${amount} ETH` : unit === "pair" ? `${amount} ${pairLabel}` : `${amount} ${tokenLabel}`;
    if (!window.confirm(`Confirm ${tab.toUpperCase()} request\n\nAmount: ${displayAmount}\nToken: ${tokenLabel}${contract ? `\nContract address: ${contract}` : ""}${tab === "send" ? `\nDestination: ${command.recipient}` : ""}`)) return;
    const actionCore = unit === "token" ? `${tab} ${amount} ${tokenLabel}`
      : unit === "percent" ? `${tab} ${amount}% of ${tokenLabel}`
        : tab === "send" && unit === "eth" && tokenLabel === "ETH" ? `send ${amount} ETH`
          : `${tab} ${displayAmount} of ${tokenLabel}`;
    const actionText = `${actionCore}${tab === "send" ? ` to ${command.recipient}` : ""}`;
    void submit({ channel: "terminal_form", text: actionText, command });
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
      <label>Unit<select name="unit" defaultValue={tab === "buy" || tab === "sell" || tab === "burn" ? "usd" : "token"} key={tab}>{tab === "buy" ? <><option value="usd">USD</option><option value="eth">ETH</option>{launch && pairLabel !== "ETH" ? <option value="pair">{pairLabel}</option> : null}</> : tab === "sell" ? <><option value="usd">USD</option><option value="eth">ETH</option><option value="token">Token</option><option value="percent">Percent</option></> : tab === "burn" ? <><option value="usd">USD</option><option value="token">Token</option><option value="percent">Percent</option></> : <><option value="token">Token</option><option value="eth">ETH</option><option value="usd">USD</option><option value="percent">Percent</option></>}</select></label>
      <label>Token or contract<input list="terminal-token-options" name="token" value={token} onChange={(event) => setToken(event.target.value)} required={tab !== "send"} placeholder={tab === "send" ? "ETH or contract" : "Search ticker or enter contract"} /></label>
      <datalist id="terminal-token-options"><option value="ETH" label="ETH — Ethereum" />{[...options.values()].filter((item) => item.symbol !== "ETH").map((item) => <option key={`${item.address}-${item.symbol}`} value={item.address || item.symbol} label={`${item.symbol} ${shortContract(item.address)} — ${item.name}`} />)}</datalist>
      {tab === "buy" || tab === "sell" ? <div className="terminal-pair-display"><span>Paired asset</span><strong>{launch ? pairLabel : "—"}</strong></div> : null}
      {tab === "send" ? <label>Destination<input required name="recipient" autoCapitalize="none" spellCheck={false} placeholder="Address or X" /></label> : null}
      {tab === "buy" || tab === "sell" ? <label>Slippage (%)<input name="slippage" type="number" min="0.1" max="20" step="0.1" defaultValue="2.5" /></label> : null}
      <button className="button button-dark" disabled={busy} type="submit">Review {tab}</button>
    </>}</form>
  </div>;
}
