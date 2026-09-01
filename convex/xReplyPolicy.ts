/**
 * A direct X reply containing this instruction is intentionally inert.
 * Parent posts and the rest of the conversation must never be supplied here.
 */
export function shouldSuppressXResponse(directReplyText: string) {
  return /\bdo\s+not\s+reply\b/i.test(directReplyText);
}

/** Questions about mechanics are informational, never transaction authority. */
export function isWalletFeatureQuestion(directReplyText: string) {
  const text = directReplyText.replace(/@[a-zA-Z0-9_]{1,15}/g, " ").replace(/\s+/g, " ").trim();
  // Requests for the caller's actual wallet/address are deterministic commands,
  // not questions asking for a definition of a wallet.
  if (/\bwallet\b/i.test(text)
    && /\b(?:my|mine|show|give|where|find|get|provide|view|see|address)\b/i.test(text)) return false;
  if (!/\b(?:wallet|launch|token|coin|dev\s*buy|buy|sell|swap|slippage|burn|transfer|send|claim\s+fees?)\b/i.test(text)) return false;
  return /\b(?:how\s+(?:does|do|would|can)|how\s+to|what\s+(?:is|are|does)|explain|tell\s+me\s+about|which\s+(?:features|commands)|what\s+(?:features|commands))\b/i.test(text);
}
