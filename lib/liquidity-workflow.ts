import { z } from "zod";
import { keccak256, stringToHex } from "viem";
import { liquidityMarketCapInput } from "./liquidity-market-cap";
import { LIQUIDITY_MAX_BANDS } from "./liquidity-limits";

export { LIQUIDITY_CONVERSATION_MS } from "./liquidity-timing";
export const LIQUIDITY_TURN_LIMIT = 40;
// Both X intake and terminal sessions supply immutable numeric X IDs. Display
// names and model-extracted values never satisfy this boundary.
export function liquidityOwnerAllowed(id: string, _source: "x" | "terminal" = "x") {
  return /^[1-9]\d{0,31}$/.test(id);
}
export function liquidityWalletAllowed(id: string, wallet: string) {
  return liquidityOwnerAllowed(id) && /^0x[a-fA-F0-9]{40}$/.test(wallet);
}
export function liquidityWorkflowEnabled(id: string, source: "x" | "terminal" = "x") {
  return liquidityOwnerAllowed(id, source);
}
export const DELTA_LIQUIDITY = {
  chainId: 4663, manager: "0x5ca6214227d1195c4b7b4b96847b8966c688295d",
  v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  v3Npm: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
  v4Manager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  v4Npm: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  v4View: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
} as const;

export const liquidityAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/).transform(s => s.toLowerCase());
export const liquidityIdentifier = z.string().trim().min(1).max(64)
  .regex(/^(?:0x[a-fA-F0-9]{40}|\$?[A-Za-z][A-Za-z0-9_.-]{0,31})$/)
  .transform(s => /^0x/i.test(s) ? s.toLowerCase() : s.replace(/^\$/, "").toUpperCase());
export const liquidityOperation = z.enum(["open", "claim", "withdraw", "add", "compound", "status", "help"]);
export const liquidityPositionIdentifier = z.string().trim().regex(/^(?:LP-)?[A-F0-9]{8}$/i)
  .transform(s => `LP-${s.replace(/^LP-/i, "").toUpperCase()}`);
