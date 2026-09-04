export const GUIDED_HELP_TTL_MS = 10 * 60_000;

export const GENERAL_GUIDED_HELP_MESSAGE =
  "✨ I can create your wallet, show balances, buy, sell, swap tokens, make cross-chain or private swaps, send, burn, claim fees, and create or manage Delta Liquidity positions here.\n\nReply telling me what you would like to do!";

export const X_GENERAL_GUIDED_HELP_MESSAGE =
  "✨ I can create your wallet, show balances, buy, sell, swap tokens, make cross-chain or private swaps, send, burn, launch on Pons, claim fees, reassign creator fees, and create or manage Delta Liquidity positions here.\n\nReply telling me what you would like to do!";

export const GUIDED_HELP_COMPLETION_PROMPT = "Anything else?";
export const GUIDED_REASSIGN_TOKEN_PROMPT =
  "💸 Which launch would you like to reassign? Reply with its ticker or contract address.";

export type GuidedHelpOperation =
  | "root"
  | "wallet"
  | "balance"
  | "buy"
  | "sell"
  | "swap"
  | "send"
  | "burn"
  | "launch"
  | "claim"
  | "claim_fees"
  | "claim_lp_offer"
  | "cross_chain"
  | "cross_chain_privacy"
  | "private_swap"
  | "reassign_fees";

const PREFIX = "guided_help";
const PENDING_PREFIX = "guided_help_pending";

export function guidedHelpCommandKind(operation: GuidedHelpOperation) {
  return operation === "root" ? PREFIX : `${PREFIX}:${operation}`;
}

export function guidedHelpPendingCommandKind(operation: string) {
  return `${PENDING_PREFIX}:${operation}`;
}

export function isGuidedHelpPendingCommandKind(kind?: string) {
  return Boolean(kind?.startsWith(`${PENDING_PREFIX}:`));
}

export function withGuidedHelpCompletion(message: string) {
  const trimmed = message.trim();
  return trimmed.endsWith(GUIDED_HELP_COMPLETION_PROMPT)
    ? trimmed
    : `${trimmed}\n\n${GUIDED_HELP_COMPLETION_PROMPT}`;
}

export function isGuidedHelpCompletion(message: string) {
  return message.trim().endsWith(GUIDED_HELP_COMPLETION_PROMPT);
}

export function guidedHelpOperationFromCommandKind(kind?: string): GuidedHelpOperation | null {
  if (kind === PREFIX) return "root";
  if (!kind?.startsWith(`${PREFIX}:`)) return null;
  const operation = kind.slice(PREFIX.length + 1);
  return ["wallet", "balance", "buy", "sell", "swap", "send", "burn", "launch", "claim", "claim_fees", "claim_lp_offer", "cross_chain", "cross_chain_privacy", "private_swap", "reassign_fees"].includes(operation)
    ? operation as GuidedHelpOperation
    : null;
}

export function guidedHelpPrompt(operation: Exclude<GuidedHelpOperation, "root">) {
  const prompts: Record<Exclude<GuidedHelpOperation, "root">, string> = {
    wallet: "👛 I’ll return your Pons Bot wallet, creating it first if you don’t have one yet.",
    balance: "💰 What balance would you like to check? Reply with an asset, such as “ETH” or “PONSBOT.”",
    buy: "🟢 What would you like to buy? Reply with an amount and ticker or contract address, such as “$5 of PONSBOT.”",
    sell: "🔴 What would you like to sell? Reply with an amount and ticker or contract address, such as “100 PONSBOT” or “all PONSBOT.”",
    swap: "🔄 What would you like to swap? Reply with an amount, source asset, and destination asset, such as “$25 of ETH for USDG.”",
    send: "📤 What would you like to send? Reply with an amount, asset, and destination, such as “10 PONSBOT to @user.”",
    burn: "🔥 What would you like to burn? Reply with an amount and ticker or contract address, such as “100 PONSBOT.”",
    launch: "🚀 What is the token name?",
    claim: "💰 Would you like to claim creator fees or Delta Liquidity LP fees? Reply “creator fees” or “LP fees.”",
    claim_fees: "💸 Which creator fees should I claim? Reply “all” or provide a ticker or contract address for one launch.",
    claim_lp_offer: "Did you mean claim LP fees?",
    cross_chain: "🌐 Tell me the amount, destination wallet address, asset, and destination chain. Example: “Send $25 to WALLET ADDRESS as ETH on Base.”",
    cross_chain_privacy: "🔒 Would you like to make this a private swap? Reply “yes” or “no.”",
    private_swap: "🔒 Tell me the amount, destination wallet address, asset, and destination chain. Example: “Send $25 to WALLET ADDRESS as ETH on Base.”",
    reassign_fees: "💸 Reply with “Reassign fees to user,” “Reassign fees to ADDRESS,” or “Reassign fees to holders.”",
  };
  return prompts[operation];
}

