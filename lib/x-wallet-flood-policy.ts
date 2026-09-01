import { xReplyBudgetScale } from "./x-budget-scale";
export const X_WALLET_LOOKUP_WINDOW_MS = 5 * 60_000;
export const X_WALLET_LOOKUP_LIMIT = 10;
export const X_WALLET_LOOKUP_MIN_GAP_MS = 60_000;
export type LookupSlot = { postId: string; owner: string; at: number };
export const X_WALLET_REQUEST_WINDOW_MS = 10 * 60_000;

// Live admission is per user, never global or scaled. Rejected requests do not
// slide the window; retries of an admitted post do not spend another slot.
export function reserveWalletRequestSlot(slots: LookupSlot[], postId: string, owner: string, now: number) {
  const active = slots.filter(slot => slot.owner === owner && slot.at > now - X_WALLET_REQUEST_WINDOW_MS);
  if (active.some(slot => slot.postId === postId)) return { allowed: true, slots: active };
  if (active.length) return { allowed: false, slots: active };
  return { allowed: true, slots: [{ postId, owner, at: now }] };
}
export type ReadOnlyReplyCategory = "wallet" | "balance" | "information";
export type BudgetedReplyCategory = ReadOnlyReplyCategory | "insufficient_eth";
type Interaction = { text: string; parsedIntentJson?: string; commandKind?: string };

// Legacy operator publication tooling only, not live request admission.
export function walletLookupLimit() {
  const configured = Number(process.env.X_WALLET_LOOKUP_MAX_PER_5_MIN);
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 25) : X_WALLET_LOOKUP_LIMIT;
}

// Pre-AI screening only. Final parsed intent is checked again before provisioning
// or publishing, so unusual wording cannot bypass the limit.
export function isWalletLookupText(text: string) {
  const clean = text.replace(/@[a-z0-9_]+/gi, " ").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  if (/\b(?:buy|buyback|sell|transfer|burn|swap|launch|deploy|claim|upgrade|reassign|balance|holdings|portfolio)\b/i.test(clean)) return false;
  if (/\bsend\b/i.test(clean) && !/\bwhere\b.*\bsend\b/i.test(clean)) return false;
  return /\b(?:show|give|create|open|make|check|get|what(?:'s| is)?|where(?:'s| is)?|need|find)\b.*\b(?:wallet|address)\b/i.test(clean)
    || /\bwhere\b.*\bsend\b.*\b(?:funds|eth|tokens)\b/i.test(clean)
    || /^(?:my\s+)?(?:wallet(?:\s+address)?|address)[.!?]*$/i.test(clean);
}

export function isWalletLookupInteraction(item: { text: string; parsedIntentJson?: string; commandKind?: string }) {
  if (item.parsedIntentJson) {
    try {
      const parsed = JSON.parse(item.parsedIntentJson);
      return parsed.kind === "command" && ["show_wallet", "create_wallet"].includes(parsed.command?.kind);
    } catch { /* Treat damaged historical intent as text, never as an action. */ }
  }
  if (["show_wallet", "create_wallet"].includes(item.commandKind ?? "")) return true;
  return isWalletLookupText(item.text);
}

