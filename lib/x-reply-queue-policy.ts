export type ReplyPriority = "A" | "B" | "C";
export const REPLY_QUEUE_WINDOW_MS = 2 * 60_000;
export const REPLY_QUEUE_WINDOW_LIMIT = 3; // Cautious/high mode: floor(1.67 * 2).
export const REPLY_QUEUE_NORMAL_WINDOW_LIMIT = 6;
export const REPLY_QUEUE_C_GAP_MS = 3 * 60_000;
export const REPLY_QUEUE_NORMAL_C_GAP_MS = 60_000;
export const X_POST_WINDOW_15_MINUTES_MS = 15 * 60_000;
export const X_POST_WINDOW_15_MINUTES_LIMIT = 100;
export const X_POST_WINDOW_3_HOURS_MS = 3 * 60 * 60_000;
export const X_POST_WINDOW_3_HOURS_LIMIT = 300;

export function replyQueueExpiresAt(priority: ReplyPriority, readyAt: number) {
  return priority === "A" ? undefined : readyAt + (priority === "B" ? 10 : 7) * 60_000;
}

export function replyQueuePriority(text: string, kind?: string, ok?: boolean): ReplyPriority {
  if (["graduation", "houdini_final", "houdini_progress", "liquidity", "guided_execution"].includes(kind ?? "")) return "A";
  if (kind === "buy_top_five") return "A";
  if (kind === "guided_reply") return "B";
  if (kind === "guided_help" || kind?.startsWith("guided_help:")) return "B";
  const opening = text.replace(/[’‘]/g, "'").replace(/^[^a-zA-Z]+/, "").replace(/\s+/g, " ").trim();
  // Read-only outputs must not be promoted by transaction words in help text.
  if (["help", "show_wallet", "create_wallet", "show_balance", "rate_limited"].includes(kind ?? "")) return "C";
  if (/^(?:Your Pons Bot wallet|Here's your wallet balance|Here is your wallet balance|Ask\b|Tell me\b|Say\b|Verified X accounts can launch|Claim with\b|You can pair|Hi there|I couldn't quite make that out|This request did not complete)/i.test(opening)) return "C";
  if (/^(?:There isn't enough ETH|You (?:don't|do not) have enough ETH|You'll need to fund your wallet with ETH for gas|This wallet needs a little more ETH|Not enough ETH|Insufficient ETH|There aren't any .*fees|No .*fees|That launch already|That token.*already|You've reached|You've requested several|Your wallet is still processing|This request is already|One moment|Please wait|Token launches are currently available)/i.test(opening)
    || /already a Pons Bot V2 token|is a Pons Bot V2 token|automated creator-fee (?:claims|processing)|creator-fee claims.*automated|fees (?:are|have been) automated|uses? manual (?:creator-)?fee claims/i.test(opening)) return "C";
  // Some confirmations deliberately have no emoji (notably upgrades). Use the
  // trusted workflow result, not punctuation, after excluding routine notices.
  if (ok === true && ["launch", "buy", "sell", "send", "burn", "buy_and_send", "buy_and_burn", "buy_top_five", "swap_token_for_token", "claim_fees", "reassign_fees", "upgrade_fees"].includes(kind ?? "")) return "A";
  // All success/partial-completion messages and real execution failures are A.
  if (/^An upgrade is already being processed|^There's an issue with this token's upgrade/i.test(opening)) return "A";
  if (/^✅/.test(text.trim()) || /^Success\b|^The buy completed|^The .+ sale completed|^The holder distributor was created|^The .*purchase (?:succeeded|completed)|^The transaction couldn't|^The network couldn't|^Network fees moved|^The price moved|^I couldn't find enough liquidity|^I couldn't complete that wallet request|^I couldn't prepare that cross-chain route|^The wallet service/i.test(opening)) return "A";
  // Remaining specific rejections: unknown tokens, unsupported pairs, malformed
  // command fields, permissions, and token holdings. No model-generated priority.
  if (/^Sorry, there's only one \$PONS(?:BOT)?$/.test(opening)) return "B";
  if (/^(?:I couldn't (?:identify|find|safely read|prepare that image|verify)|That pairing asset|That spend asset|More than one|You launched more than one|Please use|Choose a different|This wallet isn't authorized|You don't have the rights|You don't have enough of this token|There aren't enough funds|That amount|Enter |The minimum|Houdini.*minimum)/i.test(opening)
    || /^⚠️|^🔒|^🔎|^📍|^🔗|^🖼️/.test(text.trim())) return "B";
  if (/^❌|^💧|^📉|^🌐/.test(text.trim())) return "A";
  return "C";
}

export type QueueAttempt = { at: number; priority?: ReplyPriority; kind?: string };
export function replyQueueWaitMs(attempts: QueueAttempt[], priority: ReplyPriority, now: number, header?: { remaining?: number; reset?: number; blockedUntil?: number }, kind?: string) {
  const sorted = [...attempts].sort((a, b) => a.at - b.at);
  const windowWait = (ms: number, max: number, records = sorted) => {
    const recent = records.filter(a => a.at > now - ms);
    return recent.length >= max ? recent[recent.length - max].at + ms - now : 0;
  };
  const threeHourAttempts = sorted.filter(a => a.at > now - X_POST_WINDOW_3_HOURS_MS);
  const threeHourUsage = threeHourAttempts.length / X_POST_WINDOW_3_HOURS_LIMIT;
  const normal = threeHourUsage < 0.65;
  const high = threeHourUsage >= 0.8;
  const critical = threeHourUsage >= 0.9;
  const dynamicShortLimit = normal ? REPLY_QUEUE_NORMAL_WINDOW_LIMIT : REPLY_QUEUE_WINDOW_LIMIT;
  const dynamicCGapMs = normal ? REPLY_QUEUE_NORMAL_C_GAP_MS : REPLY_QUEUE_C_GAP_MS;
  const waitUntilBelow = (limit: number) => {
    if (threeHourAttempts.length < limit) return 0;
    return threeHourAttempts[threeHourAttempts.length - limit].at + X_POST_WINDOW_3_HOURS_MS - now;
  };
  // At 80% of the rolling three-hour allowance, preserve capacity for A/B.
  // At 90%, preserve it for A only. Rows remain queued and resume as soon as
  // the oldest attempts age out of the applicable rolling threshold.
  const priorityPressureWait = critical && priority !== "A"
    ? waitUntilBelow(Math.ceil(X_POST_WINDOW_3_HOURS_LIMIT * 0.9))
    : high && priority === "C"
      ? waitUntilBelow(Math.ceil(X_POST_WINDOW_3_HOURS_LIMIT * 0.8))
      : 0;
  const lastC = sorted.filter(a => a.priority === "C").at(-1)?.at;
  // Only trusted workflow kind exempts LP replies, never priority or text.
  // Legacy attempts without a kind conservatively remain in the short window.
  // Liquidity is not paced from a projected posting velocity. It can use the
  // 100th 15-minute slot and the 300th 3-hour slot, then waits before an
  // attempt would exceed either defined X window. Observed header exhaustion
  // and actual provider cooldowns remain authoritative for every kind.
  const shortWindowExempt = kind === "liquidity" || kind === "guided_reply" || kind === "guided_execution" || kind === "thread_continuation";
  const shortWait = shortWindowExempt ? 0 : windowWait(
    REPLY_QUEUE_WINDOW_MS,
    dynamicShortLimit,
    sorted.filter(a => !["liquidity", "guided_reply", "guided_execution", "thread_continuation"].includes(a.kind ?? "")),
  );
  return Math.max(0, (header?.blockedUntil ?? now) - now, shortWait,
    windowWait(X_POST_WINDOW_15_MINUTES_MS, X_POST_WINDOW_15_MINUTES_LIMIT),
    windowWait(X_POST_WINDOW_3_HOURS_MS, X_POST_WINDOW_3_HOURS_LIMIT),
    priorityPressureWait,
    priority === "C" && lastC !== undefined ? lastC + dynamicCGapMs - now : 0,
    header?.remaining !== undefined && header.remaining <= 0 && header.reset ? header.reset * 1_000 - now : 0);
}
