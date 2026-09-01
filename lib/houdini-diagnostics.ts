const knownFields = new Set(["amount", "amountFrom", "fromAmount", "tokenIn", "tokenOut", "fromToken", "toToken", "fromChain", "toChain", "chainId", "address", "recipient", "destinationAddress", "quoteId", "slippage", "isPrivate"]);

/** Private diagnostic vocabulary only. Never persist arbitrary provider text,
 * request URLs, payment headers, destinations or echoed request values. */
export function houdiniFailureDiagnostic(status: number, payload?: unknown): string {
  const hints: string[] = [], fields = new Set<string>();
  function inspect(value: unknown, depth = 0) {
    if (depth > 5 || hints.length >= 32) return;
    if (typeof value === "string") { hints.push(value.slice(0, 1_000)); return; }
    if (Array.isArray(value)) { value.slice(0, 16).forEach(v => inspect(v, depth + 1)); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value).slice(0, 32)) {
      if (knownFields.has(key)) fields.add(key);
      if (["field", "path", "loc"].includes(key)) {
        for (const part of Array.isArray(item) ? item : [item]) if (typeof part === "string" && knownFields.has(part)) fields.add(part);
      }
      if (["message", "msg", "error", "errors", "detail", "code", "reason", "type", "description"].includes(key)) inspect(item, depth + 1);
    }
  }
  inspect(payload);
  const text = hints.join(" ");
  const category = /minimum|min[_ -]?amount|below.*min|too small/i.test(text) ? "amount_below_minimum"
    : /maximum|max[_ -]?amount|above.*max|too large/i.test(text) ? "amount_above_maximum"
    : /expir|stale.*quote/i.test(text) ? "quote_expired"
    : /(?:invalid|unsupported|unknown).*(?:chain|network|asset|token)|(?:chain|network|asset|token).*(?:invalid|unsupported|unknown)/i.test(text) ? "unsupported_asset_or_chain"
    : /(?:no|unavailable|unsupported|not found|not available).*(?:route|liquidity)|(?:route|liquidity).*(?:unavailable|not found|not available)/i.test(text) ? "route_unavailable"
    : /address|recipient|destination/i.test(text) ? "destination_validation"
    : /quota|rate.?limit|too many/i.test(text) ? "provider_rate_limit"
    : /valid|missing|required|field|input|parameter/i.test(text) ? "request_validation"
    : "provider_rejection";
  return `HTTP ${status}; ${category}${fields.size ? `; fields=${[...fields].sort().join(",")}` : ""}`.slice(0, 300);
}

/** Clone and bound the diagnostic read; leave the original response untouched. */
export async function houdiniResponseDiagnostic(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader();
  if (!reader) return houdiniFailureDiagnostic(response.status);
  let size = 0, text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16_384) return houdiniFailureDiagnostic(response.status);
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    try { return houdiniFailureDiagnostic(response.status, JSON.parse(text)); }
    catch { return houdiniFailureDiagnostic(response.status, text); }
  } catch { return houdiniFailureDiagnostic(response.status); }
  finally { void reader.cancel().catch(() => undefined); }
}
