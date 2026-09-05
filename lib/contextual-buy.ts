export type ContextualBuy = { amount: string; unit: "usd" | "eth" };

/** The reply author supplies all trading authority; the parent supplies only an identifier. */
export function parseContextualBuy(text: string): ContextualBuy | undefined {
  const clean = text.trim().replace(/^(?:@[a-zA-Z0-9_]+\s+)+/, "").replace(/\s+@ponsbotfamily\b/gi, "").trim();
  // Parent-post token inference is intentionally opt-in. A normal buy made as
  // a reply must remain self-contained, so only the literal word "this" can
  // authorize resolving a token from the parent post.
  const match = clean.match(/^(?:please\s+)?buy(?:\s*back)?\s+(?:\$([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*ETH)\s+(?:(?:worth\s+)?(?:of\s+)?)?this(?:\s+(?:token|coin))?(?:\s+please)?[.!?]*$/i);
  if (!match) return undefined;
  const amount = (match[1] || match[2]).replace(/,/g, "");
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return undefined;
  return { amount, unit: match[1] ? "usd" : "eth" };
}

export async function resolveContextualBuyToken(text: string, resolve: (identifier: string) => Promise<string>) {
  const addresses = [...new Set((text.match(/\b0x[a-fA-F0-9]{40}\b/g) || []).map(a => a.toLowerCase()))];
  if (addresses.length > 1) throw new Error("CONTEXT_BUY_AMBIGUOUS");
  if (addresses.length === 1) return addresses[0];
  // Do not extract handles, URLs, or quoted instructions as trading authority.
  const plain = text.replace(/https?:\/\/\S+|@[a-zA-Z0-9_]+/gi, " ");
  const tags = [...plain.matchAll(/\$([a-zA-Z][a-zA-Z0-9]{0,15})\b/g)].map(m => m[1]);
  const candidates = [...new Set(tags.map(w => w.toUpperCase()))];
  if (candidates.length > 24) throw new Error("CONTEXT_BUY_AMBIGUOUS");
  const matches = new Set<string>();
  for (const candidate of candidates) {
    let address: string;
    try { address = await resolve(candidate); }
    catch (error) {
      if (String(error).includes("more than one token")) throw new Error("CONTEXT_BUY_AMBIGUOUS");
      throw error;
    }
    if (/^0x[a-fA-F0-9]{40}$/.test(address)) matches.add(address.toLowerCase());
  }
  if (matches.size !== 1) throw new Error(matches.size ? "CONTEXT_BUY_AMBIGUOUS" : "CONTEXT_BUY_NOT_FOUND");
  return [...matches][0];
}
