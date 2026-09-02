"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { splitTerminalMessage, type TerminalMessageRecord } from "@/lib/terminal-message";

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

function liquidityQuickReplies(text: string) {
  const replies: Array<{ label: string; value: string; emphasis?: boolean }> = [];
  const add = (label: string, value = label, emphasis = false) => {
    if (!replies.some(reply => reply.value.toLowerCase() === value.toLowerCase())) replies.push({ label, value, emphasis });
  };
  for (const match of text.matchAll(/(?:^|\n)\s*(\d{1,2})\)\s+/g)) add(`Pool ${match[1]}`, `pool ${match[1]}`);
  if (/custom pool/i.test(text)) add("Custom Pool", "custom pool");
  if (/ETH or USDG|pool pair/i.test(text)) { add("ETH", "ETH"); add("USDG", "USDG"); }
  if (/V3 or V4|Uniswap version|pool version/i.test(text)) { add("V3", "V3"); add("V4", "V4"); }
  if (/shape distribution|flat.+bell.+bid[- ]ask/is.test(text)) { add("Flat", "flat"); add("Bell", "bell"); add("Bid-Ask", "bid ask"); }
  if (/how many bands|number of bands|choose.*bands/i.test(text)) { add("3 Bands", "3 bands"); add("5 Bands", "5 bands"); add("7 Bands", "7 bands"); }
  if (/review your liquidity quote|confirm to proceed/i.test(text)) { add("Confirm", "confirm", true); add("Make Changes", "I want to make changes"); add("Cancel", "cancel"); }
  if (/reply refresh|refresh to/i.test(text)) add("Refresh", "refresh", true);
  if (/reply resume|funded.*resume/i.test(text)) add("Resume", "resume", true);
  if (/reply next|more \(\d+\/\d+\)/i.test(text)) add("Next", "next");
  if (/say yes to withdraw|withdraw the whole/i.test(text)) { add("Withdraw All", "yes", true); add("Cancel", "cancel"); }
  return replies.slice(0, 8);
}

function liquidityGuideMessages(messages: TerminalMessageRecord[]) {
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && /\b(?:(?:create|open|build)[\s\S]{0,100}(?:liquidity|pool|position)|claim[\s\S]{0,60}LP fees?|withdraw[\s\S]{0,60}(?:LP-|position)|(?:check|show|view)[\s\S]{0,60}(?:liquidity|LP|position))/i.test(message.text)) {
      start = index;
      break;
    }
  }
  return start < 0 ? [] : messages.slice(start).slice(-10);
}

function LiquidityMessageText({ text }: { text: string }) {
  return <>{splitTerminalMessage(text).map((part, index) => typeof part === "string"
    ? <span key={index}>{part}</span>
    : <span key={index}><a href={part.url} target="_blank" rel="noreferrer">{part.url}</a>{part.suffix}</span>)}</>;
}

function liquidityStepTitle(text: string) {
  if (/pool options|recommended|\d+\)\s+/i.test(text)) return "Choose a Pool";
  if (/ETH or USDG|pool pair/i.test(text)) return "Choose a Pair";
  if (/V3 or V4|Uniswap version/i.test(text)) return "Choose a Version";
  if (/shape distribution|flat.+bell.+bid[- ]ask/is.test(text)) return "Choose a Shape";
  if (/how many bands|number of bands|choose.*bands/i.test(text)) return "Choose Your Bands";
  if (/market cap|MCap range|lower.+upper/is.test(text)) return "Set the Position Range";
  if (/fee percentage|fee tier/i.test(text)) return "Choose a Fee";
  if (/review your liquidity quote|confirm to proceed/i.test(text)) return "Review Your Position";
  if (/not enough|add funds|reply resume/i.test(text)) return "Fund Your Wallet";
  if (/success|position (?:is )?(?:open|created)|LP-/i.test(text)) return "Position Created";
  return "Build Your Position";
}

function optionDescription(label: string, value: string, prompt: string) {
  const poolNumber = value.match(/^pool\s+(\d+)$/i)?.[1];
  if (poolNumber) return prompt.match(new RegExp(`(?:^|\\n)\\s*${poolNumber}\\)\\s*([\\s\\S]*?)(?=\\n\\s*\\d{1,2}\\)\\s|\\n\\s*(?:or\\s+)?custom pool|$)`, "i"))?.[1]?.trim();
  const descriptions: Record<string, string> = {
    ETH: "Pair the position with ETH.", USDG: "Pair the position with the USD stablecoin.",
    V3: "Use a concentrated Uniswap V3 position.", V4: "Use Delta Liquidity's shaped V4 position.",
    Flat: "Spreads liquidity evenly across the selected range.", Bell: "Concentrates more liquidity near the middle of the range.",
    "Bid-Ask": "Places more liquidity toward both sides of the range.", "Custom Pool": "Choose each pool setting yourself.",
    Confirm: "Create the position using the displayed quote.", "Make Changes": "Adjust one or more settings before proceeding.",
    Cancel: "End this setup without moving funds.", Refresh: "Refresh the analysis or quote with current data.",
    Resume: "Continue after funding your Pons Bot wallet.", Next: "Show the next page of results.",
    "Withdraw All": "Collect LP fees and close the full position.",
  };
  return descriptions[label];
}