// Retain "add" for old records and an explicit unsupported-action response.
// It must not produce another mint disguised as an existing-position increase.
export type LiquidityOperation = z.infer<typeof liquidityOperation>;
export const liquidityFieldsSchema = z.object({
  token: liquidityIdentifier.optional(),
  amount: z.string().regex(/^(?:0|[1-9]\d{0,10})(?:\.\d{1,18})?$/).refine(s => Number(s) > 0 && Number(s) <= 1e9).optional(),
  unit: z.enum(["usd", "eth"]).optional(),
  position: liquidityPositionIdentifier.optional(),
  allPositions: z.boolean().optional(),
  withdrawPercent: z.number().finite().gt(0).max(100).optional(),
  pair: z.enum(["ETH", "USDG"]).optional(),
  version: z.union([z.literal(3), z.literal(4)]).optional(),
  feePips: z.number().int().min(1).max(100_000).optional(),
  tickSpacing: z.number().int().min(1).max(32767).optional(),
  downPercent: z.number().finite().min(0.1).max(95).optional(),
  upPercent: z.number().finite().min(0.1).max(1000).optional(),
  // Percentage fields above remain readable for existing drafts/positions.
  lowerMarketCapUsd: z.number().finite().positive().max(1e15).optional(),
  upperMarketCapUsd: z.number().finite().positive().max(1e15).optional(),
  shape: z.enum(["flat", "bell", "bid_ask"]).optional(),
  bands: z.number().int().min(1).max(LIQUIDITY_MAX_BANDS).optional(),
  slippageBps: z.number().int().min(1).max(1000).optional(),
  autoCompound: z.boolean().optional(),
}).strict();
export type LiquidityFields = z.infer<typeof liquidityFieldsSchema>;
export const LIQUIDITY_REASON_CODES = [
  "active_trading",
  "strong_recent_volume",
  "sustained_activity",
  "low_trader_cost",
  "higher_lp_fee",
  "established_pool",
  "thin_depth",
  "high_trader_fee",
  "very_high_trader_fee",
  "quiet_recently",
  "recent_slowdown",
  "short_term_spike",
  "limited_history",
  "new_market",
  // Retained so previously saved drafts remain readable. New analysis does
  // not select these generic observations.
  "fee_paying",
  "range_risk",
] as const;
export const liquidityCandidateSchema = z.object({
  id: z.string().regex(/^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  version: z.union([z.literal(3), z.literal(4)]), pair: z.enum(["ETH", "USDG"]),
  token0: liquidityAddress, token1: liquidityAddress,
  feePips: z.number().int().min(0).max(100_000), tickSpacing: z.number().int().positive().max(32767),
  netLpFeePercent: z.number().finite().min(0).max(10), traderFeePercent: z.number().finite().min(0).max(11),
  tokenPriceUsd: z.number().finite().positive().nullable(), activeLiquidity: z.string().regex(/^\d+$/),
  activeDepthUsd: z.number().finite().nonnegative().nullable().optional(),
  reserveUsd: z.number().finite().nonnegative().nullable().optional(),
  estimatedBudgetSharePercent: z.number().finite().min(0).max(100).nullable().optional(),
  shareBasis: z.enum(["requested", "reference"]).optional(),
  volumeSixHourUsd: z.number().finite().nonnegative().nullable().optional(),
  volumeDayUsd: z.number().finite().nonnegative().nullable().optional(),
  volumeTier: z.enum(["high", "low", "limited"]).optional(),
  volumeHourUsd: z.number().finite().nonnegative().nullable(), swapsHour: z.number().int().nonnegative().nullable(),
  observedAt: z.number(), marketObservedAt: z.number().nullable(), blockNumber: z.string(),
  reasons: z.array(z.enum(LIQUIDITY_REASON_CODES)).min(1).max(3),
}).strict();
export type LiquidityCandidate = z.infer<typeof liquidityCandidateSchema>;
const phases = ["token", "budget", "analysis", "pool", "pair", "version", "fee", "spacing", "range", "shape", "bands", "position", "percentage", "compound", "review", "blocked", "cancelled", "done"] as const;
export type LiquidityPhase = typeof phases[number];
export const liquidityDraftSchema = z.object({
  operation: liquidityOperation, fields: liquidityFieldsSchema,
  phase: z.enum(phases), custom: z.boolean().default(false),
  tokenAddress: liquidityAddress.optional(), symbol: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/).optional(),
  analyzed: z.boolean().default(false), candidates: z.array(liquidityCandidateSchema).max(6).default([]),
  selected: liquidityCandidateSchema.optional(),
  analysis: z.object({
    checkedAt: z.number(), stage: z.enum(["high", "low", "limited"]),
    summaries: z.number().int().nonnegative(), checkedPools: z.number().int().nonnegative(),
    descriptorLookups: z.number().int().nonnegative().optional(),
    verifiedPools: z.number().int().nonnegative(), diagnostics: z.array(z.string().max(80)).max(12),
    rankingMode: z.enum(["ai", "repaired", "fallback"]).optional(),
    rankingDiagnostics: z.array(z.string().max(80)).max(12).optional(),
  }).strict().optional(),
  // Missing on legacy drafts means an existing band count was explicitly chosen.
  bandsDefaulted: z.boolean().optional(),
  review: z.object({ hash: z.string().regex(/^0x[a-f0-9]{64}$/), expiresAt: z.number(), executionReady: z.boolean() }).strict().optional(),
  executionPlanJson: z.string().max(60000).optional(),
  quoteSummary: z.array(z.string().max(300)).max(20).default([]),
  // Display-only reference captured during live pool analysis so range errors
  // can tell the user what market cap their bounds need to surround.
  currentMarketCapUsd: z.number().finite().positive().max(1e15).optional(),
  // X presents every page before confirmation; no clipped financial terms.
  remainingPages: z.array(z.string().max(8000)).max(12).default([]),
  positionCursor: z.string().optional(),
  statusView: z.literal("nfts").optional(),
  positionChoices: z.array(z.object({ positionId: z.string().regex(/^LP-[A-F0-9]{8}$/), symbol: z.string(), pair: z.enum(["ETH", "USDG"]) }).strict()).max(20).default([]),
  morePositionChoices: z.boolean().default(false),
  // Position lookups during setup have their own pagination, never the quote's.
  positionInquiry: z.object({
    pages: z.array(z.string().max(8000)).max(12), cursor: z.string().optional(),
    position: z.string().regex(/^LP-[A-F0-9]{8}$/).optional(),
    token: z.string().min(1).max(80).optional(),
    view: z.literal("nfts").optional(),
  }).strict().optional(),
  explanationPages: z.array(z.string().max(260)).max(12).default([]),
  diagnosticCode: z.string().max(100).optional(),
  // A conservative, read-only check performed when the position budget first
  // becomes known. Exact asset ratios and gas are still checked by the signed
  // quote. A failed check keeps the setup resumable after the wallet is funded.
  fundingCheck: z.object({
    fingerprint: z.string().min(1).max(220), checkedAt: z.number(),
    sufficient: z.boolean(), missing: z.enum(["ETH", "USDG", "POSITION_ASSET", "FUNDING"]).optional(),
  }).strict().optional(),
  alternative: z.enum(["copy", "withdraw_all"]).optional(),
  copyFromPosition: z.string().regex(/^LP-[A-F0-9]{8}$/).optional(),
}).strict();
export type LiquidityDraft = z.infer<typeof liquidityDraftSchema>;