export function guidedHelpExplanation(operation: Exclude<GuidedHelpOperation, "root">) {
  const explanations: Record<Exclude<GuidedHelpOperation, "root">, string> = {
    wallet: "👛 Your Pons Bot wallet is linked to your X account. If it does not exist yet, I create it automatically before showing it.",
    balance: "📊 A full balance check shows the ETH and indexed token holdings in your Pons Bot wallet. Naming one ticker or contract checks only that asset.",
    buy: "🟢 A buy spends the amount you provide on the token you identify. You can use USD, ETH, or the token’s supported paired asset.",
    sell: "🔴 A sell exchanges the amount of the token you identify. You can provide a token amount, ETH or USD value, percentage, half, or all.",
    swap: "🔄 A token swap exchanges a stated value of one asset for another, routing through ETH when a direct route is unavailable.",
    send: "📤 A send transfers an asset from your Pons Bot wallet to a wallet address or X user with a Pons Bot wallet.",
    burn: "🔥 Burning permanently sends the specified tokens to the burn address. It cannot be reversed.",
    launch: "🚀 A guided launch collects the token name and ticker first, followed by optional artwork, metadata, pairing, developer-buy, and creator-fee choices.",
    claim: "💰 Creator fees come from token launches. LP fees come from your Delta Liquidity positions.",
    claim_fees: "💸 Creator-fee claims can cover all eligible launches or one launch identified by ticker or contract address.",
    claim_lp_offer: "💧 LP fees are trading fees earned by your Delta Liquidity positions.",
    cross_chain: "🌐 A cross-chain swap sends Robinhood Chain ETH from your Pons Bot wallet and delivers the selected asset on another supported chain.",
    cross_chain_privacy: "🔒 Private routing uses Houdini Swap’s private option for the cross-chain transfer.",
    private_swap: "🔒 A private swap sends Robinhood Chain ETH from your Pons Bot wallet through Houdini Swap’s private route to the destination you provide.",
    reassign_fees: "💸 Reassigning creator fees transfers control of future fee rights for an eligible launch to another wallet, X user, or token holders. The current controller is the only wallet that can authorize it.",
  };
  return explanations[operation];
}

export function guidedHelpQuestion(text: string) {
  const clean = cleanChoice(text);
  return /^(?:what does (?:this|that|it) mean|what do (?:these|those) mean|can you explain|could you explain|please explain|explain (?:this|that|it)|tell me more|help me understand|why (?:is|are|does|do|would)|how (?:does|do|would|can) (?:this|that|it))\b/i.test(clean)
    || /^(?:how (?:do|can|would|should) i|what (?:can|should) i|can you (?:show|tell) me how|could you (?:show|tell) me how)\b/i.test(clean)
    || (/\?$/.test(text.trim()) && /\b(?:mean|explain|work|difference|option|choice|supported|available)\b/i.test(clean));
}

export function guidedHelpQuestionResponse(
  operation: Exclude<GuidedHelpOperation, "root">,
  answer?: string,
) {
  return `${answer?.trim() || guidedHelpExplanation(operation)}\n\n${guidedHelpPrompt(operation)}`;
}

