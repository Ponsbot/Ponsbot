"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { splitTerminalMessage, type TerminalMessageRecord } from "@/lib/terminal-message";

type LiveAsset = { symbol: string; amount: string; usd: number | null; unclaimed: string | null; unclaimedUsd: number | null };
type Position = {
  id: string; status: "active" | "closed"; token: string; symbol: string; version: 3 | 4; poolId: string;
  pair?: "ETH" | "USDG"; shape?: "flat" | "bell" | "bid_ask"; feePercent?: number; bands?: number;
  lowerMarketCapUsd?: number; upperMarketCapUsd?: number; createdAt: number; updatedAt: number; nftIds: string[];
  feesClaimed: Array<{ symbol: string; amount: string; usd?: number }>;
  lastClaim?: { items: Array<{ symbol: string; amount: string; usd?: number }>; claimedAt: number };
  live: null | { assets: LiveAsset[]; marketCapRangeUsd?: { lower: number; upper: number } | null; range: { inRange: boolean } };
};

const money = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : value > 0 && value < .01 ? "<$0.01" : value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const amount = (value: string) => Number(value).toLocaleString("en-US", { maximumSignificantDigits: 7 });
const mcap = (value?: number) => value == null ? "—" : value >= 1e9 ? `$${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `$${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `$${(value / 1e3).toFixed(1)}K` : `$${value.toFixed(0)}`;
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

function parseCompactMoney(value: string) {
  const match = value.trim().replaceAll(",", "").match(/^\$?([0-9]+(?:\.[0-9]+)?)\s*([kmb])?$/i);
  if (!match) return undefined;
  const multiplier = match[2]?.toLowerCase() === "b" ? 1e9 : match[2]?.toLowerCase() === "m" ? 1e6 : match[2]?.toLowerCase() === "k" ? 1e3 : 1;
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function currentMarketCapFromMessages(messages: TerminalMessageRecord[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const match = messages[index].text.match(/Current MCap:\s*(\$?[0-9][0-9,.]*\s*[KMB]?)/i);
    const parsed = match ? parseCompactMoney(match[1]) : undefined;
    if (parsed && parsed > 0) return parsed;
  }
  return undefined;
}

function ShapeGraphic({ shape }: { shape: "flat" | "bell" | "bid-ask" }) {
  return <span className={`liquidity-shape-graphic ${shape}`} aria-hidden="true">
    {[0, 1, 2, 3, 4].map(index => <i key={index} />)}
  </span>;
}

function AnimatedDots() {
  return <span className="animated-waiting-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>;
}

function liquidityQuickReplies(text: string) {
  const replies: Array<{ label: string; value: string; emphasis?: boolean }> = [];
  const add = (label: string, value = label, emphasis = false) => {
    if (!replies.some(reply => reply.value.toLowerCase() === value.toLowerCase())) replies.push({ label, value, emphasis });
  };
  for (const match of text.matchAll(/(?:^|\n)\s*(\d{1,2})\)\s+/g)) add(`Pool ${match[1]}`, `pool ${match[1]}`);
  if (/custom pool/i.test(text)) add("Custom Pool", "custom pool");
  // Pool cards contain fee data as descriptive context. Do not mistake those
  // percentages for a separate fee-selection step beneath the pool choices.
  if (replies.some(reply => /^pool\s+\d+$/i.test(reply.value))) return replies.slice(0, 8);
  if (/ETH or USDG|pool pair/i.test(text)) { add("ETH", "ETH"); add("USDG", "USDG"); }
  if (/V3 or V4|Uniswap version|pool version/i.test(text)) { add("V3", "V3"); add("V4", "V4"); }
  if (/swap fee|fee percentage|fee tier/i.test(text)) {
    add("0.01%", "0.01%"); add("0.05%", "0.05%"); add("0.3%", "0.3%"); add("1%", "1%");
  }
  if (/shape distribution|flat.+bell.+bid[- ]ask/is.test(text)) { add("Flat", "flat"); add("Bell", "bell"); add("Bid-Ask", "bid ask"); }
  if (/how many bands|number of bands|choose.*bands/i.test(text)) { add("3 Bands", "3 bands"); add("5 Bands", "5 bands"); add("7 Bands", "7 bands"); }
  if (/review your liquidity quote|confirm to proceed/i.test(text)) add("Confirm", "confirm", true);
  if (/reply refresh|refresh to/i.test(text)) add("Refresh", "refresh", true);
  if (/reply resume|funded.*resume/i.test(text)) add("Resume", "resume", true);
  if (/reply next|more \(\d+\/\d+\)/i.test(text)) add("Next", "next");
  if (/say yes to withdraw|withdraw the whole/i.test(text)) { add("Withdraw All", "yes", true); add("Cancel", "cancel"); }
  return replies.slice(0, 8);
}

function liquidityGuideMessages(messages: TerminalMessageRecord[]) {
  const builderMessages = messages.filter(message => !message.requestId?.startsWith("liquidity-management_"));
  const latestCancellation = builderMessages.findLastIndex(message => message.role === "assistant" && /liquidity setup cancelled/i.test(message.text));
  let start = -1;
  for (let index = builderMessages.length - 1; index >= 0; index -= 1) {
    const message = builderMessages[index];
    if (message.role === "user" && /\b(?:(?:create|open|build)[\s\S]{0,100}(?:liquidity|pool|position)|claim[\s\S]{0,60}LP fees?|withdraw[\s\S]{0,60}(?:LP-|position)|(?:check|show|view)[\s\S]{0,60}(?:liquidity|LP|position))/i.test(message.text)) {
      start = index;
      break;
    }
  }
  if (latestCancellation >= start && start >= 0) return [];
  return start < 0 ? [] : builderMessages.slice(start).slice(-10);
}

function LiquidityMessageText({ text }: { text: string }) {
  return <>{splitTerminalMessage(text).map((part, index) => typeof part === "string"
    ? <span key={index}>{part}</span>
    : <span key={index}><a href={part.url} target="_blank" rel="noreferrer">{part.url}</a>{part.suffix}</span>)}</>;
}

function terminalLiquidityText(text: string) {
  const cleaned = text
    .replace(/\n\s*Your wallet:\s*https?:\/\/\S+/gi, "")
    .replace(/\bthen reply resume\b/gi, "then click Resume")
    .replace(/\breply resume\b/gi, "click Resume")
    .replace(/\breply refresh\b/gi, "click Refresh")
    .replace(/\breply next\b/gi, "click Next")
    .replace(/\breply confirm\b/gi, "click Confirm")
    .replace(/\breply cancel\b/gi, "click Cancel");
  if (/^📊 What MCap range should your position cover\?/i.test(cleaned)) return "📊 What MCap range should your position cover?";
  return cleaned;
}

function LiquidityQuoteDetails({ text }: { text: string }) {
  const sections = text.split(/\n\s*\n/).map(section => section.trim()).filter(Boolean)
    .filter(section => !/^💧 Review your liquidity quote$/i.test(section));
  return <div className="liquidity-quote-details">{sections.map((section, index) =>
    <section key={`${index}-${section.slice(0, 24)}`} className={`liquidity-quote-section${/^Token:/i.test(section) ? " overview" : /^V[34]\b/i.test(section) ? " settings" : " funding"}`}>
      <LiquidityMessageText text={section} />
    </section>)}</div>;
}

function liquidityStepTitle(text: string) {
  if (/review your liquidity quote|confirm to proceed/i.test(text)) return "Position Quote";
  if (/pool options|recommended|\d+\)\s+/i.test(text)) return "Choose a Pool";
  if (/ETH or USDG|pool pair/i.test(text)) return "Choose a Pair";
  if (/V3 or V4|Uniswap version/i.test(text)) return "Choose a Version";
  if (/shape distribution|flat.+bell.+bid[- ]ask/is.test(text)) return "Choose a Shape";
  if (/how many bands|number of bands|choose.*bands/i.test(text)) return "Choose Your Bands";
  if (/market cap|MCap range|lower.+upper/is.test(text)) return "Set the Position Range";
  if (/fee percentage|fee tier/i.test(text)) return "Choose a Fee";
  if (/not enough|add funds|reply resume/i.test(text)) return "Fund Your Wallet";
  if (/success|position (?:is )?(?:open|created)|LP-/i.test(text)) return "Position Created";
  return "Build Your Position";
}

