"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { formatEther, formatUnits } from "viem";
import { ownerBotIntent, type OwnerBotIntent } from "@/lib/trading-agents/execution";
import type { OwnedBotsResponse } from "@/lib/trading-agents/owner-view";
import styles from "./MyBots.module.css";
import { BotPnl } from "./BotPnl";

export function MyBots() {
  const [data, setData] = useState<OwnedBotsResponse | null>(null);
  const [error, setError] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const requestKeys = useRef(new Map<string, string>());
  const generation = useRef(0);
  const refreshing = useRef(false);
  const refreshQueued = useRef(false);
  const mounted = useRef(false);
  const invalidate = useCallback(() => { mounted.current = false; }, []);
  const refresh = useCallback(async function refreshOwnedBots() {
    if (refreshing.current) { refreshQueued.current = true; return; }
    refreshing.current = true;
    const request = ++generation.current;
    try {
      const r = await fetch("/api/bot-yard/owner?balances=true", { cache: "no-store", signal: AbortSignal.timeout(45000) });
      const value = await r.json();
      if (!r.ok) throw new Error(value.error || "Could not load your bots.");
      if (mounted.current && request === generation.current) {
        const next = value as OwnedBotsResponse;
        const completed = new Set(next.bots.flatMap(bot => bot.transactions?.filter(tx => tx.state !== "active").map(tx => tx.requestKey) ?? []));
        for (const [fingerprint, key] of requestKeys.current) if (completed.has(key)) requestKeys.current.delete(fingerprint);
        setData(next); setError("");
      }
    } catch (e) { if (mounted.current && request === generation.current) setError(e instanceof Error ? e.message : "Could not load your bots."); }
    finally {
      refreshing.current = false;
      if (refreshQueued.current && mounted.current) { refreshQueued.current = false; void refreshOwnedBots(); }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return invalidate;
  }, [refresh, invalidate]);
  const active = data?.bots.some(bot => bot.transactions?.some(tx => tx.state === "active"));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 10000);
    return () => clearInterval(timer);
  }, [active, refresh]);
  async function submit(agentId: string, intent: OwnerBotIntent) {
    if (busy || !data?.executionEnabled) return;
    const parsed = ownerBotIntent.safeParse(intent);
    if (!parsed.success) { setNotice("Enter a positive ETH amount with at most 18 decimal places."); return; }
    if (!window.confirm(intent.kind === "sell" ? "Sell this bot’s entire position in this token? Proceeds stay in the bot wallet and may be in the paired asset." : `Withdraw ${intent.amount} ETH to your Pons Bot wallet?`)) return;
    const fingerprint = JSON.stringify([agentId, intent]);
    const requestKey = requestKeys.current.get(fingerprint) || crypto.randomUUID();
    requestKeys.current.set(fingerprint, requestKey);
    setBusy(true); setNotice("");
    try {
      const r = await fetch("/api/bot-yard/owner", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": data.csrfToken || "" }, body: JSON.stringify({ agentId, requestKey, intent }) });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || "Could not submit the request.");
      setNotice("Transaction submitted. Its confirmed result will appear below.");
      await refresh();
    } catch (e) { setNotice(e instanceof Error ? e.message : "Check transaction status before retrying."); }
    finally { setBusy(false); }
  }
  return <section className={styles.page}>
    <h1>My Bot</h1>
    <button type="button" onClick={() => void refresh()}>Refresh balances</button>
    {notice && <p role="status">{notice}</p>}
    {error ? <p role="alert">{error} <a href="/api/auth/x/start">Sign in with X</a></p> : !data ? <p role="status">Loading your bots…</p> : <>
      <p>Manage the bots owned by your signed-in X account.</p>
      <p className={styles.notice}>{data.executionEnabled ? "These controls manage real funds in your bot’s dedicated wallet. Withdrawals and trades run one at a time per bot." : "Owner transaction controls are not enabled yet. Balances shown here are actual wallet balances."}</p>
      {!data.bots.length && <p>You don’t own any bots yet.</p>}
      <div className={styles.grid}>{data.bots.map(bot => <article className={styles.card} key={bot.id}>
        <h2>{bot.name}</h2>
        {bot.mode === "live" && <BotPnl pnl={bot.pnl} />}
        {bot.walletAddress ? <p>Bot wallet: <a href={`/bot-yard/wallet/${bot.walletAddress}`}>{bot.walletAddress}</a></p> : <p>Bot wallet has not been provisioned yet.</p>}
        <h3>Token positions</h3>
        <p>Sales stay in the bot wallet. Paired-token sales may return the pairing asset instead of ETH.</p>
        {!bot.live ? <p>Live balances could not be loaded. Refresh to try again.</p> : <>
          {!bot.live.complete && <p>Some holdings may not have been discovered yet.</p>}
          {bot.live.tokens.length ? <ul>{bot.live.tokens.map(holding => <li key={holding.address}>
            <span>${holding.symbol}<small>{formatUnits(BigInt(holding.balance), holding.decimals)}</small><small>{holding.address}</small></span>
            <button type="button" disabled={busy || !data.executionEnabled || !!bot.transactions?.some(tx => tx.state === "active")} onClick={() => void submit(bot.id, { kind: "sell", token: holding.address })}>Sell all</button>
          </li>)}</ul> : <p>No token positions found.</p>}
        </>}
        <h3>Withdraw Robinhood ETH</h3>
        {bot.live && <p>ETH balance: {formatEther(BigInt(bot.live.cashWei))} ETH</p>}
        <label htmlFor={`amount-${bot.id}`}>Amount (ETH)</label>
        <input id={`amount-${bot.id}`} inputMode="decimal" placeholder="0.01" value={amounts[bot.id] ?? ""} onChange={e => setAmounts(prev => ({ ...prev, [bot.id]: e.target.value }))} />
        <p>To your Pons Bot wallet: <a href={`/wallet/${data.destination}`}>{data.destination}</a></p>
        <button type="button" disabled={busy || !data.executionEnabled || !bot.live || !!bot.transactions?.some(tx => tx.state === "active")} onClick={() => void submit(bot.id, { kind: "withdraw", amount: amounts[bot.id] || "" })}>Withdraw ETH</button>
        {bot.transactions?.map(tx => <div key={tx.id} role="status"><p>{tx.state === "confirmed" ? `${tx.kind === "sell" ? "Sale" : "Withdrawal"} confirmed.` : tx.state === "failed" ? tx.error : "Transaction processing…"}</p>
          {tx.hashes.map((hash, i) => <p key={hash}><a href={`https://robinhoodchain.blockscout.com/tx/${hash}`} target="_blank" rel="noreferrer">Transaction {i + 1}</a></p>)}
        </div>)}
      </article>)}</div>
    </>}
  </section>;
}