export function LiquidityPositionsPanel({ busy, submit, messages }: {
  busy: boolean;
  submit: (payload: { channel: "terminal_chat"; text: string }) => Promise<void>;
  messages: TerminalMessageRecord[];
  username: string;
}) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [view, setView] = useState<"build" | "positions">("build");
  const [tab, setTab] = useState<"active" | "closed">("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [acting, setActing] = useState<string>();
  const [token, setToken] = useState("");
  const [budget, setBudget] = useState("");
  const [unit, setUnit] = useState<"usd" | "eth">("usd");
  const [pair, setPair] = useState<"ETH" | "USDG">("ETH");
  const [reply, setReply] = useState("");

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
    void submit({ channel: "terminal_chat", text });
  };
  const replyToGuide = (event: FormEvent) => {
    event.preventDefault();
    const text = reply.trim();
    if (!text) return;
    setReply("");
    void submit({ channel: "terminal_chat", text });
  };
  const act = async (position: Position, kind: "claim" | "withdraw") => {
    setActing(`${kind}:${position.id}`);
    await submit({ channel: "terminal_chat", text: kind === "claim" ? `claim LP fees for ${position.id}` : `withdraw ${position.id}` });
    window.setTimeout(() => { void refresh(); setActing(undefined); }, 5_000);
  };
  const visible = positions.filter(position => position.status === tab);
  const guideMessages = liquidityGuideMessages(messages);
  const latestAssistant = [...guideMessages].reverse().find(message => message.role === "assistant");
  const quickReplies = latestAssistant ? liquidityQuickReplies(latestAssistant.text) : [];
  const selections = guideMessages.filter(message => message.role === "user").slice(1).slice(-5);
  const choose = (value: string) => void submit({ channel: "terminal_chat", text: value });

  return <section className="liquidity-positions-shell">
    <div className="liquidity-section-tabs" role="tablist" aria-label="Liquidity positions">
      <button type="button" role="tab" aria-selected={view === "build"} className={view === "build" ? "active" : ""} onClick={() => setView("build")}>Build a Position</button>
      <button type="button" role="tab" aria-selected={view === "positions"} className={view === "positions" ? "active" : ""} onClick={() => setView("positions")}>My Positions <span>{positions.filter(position => position.status === "active").length}</span></button>
    </div>

    {view === "build" ? <div className="liquidity-build-experience">
    {!guideMessages.length ? <form className="liquidity-builder liquidity-builder-start" onSubmit={build}>
      <div><p className="eyebrow"><a className="delta-powered-link" href="https://deltaliquidity.app/" target="_blank" rel="noreferrer">Powered by Delta Liquidity ↗</a></p><h2>Build a Position</h2><p>Start with the token and budget. Pons Bot will analyze available pools and guide you through the remaining choices.</p></div>
      <div className="liquidity-start-fields"><label>Token or contract<input value={token} onChange={event => setToken(event.target.value)} placeholder="PONSBOT or 0x…" required /></label>
      <label>Budget<div className="liquidity-budget-input"><input value={budget} inputMode="decimal" onChange={event => setBudget(event.target.value)} placeholder={unit === "usd" ? "100" : "0.05"} required /><div className="liquidity-unit-toggle"><button type="button" className={unit === "usd" ? "active" : ""} onClick={() => setUnit("usd")}>USD</button><button type="button" className={unit === "eth" ? "active" : ""} onClick={() => setUnit("eth")}>ETH</button></div></div></label></div>
      <fieldset className="liquidity-pair-picker"><legend>Choose a pool pair</legend><div><button type="button" className={pair === "ETH" ? "active" : ""} onClick={() => setPair("ETH")}><strong>ETH</strong><span>Pair your token with ETH</span></button><button type="button" className={pair === "USDG" ? "active" : ""} onClick={() => setPair("USDG")}><strong>USDG</strong><span>Pair your token with USDG</span></button></div></fieldset>
      <button className="button button-dark" disabled={busy} type="submit">Analyze Pools</button>
    </form> : null}

    {guideMessages.length ? <div className="liquidity-step-shell" aria-live="polite">
      <div className="liquidity-step-progress"><div><p className="eyebrow"><a className="delta-powered-link" href="https://deltaliquidity.app/" target="_blank" rel="noreferrer">Powered by Delta Liquidity ↗</a></p><strong>Position setup</strong></div><span>{busy ? "Working…" : "In progress"}</span></div>
      {selections.length ? <div className="liquidity-selection-trail">{selections.map((message, index) => <span key={`${message.requestId || message.createdAt}-${index}`}>{message.text}</span>)}</div> : null}
      <article className="liquidity-current-step">
        <header><span className="liquidity-step-icon">{busy ? "•••" : "◆"}</span><div><p>Current step</p><h2>{latestAssistant ? liquidityStepTitle(latestAssistant.text) : "Preparing Your Options"}</h2></div></header>
        <div className="liquidity-step-copy">{latestAssistant ? <LiquidityMessageText text={latestAssistant.text} /> : "Pons Bot is analyzing the available liquidity pools."}</div>
        {quickReplies.length ? <div className="liquidity-choice-cards">{quickReplies.map(item => {
          const description = latestAssistant ? optionDescription(item.label, item.value, latestAssistant.text) : undefined;
          return <button key={item.value} className={item.emphasis ? "primary" : ""} type="button" disabled={busy} onClick={() => choose(item.value)}><strong>{item.label}</strong>{description ? <span>{description}</span> : null}<i>Choose →</i></button>;
        })}</div> : null}
        <form className="liquidity-custom-answer" onSubmit={replyToGuide}><label htmlFor="liquidity-custom-answer">Custom answer or question</label><div><input id="liquidity-custom-answer" value={reply} maxLength={500} onChange={event => setReply(event.target.value)} placeholder="Type a value, request a change, or ask what this means…" /><button disabled={busy || !reply.trim()} type="submit">Continue</button></div></form>
      </article>
    </div> : null}
    </div> : <div className="liquidity-position-list">
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
    </div>}
  </section>;
}