function liquidityStage(text?: string) {
  if (!text) return 1;
  if (/review your liquidity quote|confirm to proceed/i.test(text)) return 4;
  if (/pool options|recommended|\d+\)\s+/i.test(text)) return 2;
  if (/ETH or USDG|pool pair|V3 or V4|Uniswap version|shape distribution|flat.+bell.+bid[- ]ask|how many bands|number of bands|market cap|MCap range|lower.+upper|fee percentage|fee tier/i.test(text)) return 3;
  return 1;
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

function PoolOptionDescription({ description }: { description: string }) {
  const lines = description.split("\n").map(line => line.trim()).filter(Boolean);
  const totalLiquidityIndex = lines.findIndex(line => /^Total pool liquidity:/i.test(line));
  return <span className="liquidity-pool-option-description">
    {lines.flatMap((line, index) => {
      const swapAndDepth = line.match(/^(Swap fee\s+[^•]+)\s*•\s*(Active depth[\s\S]*)$/i);
      if (swapAndDepth) return [
        <span key={`${index}-fee`} className="liquidity-pool-metric swap-fee">{swapAndDepth[1].trim()}</span>,
        <span key={`${index}-depth`} className="liquidity-pool-metric active-depth">{swapAndDepth[2].trim()}</span>,
      ];
      const recommendation = totalLiquidityIndex >= 0 && index > totalLiquidityIndex;
      return <span key={index} className={`${index === 0 ? "liquidity-pool-summary" : "liquidity-pool-line"}${recommendation ? " liquidity-pool-recommendation" : ""}`}>{line}</span>;
    })}
  </span>;
}

