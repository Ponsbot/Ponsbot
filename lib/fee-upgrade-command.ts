/** Only the explicit Upgrade IDENTIFIER phrase grants upgrade authority. */
export function parseFeeUpgradePhrase(raw: string):
  | { kind: "upgrade_fees"; token: string }
  | { kind: "unknown"; reason: string }
  | null {
  const text = raw
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/@[a-zA-Z0-9_]{1,15}\b/g, " ")
    .replace(/["“][^"”]*["”]/g, " ")
    // Do not treat apostrophes in don't/I'm as quotation boundaries.
    .replace(/(?:^|[\s(:])['‘][^'’]*['’](?=$|[\s.,!?;:)])/g, " ");
  if (!/\bupgrade\b/i.test(text)) return null;
  if (/\b(?:do\s+not|don['’]?t|never|not\s+(?:trying|asking|ready)\s+to)\s+(?:please\s+)?upgrade\b/i.test(text)
    || /\b(?:how\s+(?:do|can|would|should|to)|what\s+(?:if|does|happens)|can\s+i|should\s+i|explain|for\s+example)\b[^.!?\n]*\bupgrade\b/i.test(text)
    || /\bexample\s*:[^.!?\n]*\bupgrade\b/i.test(text)
    || /\b(?:if|when|unless)\s+(?:i|we|you)\s+upgrade\b/i.test(text)
    || /\b(?:i|we|they|he|she)\s+(?:will|might|may|can|usually|often)\s+upgrade\b/i.test(text)) return null;
  const mentions = [...text.matchAll(/\bupgrade\b(?:\s+([^\s,;!?()[\]{}"“”]+))?/gi)];
  const invalid = { kind: "unknown" as const, reason: "⚠️ Reply with one upgrade request: Upgrade $TICKER or Upgrade CONTRACT ADDRESS." };
  if (mentions.length !== 1) return invalid;
  const before = text.slice(0, mentions[0].index);
  // UPGRADE can itself be a literal token ticker or launch field.
  if (/\b(?:ticker|symbol|named|called|name\s*:?|of|for)\s+\$?$/i.test(before)
    || /\b(?:buy|sell|send|burn)\s+(?:all\s+(?:my\s+)?|\d+(?:\.\d+)?\s+)\$?$/i.test(before)) return null;
  const supplied = (mentions[0][1] || "").replace(/[.:]+$/, "");
  const identifier = supplied.replace(/^\$/, "");
  const address = /^0x[a-fA-F0-9]{40}$/i.test(identifier);
  if (!address && !/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(identifier)) return invalid;
  if (!supplied.startsWith("$") && /^(?:a|an|the|and|with|to|for|my|this|that|it|all|fees?|tokens?|contract|wallet|please|now)$/i.test(identifier)) return invalid;
  // Extra conversation is fine; explicit additional actions or token choices
  // are not an authorization to pick one arbitrarily.
  const remainder = text.slice(0, mentions[0].index) + text.slice(mentions[0].index! + mentions[0][0].length);
  if (/\b(?:buy|sell|send|burn|swap|transfer)\s+(?:\$?\d|all\b|half\b)|\b(?:claim|collect|reassign|assign)\s+(?:my\s+)?(?:fees|\$)|\b(?:launch|deploy)\s+(?:\$|[a-zA-Z])/i.test(remainder)
    || /^\s*(?:and|or|,)\s*(?:0x[a-fA-F0-9]{40}|\$[a-zA-Z][a-zA-Z0-9]{0,31})(?=\s|$|[.,!?])/i.test(text.slice(mentions[0].index! + mentions[0][0].length))) return invalid;
  return { kind: "upgrade_fees", token: address ? identifier.toLowerCase() : identifier.toUpperCase() };
}

export const FEE_UPGRADE_RESPONSES = {
  failed: "❌ I couldn't complete that upgrade. Reply with the Upgrade request again shortly.",
  unauthorized: "🔒 Your Pons Bot wallet doesn't control the creator-fee rights for that token, so it can't upgrade it.",
  already: "That token is already a Pons Bot V2 token",
  notFound: "🔎 I couldn't find that Pons Bot launch. Reply with the Upgrade request using the correct ticker or contract address.",
  ambiguous: "⚠️ More than one Pons Bot launch uses that ticker. Reply with the full Upgrade request using the contract address.",
  holders: "ℹ️ That token shares creator fees with holders, so it isn't eligible for this upgrade.",
  inProgress: "⏳ An upgrade is already being processed for that token. Please wait for the result.",
  review: "There's an issue with this token's upgrade - please DM @Ponsbotfamily for help",
  unavailable: "🛠️ Token upgrades aren't available right now. Reply with the Upgrade request again later.",
} as const;

function feeUpgradeTokenLabel(symbol: string | undefined) {
  const ticker = symbol?.replace(/^\$/, "");
  return ticker && /^[a-zA-Z0-9]{1,32}$/.test(ticker) ? `$${ticker}` : "That token";
}

export function feeUpgradeAlreadyMessage(symbol?: string) {
  return FEE_UPGRADE_RESPONSES.already.replace("That token", () => feeUpgradeTokenLabel(symbol));
}

export function feeUpgradeSuccessMessage(symbol: string | undefined, tokenPageUrl: string) {
  return `${feeUpgradeTokenLabel(symbol)} has been upgraded to Pons Bot V2 - 95% of creator fees go to the creator, while 5% buys back and burns $PONSBOT\n${tokenPageUrl}`;
}

export function existingFeeUpgradeState(program: {
  status: string; enrollmentSource: string; enrollmentRequestId?: string; enrollmentTransactionHash?: string;
  enrollmentDiagnosticCode?: string; deploymentConfirmedAt?: number; deploymentTransactionHash?: string;
} | null, requestId: string): "new" | "restart" | "resume" | "confirmed_retry" | "already" | "in_progress" | "review" {
  if (!program) return "new";
  if (program.status === "enrolled") return program.enrollmentSource === "upgrade"
    && program.enrollmentRequestId === requestId && !!program.enrollmentTransactionHash ? "confirmed_retry" : "already";
  if (program.status === "paused") return "already";
  if (program.status === "manual_review" && program.enrollmentSource === "upgrade"
    && program.enrollmentDiagnosticCode === "UPGRADE_CANCELLED_BY_OPERATOR"
    && program.enrollmentRequestId && program.enrollmentRequestId !== requestId
    && !program.enrollmentTransactionHash && program.deploymentTransactionHash && program.deploymentConfirmedAt) return "restart";
  if (program.status === "exited" || program.status === "manual_review") return "review";
  return program.enrollmentSource === "upgrade" && program.enrollmentRequestId === requestId ? "resume" : "in_progress";
}
