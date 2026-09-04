export function isFeeAssignmentQuestion(text: string) {
  return /\bwho\b/i.test(text) && /\b(?:fees?|claim)\b/i.test(text);
}

// null means ambiguous; do not fall back to a parent's token in that case.
export function feeQuestionToken(text: string): string | null | undefined {
  const addresses = [...new Set((text.match(/0x[a-fA-F0-9]{40}\b/g) || []).map(a => a.toLowerCase()))];
  if (addresses.length) return addresses.length === 1 ? addresses[0] : null;
  const tickers = [...new Set([...text.matchAll(/\$([A-Za-z][A-Za-z0-9]{0,15})\b/g)].map(m => m[1].toUpperCase()))];
  if (tickers.length) return tickers.length === 1 ? tickers[0] : null;
  const named = text.match(/\b(?:fees?\s+(?:for|from|on)|claim\s+(?:fees?\s+)?(?:for|from|on))\s+([A-Za-z][A-Za-z0-9]{0,15})\b/i)?.[1];
  return named && !/^(?:this|that|the|my|a|coin|token)$/i.test(named) ? named.toUpperCase() : undefined;
}

export function feeAssignmentMessage(launch: { holderFeeSharing?: boolean; feeRecipientUsername?: string; creatorFeeRecipient?: string; creatorAddress?: string; launcherUsername?: string }) {
  const recipient = launch.holderFeeSharing ? "holders" : launch.feeRecipientUsername?.replace(/^@/, "")
    || (launch.creatorFeeRecipient && launch.creatorFeeRecipient.toLowerCase() !== launch.creatorAddress?.toLowerCase()
      ? launch.creatorFeeRecipient : launch.launcherUsername?.replace(/^@/, "") || launch.creatorFeeRecipient || launch.creatorAddress);
  return recipient ? `Fees are assigned to ${recipient}` : "I couldn’t verify who fees are assigned to for this token.";
}