function cleanChoice(text: string) {
  return text
    .replace(/^(?:@[A-Za-z0-9_]{1,15}[\s,:-]+)+/, "")
    .replace(/[\s.!?,;:]+$/, "")
    .replace(/^(?:please\s+)+/i, "")
    .replace(/\s+(?:please|thanks|thank you)$/i, "")
    .replace(/[\s.!?,;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Bare menu selections only. Complete commands continue to the normal parser. */
export function guidedHelpSelection(text: string): Exclude<GuidedHelpOperation, "root"> | null {
  const clean = cleanChoice(text);
  if (/^(?:wallet|my wallet|wallet address|show (?:me )?my wallet)$/i.test(clean)) return "wallet";
  if (/^(?:balance|balances|wallet balance|token balance|show (?:me )?my balance)$/i.test(clean)) return "balance";
  if (/^(?:buy|purchase|i (?:want|would like) to (?:buy|purchase))$/i.test(clean)) return "buy";
  if (/^(?:sell|i (?:want|would like) to sell)$/i.test(clean)) return "sell";
  if (/^(?:swap|i (?:want|would like) to swap)$/i.test(clean)) return "swap";
  if (/^(?:send|transfer|i (?:want|would like) to (?:send|transfer))$/i.test(clean)) return "send";
  if (/^(?:burn|i (?:want|would like) to burn)$/i.test(clean)) return "burn";
  if (/^(?:claim(?:\s+fees?)?|(?:i\s+(?:want|would\s+like)\s+to|help\s+me)\s+claim\s+fees?)$/i.test(clean)) return "claim";
  if (/^(?:(?:i\s+(?:want|would\s+like)\s+(?:to\s+)?)?(?:make\s+)?(?:a\s+)?cross[ -]?chain(?:\s+swap)?)$/i.test(clean)) return "cross_chain";
  if (/^(?:(?:i\s+(?:want|would\s+like)\s+(?:to\s+)?)?(?:make\s+)?(?:a\s+)?private(?:\s+swap)?)$/i.test(clean)) return "private_swap";
  if (/^(?:reassign|reassign\s+(?:my\s+|creator\s+)?fees?|fee\s+reassignment|transfer\s+(?:creator\s+)?fees?|(?:i\s+(?:want|would\s+like)\s+to|help\s+me)\s+reassign\s+(?:my\s+|creator\s+)?fees?)$/i.test(clean)) return "reassign_fees";
  return null;
}

export function guidedHelpImmediateCommand(operation: GuidedHelpOperation | null) {
  if (operation === "wallet") return "show my wallet";
  if (operation === "balance") return "show all my wallet holdings";
  return null;
}

export function guidedHelpOperationFromHelp(text: string, topic?: string): Exclude<GuidedHelpOperation, "root"> | null {
  const clean = cleanChoice(text);
  // A question inside a guided chain asks for an explanation. It does not
  // select or start an operation merely because the question names one.
  if (guidedHelpQuestion(clean)) return null;
  if (/\breassign\b[^.!?]{0,30}\bfees?\b/i.test(clean)) return "reassign_fees";
  if (/\bcross[ -]?chain\b/i.test(clean) || topic === "cross_chain") return "cross_chain";
  if (/\bprivate(?:ly)?(?:\s+swap)?\b/i.test(clean)) return "private_swap";
  if (/\b(?:buy|purchase)\b/i.test(clean)) return "buy";
  if (/\bsell\b/i.test(clean)) return "sell";
  if (/\bswap\b/i.test(clean)) return "swap";
  if (/\b(?:send|transfer)\b/i.test(clean)) return "send";
  if (/\bburn\b/i.test(clean)) return "burn";
  if (/\b(?:claim|creator fees?)\b/i.test(clean)) return "claim_fees";
  if (/\b(?:balance|holdings?|portfolio)\b/i.test(clean) || topic === "balance") return "balance";
  if (/\b(?:wallet|address)\b/i.test(clean) || topic === "wallet" || topic === "fund") return "wallet";
  if (topic === "send") return "send";
  if (topic === "burn") return "burn";
  if (topic === "fees") return "claim_fees";
  return null;
}

export function guidedHelpCancelled(text: string) {
  return /^(?:cancel|stop|never mind|nevermind|cancel this|stop this)$/i.test(cleanChoice(text));
}

export function guidedHelpClaimSelection(text: string) {
  const clean = cleanChoice(text);
  if (/^(?:creator|creator fees?|token creator fees?|claim (?:my )?creator fees?)$/i.test(clean)) return "creator" as const;
  if (/^(?:LP|LP fees?|liquidity fees?|liquidity position fees?|claim (?:my )?(?:LP|liquidity) fees?)$/i.test(clean)) return "lp" as const;
  return null;
}

export const CLAIM_LP_FEE_OFFER = "Did you mean claim LP fees?";

export function withClaimLpFeeOffer(message: string) {
  return message.includes(CLAIM_LP_FEE_OFFER)
    ? message
    : `${message.trim()}\n\n${CLAIM_LP_FEE_OFFER}`;
}

export function guidedHelpClaimLpOfferSelection(text: string) {
  const clean = cleanChoice(text);
  if (/^(?:yes|yeah|yep|sure|please do|go ahead|claim(?:\s+my)?\s+LP fees?|LP fees?|liquidity fees?)$/i.test(clean)) return "lp" as const;
  if (/^(?:no|no thanks|cancel|stop|never mind|nevermind|not now)$/i.test(clean)) return "cancel" as const;
  return null;
}

export function guidedHelpPrivacySelection(text: string) {
  const clean = cleanChoice(text);
  if (/^(?:yes|yeah|yep|sure|please do|go ahead|private|make it private|privately)$/i.test(clean)) return "private" as const;
  if (/^(?:no|no thanks|public|cross[ -]?chain|not private|keep it public)$/i.test(clean)) return "public" as const;
  return null;
}

export type GuidedReassignState = { version: 1; type: "reassign_fees"; token?: string };

export function decodeGuidedReassignState(value?: string): GuidedReassignState | null {
  if (!value || value.length > 1_000) return null;
  try {
    const parsed = JSON.parse(value) as GuidedReassignState;
    return parsed.version === 1 && parsed.type === "reassign_fees"
      && (parsed.token === undefined || /^(?:0x[a-fA-F0-9]{40}|[A-Za-z][A-Za-z0-9]{0,31})$/.test(parsed.token))
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function guidedReassignTokenSelection(text: string) {
  const clean = cleanChoice(text).replace(/^\$/, "");
  return /^(?:0x[a-fA-F0-9]{40}|[A-Za-z][A-Za-z0-9]{0,31})$/.test(clean) ? clean : null;
}

export function guidedReassignRecipientSelection(text: string) {
  const clean = cleanChoice(text).replace(/^reassign\s+fees\s+to\s+/i, "").trim();
  if (/^holders$/i.test(clean)) return "holders";
  if (/^0x[a-fA-F0-9]{40}$/.test(clean)) return clean;
  const handle = clean.match(/^@?([A-Za-z0-9_]{1,15})$/)?.[1];
  return handle ? `@${handle}` : null;
}

function alreadyNamesOperation(text: string) {
  return /^(?:please\s+)?(?:buy|buyback|purchase|sell|swap|send|transfer|give|pay|burn|claim|collect|show|create|what|check)\b/i.test(cleanChoice(text));
}

/** Adds only the operation selected by the same user in the immediately prior prompt. */
export function guidedHelpCommandText(text: string, operation: GuidedHelpOperation) {
  const clean = cleanChoice(text);
  if (!clean || operation === "root" || guidedHelpQuestion(text)) return clean;
  if (operation === "private_swap" && !guidedHelpQuestion(text)) {
    const command = alreadyNamesOperation(clean) ? clean : `send ${clean}`;
    return /\bprivat(?:e|ely)\b/i.test(command) ? command : `private ${command}`;
  }
  if (alreadyNamesOperation(clean)) return clean;
  if (operation === "claim_fees")
    return /^(?:all|everything)$/i.test(clean) ? "claim my fees" : `claim my fees for ${clean}`;
  if (operation === "cross_chain") return alreadyNamesOperation(clean) ? clean : `send ${clean}`;
  if (operation === "reassign_fees") return /^reassign\b/i.test(clean) ? clean : `reassign ${clean}`;
  if (operation === "balance")
    return /^(?:all|everything|all balances?|my balance|balance|balances|holdings|portfolio)$/i.test(clean)
      ? "show all my wallet holdings"
      : `what is my ${clean} balance`;
  if (operation === "wallet") return clean;
  return `${operation} ${clean}`;
}

export function guidedHelpOperationFromPrompt(text: string): GuidedHelpOperation | null {
  if (text === GENERAL_GUIDED_HELP_MESSAGE || text === X_GENERAL_GUIDED_HELP_MESSAGE) return "root";
  if (text === GUIDED_REASSIGN_TOKEN_PROMPT || text.trim().endsWith(GUIDED_REASSIGN_TOKEN_PROMPT)) return "reassign_fees";
  if (text.trim().endsWith(CLAIM_LP_FEE_OFFER)) return "claim_lp_offer";
  for (const operation of ["wallet", "balance", "buy", "sell", "swap", "send", "burn", "launch", "claim", "claim_fees", "claim_lp_offer", "cross_chain", "cross_chain_privacy", "private_swap", "reassign_fees"] as const)
    if (text === guidedHelpPrompt(operation) || text.trim().endsWith(guidedHelpPrompt(operation))) return operation;
  return null;
}