export function isOrdinaryWalletCommand(text: string) {
  const clean = text.replace(/https?:\/\/\S+|@[A-Za-z0-9_]+/g, " ").replace(/["“‘][^"”’]*["”’]/g, " ");
  const first = /\b(buy|buyback|purchase|sell|send|transfer|give|pay|burn|swap|launch|deploy|reassign|upgrade|create|open|add|close|withdraw|claim|collect|show|list|manage)\b/i.exec(clean);
  if (first && /^(buy|buyback|purchase|sell|send|transfer|give|pay|burn|swap|launch|deploy|reassign|upgrade)$/i.test(first[1]) && !/^\s*(?:how|why|what|does|will|is)\b/i.test(clean)) return true;
  if (/\b(?:create|make|mint)\s+(?:(?:a|the|me|new)\s+)*(?:token|coin)\b/i.test(clean)) return true;
  return /\b(?:create|show|give|check)\s+(?:me\s+)?(?:my\s+)?wallet\b|\b(?:my|wallet)\s+balance\b/i.test(clean)
    || /\bclaim\s+(?:my\s+)?(?:creator\s+)?fees\b/i.test(clean) && !/\b(?:liquidity|pool|position|LP|LP-[A-F0-9]{8})\b/i.test(clean)
      && !liquidityClaimSelection(clean)?.position;
}

/** Broad, read-only language that means "start helping me build an LP".
 *
 * This deliberately stays separate from the model extractor. Questions such
 * as "what Pons pools are there?" otherwise look informational to the model
 * and end after a help response. A match here starts the ordinary open flow;
 * it does not discover a pool, quote, approve, or move funds by itself.
 * Straightforward wallet/launch commands remain authoritative and never enter
 * through this path.
 */
export function liquidityOpenInquirySelection(text: string): LiquidityFields | null {
  if (isOrdinaryWalletCommand(text)) return null;
  const clean = text.replace(/https?:\/\/\S+|@[A-Za-z0-9_]+/gi, " ").replace(/[“”‘’"']/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || /\b(?:my|our)\s+(?:liquidity\s+)?pools?\b|\b(?:pools?|positions?)\s+(?:do\s+)?i\s+(?:have|own)\b/i.test(clean)) return null;
  if (/\b(?:withdraw|claim|collect|remove|close|compound|nfts?|status)\b/i.test(clean)) return null;
  // Conceptual questions should receive an explanation rather than silently
  // becoming a position setup.
  if (/^(?:please\s+)?what\s+(?:is|does)\s+(?:a\s+|the\s+)?(?:liquidity\s+)?pool\b|\b(?:want|would\s+like)\s+to\s+(?:know|understand)\b/i.test(clean)) return null;

  const discovery = /\b(?:what|which|show|find|list|recommend|suggest)\b[^.!?]{0,90}\b(?:liquidity\s+)?pools?\b/i.test(clean)
    || /\b(?:what|which|show|find|list|recommend|suggest)\b[^.!?]{0,90}\b(?:liquidity|LP)\s+(?:options?|opportunities|recommendations?)\b/i.test(clean)
    || /\b(?:best|available|recommended|existing)\s+(?:liquidity\s+)?pools?\b/i.test(clean)
    || /\b(?:are|is)\s+there\b[^.!?]{0,60}\b(?:liquidity\s+)?pools?\b/i.test(clean)
    || /\b(?:\$?[A-Za-z][A-Za-z0-9_.-]{0,31}|0x[a-fA-F0-9]{40})\s+(?:liquidity\s+)?(?:pools?|LP\s+options?|liquidity\s+options?)\b/i.test(clean)
    || /\bdoes\s+(?:\$?[A-Za-z][A-Za-z0-9_.-]{0,31}|0x[a-fA-F0-9]{40})\s+have\b[^.!?]{0,30}\b(?:liquidity\s+)?pools?\b/i.test(clean);
  const participation = /\b(?:want|would\s+like|interested|ready|trying|looking|help\s+me|can\s+i|how\s+(?:can|do)\s+i|where\s+can\s+i|let(?:'s|s))\b[^.!?]{0,90}\b(?:provide|create|open|set\s*up|make|add)\b[^.!?]{0,45}\b(?:liquidity|LP|pool|position)\b/i.test(clean)
    || /\b(?:want|would\s+like|interested|ready|trying|looking|help\s+me|get\s+me\s+started|can\s+i|how\s+(?:can|do)\s+i|where\s+can\s+i)\b[^.!?]{0,65}\b(?:liquidity|LP|pool|position)\b/i.test(clean)
    || /\b(?:want|would\s+like|can\s+i|how\s+(?:can|do)\s+i|where\s+can\s+i)\b[^.!?]{0,60}\b(?:earn|collect|get)\b[^.!?]{0,30}\bLP\s+fees?\b/i.test(clean);
  if (!discovery && !participation) return null;

  const candidates = [
    /\bLP\s+fees?\s+(?:for|from|on)\s+(\$?[A-Za-z][A-Za-z0-9_.-]{0,31}|0x[a-fA-F0-9]{40})\b/i,
    /\b(?:pools?|options?|opportunities|recommendations?|liquidity|LP)\s+(?:are\s+(?:there|available)\s+)?(?:for|with|on)\s+(?:token\s+)?(\$?[A-Za-z][A-Za-z0-9_.-]{0,31}|0x[a-fA-F0-9]{40})\b/i,
    /\b(?:provide\s+liquidity|position|pool)\s+(?:for\s+|on\s+)?(\$?[A-Za-z][A-Za-z0-9_.-]{0,31}|0x[a-fA-F0-9]{40})\b/i,
    /\bLP\s+(?:for|on)\s+(\$?[A-Za-z][A-Za-z0-9_.-]{0,31}|0x[a-fA-F0-9]{40})\b/i,
    /\bLP\s+(\$[A-Za-z][A-Za-z0-9_.-]{0,31}|0x[a-fA-F0-9]{40})\b/i,
    /\b(?:what|which|show|find|list|recommend|suggest)\s+(\$?[A-Za-z][A-Za-z0-9_.-]{0,31})\s+(?:liquidity\s+)?pools?\b/i,
    /\b(\$?[A-Za-z][A-Za-z0-9_.-]{0,31})\s+(?:liquidity\s+)?(?:pools?|LP\s+options?|liquidity\s+options?)\b/i,
    /\bdoes\s+(\$?[A-Za-z][A-Za-z0-9_.-]{0,31}|0x[a-fA-F0-9]{40})\s+have\b[^.!?]{0,30}\b(?:liquidity\s+)?pools?\b/i,
  ].map(pattern => pattern.exec(clean)?.[1]).filter((value): value is string => Boolean(value));
  const explicit = /(?:^|\s)(0x[a-fA-F0-9]{40}|\$[A-Za-z][A-Za-z0-9_.-]{0,31})(?=$|\s|[,.!?])/i.exec(clean)?.[1];
  const raw = explicit ?? candidates[0];
  if (!raw) return {};
  const blocked = new Set(["A", "AN", "ARE", "AVAILABLE", "BEST", "DO", "EXISTING", "FOR", "I", "IS", "LIQUIDITY", "MY", "NEW", "POOL", "POOLS", "RECOMMENDED", "THE", "THERE", "WHAT", "WHICH", "WITH"]);
  const parsed = liquidityIdentifier.safeParse(raw);
  return parsed.success && !blocked.has(parsed.data) ? { token: parsed.data } : {};
}
export function isLiquidityMessage(text: string) {
  if (isOrdinaryWalletCommand(text)) return false;
  const clean = text.replace(/https?:\/\/\S+|@[A-Za-z0-9_]+/gi, " ").trim();
  const bareManagementId = /^(?:please\s+)?(?:add|close|manage)\b/i.test(clean)
    && /(?<![A-Za-z0-9_$-])[A-F0-9]{8}(?![A-Za-z0-9_-])/i.test(clean);
  return bareManagementId || liquidityOpenInquirySelection(text) !== null || /\b(?:liquidity|pools?|positions?|LPs?)\b|\bL[PQ]-[A-F0-9]{8}\b|\bauto(?:matic)?[ -]?compound(?:ing)?\b/i.test(text) || liquidityWithdrawalSelection(text) !== null || liquidityStatusSelection(text) !== null || liquidityNftSelection(text) !== null || liquidityClaimSelection(text) !== null;
}
/** Explicit read-only NFT lookup. Never interpret an NFT request as a mint,
 * transfer, approval, or spending authorization, and never guess multiple IDs. */
export function liquidityNftSelection(text: string): LiquidityFields | null {
  if (isOrdinaryWalletCommand(text)) return null;
  const clean = text.replace(/@[A-Za-z0-9_]+/g, " ").replace(/\s+/g, " ").trim();
  const direct = /\b(?:show|list|view|check|get)\b[^.!?]{0,60}\bnfts?\b|^nfts?\b/i.test(clean);
  const question = /\b(?:what|which)\s+(?:(?:are|is)\s+)?(?:(?:the|my|underlying)\s+)?nfts?\b/i.test(clean)
    && /\bpositions?\b|\bLP-[A-F0-9]{8}\b/i.test(clean);
  if (!direct && !question) return null;
  const ids = [...clean.replace(/https?:\/\/\S+/gi, " ").matchAll(/(?<![A-Za-z0-9_$-])(?:LP-)?([A-F0-9]{8})(?![A-Za-z0-9_-])/gi)];
  const positions = [...new Set(ids.map(m => `LP-${m[1].toUpperCase()}`))];
  return positions.length === 1 ? { position: positions[0] } : {};
}

/** Read-only LP lookups never authorize claims, withdrawals, deposits,
 * approvals, swaps, or any other wallet mutation. */
export function isIndependentLiquidityRead(text: string) {
  if (liquidityNftSelection(text)) return true;
  const clean = text.replace(/@[A-Za-z0-9_]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(?:claim|collect|withdraw|remove|close|add|deposit|create|open|confirm|approve|swap|buy|sell|send|burn)\b/i.test(clean)) return false;
  return /^(?:please\s+)?(?:check|show|view|list|get)(?:\s+me)?\b[^.!?]{0,100}\b(?:positions?|LPs?|LP-[A-F0-9]{8})\b/i.test(clean)
    || /^(?:please\s+)?(?:what|which)\b[^.!?]{0,100}\b(?:positions?|LPs?)\b/i.test(clean);
}
export function liquidityStatusSelection(text: string): LiquidityFields | null {
  const clean = text.replace(/@[A-Za-z0-9_]+/g, " ").trim().replace(/[.!]+$/, "");
  const match = /^(?:check|show|view|status(?:\s+(?:of|for))?)(?:\s+(?:my\s+)?position)?\s+(?:LP-)?([a-f0-9]{8})$/i.exec(clean);
  if (match) return { position: `LP-${match[1].toUpperCase()}` };
  if (/^(?:please\s+)?(?:check|show|view|get)(?:\s+me)?\s+(?:all\s+)?my\s+(?:liquidity\s+)?positions?(?:\s+please)?$/i.test(clean)) return {};
  const token = /^(?:please\s+)?(?:check|show|view|get)(?:\s+me)?\s+(?:my\s+)?(?:\$?([A-Za-z][A-Za-z0-9_.-]{0,31})|(0x[a-f0-9]{40}))\s+(?:liquidity\s+)?positions?(?:\s+please)?$/i.exec(clean)
    ?? /^(?:please\s+)?(?:check|show|view|get)(?:\s+me)?\s+(?:my\s+)?(?:liquidity\s+)?positions?\s+(?:for|in|of)\s+(?:\$?([A-Za-z][A-Za-z0-9_.-]{0,31})|(0x[a-f0-9]{40}))(?:\s+please)?$/i.exec(clean);
  return token ? { token: token[1] || token[2] } : null;
}

/** X can render the canonical Ethereum PONS cashtag as a chain-qualified
 * asset identifier. Inside the Robinhood liquidity workflow it means the
 * indexed PONS ticker, never that Ethereum contract as a Robinhood pool. */
export function normalizeLiquidityTokenAliases(text: string) {
  return text.replace(/\bethereum:0x07f5b6823751c2e2cd4560f28af75ff887102241\b/gi, "$PONS");
}
/** A bare withdraw means the whole LP, never a withdrawal to an external wallet.
 * Explicit partial requests stay partial so they receive the unsupported reply. */
export function liquidityWithdrawalSelection(text: string): LiquidityFields | null {
  const clean = text.replace(/@[A-Za-z0-9_]+/g, " ").trim().replace(/[.!]+$/, "").replace(/\s+please$/i, "").trim();
  const match = /^(?:please\s+)?withdraw(?:\s+(all|half|quarter|\d+(?:\.\d+)?%)(?:\s+of)?)?(?:\s+my)?(?:\s+(?:(\$?[A-Za-z][A-Za-z0-9_.-]*|0x[a-f0-9]{40})\s+)?(?:liquidity|positions?))?(?:\s+((?:LP-)?[A-F0-9]{8}))?$/i.exec(clean);
  if (!match) return null;
  const percent = match[1] ? ({ all: 100, half: 50, quarter: 25 }[match[1].toLowerCase()] ?? Number(match[1].replace("%", ""))) : 100;
  const parsed = liquidityFieldsSchema.safeParse({ withdrawPercent: percent, ...(match[2] ? { token: match[2] } : {}), ...(match[3] ? { position: match[3].toUpperCase() } : {}) });
  return parsed.success ? parsed.data : null;
}
export function liquidityThreadRedirect(text: string) {
  return /\bcreate\s+(?:(?:a|new|liquidity)\s+)*(?:liquidity|pool|position)\b/i.test(text);
}
/** Explicit fee selectors only; bare "all" belongs to the LP claim question. */
export function liquidityClaimSelection(text: string, draft?: LiquidityDraft): LiquidityFields | null {
  const clean = text.replace(/@[A-Za-z0-9_]+/g, " ").trim().replace(/[.!]+$/, "").trim();
  const match = /^(?:please\s+)?(?:claim|collect|withdraw)\s+(all\s+)?(?:my\s+)?(?:LP|liquidity|pool|position)\s+(?:fees|rewards)(?:\s+(?:for|from|on)\s+(.+?))?(?:\s+please)?$/i.exec(clean);
  const positionClaim = /^(?:please\s+)?(?:claim|collect)\s+(?:all\s+)?(?:my\s+)?(?:fees|rewards)\s+(?:(?:for|from|on)\s+)?((?:LP-)?[A-F0-9]{8})(?:\s+please)?$/i.exec(clean);
  if (positionClaim) return { position: liquidityPositionIdentifier.parse(positionClaim[1]) };
  const bare = draft?.operation === "claim" && draft.phase === "position";
  if (!match && !bare) return null;
  const target = match ? match[2]?.trim() : clean;
  // "All fees for TOKEN/LP-ID" means every fee for that explicit target,
  // never every position. Only an unqualified "all" expands the scope.
  if (!target) return match?.[1] ? { allPositions: true } : {};
  if (/^all(?:\s+(?:my\s+)?positions)?$/i.test(target)) return { allPositions: true };
  const position = liquidityPositionIdentifier.safeParse(target);
  if (position.success) return { position: position.data };
  const parsed = liquidityIdentifier.safeParse(target);
  return parsed.success ? { token: parsed.data } : null;
}
/** Adds inherit settings, never an earlier spending authorization. */
export function inheritLiquidityPositionFields(saved: LiquidityFields, requested: LiquidityFields): LiquidityFields {
  const keys = ["token", "pair", "version", "feePips", "tickSpacing", "downPercent", "upPercent", "lowerMarketCapUsd", "upperMarketCapUsd", "shape", "bands"] as const;
  for (const key of keys) if (requested[key] !== undefined && saved[key] !== undefined && requested[key] !== saved[key]) throw new Error("LP_POSITION_SETTINGS_CONFLICT");
  const { amount: _amount, unit: _unit, withdrawPercent: _withdrawPercent, position: _position, allPositions: _all, ...settings } = saved;
  return liquidityFieldsSchema.parse({ ...settings, ...requested });
}
export function liquidityControl(text: string, phase?: LiquidityPhase): { kind: "confirm" | "cancel" | "back" | "continue" | "next" | "refresh" | "choose" | "custom"; id?: string; option?: number } | null {
  const clean = text.trim().replace(/^(?:@[A-Za-z0-9_]+\s+)+/, "").replace(/[.!]+$/, "").trim();
  const match = /^(confirm|approve|yes|cancel|no|back|go\s+back|previous(?:\s+step)?|continue|next|refresh|resume)(?:\s+(LQ-[A-F0-9]{8}))?$/i.exec(clean);
  if (match) return { kind: /confirm|approve|yes/i.test(match[1]) ? "confirm" : /cancel|no/i.test(match[1]) ? "cancel" : /back|previous/i.test(match[1]) ? "back" : /resume/i.test(match[1]) ? "refresh" : match[1].toLowerCase() as "continue" | "next" | "refresh", ...(match[2] ? { id: match[2].toUpperCase() } : {}) };
  // Pool replies are often conversational, but remain tightly anchored to a
  // single option number. This accepts "Pool 1" and similarly explicit short
  // choices without treating trade amounts or multi-parameter edits as pool
  // selections. Numbers retain this meaning only while the displayed step is
  // the pool-selection step.
  const poolChoice = clean.replace(/\s+(?:please|pls|thanks|thank\s+you)$/i, "").trim();
  const choice = [
    /^(?:pool|option|choice|number)\s*(?:number\s*)?#?\s*([1-6])$/i,
    /^(?:choose|pick|select|use|take|go\s+with)\s+(?:(?:pool|option|choice|number)\s*(?:number\s*)?)?#?\s*([1-6])$/i,
    /^(?:i\s+(?:want|choose|pick|select|prefer|will\s+take|would\s+like)|i[’']d\s+(?:like|choose|pick|select|prefer)|let[’']?s\s+(?:do|use|choose|pick|select|go\s+with))\s+(?:(?:pool|option|choice|number)\s*(?:number\s*)?)?#?\s*([1-6])$/i,
    /^(?:option\s*|choose\s*|use\s*)?([1-6])$/i,
  ].map(pattern => pattern.exec(poolChoice)).find(Boolean);
  if (choice && phase === "pool") return { kind: "choose", option: Number(choice[1]) };
  if (/^(?:custom|new)(?:\s+pool)?$/i.test(clean)) return { kind: "custom" };
  return null;
}

/** Move an opening setup back one meaningful choice and invalidate any quote
 * derived from the removed setting. */
export function backLiquidityDraft(draft: LiquidityDraft): LiquidityDraft {
  const d = structuredClone(draft);
  if (d.operation !== "open") return d;
  switch (d.phase) {
    case "budget": delete d.fields.token; break;
    case "analysis":
    case "pool": delete d.fields.amount; delete d.fields.unit; d.analyzed = false; d.analysis = undefined; d.candidates = []; break;
    case "pair": d.custom = false; d.selected = undefined; d.analyzed = true; break;
    case "version": delete d.fields.pair; break;
    case "fee": delete d.fields.version; delete d.fields.tickSpacing; break;
    case "spacing": delete d.fields.feePips; delete d.fields.tickSpacing; break;
    case "range":
      if (d.selected) {
        d.selected = undefined;
        for (const key of ["pair", "version", "feePips", "tickSpacing"] as const) delete d.fields[key];
      } else { delete d.fields.feePips; delete d.fields.tickSpacing; }
      break;
    case "shape":
      for (const key of ["lowerMarketCapUsd", "upperMarketCapUsd", "downPercent", "upPercent"] as const) delete d.fields[key];
      break;
    case "bands": delete d.fields.shape; delete d.fields.bands; d.bandsDefaulted = undefined; break;
    case "review": delete d.fields.bands; d.bandsDefaulted = undefined; break;
    default: return d;
  }
  d.review = undefined; d.executionPlanJson = undefined; d.quoteSummary = [];
  d.remainingPages = []; d.explanationPages = [];
  d.phase = liquidityNextPhase(d);
  return d;
}

/** Whether Back can actually rewind the persisted opening workflow. Keep this
 * in the shared workflow module so terminal controls cannot drift from the
 * state transition enforced by Convex. */
export function canBackLiquidityDraft(draft: LiquidityDraft): boolean {
  if (draft.operation !== "open") return false;
  return (["budget", "analysis", "pool", "pair", "version", "fee", "spacing", "range", "shape", "bands", "review"] as LiquidityPhase[]).includes(draft.phase);
}
/** A short answer inherits meaning only from the question currently displayed. */
export function liquidityStepFields(text: string, draft?: LiquidityDraft): LiquidityFields | null {
  if (!draft) return null;
  const clean = text.trim().replace(/^(?:@[A-Za-z0-9_]+\s+)+/, "").replace(/\s+(?:please|pls)[.!]*$/i, "").replace(/[.!]+$/, "").trim().toLowerCase();
  let patch: LiquidityFields | undefined;
  const bandNumber = (value: string) => Number(value) || ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"].indexOf(value) + 1;
  if (draft.phase === "position") {
    const choice = /^(?:option\s*|choose\s*)?(\d{1,2})$/.exec(clean);
    const selected = choice ? draft.positionChoices[Number(choice[1]) - 1] : undefined;
    if (selected) patch = { position: selected.positionId };
    else if (liquidityPositionIdentifier.safeParse(clean).success) patch = { position: liquidityPositionIdentifier.parse(clean) };
  }
  if (draft.operation === "open") patch = liquidityMarketCapInput(clean, draft.phase === "range") ?? undefined;
  // Explicit band selections work at any setup/review step. Anchor the whole
  // answer so questions, negations and multi-parameter edits still go to AI.
  const bandChoice = /^(?:(?:i\s+(?:want|would like)|use|make it|change(?: it)? to|set(?: it)? to)\s+)?(\d{1,2}|[a-z]+)\s+bands?$/.exec(clean)
    ?? /^(?:set|change)\s+(?:the\s+)?bands\s+to\s+(\d{1,2}|[a-z]+)$/.exec(clean);
  if (bandChoice && draft.operation === "open") patch = { bands: bandNumber(bandChoice[1]) };
  if (draft.phase === "version" && /^(?:v|uniswap\s+v?)?[34]$/.test(clean)) patch = { version: Number(clean.match(/[34]$/)![0]) as 3 | 4 };
  if (draft.phase === "bands") {
    const match = /^(?:use\s+)?(\d{1,2}|[a-z]+)(?:\s+bands?)?$/.exec(clean);
    if (match) patch = { bands: bandNumber(match[1]) };
  }
  if (draft.phase === "spacing" && /^\d+(?:\s+(?:tick\s+)?spacing)?$/.test(clean)) patch = { tickSpacing: Number(clean.match(/^\d+/)![0]) };
  if (draft.phase === "fee" && /^(?:\d+(?:\.\d+)?|\.\d+)\s*%?$/.test(clean)) patch = { feePips: Number((Number(clean.replace(/\s*%$/, "")) * 10000).toFixed(8)) };
  if (draft.phase === "percentage" && /^(?:\d+(?:\.\d+)?|\.\d+)\s*%?$/.test(clean)) patch = { withdrawPercent: Number(clean.replace(/\s*%$/, "")) };
  if (!patch) return null;
  const parsed = liquidityFieldsSchema.safeParse(patch);
  return parsed.success ? parsed.data : null;
}
export function liquidityNextPhase(d: LiquidityDraft): LiquidityPhase {
  const f = d.fields;
  if (d.operation === "help" || d.operation === "status") return "done";
  if (d.alternative) return "blocked";
  if (d.operation === "add") return "position";
  if (d.operation !== "open") {
    if (d.operation === "claim" && (f.token || f.allPositions)) return "review";
    if (!f.position) return "position";
    if (d.operation === "compound" && f.autoCompound === undefined) return "compound";
    return "review";
  }
  if (!f.token) return "token";
  if (!f.amount || !f.unit) return "budget";
  if (!d.analyzed) return "analysis";
  if (!d.custom && !d.selected) return "pool";
  if (!f.pair) return "pair";
  if (!f.version) return "version";
  if (!f.feePips) return "fee";
  if (!f.tickSpacing) return "spacing";
  if (f.lowerMarketCapUsd !== undefined || f.upperMarketCapUsd !== undefined) {
    if (f.lowerMarketCapUsd === undefined || f.upperMarketCapUsd === undefined) return "range";
  } else if (f.downPercent === undefined || f.upPercent === undefined) return "range";
  if (!f.shape) return "shape";
  if (!f.bands) return "bands";
  return "review";
}
export function newLiquidityDraft(operation: LiquidityOperation = "open", fields: LiquidityFields = {}): LiquidityDraft {
  const d = liquidityDraftSchema.parse({ operation, fields: operation === "withdraw" ? { withdrawPercent: 100, ...fields } : fields, phase: "token" });
  applyLiquidityBandDefault(d);
  applyLiquiditySpacingDefault(d);
  d.phase = liquidityNextPhase(d); return d;
}
/** Pool spacing is infrastructure, not a required user choice. Never replace
 * an existing pool's setting or an explicitly supplied custom setting. */
export function applyLiquiditySpacingDefault(d: LiquidityDraft) {
  if (d.operation !== "open") return;
  if (d.selected) { d.fields.tickSpacing = d.selected.tickSpacing; return; }
  if (d.fields.version === 3 && d.fields.feePips) {
    const spacing = ({ 100: 1, 500: 10, 3000: 60, 10000: 200 } as Record<number, number>)[d.fields.feePips];
    if (!spacing && !d.fields.tickSpacing) throw new Error("UNSUPPORTED_V3_FEE");
    if (spacing) d.fields.tickSpacing = spacing;
  } else if (d.fields.version === 4 && d.fields.tickSpacing === undefined) {
    d.fields.tickSpacing = 60;
  }
}
/** Materialize the suggested setting before quoting so display and signing agree. */
export function applyLiquidityBandDefault(d: LiquidityDraft) {
  if (d.operation !== "open" || !d.fields.shape) return;
  if (d.fields.bands === undefined || d.bandsDefaulted) {
    d.fields.bands = d.fields.shape === "flat" ? 1 : 5;
    d.bandsDefaulted = true;
  }
}
export function updateLiquidityFields(draft: LiquidityDraft, patch: LiquidityFields): LiquidityDraft {
  const d = structuredClone(draft), previous = d.fields;
  d.fields = liquidityFieldsSchema.parse({ ...previous, ...patch });
  if (d.operation === "withdraw" && d.fields.withdrawPercent === undefined) d.fields.withdrawPercent = 100;
  if (d.operation === "withdraw" && patch.position) { delete d.fields.token; delete d.fields.allPositions; }
  if (patch.position) { d.positionChoices = []; d.morePositionChoices = false; }
  if (patch.lowerMarketCapUsd !== undefined || patch.upperMarketCapUsd !== undefined) {
    delete d.fields.downPercent; delete d.fields.upPercent;
  } else if (patch.downPercent !== undefined || patch.upPercent !== undefined) {
    delete d.fields.lowerMarketCapUsd; delete d.fields.upperMarketCapUsd;
  }
  if (patch.bands !== undefined) d.bandsDefaulted = false;
  applyLiquidityBandDefault(d);
  if (d.operation === "claim") {
    if (patch.position) { delete d.fields.allPositions; delete d.fields.token; }
    else if (patch.token) { delete d.fields.allPositions; delete d.fields.position; }
    else if (patch.allPositions) { delete d.fields.position; delete d.fields.token; }
  }
  if (d.fields.version === 3 && d.fields.feePips) {
    const spacing = ({ 100: 1, 500: 10, 3000: 60, 10000: 200 } as Record<number, number>)[d.fields.feePips];
    if (!spacing && !d.fields.tickSpacing) throw new Error("UNSUPPORTED_V3_FEE");
    if (spacing && patch.tickSpacing !== undefined && patch.tickSpacing !== spacing) throw new Error("INVALID_TICK_SPACING");
    if (spacing) d.fields.tickSpacing = spacing;
  }
  if (patch.token && patch.token !== previous.token || patch.amount && patch.amount !== previous.amount || patch.unit && patch.unit !== previous.unit) {
    d.analysis = undefined;
    d.analyzed = false; d.candidates = []; d.selected = undefined; d.tokenAddress = undefined; d.symbol = undefined; d.currentMarketCapUsd = undefined;
    d.fundingCheck = undefined;
  }
  if (d.selected && ["pair", "version", "feePips", "tickSpacing"].some(k => patch[k as keyof LiquidityFields] !== undefined && patch[k as keyof LiquidityFields] !== previous[k as keyof LiquidityFields])) {
    d.analysis = undefined;
    d.selected = undefined; d.analyzed = false; d.candidates = [];
  }
  applyLiquiditySpacingDefault(d);
  d.review = undefined; d.executionPlanJson = undefined; d.quoteSummary = []; d.remainingPages = []; d.phase = liquidityNextPhase(d); return d;
}
export function selectLiquidityPool(draft: LiquidityDraft, option: number) {
  if (draft.phase !== "pool") throw new Error("INVALID_OPTION_STEP");
  const selected = draft.candidates[option - 1]; if (!selected) throw new Error("INVALID_OPTION");
  const d = structuredClone(draft); d.custom = false; d.selected = selected;
  d.fields = { ...d.fields, pair: selected.pair, version: selected.version, feePips: selected.feePips, tickSpacing: selected.tickSpacing };
  applyLiquidityBandDefault(d);
  applyLiquiditySpacingDefault(d);
  d.review = undefined; d.executionPlanJson = undefined; d.quoteSummary = []; d.remainingPages = []; d.phase = liquidityNextPhase(d); return d;
}
export function liquidityReviewHash(publicId: string, owner: string, revision: number, draft: LiquidityDraft) {
  // Fixed key ordering through schema parsing; no model-provided calldata/owner.
  return keccak256(stringToHex(JSON.stringify({ version: 1, publicId, owner, revision, operation: draft.operation,
    fields: liquidityFieldsSchema.parse(draft.fields), tokenAddress: draft.tokenAddress,
    pool: draft.selected?.id, custom: draft.custom, plan: draft.executionPlanJson })));
}
export function validateLiquidityReview(d: LiquidityDraft) {
  if (liquidityNextPhase(d) !== "review") throw new Error("INCOMPLETE_REVIEW");
  if (d.operation === "open") {
    if (d.fields.lowerMarketCapUsd !== undefined && d.fields.lowerMarketCapUsd >= d.fields.upperMarketCapUsd!) throw new Error("LP_INVALID_MCAP_RANGE");
    if (!d.tokenAddress || !d.symbol) throw new Error("UNRESOLVED_TOKEN");
    if (!d.selected && !d.custom) throw new Error("MISSING_POOL");
    if (d.fields.bands! > LIQUIDITY_MAX_BANDS || d.fields.shape !== "flat" && d.fields.bands! < 3) throw new Error("INVALID_BANDS");
    if (d.fields.pair === "USDG" && d.tokenAddress === DELTA_LIQUIDITY.usdg || d.fields.pair === "ETH" && d.tokenAddress === DELTA_LIQUIDITY.weth) throw new Error("SELF_PAIR");
  }
}