// Only obvious, whole-message questions are admitted before AI. A sentence
// containing a real transaction must reach intent parsing, not a read-only gate.
export function readOnlyReplyCategory(item: Interaction): ReadOnlyReplyCategory | undefined {
  if (item.parsedIntentJson) {
    try {
      const parsed = JSON.parse(item.parsedIntentJson);
      if (parsed?.kind === "help") return "information";
      if (parsed?.kind === "command") return commandCategory(parsed.command?.kind);
      return undefined;
    } catch { /* Fall back conservatively for damaged historical records. */ }
  }
  const category = commandCategory(item.commandKind);
  if (category) return category;
  if (TRANSACTIONS.has(item.commandKind ?? "") || /^(?:liquidity|houdini)/.test(item.commandKind ?? "")) return undefined;
  const clean = item.text.replace(/@[a-z0-9_]+/gi, " ").replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ").trim().replace(/^(?:hey|hi|hello|yo)[,!]?\s+/i, "")
    .replace(/\s+(?:please|pls)[.!?]*$/i, "").replace(/[.!?]+$/, "");
  if (/^(?:help|what can you do|how (?:does (?:this|pons bot) work|do i (?:buy|sell|burn|swap|send|launch|claim)(?: (?:tokens?|fees|a token))?)|(?:what|which) (?:assets|pairs|chains)(?: are (?:available|supported)| can i (?:use|pair with))?)$/i.test(clean)) return "information";
  if (/^(?:(?:show(?: me)?|give me|check|get|what(?:'s| is)|how much is)\s+)?(?:my\s+)?(?:(?:wallet|eth|\$?[a-z0-9_]+|0x[a-f0-9]{40})\s+)?(?:balance|balances|holdings|portfolio)(?:\s+(?:check|for\s+\$?[a-z0-9_]+))?$/i.test(clean)
    || /^(?:show(?: me)?|list) (?:everything|all(?: (?:the|my))? tokens) in my wallet$/i.test(clean)
    || /^what(?:'s| is) in (?:my|the) wallet$/i.test(clean)) return "balance";
  if (/^(?:(?:show(?: me)?|give me|create|open|make|get|what(?:'s| is)|where(?:'s| is)|need|find)\s+)?(?:my\s+)?(?:receiving\s+)?(?:wallet(?:\s+address)?|address)$/i.test(clean)
    || /^where (?:do|can|should) i send (?:funds|eth|tokens)(?: to)?$/i.test(clean)) return "wallet";
  return undefined;
}

function commandCategory(kind?: string): ReadOnlyReplyCategory | undefined {
  if (kind === "show_wallet" || kind === "create_wallet") return "wallet";
  if (kind === "show_balance") return "balance";
  if (kind === "help") return "information";
  return undefined;
}

// Legacy operator publication tooling only. Live requests use
// reserveWalletRequestSlot; live replies are paced by the durable queue.
export function reserveLookupSlot(slots: LookupSlot[], postId: string, owner: string, now: number, limit = X_WALLET_LOOKUP_LIMIT, publication = false, limitSameOwner = true) {
  limit = Math.max(1, Math.floor(limit * xReplyBudgetScale()));
  const minGap = X_WALLET_LOOKUP_MIN_GAP_MS / xReplyBudgetScale();
  const active = slots.filter(slot => slot.at > now - X_WALLET_LOOKUP_WINDOW_MS);
  if (active.some(slot => slot.postId === postId)) {
    if (!publication) return { allowed: true, slots: active };
    // A pacing-deferred or explicitly rejected publication may try again.
    // It must respect newer replies and anchor its next gap to this attempt,
    // rather than reusing an old timestamp that permits an immediate burst.
    if (active.some(slot => slot.postId !== postId && now - slot.at < minGap))
      return { allowed: false, slots: active };
    return { allowed: true, slots: active.map(slot => slot.postId === postId ? { ...slot, at: now } : slot) };
  }
  // Rolling gap, not fixed time buckets: quiet periods never bank burst capacity.
  // Rejected attempts don't consume a slot or extend the gap. Both admission and
  // publication use this atomic policy, so delayed workers cannot bunch replies.
  if (active.length >= limit || active.some(slot => (limitSameOwner && slot.owner === owner) || now - slot.at < minGap))
    return { allowed: false, slots: active };
  return { allowed: true, slots: [...active, { postId, owner, at: now }] };
}

const TRANSACTIONS = new Set(["launch", "buy", "sell", "send", "burn", "buy_and_send", "buy_and_burn", "buy_top_five", "swap_token_for_token", "claim_fees", "reassign_fees", "upgrade_fees"]);
export function compareXPriority(a: { id: string; verified: boolean; operation?: string; text: string }, b: { id: string; verified: boolean; operation?: string; text: string }) {
  const rank = (item: typeof a) => TRANSACTIONS.has(item.operation ?? "") ? 0 : isWalletLookupText(item.text) ? 2 : 1;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.verified !== b.verified) return a.verified ? -1 : 1;
  return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
}