export function LiquidityPositionsPanel({ busy, submit, messages }: {
  busy: boolean;
  submit: (payload: { channel: "terminal_chat"; text: string }, context?: "builder" | "management") => Promise<void>;
  messages: TerminalMessageRecord[];
  username: string;
}) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [view, setView] = useState<"build" | "positions">("positions");
  const [tab, setTab] = useState<"active" | "closed">("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [acting, setActing] = useState<string>();
  const [actingStartedAt, setActingStartedAt] = useState(0);
  const [withdrawalCards, setWithdrawalCards] = useState<Record<string, Position>>({});
  const [withdrawalResults, setWithdrawalResults] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [budget, setBudget] = useState("");
  const [unit, setUnit] = useState<"usd" | "eth">("usd");
  const [reply, setReply] = useState("");
  const [rangeLower, setRangeLower] = useState("");
  const [rangeUpper, setRangeUpper] = useState("");
  const [canGoBack, setCanGoBack] = useState(false);
  const [workflowMarketCapUsd, setWorkflowMarketCapUsd] = useState<number>();
  const [workflowPhase, setWorkflowPhase] = useState<string>();
  const [builderResetAt, setBuilderResetAt] = useState(0);
  const workflowRefreshSequence = useRef(0);
  const latestMessage = messages.at(-1);
  const latestMessageKey = latestMessage?.requestId ?? (latestMessage ? `${latestMessage.createdAt}:${latestMessage.role}:${latestMessage.text}` : "empty");

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

  const refreshWorkflow = useCallback(async () => {
    const sequence = ++workflowRefreshSequence.current;
    try {
      const response = await fetch("/api/terminal/liquidity?workflow=1", { cache: "no-store" });
      const value = await response.json();
      if (sequence !== workflowRefreshSequence.current) return;
      setCanGoBack(response.ok && value.active === true && value.canGoBack === true);
      setWorkflowPhase(response.ok && value.active === true && typeof value.phase === "string" ? value.phase : undefined);
      setWorkflowMarketCapUsd(response.ok && Number.isFinite(value.currentMarketCapUsd) && value.currentMarketCapUsd > 0
        ? value.currentMarketCapUsd : undefined);
    } catch {
      if (sequence !== workflowRefreshSequence.current) return;
      setCanGoBack(false); setWorkflowPhase(undefined); setWorkflowMarketCapUsd(undefined);
    }
  }, []);
  useEffect(() => { void refreshWorkflow(); }, [latestMessageKey, refreshWorkflow]);

  const build = (event: FormEvent) => {
    event.preventDefault();
    const symbol = token.trim();
    const value = budget.trim();
    if (!symbol || !value) return;
    const text = `create a ${unit === "usd" ? `$${value}` : `${value} ETH`} liquidity position for ${symbol}`;
    void submit({ channel: "terminal_chat", text }).then(refreshWorkflow);
  };
  const replyToGuide = (event: FormEvent) => {
    event.preventDefault();
    const text = reply.trim();
    if (!text) return;
    setReply("");
    void submit({ channel: "terminal_chat", text }).then(refreshWorkflow);
  };
  const submitRange = (event: FormEvent) => {
    event.preventDefault();
    const lower = rangeLower.trim(), upper = rangeUpper.trim();
    if (!lower || !upper) return;
    void submit({ channel: "terminal_chat", text: `${lower} to ${upper}` }).then(refreshWorkflow);
  };
  const act = async (position: Position, kind: "claim" | "withdraw") => {
    if (kind === "withdraw") {
      setWithdrawalCards(current => ({ ...current, [position.id]: position }));
      setWithdrawalResults(current => {
        const next = { ...current };
        delete next[position.id];
        return next;
      });
    }
    setActing(`${kind}:${position.id}`);
    setActingStartedAt(Date.now());
    await submit({ channel: "terminal_chat", text: kind === "claim" ? `claim LP fees for ${position.id}` : `withdraw ${position.id}` }, "management");
    void refresh();
  };
  useEffect(() => {
    if (!acting || !actingStartedAt) return;
    const completed = [...messages].reverse().find(message => message.role === "assistant"
      && message.requestId?.startsWith("liquidity-management_") && message.createdAt >= actingStartedAt
      && /confirmed|failed|couldn.?t|not enough|no (?:LP )?fees|nothing (?:to )?collect|withdrawn|collected/i.test(message.text));
    if (!completed) return;
    if (acting.startsWith("withdraw:")) {
      const positionId = acting.slice("withdraw:".length);
      if (/position withdrawn|withdrawal confirmed/i.test(completed.text)) {
        setWithdrawalResults(current => ({ ...current, [positionId]: completed.text }));
      } else {
        setWithdrawalCards(current => {
          const next = { ...current };
          delete next[positionId];
          return next;
        });
      }
    }
    void refresh().finally(() => { setActing(undefined); setActingStartedAt(0); });
  }, [acting, actingStartedAt, messages, refresh]);
  useEffect(() => {
    if (!actingStartedAt) return;
    const timer = window.setTimeout(() => { setActing(undefined); setActingStartedAt(0); void refresh(); }, 120_000);
    return () => window.clearTimeout(timer);
  }, [actingStartedAt, refresh]);
  const visible = tab === "closed"
    ? positions.filter(position => position.status === "closed")
    : [...positions.filter(position => position.status === "active"),
      ...Object.values(withdrawalCards).filter(position => !positions.some(current => current.status === "active" && current.id === position.id))];
  const guideMessages = liquidityGuideMessages(builderResetAt
    ? messages.filter(message => message.createdAt > builderResetAt)
    : messages);
  const latestAssistant = [...guideMessages].reverse().find(message => message.role === "assistant");
  const quickReplies = latestAssistant ? liquidityQuickReplies(latestAssistant.text) : [];
  const poolChoiceStep = quickReplies.some(item => /^pool\s+\d+$/i.test(item.value));
  const feeChoiceStep = latestAssistant ? /swap fee|fee percentage|fee tier/i.test(latestAssistant.text) : false;
  const shapeChoiceStep = latestAssistant ? /shape distribution|flat.+bell.+bid[- ]ask/is.test(latestAssistant.text) : false;
  const rangePromptStep = latestAssistant ? /what MCap range|provide a lower and upper|range should your position cover|requested range[\s\S]*band spacing/i.test(latestAssistant.text) : false;
  // A freshly rendered prompt is more current than the separately refreshed
  // workflow snapshot. In particular, do not keep the range editor mounted
  // when the conversation has already advanced to the shape choice.
  const rangeChoiceStep = rangePromptStep || (workflowPhase === "range" && !shapeChoiceStep);
  // The saved workflow is authoritative. Parsing rendered messages remains a
  // fallback for a response that arrives just before the workflow-state fetch.
  const currentMarketCap = workflowMarketCapUsd ?? currentMarketCapFromMessages(guideMessages);
  const sliderMaximum = currentMarketCap ? currentMarketCap * 2 : 0;
  const sliderLower = currentMarketCap ? Math.max(0, Math.min(sliderMaximum, parseCompactMoney(rangeLower) ?? currentMarketCap * .5)) : 0;
  const sliderUpper = currentMarketCap ? Math.max(0, Math.min(sliderMaximum, parseCompactMoney(rangeUpper) ?? currentMarketCap * 1.5)) : 0;
  const lowerHandle = Math.min(sliderLower, sliderUpper);
  const upperHandle = Math.max(sliderLower, sliderUpper);
  const quoteChoiceStep = latestAssistant ? /review your liquidity quote|confirm to proceed/i.test(latestAssistant.text) : false;
  const positionCreatedStep = latestAssistant
    ? /✅\s+LP-[A-F0-9]{8}:\s*Delta Liquidity position opened!/i.test(latestAssistant.text)
    : false;
  const stage = liquidityStage(latestAssistant?.text);
  const choose = (value: string) => void submit({ channel: "terminal_chat", text: value }).then(refreshWorkflow);
  const startNewPosition = () => {
    setBuilderResetAt(Math.max(Date.now(), latestAssistant?.createdAt ?? 0));
    setToken(""); setBudget(""); setUnit("usd"); setReply(""); setRangeLower(""); setRangeUpper("");
    setCanGoBack(false); setWorkflowPhase(undefined); setWorkflowMarketCapUsd(undefined);
  };

  useEffect(() => {
    if (!rangeChoiceStep || !currentMarketCap) return;
    setRangeLower(current => current.trim() ? current : String(Math.round(currentMarketCap * .5)));
    setRangeUpper(current => current.trim() ? current : String(Math.round(currentMarketCap * 1.5)));
  }, [currentMarketCap, rangeChoiceStep]);

  return <section className="liquidity-positions-shell">
    <div className="liquidity-section-tabs" role="tablist" aria-label="Liquidity positions">
      <button type="button" role="tab" aria-selected={view === "positions"} className={view === "positions" ? "active" : ""} onClick={() => setView("positions")}>My Positions <span>{positions.filter(position => position.status === "active").length}</span></button>
      <button type="button" role="tab" aria-selected={view === "build"} className={view === "build" ? "active" : ""} onClick={() => setView("build")}>Build a Position</button>
    </div>

    {view === "build" ? <div className="liquidity-build-experience liquidity-build-workspace">
    <form className="liquidity-builder liquidity-builder-start" onSubmit={build}>
      <div><p className="eyebrow"><a className="delta-powered-link" href="https://deltaliquidity.app/" target="_blank" rel="noreferrer">Powered by Delta Liquidity ↗</a></p><h2>Build a Position</h2><p>Start with the token and budget. Pons Bot will analyze available pools and guide you through the remaining choices.</p></div>
      <div className="liquidity-start-fields"><label>Token or contract<input value={token} onChange={event => setToken(event.target.value)} placeholder="PONSBOT or 0x…" required /></label>
      <label>Budget<div className="liquidity-budget-input"><input value={budget} inputMode="decimal" onChange={event => setBudget(event.target.value)} placeholder={unit === "usd" ? "100" : "0.05"} required /><div className="liquidity-unit-toggle"><button type="button" className={unit === "usd" ? "active" : ""} onClick={() => setUnit("usd")}>USD</button><button type="button" className={unit === "eth" ? "active" : ""} onClick={() => setUnit("eth")}>ETH</button></div></div></label></div>
      <button className="button button-dark" disabled={busy || !token.trim() || !budget.trim()} type="submit">{guideMessages.length ? "Update Quote" : "Analyze Pools"}</button>
    </form>

    {guideMessages.length ? <div className="liquidity-step-shell" aria-live="polite">
      <div className="liquidity-step-progress"><div><strong>Position setup</strong><span>{busy ? <>Updating your setup<AnimatedDots /></> : `Step ${stage} of 4`}</span></div><ol aria-label="Position setup progress">{["Basics", "Pool", "Settings", "Quote"].map((label, index) => <li key={label} className={index + 1 < stage ? "complete" : index + 1 === stage ? "active" : ""}><i>{index + 1 < stage ? "✓" : index + 1}</i><span>{label}</span></li>)}</ol></div>
      <article className="liquidity-current-step">
        <header className={quoteChoiceStep ? "quote" : ""}><span className="liquidity-step-icon">{busy ? <AnimatedDots /> : quoteChoiceStep ? "✓" : "◆"}</span><div><p>{quoteChoiceStep ? "Ready to review" : "Current step"}</p><h2>{latestAssistant ? liquidityStepTitle(latestAssistant.text) : "Preparing Your Options"}</h2></div></header>
        {quoteChoiceStep && latestAssistant ? <LiquidityQuoteDetails text={terminalLiquidityText(latestAssistant.text)} />
          : !poolChoiceStep && !shapeChoiceStep ? <div className="liquidity-step-copy">{latestAssistant ? <LiquidityMessageText text={terminalLiquidityText(latestAssistant.text)} /> : "Pons Bot is analyzing the available liquidity pools."}</div> : null}
        {quickReplies.length && !quoteChoiceStep ? <div className={`liquidity-choice-cards${feeChoiceStep ? " fee-options" : ""}${poolChoiceStep ? " pool-options" : ""}`}>{quickReplies.map(item => {
          const description = latestAssistant ? optionDescription(item.label, item.value, latestAssistant.text) : undefined;
          const shape = /bid[- ]ask/i.test(item.label) ? "bid-ask" : /bell/i.test(item.label) ? "bell" : /^flat$/i.test(item.label) ? "flat" : undefined;
          const poolOption = /^pool\s+\d+$/i.test(item.value);
          const button = <button className={`${item.emphasis ? "primary " : ""}${poolOption ? "liquidity-pool-option" : ""}`.trim()} type="button" disabled={busy} onClick={() => choose(item.value)}>{!poolOption ? <strong>{item.label}</strong> : null}{shape ? <ShapeGraphic shape={shape} /> : null}{description ? poolOption ? <PoolOptionDescription description={description} /> : <span>{description}</span> : null}<i>Choose →</i></button>;
          return poolOption ? <div className="liquidity-pool-choice" key={item.value}><strong className="liquidity-pool-label">{item.label}</strong>{button}</div> : <div className="liquidity-choice-item" key={item.value}>{button}</div>;
        })}</div> : null}
        {rangeChoiceStep ? <form className="liquidity-range-answer" onSubmit={submitRange}>
          <label>Position MCap range</label>
          {currentMarketCap ? <div className="liquidity-range-slider">
            <div className="liquidity-range-current"><span>Current MCap</span><strong>{mcap(currentMarketCap)}</strong></div>
            <div className="liquidity-dual-range">
              <span className="liquidity-dual-range-track" />
              <span className="liquidity-dual-range-fill" style={{ left: `${lowerHandle / sliderMaximum * 100}%`, right: `${100 - upperHandle / sliderMaximum * 100}%` }} />
              <span className="liquidity-current-mcap-marker" style={{ left: `${currentMarketCap / sliderMaximum * 100}%` }}><i /><b>Current</b></span>
              <input aria-label="Lower market cap" type="range" min="0" max={sliderMaximum} step={Math.max(1, Math.round(currentMarketCap / 200))} value={lowerHandle} onChange={event => setRangeLower(String(Math.min(Number(event.target.value), upperHandle)))} />
              <input aria-label="Upper market cap" type="range" min="0" max={sliderMaximum} step={Math.max(1, Math.round(currentMarketCap / 200))} value={upperHandle} onChange={event => setRangeUpper(String(Math.max(Number(event.target.value), lowerHandle)))} />
            </div>
            <div className="liquidity-range-scale"><span>$0</span><span>Current MCap: {mcap(currentMarketCap)}</span><span>{mcap(sliderMaximum)}</span></div>
            <div className="liquidity-range-selected"><span>Lower <strong>{mcap(lowerHandle)}</strong></span><span>Upper <strong>{mcap(upperHandle)}</strong></span></div>
          </div> : null}
          <div className="liquidity-range-fields"><label htmlFor="liquidity-range-lower"><span>Lower MCap</span><div className="liquidity-money-input"><b>$</b><input id="liquidity-range-lower" value={rangeLower} maxLength={24} inputMode="text" onChange={event => setRangeLower(event.target.value.replace(/^\$/, ""))} placeholder="100k or 100,000" /></div></label><span>to</span><label htmlFor="liquidity-range-upper"><span>Upper MCap</span><div className="liquidity-money-input"><b>$</b><input id="liquidity-range-upper" value={rangeUpper} maxLength={24} inputMode="text" onChange={event => setRangeUpper(event.target.value.replace(/^\$/, ""))} placeholder="250k or 250,000" /></div></label><button disabled={busy || !rangeLower.trim() || !rangeUpper.trim()} type="submit">Apply Range</button></div>
        </form> : feeChoiceStep && !poolChoiceStep ? <form className="liquidity-custom-answer" onSubmit={replyToGuide}><label htmlFor="liquidity-custom-answer">Custom swap fee</label><div><input id="liquidity-custom-answer" value={reply} maxLength={32} inputMode="decimal" onChange={event => setReply(event.target.value)} placeholder="Enter a custom percentage" /><button disabled={busy || !reply.trim()} type="submit">Apply</button></div><small>{/V3/i.test(latestAssistant?.text || "") ? "V3 supports 0.01%, 0.05%, 0.3%, or 1%." : "V4 accepts a custom swap fee up to 10%."}</small></form> : null}
        <footer className="liquidity-step-controls"><button type="button" className="back" disabled={busy || !canGoBack || positionCreatedStep} aria-disabled={busy || !canGoBack || positionCreatedStep} onClick={() => choose("back")}>← Back</button><div>{positionCreatedStep ? <button type="button" className="confirm" disabled={busy} onClick={startNewPosition}>New position</button> : <button type="button" className="cancel" disabled={busy} onClick={() => choose("cancel")}>Cancel setup</button>}{quoteChoiceStep ? <button type="button" className="confirm" disabled={busy} onClick={() => choose("confirm")}>{busy ? <>Preparing<AnimatedDots /></> : "Confirm Position"}</button> : null}</div></footer>
      </article>
    </div> : <aside className="liquidity-build-preview" aria-hidden="true">
      <div className="liquidity-preview-card"><span>1</span><div><strong>Pool analysis</strong><p>Matching ETH and USDG pool options will appear here.</p></div></div>
      <div className="liquidity-preview-card"><span>2</span><div><strong>Position settings</strong><p>Choose a pool or customize the range, fee, shape, and bands.</p></div></div>
      <div className="liquidity-preview-card"><span>3</span><div><strong>Review and confirm</strong><p>Review the completed position quote before any funds move.</p></div></div>
    </aside>}
    </div> : <div className="liquidity-position-list">
      <div className="terminal-section-head"><div><h2>Liquidity Positions</h2></div><button className="button button-quiet" type="button" onClick={() => void refresh()} disabled={loading}>Refresh</button></div>
      <div className="liquidity-position-tabs"><button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")} type="button">Open ({positions.filter(position => position.status === "active").length})</button><button className={tab === "closed" ? "active" : ""} onClick={() => setTab("closed")} type="button">Closed ({positions.filter(position => position.status === "closed").length})</button></div>
      {error ? <p className="liquidity-position-error">{error}</p> : null}
      {loading ? <p className="terminal-empty">Loading your Delta Liquidity positions<AnimatedDots /></p> : null}
      {!loading && !visible.length ? <p className="terminal-empty">No {tab} liquidity positions.</p> : null}
      <div className="liquidity-position-cards">{visible.map(position => {
        const withdrawalResult = withdrawalResults[position.id];
        const range = position.live?.marketCapRangeUsd ?? (position.lowerMarketCapUsd && position.upperMarketCapUsd ? { lower: position.lowerMarketCapUsd, upper: position.upperMarketCapUsd } : null);
        const liveFees = position.live?.assets.filter(asset => asset.unclaimed !== null) ?? [];
        const valuedAssets = position.live?.assets.filter(asset => asset.usd !== null && Number.isFinite(asset.usd)) ?? [];
        const positionUsd = valuedAssets.length ? valuedAssets.reduce((total, asset) => total + asset.usd!, 0) : null;
        const valuedFees = liveFees.filter(asset => asset.unclaimedUsd !== null && Number.isFinite(asset.unclaimedUsd));
        const unclaimedFeesUsd = valuedFees.length ? valuedFees.reduce((total, asset) => total + asset.unclaimedUsd!, 0) : liveFees.length ? null : 0;
        return <article key={position.id} className="liquidity-position-card">
          <header><div className="liquidity-position-identity"><strong>{position.id}</strong><h3><span>${position.symbol}</span></h3><a href={`https://robinhoodchain.blockscout.com/token/${position.token}`} target="_blank" rel="noreferrer">{short(position.token)} ↗</a></div><div className="liquidity-position-totals"><div><span>Total position</span><strong>{money(positionUsd)}</strong></div><div><span>Unclaimed LP fees</span><strong>{money(unclaimedFeesUsd)}</strong></div></div><span className={position.live?.range.inRange === false ? "out" : position.status}>{position.status === "closed" ? "Closed" : position.live?.range.inRange === false ? "Out of range" : "Active"}</span></header>
          <dl>
            <div><dt>Position assets</dt><dd>{position.live?.assets.map(asset => `${amount(asset.amount)} ${asset.symbol} (${money(asset.usd)})`).join(" + ") || "Live value unavailable"}</dd></div>
            <div><dt>Unclaimed fee assets</dt><dd>{liveFees.length ? liveFees.map(asset => `${amount(asset.unclaimed!)} ${asset.symbol} (${money(asset.unclaimedUsd)})`).join(" + ") : position.status === "closed" ? "—" : "None currently"}</dd></div>
            <div><dt>Fees claimed so far</dt><dd>{position.feesClaimed.length ? position.feesClaimed.map(fee => `${amount(fee.amount)} ${fee.symbol}`).join(" + ") : "None"}</dd></div>
            <div><dt>MCap range</dt><dd>{range ? `${mcap(range.lower)} to ${mcap(range.upper)}` : "—"}</dd></div>
            <div><dt>Pool settings</dt><dd>V{position.version} · {position.pair || "—"} · {position.feePercent === undefined ? "—" : `${position.feePercent}% fee`} · {position.shape?.replace("_", "-") || "—"}{position.bands ? ` · ${position.bands} bands` : ""}</dd></div>
            <div><dt>Pool</dt><dd title={position.poolId}>{short(position.poolId)}</dd></div>
            <div><dt>{position.status === "closed" ? "Closed" : "Opened"}</dt><dd>{new Date(position.status === "closed" ? position.updatedAt : position.createdAt).toLocaleString()}</dd></div>
            <div><dt>NFTs</dt><dd>{position.nftIds.map(id => <a key={id} href={`https://robinhoodchain.blockscout.com/token/0x58daec3116aae6d93017baaea7749052e8a04fa7/instance/${id}`} target="_blank" rel="noreferrer">#{id} ↗</a>)}</dd></div>
          </dl>
          {withdrawalResult ? <footer className="liquidity-withdrawal-result"><p className="liquidity-claim-success"><LiquidityMessageText text={terminalLiquidityText(withdrawalResult)} /></p></footer> : position.status === "active" ? <footer>
            {position.live?.range.inRange === false ? <p className="liquidity-out-of-range-message">Out of range. This position is not currently earning LP fees.</p> : <span />}
            {position.lastClaim?.items.length ? <p className="liquidity-claim-success">You claimed {position.lastClaim.items.map(fee => `${amount(fee.amount)} ${fee.symbol}${fee.usd === undefined ? "" : ` (${money(fee.usd)})`}`).join(" + ")}.</p> : null}
            <div className="liquidity-position-actions"><button className="button button-quiet" type="button" disabled={busy || Boolean(acting)} onClick={() => void act(position, "claim")}>{acting === `claim:${position.id}` ? <>Collecting<AnimatedDots /></> : "Claim LP Fees"}</button><button className="button button-dark" type="button" disabled={busy || Boolean(acting)} onClick={() => void act(position, "withdraw")}>{acting === `withdraw:${position.id}` ? <>Withdrawing<AnimatedDots /></> : "Withdraw"}</button></div>
          </footer> : null}
        </article>;
      })}</div>
    </div>}
  </section>;
}
