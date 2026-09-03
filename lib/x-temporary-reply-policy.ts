function replyOpening(text: string) {
  return text.replace(/[’‘]/g, "'").replace(/^[^a-zA-Z]+/, "").replace(/\s+/g, " ").trim();
}

// Classify the generated response, never the user's request or a token name.
export function isInsufficientEthReply(text: string) {
  return /^(?:There isn't enough ETH\b|You (?:don't|do not) have enough ETH\b|You'll need to fund your wallet with (?:~?[\d.]+\s+)?ETH for gas\b|This wallet needs a little more ETH\b|Not enough ETH\b|Insufficient ETH\b)/i.test(replyOpening(text));
}

/** Publication-only switch. Never alter wallet validation or terminal responses. */
export function temporaryXReplySuppressionReason(
  text: string,
  enabled = process.env.X_SUPPRESS_ROUTINE_FAILURE_REPLIES?.trim().toLowerCase() === "true",
): string | undefined {
  if (!enabled) return undefined;
  // Match prepared response openings, not quoted user input or launch names.
  const opening = replyOpening(text);
  // Insufficient-ETH notices now have their own one-per-minute publication
  // budget. Historical suppressed records remain sealed by their stored reason.
  // Unverified launch attempts need a clear explanation. Continue suppressing
  // only the temporary "X-only" availability notice.
  if (/^(?:Token )?launches are (?:currently )?(?:(?:only )?available (?:through|on) X(?: posts)? only|only available (?:through|on) X(?: posts)?)[.!\s]/i.test(opening))
    return "launch_x_restriction";
  if (/^I couldn't quite make that out\b/i.test(opening)) return "ai_ambiguity";
  if (/^This request did not complete\b/i.test(opening)) return "request_not_completed";
  return undefined;
}
