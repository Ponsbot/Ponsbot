import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { shouldSuppressXResponse } from "./xReplyPolicy";
import { isEmptyNativeGasBalanceError, noNativeGasMessage } from "../lib/wallet-native-gas";
import { compareXPriority, readOnlyReplyCategory } from "../lib/x-wallet-flood-policy";
import { suppressReadOnlyReply, rejectReadOnlyReply, suppressInsufficientEthReply } from "./xFloodProtection";
import { temporaryXReplySuppressionReason, isInsufficientEthReply } from "../lib/x-temporary-reply-policy";
import { publicationCapacity } from "./xPublicationBudget";
import { REPLY_QUEUE_WINDOW_MS, REPLY_QUEUE_WINDOW_LIMIT, REPLY_QUEUE_C_GAP_MS, replyQueueWaitMs } from "../lib/x-reply-queue-policy";
import { directPostCommandText, isResumeReply } from "../lib/x-direct-post-policy";
import { loadReplyMetadata, type ReferencePost } from "../lib/x-reference-metadata";
import { loadAuthorProfiles } from "../lib/x-author-profiles";
import { restrictedXSearchQuery, intakeSourceTransition, walletBalanceReadsExcluded, verifiedXReadsOnly, effectiveXIntakeFilters } from "../lib/x-intake-filter";
import { advanceXIntakeSpikeGuard, xAutoIntakeGuardEnabled } from "../lib/x-intake-spike-guard";
import { isLiquidityMessage, isOrdinaryWalletCommand, liquidityOwnerAllowed } from "../lib/liquidity-workflow";
import { liquidityAdmissionExempt } from "./liquidity";
import { AUTOMATED_FEE_WORKFLOW_CONTINUATION, isAutomatedFeeWorkflowContinuation } from "../lib/automated-fee-workflow";
import {
  decodePersistedXWalletIntent,
  explicitInformationalTopic,
  isContextualGasCostFollowup,
  parseXWalletIntent,
  requestedOperations,
  straightforwardCommandOperation,
  unknownWalletMessage,
  walletHelpMessage,
} from "./xWalletIntent";
import type { XWalletIntent } from "./xWalletIntent";
import { fitXReply, xWeightedLength } from "./xText";
import {
  mentionPaginationProgress,
  paginationFailureState,
  shouldRecoverXInteraction,
  shouldSendBurstNotice,
  shouldSendCooldownNotice,
  shouldSendDailyNotice,
  xInteractionDispatchDelay,
} from "../lib/x-operational-policy";
import {
  firstPhotoUrl,
  requestsReferencedLaunchImage,
  selectLaunchImageReference,
  type XReferenceType,
} from "../lib/x-launch-image-policy";
import {
  hasExplicitBotMention,
  isPassiveBotChainReply,
  launchPostAuthorized,
  shouldRestrictChainReply,
} from "../lib/x-passive-chain-policy";
import {
  looksLikeXHoudiniCommand,
  houdiniMinimumAmountReply,
  parseXHoudiniCommand,
  parseXHoudiniDecision,
} from "./xHoudini";
import {
  GENERAL_GUIDED_HELP_MESSAGE,
  X_GENERAL_GUIDED_HELP_MESSAGE,
  GUIDED_HELP_TTL_MS,
  guidedHelpCancelled,
  guidedHelpClaimLpOfferSelection,
  guidedHelpClaimSelection,
  guidedHelpCommandKind,
  guidedHelpCommandText,
  guidedHelpExplanation,
  guidedHelpImmediateCommand,
  guidedHelpQuestion,
  guidedHelpQuestionResponse,
  guidedHelpPendingCommandKind,
  isGuidedHelpCompletion,
  isGuidedHelpPendingCommandKind,
  guidedHelpOperationFromCommandKind,
  guidedHelpOperationFromHelp,
  guidedHelpPrivacySelection,
  guidedHelpPrompt,
  guidedHelpSelection,
  decodeGuidedReassignState,
  guidedReassignRecipientSelection,
  guidedReassignTokenSelection,
  CLAIM_LP_FEE_OFFER,
  GUIDED_REASSIGN_TOKEN_PROMPT,
  withGuidedHelpCompletion,
} from "../lib/guided-help-workflow";
import { exceedsXReplyDepthLimit } from "../lib/x-reply-depth-policy";
import {
  advanceGuidedLaunch,
  createGuidedLaunchState,
  decodeGuidedLaunchState,
  guidedLaunchPrompt,
  guidedLaunchRequested,
  type GuidedLaunchAdvance,
} from "../lib/guided-launch-workflow";

const X_API = "https://api.x.com/2";
const X_MENTION_PAGE_SIZE = 100;
// One page per two-minute poll; persist pagination to drain bursts safely.
const X_MENTION_PAGES_PER_POLL = 1;
const X_POLL_LEASE_MS = 15 * 60_000;
const REFERENCED_IMAGE_FAILURE =
  "🖼️ I couldn't prepare that image. Reply with the launch request using another image, or launch without artwork.";
const X_DISPATCH_BATCH_SIZE = 5;
const X_DISPATCH_BATCH_DELAY_MS = 1_000;
const MAX_X_REPLY_DEPTH = 6;
function repliesEnabled() {
  return process.env.X_REPLIES_ENABLED === "true";
}

function automatedFeeUpgradeCommandsEnabled() {
  return process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true"
    && process.env.AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED?.trim().toLowerCase() === "true"
    && process.env.AUTOMATED_FEE_BOT_COMMANDS_ENABLED?.trim().toLowerCase() === "true";
}

function standaloneMentionsEnabled() {
  return process.env.X_STANDALONE_MENTIONS_ENABLED === "true";
}

function standaloneMentionsSince() {
  const value = Number(process.env.X_STANDALONE_MENTIONS_SINCE_MS);
  return Number.isFinite(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
}

function positiveInteger(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function premiumSubscription(subscriptionType?: string) {
  return subscriptionType === "Premium" || subscriptionType === "PremiumPlus";
}

function nonNegativeInteger(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : fallback;
}

function replyLimits(premium = false) {
  const regularDaily = positiveInteger(
    "X_REPLY_USER_DAILY_LIMIT",
    10_000,
    100_000,
  );
  const premiumDaily = Math.max(
    regularDaily,
    positiveInteger("X_REPLY_PREMIUM_DAILY_LIMIT", regularDaily, 100_000),
  );
  return {
    userDaily: premium ? premiumDaily : regularDaily,
    globalDaily: positiveInteger(
      "X_REPLY_GLOBAL_DAILY_LIMIT",
      100_000,
      100_000,
    ),
    userWindow: positiveInteger("X_REPLY_USER_WINDOW_LIMIT", 20, 100),
    globalWindow: positiveInteger("X_REPLY_GLOBAL_WINDOW_LIMIT", 1_000, 10_000),
    windowMs: positiveInteger("X_REPLY_WINDOW_MINUTES", 10, 60) * 60_000,
    cooldownMs:
      nonNegativeInteger("X_REPLY_COOLDOWN_SECONDS", 0, 3_600) * 1_000,
  };
}

function rateLimitMessage(reason: string) {
  if (reason === "user cooldown")
    return "⏳ One moment! Please wait briefly before sending another wallet request.";
  if (reason === "user daily limit")
    return "⏰ You've reached today's wallet request limit. It resets at 00:00 UTC!";
  if (reason === "user burst limit")
    return "⚡ You're moving fast! Please wait a few minutes, then reply with the request again.";
  return "🛠️ I'm handling lots of wallet requests right now. Reply with the request again shortly!";
}

async function helpReply(
  _ctx: ActionCtx,
  topic: Parameters<typeof walletHelpMessage>[0],
) {
  return walletHelpMessage(topic);
}

function oauthEncode(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function hmacSha1Base64(key: string, value: string) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)),
  );
  return btoa(String.fromCharCode(...bytes));
}

async function xAuthorization(
  method: "GET" | "POST",
  url: string,
  query: URLSearchParams = new URLSearchParams(),
) {
  const consumerKey = process.env.X_API_KEY;
  const consumerSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret)
    throw new Error("X OAuth credentials are not configured");
  const oauth: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomUUID().replaceAll("-", ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1_000)),
    oauth_token: accessToken,
    oauth_version: "1.0",
  };
  const parameters = [...Object.entries(oauth), ...query.entries()]
    .sort(([ak, av], [bk, bv]) =>
      ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk),
    )
    .map(([key, value]) => `${oauthEncode(key)}=${oauthEncode(value)}`)
    .join("&");
  const signatureBase = `${method}&${oauthEncode(url)}&${oauthEncode(parameters)}`;
  oauth.oauth_signature = await hmacSha1Base64(
    `${oauthEncode(consumerSecret)}&${oauthEncode(accessTokenSecret)}`,
    signatureBase,
  );
  return `OAuth ${Object.entries(oauth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`)
    .join(", ")}`;
}

async function xGet<T>(
  path: string,
  query: URLSearchParams,
  timeoutMs = 20_000,
): Promise<T> {
  const url = `${X_API}${path}`;
  const response = await fetch(`${url}?${query}`, {
    headers: { authorization: await xAuthorization("GET", url, query) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    detail?: string;
  };
  if (!response.ok)
    throw new Error(payload.detail || `X GET failed (${response.status})`);
  return payload;
}

class ReplyPublicationRejectedError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number,
    readonly rate: XRateHeaders,
  ) {
    super(message);
  }
}

class ReplyPublicationDeferredError extends Error {
  constructor(readonly waitMs: number) {
    super("X publication pacing required");
  }
}

type XRateHeaders = { limit?: number; remaining?: number; reset?: number };
function numericHeader(response: Response, name: string) {
  const raw = response.headers.get(name);
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
function xRateHeaders(response: Response): XRateHeaders {
  return {
    limit: numericHeader(response, "x-rate-limit-limit"),
    remaining: numericHeader(response, "x-rate-limit-remaining"),
    reset: numericHeader(response, "x-rate-limit-reset"),
  };
}
function temporarilyWriteRestricted(status: number, message: string) {
  return (
    status === 403 &&
    /not permitted to access this feature|posting limitation|post limit|status update limit/i.test(
      message,
    )
  );
}

/** The only X POST sender. It consumes a frozen reply, never a wallet command. */
export const drainReplyQueue = internalAction({
  args: { wakeToken: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const reserved = await ctx.runMutation(internal.xReplyQueue.takeNext, args);
    if (!reserved) return;
    const { row, leaseToken } = reserved;
    type Outcome = { outcome: "published" | "retry" | "blocked" | "uncertain"; responsePostId?: string; error?: string; httpStatus?: number; retryAfterMs?: number } & XRateHeaders;
    let outcome: Outcome;
    let attempted = false;
    try {
      let text = row.text;
      if (row.standalone && row.kind !== "graduation") {
        const username = row.username?.replace(/^@/, "");
        if (!username || !/^[a-zA-Z0-9_]{1,15}$/.test(username)) throw new Error("X recipient username unavailable");
        text = `@${username} ${text}`;
      }
      if (!row.allowLong) text = fitXReply(text);
      if (xWeightedLength(text) > (row.allowLong ? 8000 : 280)) throw new Error("X reply exceeded its character limit");
      if (!row.standalone && !row.postId) throw new Error("X reply source unavailable");
      const url = `${X_API}/tweets`;
      const authorization = await xAuthorization("POST", url);
      if (!repliesEnabled()) {
        outcome = { outcome: "retry", error: "X publishing is disabled", retryAfterMs: 60_000 };
      } else {
        attempted = true;
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(row.standalone ? { text } : { text, reply: { in_reply_to_tweet_id: row.postId } }),
          signal: AbortSignal.timeout(20_000),
        });
        const payload = await response.json().catch(() => ({})) as {
          data?: { id?: string }; detail?: string; title?: string; errors?: Array<{ message?: string }>;
        };
        const rate = xRateHeaders(response);
        const error = (payload.detail || payload.errors?.map(e => e.message).filter(Boolean).join("; ") || payload.title || `X publication failed (${response.status})`).slice(0, 1000);
        if (response.ok && payload.data?.id) outcome = { outcome: "published", responsePostId: payload.data.id, httpStatus: response.status, ...rate };
        else if (response.ok || response.status >= 500) {
          // X may have committed a write before returning an incomplete/5xx
          // response. Retain it for reconciliation, never blindly duplicate.
          outcome = { outcome: "uncertain", error, httpStatus: response.status, ...rate };
        } else {
          const rawRetryAfter = response.headers.get("retry-after");
          const parsedSeconds = rawRetryAfter === null ? NaN : Number(rawRetryAfter);
          const retryAfterMs = Number.isFinite(parsedSeconds) ? Math.max(0, parsedSeconds * 1000)
            : rawRetryAfter ? Math.max(0, Date.parse(rawRetryAfter) - Date.now()) : undefined;
          outcome = {
            outcome: response.status === 429 || temporarilyWriteRestricted(response.status, error) ? "retry" : "blocked",
            error, httpStatus: response.status, ...rate,
            ...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
          };
        }
      }
    } catch (error) {
      outcome = { outcome: attempted ? "uncertain" : "blocked", error: error instanceof Error ? error.message.slice(0, 1000) : "X publication failed" };
    }
    // Keep persistence outside the network catch: a DB failure after success
    // must not be mistaken for an explicit X rejection and resubmitted.
    await ctx.runMutation(internal.xReplyQueue.finish, { queueId: row._id, leaseToken, ...outcome });
  },
});

export const publishStandalonePost = internalAction({
  args: { text: v.string(), publicationKey: v.string(), launchId: v.id("tokenLaunches") },
  handler: async (ctx, args): Promise<{ status: "queued" | "posted" | "rejected" | "uncertain"; postId?: string; error?: string }> => {
    const queued = await ctx.runMutation(internal.xReplyQueue.enqueue, {
      key: args.publicationKey, text: args.text, launchId: args.launchId, kind: "graduation", ok: true,
    });
    if (queued.status === "published" && queued.responsePostId) return { status: "posted", postId: queued.responsePostId };
    if (queued.status === "queued" || queued.status === "paused" || queued.status === "sending") return { status: "queued" };
    return { status: queued.status === "cancelled" || queued.status === "expired" ? "rejected" : "uncertain", error: `Publication queue: ${queued.status}` };
  },
});

// Legacy audit/reservation API; live publishers now exclusively use xReplyQueue.
export const beginStandalonePublication = internalMutation({
  args: { publicationKey: v.string() },
  handler: async (ctx, { publicationKey }) => {
    if (process.env.X_REPLIES_ENABLED !== "true") return { reserved: false, waitMs: 60_000 };
    const prior = await ctx.db.query("xPublicationEvents").withIndex("by_post_id", q => q.eq("postId", publicationKey)).order("desc").first();
    if (prior && prior.status !== "rejected") return { reserved: false, waitMs: 0, priorStatus: prior.status, responsePostId: prior.responsePostId };
    const now = Date.now();
    const capacity = await publicationCapacity(ctx, now);
    if (capacity.waitMs) return { reserved: false, waitMs: capacity.waitMs };
    const eventId = await ctx.db.insert("xPublicationEvents", { postId: publicationKey, replyCategory: "other", status: "reserved", createdAt: now, updatedAt: now });
    return { reserved: true, waitMs: 0, eventId };
  },
});

export const publicationBudgetStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query("xReplyQueueState").withIndex("by_key", q => q.eq("key", "main")).unique();
    const now = Date.now(), attempts = state?.attempts ?? [];
    const groups = await Promise.all((["A", "B", "C"] as const).map(async priority => {
      const entries = await ctx.db.query("xReplyQueue").withIndex("by_status_priority_ready", q => q.eq("status", "queued").eq("priority", priority)).take(1001);
      return { priority, queued: entries.length, countIsLowerBound: entries.length === 1001, oldestReadyAt: entries[0]?.readyAt,
        waitMs: replyQueueWaitMs(attempts, priority, now, state ?? undefined) };
    }));
    return { policy: "priority_queue", initialized: Boolean(state), enabled: repliesEnabled(), windowMs: REPLY_QUEUE_WINDOW_MS,
      limit: REPLY_QUEUE_WINDOW_LIMIT, lowPriorityGapMs: REPLY_QUEUE_C_GAP_MS,
      recentAttempts: attempts.filter(a => a.at > now - REPLY_QUEUE_WINDOW_MS).length, groups,
      activeId: state?.activeId, wakeAt: state?.wakeAt, remaining: state?.remaining, reset: state?.reset };
  },
});

class ReplyPublicationUncertainError extends Error {}
class ReplyPublicationSuppressedError extends Error {}

class ReplyPublicationQueuedError extends Error {}

async function publishReplyOnce(
  ctx: ActionCtx,
  text: string,
  sourcePostId: string,
  publicationKey?: string,
  allowLongLiquidity = false,
  options?: { ok?: boolean; kind?: "reply" | "guided_reply" | "guided_execution" | "liquidity" | "houdini_progress" | "houdini_final"; houdiniQuoteId?: Id<"xHoudiniQuotes"> },
) {
  const queued = await ctx.runMutation(internal.xReplyQueue.enqueue, {
    key: publicationKey || sourcePostId, postId: sourcePostId, text,
    kind: options?.kind ?? (allowLongLiquidity ? "liquidity" : "reply"),
    allowLong: allowLongLiquidity, ...options,
  });
  if (queued.status === "published" && queued.responsePostId) return queued.responsePostId;
  if (queued.status === "queued" || queued.status === "sending") throw new ReplyPublicationQueuedError("Reply saved for publication");
  if (queued.status === "cancelled" || queued.status === "expired") throw new ReplyPublicationSuppressedError(queued.status);
  throw new ReplyPublicationUncertainError(`Reply retained for review: ${queued.status}`);
}

export const getPollState = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("xReplyState")
      .withIndex("by_key", (q) => q.eq("key", "mentions"))
      .unique(),
});

export const preparePollSource = internalMutation({
  args: {},
  handler: async ctx => {
    const state = await ctx.db.query("xReplyState").withIndex("by_key", q => q.eq("key", "mentions")).unique();
    const now = Date.now();
    if (!state?.leaseUntil || state.leaseUntil <= now) throw new Error("Poll lease required");
    const guard = advanceXIntakeSpikeGuard(state.intakeSpikeGuard, now, [], xAutoIntakeGuardEnabled(), {
      excludeWalletBalance: walletBalanceReadsExcluded(), verifiedOnly: verifiedXReadsOnly(),
    });
    if (JSON.stringify(guard.state) !== JSON.stringify(state.intakeSpikeGuard))
      await ctx.db.patch(state._id, { intakeSpikeGuard: guard.state });
    const effectiveFilters = effectiveXIntakeFilters(guard.filters);
    const patch = intakeSourceTransition(state.intakeSource, effectiveFilters.excludeWalletBalance, now, effectiveFilters.verifiedOnly, effectiveFilters.countries, effectiveFilters.excludeShowMyWallet);
    if (patch) await ctx.db.patch(state._id, patch);
    return { ...state, ...patch, intakeSpikeGuard: guard.state, effectiveFilters };
  },
});

// Called once per fetched page, before profiles/AI. No additional X requests,
// historical scans, response jobs, or environment-variable writes are needed.
export const observeIntakeTraffic = internalMutation({
  args: { postIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (!xAutoIntakeGuardEnabled()) return effectiveXIntakeFilters();
    if (args.postIds.length > X_MENTION_PAGE_SIZE) throw new Error("Intake observation exceeds one page");
    const state = await ctx.db.query("xReplyState").withIndex("by_key", q => q.eq("key", "mentions")).unique();
    const now = Date.now();
    if (!state?.leaseUntil || state.leaseUntil <= now) throw new Error("Poll lease required");
    const guard = advanceXIntakeSpikeGuard(state.intakeSpikeGuard, now, args.postIds, true, {
      excludeWalletBalance: walletBalanceReadsExcluded(), verifiedOnly: verifiedXReadsOnly(),
    });
    if (JSON.stringify(guard.state) !== JSON.stringify(state.intakeSpikeGuard))
      await ctx.db.patch(state._id, { intakeSpikeGuard: guard.state, updatedAt: now });
    return effectiveXIntakeFilters(guard.filters);
  },
});

export const consumeReplyLimit = internalMutation({
  args: { xUserId: v.string(), premium: v.boolean(), postId: v.optional(v.string()) },
  handler: async (ctx, { xUserId, premium, postId }) => {
    if (postId) {
      const interaction = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", q => q.eq("postId", postId)).unique();
      if (interaction && interaction.authorXUserId === xUserId && !interaction.replySuppressedReason &&
        !["completed", "rejected"].includes(interaction.status) && interaction.commandKind !== "operator_cancelled" &&
        await liquidityAdmissionExempt(ctx, { ownerXUserId: xUserId, text: interaction.text, parentPostId: interaction.parentPostId, postId }))
        return { allowed: true, reason: "liquidity workflow", shouldNotify: false };
    }
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const limits = replyLimits(premium);
    const keys = [`user:${xUserId}`, "global"];
    const records = await Promise.all(
      keys.map((key) =>
        ctx.db
          .query("xReplyRateLimits")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique(),
      ),
    );
    const states = records.map((record) => {
      const sameDay = record?.utcDay === day;
      const sameWindow = Boolean(
        record && now - record.windowStartedAt < limits.windowMs,
      );
      return {
        dailyCount: sameDay ? record!.dailyCount : 0,
        windowCount: sameWindow ? record!.windowCount : 0,
        windowStartedAt: sameWindow ? record!.windowStartedAt : now,
        lastAcceptedAt: record?.lastAcceptedAt || 0,
      };
    });
    if (
      limits.cooldownMs > 0 &&
      now - states[0].lastAcceptedAt < limits.cooldownMs
    ) {
      // Publish at most one notice for each accepted-request cooldown period.
      // A later accepted request starts a new period and may receive one new notice.
      const shouldNotify = shouldSendCooldownNotice(
        records[0]?.lastCooldownNoticeAt,
        states[0].lastAcceptedAt,
      );
      if (shouldNotify && records[0])
        await ctx.db.patch(records[0]._id, {
          lastCooldownNoticeAt: now,
          updatedAt: now,
        });
      return { allowed: false, reason: "user cooldown", shouldNotify };
    }
    if (states[0].dailyCount >= limits.userDaily) {
      const shouldNotify = shouldSendDailyNotice(
        records[0]?.lastDailyNoticeAt,
        day,
      );
      if (shouldNotify && records[0])
        await ctx.db.patch(records[0]._id, {
          lastDailyNoticeAt: now,
          updatedAt: now,
        });
      return { allowed: false, reason: "user daily limit", shouldNotify };
    }
    if (states[1].dailyCount >= limits.globalDaily)
      return {
        allowed: false,
        reason: "global daily limit",
        shouldNotify: false,
      };
    if (states[0].windowCount >= limits.userWindow) {
      const shouldNotify = shouldSendBurstNotice(
        records[0]?.lastBurstNoticeAt,
        states[0].windowStartedAt,
      );
      if (shouldNotify && records[0])
        await ctx.db.patch(records[0]._id, {
          lastBurstNoticeAt: now,
          updatedAt: now,
        });
      return { allowed: false, reason: "user burst limit", shouldNotify };
    }
    if (states[1].windowCount >= limits.globalWindow)
      return {
        allowed: false,
        reason: "global burst limit",
        shouldNotify: false,
      };
    for (let index = 0; index < keys.length; index += 1) {
      const value = {
        utcDay: day,
        dailyCount: states[index].dailyCount + 1,
        windowStartedAt: states[index].windowStartedAt,
        windowCount: states[index].windowCount + 1,
        lastAcceptedAt: now,
        updatedAt: now,
      };
      if (records[index]) await ctx.db.patch(records[index]!._id, value);
      else
        await ctx.db.insert("xReplyRateLimits", { key: keys[index], ...value });
    }
    return { allowed: true, reason: "accepted", shouldNotify: false };
  },
});

export const admitWorkflowContinuation = internalMutation({
  args: { ownerXUserId: v.string(), postId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const windowMs = 15 * 60_000;
    const record = await ctx.db.query("xWorkflowReplyLimits")
      .withIndex("by_owner", q => q.eq("ownerXUserId", args.ownerXUserId)).unique();
    const slots = (record?.slots || []).filter(slot => slot.at > now - windowMs);
    if (slots.some(slot => slot.postId === args.postId)) return { allowed: true, notify: false };
    if ((record?.cooldownUntil || 0) > now) {
      return { allowed: false, notify: record?.noticePostId === args.postId, cooldownUntil: record!.cooldownUntil };
    }
    if (slots.length >= 20) {
      const cooldownUntil = now + windowMs;
      const value = { slots, cooldownUntil, noticePostId: args.postId, updatedAt: now };
      if (record) await ctx.db.patch(record._id, value);
      else await ctx.db.insert("xWorkflowReplyLimits", { ownerXUserId: args.ownerXUserId, ...value });
      return { allowed: false, notify: true, cooldownUntil };
    }
    const value = { slots: [...slots, { postId: args.postId, at: now }], cooldownUntil: undefined, noticePostId: undefined, updatedAt: now };
    if (record) await ctx.db.patch(record._id, value);
    else await ctx.db.insert("xWorkflowReplyLimits", { ownerXUserId: args.ownerXUserId, ...value });
    return { allowed: true, notify: false };
  },
});

export const updatePollState = internalMutation({
  args: {
    newestSeenPostId: v.optional(v.string()),
    backlogPaginationToken: v.optional(v.string()),
    backlogNewestPostId: v.optional(v.string()),
    backlogPaginationFailures: v.optional(v.number()),
    backlogVisitedPaginationTokens: v.optional(v.array(v.string())),
    clearBacklog: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const state = await ctx.db
      .query("xReplyState")
      .withIndex("by_key", (q) => q.eq("key", "mentions"))
      .unique();
    const { clearBacklog, ...updates } = args;
    const patch = clearBacklog
      ? {
          ...updates,
          backlogPaginationToken: undefined,
          backlogNewestPostId: undefined,
          backlogVisitedPaginationTokens: undefined,
          leaseUntil: undefined,
          lastPolledAt: now,
          updatedAt: now,
        }
      : {
          ...updates,
          leaseUntil: undefined,
          lastPolledAt: now,
          updatedAt: now,
        };
    if (state) await ctx.db.patch(state._id, patch);
    else
      await ctx.db.insert("xReplyState", {
        key: "mentions",
        ...updates,
        lastPolledAt: now,
        updatedAt: now,
      });
  },
});

export const acquirePollLease = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const state = await ctx.db
      .query("xReplyState")
      .withIndex("by_key", (q) => q.eq("key", "mentions"))
      .unique();
    if (state?.leaseUntil && state.leaseUntil > now) return false;
    if (state)
      await ctx.db.patch(state._id, {
        leaseUntil: now + X_POLL_LEASE_MS,
        updatedAt: now,
      });
    else
      await ctx.db.insert("xReplyState", {
        key: "mentions",
        leaseUntil: now + X_POLL_LEASE_MS,
        updatedAt: now,
      });
    return true;
  },
});

export const releasePollLease = internalMutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db
      .query("xReplyState")
      .withIndex("by_key", (q) => q.eq("key", "mentions"))
      .unique();
    if (state)
      await ctx.db.patch(state._id, {
        leaseUntil: undefined,
        updatedAt: Date.now(),
      });
  },
});

export const reserveInteraction = internalMutation({
  args: {
    postId: v.string(),
    authorXUserId: v.string(),
    authorVerified: v.optional(v.boolean()),
    text: v.string(),
    mediaUrl: v.optional(v.string()),
    mediaSource: v.optional(v.union(v.literal("direct"), v.literal("quoted"), v.literal("replied_to"))),
    referencedPostId: v.optional(v.string()),
    referencedPostType: v.optional(
      v.union(v.literal("quoted"), v.literal("replied_to")),
    ),
    nestedReply: v.optional(v.boolean()),
    botParentAuthorized: v.optional(v.boolean()),
    parentPostId: v.optional(v.string()),
    replyDepth: v.optional(v.number()),
    parsedIntentJson: v.optional(v.string()),
    recipientAddress: v.optional(v.string()),
    guidedHelpStateJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", args.postId))
      .unique();
    if (existing) return false;
    const now = Date.now();
    await ctx.db.insert("xReplyInteractions", {
      ...args,
      status: "received",
      createdAt: now,
      updatedAt: now,
    });
    return true;
  },
});

export const updateInteraction = internalMutation({
  args: {
    postId: v.string(),
    status: v.union(
      v.literal("received"),
      v.literal("processing"),
      v.literal("publishing"),
      v.literal("completed"),
      v.literal("rejected"),
      v.literal("failed"),
    ),
    commandKind: v.optional(v.string()),
    responsePostId: v.optional(v.string()),
    safeError: v.optional(v.string()),
    guidedHelpStateJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const interaction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", args.postId))
      .unique();
    if (interaction?.commandKind === "operator_cancelled") return;
    if (interaction?.walletLookupSuppressed) return;
    if (interaction?.replySuppressedReason) return;
    // The saved publication owns status until its publisher settles it.
    if (interaction?.publicationQueued) return;
    if (interaction)
      await ctx.db.patch(interaction._id, {
        status: args.status,
        commandKind: args.commandKind,
        responsePostId: args.responsePostId,
        safeError: args.safeError,
        guidedHelpStateJson: args.guidedHelpStateJson,
        updatedAt: Date.now(),
      });
  },
});

export const replyDepthFromParent = internalQuery({
  args: { parentPostId: v.string() },
  handler: async (ctx, { parentPostId }) => {
    const parentInteraction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", parentPostId))
      .unique();
    if (parentInteraction) return (parentInteraction.replyDepth || 0) + 1;
    const botReplyInteraction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_response_post_id", (q) =>
        q.eq("responsePostId", parentPostId),
      )
      .unique();
    // The bot response is one level below its source interaction, and this
    // incoming reply is one further level below the bot response.
    if (botReplyInteraction) return (botReplyInteraction.replyDepth || 0) + 2;
    return undefined;
  },
});

export const guidedHelpContext = internalQuery({
  args: { ownerXUserId: v.string(), parentPostId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.parentPostId) return null;
    const parent = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_response_post_id", q => q.eq("responsePostId", args.parentPostId!))
      .unique();
    if (!parent || parent.updatedAt < Date.now() - GUIDED_HELP_TTL_MS) return null;
    let operation = guidedHelpOperationFromCommandKind(parent.commandKind);
    if (!operation) {
    try {
      const intent = parent.parsedIntentJson
        ? decodePersistedXWalletIntent(parent.parsedIntentJson)
        : null;
      // Both the general capability menu and the dedicated launch how-to
      // response are guided entry points. The latter previously published the
      // right copy without persisting a guided command kind, so "get started"
      // replies had no workflow context.
      operation = intent?.kind === "help" && ["capabilities", "launch"].includes(intent.topic)
        ? "root"
        : null;
    } catch {
      return null;
    }
    }
    // Authorization is inherited only through this owner's persisted guided
    // chain. Looking solely at the immediately preceding reply loses the
    // original explicit mention after one or two guided questions.
    let sourceExplicitMention = parent.botParentAuthorized === true || /@ponsbotfamily\b/i.test(parent.text);
    let ancestor = parent;
    for (let depth = 0; !sourceExplicitMention && depth < 16; depth += 1) {
      if (!ancestor.parentPostId) break;
      const prior = await ctx.db.query("xReplyInteractions")
        .withIndex("by_response_post_id", q => q.eq("responsePostId", ancestor.parentPostId!))
        .unique();
      if (!prior || prior.authorXUserId !== args.ownerXUserId || prior.updatedAt < Date.now() - GUIDED_HELP_TTL_MS) break;
      sourceExplicitMention = prior.botParentAuthorized === true || /@ponsbotfamily\b/i.test(prior.text);
      ancestor = prior;
    }
    return operation ? {
      operation,
      owner: parent.authorXUserId,
      allowed: parent.authorXUserId === args.ownerXUserId,
      sourceText: directPostCommandText(parent.text),
      sourceExplicitMention,
      ...(parent.guidedHelpStateJson ? { guidedHelpStateJson: parent.guidedHelpStateJson } : {}),
    } : null;
  },
});

export const insufficientEthReplyContext = internalQuery({
  args: { ownerXUserId: v.string(), parentPostId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.parentPostId) return false;
    const parent = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_response_post_id", q => q.eq("responsePostId", args.parentPostId!))
      .unique();
    return Boolean(parent && parent.authorXUserId === args.ownerXUserId && parent.safeError
      && isInsufficientEthReply(parent.safeError));
  },
});

export const ownedBotReplyContext = internalQuery({
  args: { ownerXUserId: v.string(), parentPostId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.parentPostId) return false;
    const parent = await ctx.db.query("xReplyInteractions")
      .withIndex("by_response_post_id", q => q.eq("responsePostId", args.parentPostId!)).unique();
    return Boolean(parent && parent.authorXUserId === args.ownerXUserId);
  },
});

export const botReplyContext = internalQuery({
  args: { parentPostId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.parentPostId) return false;
    const parent = await ctx.db.query("xReplyInteractions")
      .withIndex("by_response_post_id", q => q.eq("responsePostId", args.parentPostId!)).unique();
    return Boolean(parent);
  },
});

export const insufficientEthResumeContext = internalQuery({
  args: { ownerXUserId: v.string(), parentPostId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.parentPostId) return null;
    const parent = await ctx.db.query("xReplyInteractions")
      .withIndex("by_response_post_id", q => q.eq("responsePostId", args.parentPostId!)).unique();
    if (!parent || parent.authorXUserId !== args.ownerXUserId
      || parent.updatedAt < Date.now() - GUIDED_HELP_TTL_MS
      || parent.gasResumeConsumedByPostId || !parent.safeError
      || !isInsufficientEthReply(parent.safeError)) return null;
    const state = decodeGasResumeState(parent.guidedHelpStateJson);
    return {
      parsedIntentJson: parent.parsedIntentJson,
      mediaUrl: parent.mediaUrl,
      recipientAddress: parent.recipientAddress,
      explicitMentionAuthorized: state?.explicitMentionAuthorized === true || /@ponsbotfamily\b/i.test(parent.text),
      sourceText: state?.sourceText || parent.text,
      resumable: Boolean(state?.sourceText) || /reply\s+[“\"]resume[”\"]/i.test(parent.safeError),
    };
  },
});

/** Atomically grants one X post authority to replay a funded request. A retry
 * of that same post remains idempotent; sibling replies cannot execute it. */
export const claimInsufficientEthResume = internalMutation({
  args: { ownerXUserId: v.string(), parentPostId: v.string(), consumerPostId: v.string() },
  handler: async (ctx, args) => {
    const parent = await ctx.db.query("xReplyInteractions")
      .withIndex("by_response_post_id", q => q.eq("responsePostId", args.parentPostId)).unique();
    if (!parent || parent.authorXUserId !== args.ownerXUserId
      || parent.updatedAt < Date.now() - GUIDED_HELP_TTL_MS || !parent.safeError
      || !isInsufficientEthReply(parent.safeError)) return false;
    if (parent.gasResumeConsumedByPostId)
      return parent.gasResumeConsumedByPostId === args.consumerPostId;
    await ctx.db.patch(parent._id, { gasResumeConsumedByPostId: args.consumerPostId });
    return true;
  },
});

function decodeGasResumeState(value?: string) {
  if (!value || value.length > 1_000) return null;
  try {
    const parsed = JSON.parse(value) as { type?: unknown; explicitMentionAuthorized?: unknown; sourceText?: unknown };
    return parsed.type === "gas_resume" && typeof parsed.explicitMentionAuthorized === "boolean"
      && typeof parsed.sourceText === "string" && parsed.sourceText.length > 0 && parsed.sourceText.length <= 800
      ? { sourceText: parsed.sourceText, explicitMentionAuthorized: parsed.explicitMentionAuthorized }
      : null;
  } catch {
    return null;
  }
}

function gasResumeAuthorized(value?: string) {
  return Boolean(decodeGasResumeState(value)?.explicitMentionAuthorized);
}

/** A guided launch prompt authorizes one owner reply. Retrying that same reply
 * remains idempotent, while sibling replies cannot fork into duplicate launches. */
export const claimGuidedLaunchStep = internalMutation({
  args: { ownerXUserId: v.string(), parentPostId: v.string(), consumerPostId: v.string() },
  handler: async (ctx, args) => {
    const parent = await ctx.db.query("xReplyInteractions")
      .withIndex("by_response_post_id", q => q.eq("responsePostId", args.parentPostId)).unique();
    if (!parent || parent.authorXUserId !== args.ownerXUserId
      || guidedHelpOperationFromCommandKind(parent.commandKind) !== "launch"
      || !parent.guidedHelpStateJson || parent.updatedAt < Date.now() - GUIDED_HELP_TTL_MS) return false;
    if (parent.guidedHelpConsumedByPostId) return parent.guidedHelpConsumedByPostId === args.consumerPostId;
    await ctx.db.patch(parent._id, { guidedHelpConsumedByPostId: args.consumerPostId, updatedAt: Date.now() });
    return true;
  },
});

export const bindInteractionMedia = internalMutation({
  args: {
    postId: v.string(),
    mediaUrl: v.string(),
    mediaSource: v.union(v.literal("quoted"), v.literal("replied_to")),
    referencedPostId: v.string(),
  },
  handler: async (ctx, args) => {
    const interaction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", args.postId))
      .unique();
    if (!interaction) throw new Error("X interaction was not reserved");
    if (interaction.mediaUrl) return interaction.mediaUrl;
    if (
      interaction.referencedPostId !== args.referencedPostId ||
      interaction.referencedPostType !== args.mediaSource
    ) {
      throw new Error("X referenced image binding mismatch");
    }
    await ctx.db.patch(interaction._id, {
      mediaUrl: args.mediaUrl,
      mediaSource: args.mediaSource,
      updatedAt: Date.now(),
    });
    return args.mediaUrl;
  },
});

export const recordBacklogPaginationFailure = internalMutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db
      .query("xReplyState")
      .withIndex("by_key", (q) => q.eq("key", "mentions"))
      .unique();
    if (!state?.backlogPaginationToken) return false;
    const { failures, reset } = paginationFailureState(
      state.backlogPaginationFailures,
    );
    await ctx.db.patch(
      state._id,
      reset
        ? {
            backlogPaginationToken: undefined,
            backlogNewestPostId: undefined,
            backlogPaginationFailures: 0,
            updatedAt: Date.now(),
          }
        : { backlogPaginationFailures: failures, updatedAt: Date.now() },
    );
    return reset;
  },
});

// Kept for existing operator tooling. This does not post, and is not used by
// the durable queue or any live publication action.
export const beginReplyPublication = internalMutation({
  args: { postId: v.string(), publicationKey: v.optional(v.string()), replyText: v.optional(v.string()) },
  handler: async (ctx, { postId, publicationKey, replyText }) => {
    const interaction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", postId))
      .unique();
    if (!interaction || interaction.commandKind === "operator_cancelled")
      return { reserved: false, waitMs: 0 };
    if (interaction.replySuppressedReason)
      return { reserved: false, waitMs: 0, suppressedReason: interaction.replySuppressedReason };
    const suppressedReason = temporaryXReplySuppressionReason(replyText ?? "");
    if (suppressedReason) {
      // Don't rewrite an ordinary reply whose publication already began.
      if (!publicationKey && (interaction.publicationAttempted || interaction.responsePostId || interaction.status === "publishing"))
        return { reserved: false, waitMs: 0 };
      await ctx.db.patch(interaction._id, {
        status: "rejected",
        replySuppressedReason: suppressedReason,
        nextRetryAt: undefined,
        safeError: `X response silently suppressed: ${suppressedReason}`,
        updatedAt: Date.now(),
      });
      // No publication reservation, X API call, replacement reply, or retry.
      return { reserved: false, waitMs: 0, suppressedReason };
    }
    if (await suppressReadOnlyReply(ctx, interaction, true)) {
      return { reserved: false, waitMs: 0 };
    }
    if (publicationKey) {
      const prior = await ctx.db
        .query("xPublicationEvents")
        .withIndex("by_post_id", (q) => q.eq("postId", publicationKey))
        .order("desc")
        .first();
      // A published or uncertain follow-up must never be repeated. Explicit
      // X rejections remain retryable through the caller's bounded workflow.
      if (prior && prior.status !== "rejected")
        return { reserved: false, waitMs: 0 };
    } else if (
      interaction.publicationAttempted ||
      interaction.status === "publishing" ||
      interaction.responsePostId ||
      interaction.status === "completed" ||
      interaction.status === "rejected"
    )
      return { reserved: false, waitMs: 0 };
    const insufficientEthReply = isInsufficientEthReply(replyText ?? "");
    if (insufficientEthReply && await suppressInsufficientEthReply(ctx, interaction, publicationKey)) {
      return { reserved: false, waitMs: 0, suppressedReason: "insufficient_eth_reply_budget" };
    }
    const now = Date.now();
    const capacity = await publicationCapacity(ctx, now);
    const category = insufficientEthReply ? "insufficient_eth" : readOnlyReplyCategory(interaction);
    if (category && capacity.lowPriorityFull) {
      await rejectReadOnlyReply(ctx, interaction, category);
      return { reserved: false, waitMs: 0, suppressedReason: `${category}_reply_budget` };
    }
    const waitMs = capacity.waitMs;
    if (waitMs > 0) {
      if (category) {
        // Low-priority read-only responses never accumulate a publication backlog.
        await rejectReadOnlyReply(ctx, interaction, category);
        return { reserved: false, waitMs: 0 };
      }
      return { reserved: false, waitMs };
    }
    const eventId = await ctx.db.insert("xPublicationEvents", {
      postId: publicationKey || postId,
      replyCategory: category ?? "other",
      status: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    if (!publicationKey)
      await ctx.db.patch(interaction._id, {
        status: "publishing",
        publicationAttempted: true,
        updatedAt: now,
      });
    return { reserved: true, waitMs: 0, eventId };
  },
});

export const completePublicationEvent = internalMutation({
  args: {
    eventId: v.id("xPublicationEvents"),
    status: v.union(
      v.literal("published"),
      v.literal("rejected"),
      v.literal("uncertain"),
    ),
    responsePostId: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    limit: v.optional(v.number()),
    remaining: v.optional(v.number()),
    reset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.eventId, {
      status: args.status,
      responsePostId: args.responsePostId,
      httpStatus: args.httpStatus,
      error: args.error,
      rateLimit: args.limit,
      rateLimitRemaining: args.remaining,
      rateLimitReset: args.reset,
      updatedAt: Date.now(),
    });
  },
});

export const deferInteractionPublication = internalMutation({
  args: { postId: v.string(), delayMs: v.number(), safeError: v.string() },
  handler: async (ctx, { postId, delayMs, safeError }) => {
    const interaction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", postId))
      .unique();
    if (
      !interaction ||
      interaction.responsePostId ||
      interaction.status === "completed" ||
      interaction.status === "rejected"
    )
      return false;
    const nextRetryAt = Date.now() + Math.max(60_000, delayMs);
    await ctx.db.patch(interaction._id, {
      status: "failed",
      publicationAttempted: false,
      nextRetryAt,
      safeError,
      updatedAt: Date.now(),
    });
    return nextRetryAt;
  },
});

export const resetReplyPublication = internalMutation({
  args: { postId: v.string(), safeError: v.string() },
  handler: async (ctx, args) => {
    const interaction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", args.postId))
      .unique();
    if (interaction?.status === "publishing" && !interaction.responsePostId) {
      await ctx.db.patch(interaction._id, {
        status: "failed",
        publicationAttempted: false,
        safeError: args.safeError,
        updatedAt: Date.now(),
      });
    }
  },
});

export const bindInteractionIntent = internalMutation({
  args: { postId: v.string(), parsedIntentJson: v.string() },
  handler: async (ctx, args) => {
    if (args.parsedIntentJson.length > 8_000)
      throw new Error("parsed X intent is too large");
    decodePersistedXWalletIntent(args.parsedIntentJson);
    const interaction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", args.postId))
      .unique();
    if (!interaction) throw new Error("X interaction was not reserved");
    if (interaction.parsedIntentJson) return interaction.parsedIntentJson;
    await ctx.db.patch(interaction._id, {
      parsedIntentJson: args.parsedIntentJson,
      updatedAt: Date.now(),
    });
    return args.parsedIntentJson;
  },
});

export const markPublicationTerminalFailure = internalMutation({
  args: { postId: v.string(), safeError: v.string() },
  handler: async (ctx, args) => {
    const interaction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", args.postId))
      .unique();
    if (
      !interaction ||
      interaction.responsePostId ||
      interaction.status === "completed" ||
      interaction.status === "rejected"
    )
      return;
    await ctx.db.patch(interaction._id, {
      status: "failed",
      publicationAttempted: false,
      nextRetryAt: undefined,
      retryCount: Math.max(6, interaction.retryCount || 0),
      safeError: args.safeError,
      updatedAt: Date.now(),
    });
  },
});

export const markRateLimitPublicationRetry = internalMutation({
  args: {
    postId: v.string(),
    reason: v.string(),
    attempt: v.number(),
    nextRetryAt: v.number(),
  },
  handler: async (ctx, args) => {
    const interaction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", args.postId))
      .unique();
    if (
      !interaction ||
      interaction.responsePostId ||
      interaction.status === "completed" ||
      interaction.status === "rejected"
    )
      return;
    await ctx.db.patch(interaction._id, {
      status: "failed",
      commandKind: "rate_limited",
      publicationAttempted: false,
      retryCount: args.attempt,
      nextRetryAt: args.nextRetryAt,
      safeError: args.reason,
      updatedAt: Date.now(),
    });
  },
});

export const bindInteractionRecipient = internalMutation({
  args: {
    postId: v.string(),
    recipientXUserId: v.string(),
    recipientAddress: v.string(),
  },
  handler: async (ctx, args) => {
    const interaction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", args.postId))
      .unique();
    if (!interaction) throw new Error("X interaction was not reserved");
    if (interaction.recipientXUserId || interaction.recipientAddress) {
      if (
        interaction.recipientXUserId !== args.recipientXUserId ||
        interaction.recipientAddress?.toLowerCase() !==
          args.recipientAddress.toLowerCase()
      ) {
        throw new Error("X recipient binding mismatch");
      }
      return {
        recipientXUserId: interaction.recipientXUserId,
        recipientAddress: interaction.recipientAddress,
      };
    }
    await ctx.db.patch(interaction._id, {
      recipientXUserId: args.recipientXUserId,
      recipientAddress: args.recipientAddress,
      updatedAt: Date.now(),
    });
    return {
      recipientXUserId: args.recipientXUserId,
      recipientAddress: args.recipientAddress,
    };
  },
});

async function resolveXRecipient(
  ctx: ActionCtx,
  postId: string,
  recipient: string,
) {
  if (/^0x[a-fA-F0-9]{40}$/.test(recipient)) return recipient;
  const username = recipient.replace(/^@/, "");
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(username))
    throw new Error("invalid X recipient");
  const query = new URLSearchParams({
    "user.fields": "id,username,verified,verified_type,subscription_type",
  });
  const response = await xGet<{ data?: XUser }>(
    `/users/by/username/${encodeURIComponent(username)}`,
    query,
  );
  const user = response.data;
  if (!user?.id) throw new Error("that X account could not be found");
  await ctx.runMutation(internal.wallets.upsertXUser, {
    xUserId: user.id,
    username: user.username,
    verified: Boolean(user.verified),
    ...(user.verified_type ? { verifiedType: user.verified_type } : {}),
    ...(user.subscription_type
      ? { subscriptionType: user.subscription_type }
      : {}),
  });
  const wallet = await ctx.runAction(internal.wallets.ensureWallet, {
    xUserId: user.id,
  });
  if (!wallet?.address)
    throw new Error("the recipient wallet could not be prepared");
  const bound = await ctx.runMutation(
    internal.xReplies.bindInteractionRecipient,
    {
      postId,
      recipientXUserId: user.id,
      recipientAddress: wallet.address,
    },
  );
  return bound.recipientAddress;
}

export const resolveTerminalRecipient = internalAction({
  args: { recipient: v.string() },
  handler: async (ctx, { recipient }): Promise<string> => {
    if (/^0x[a-fA-F0-9]{40}$/.test(recipient)) return recipient;
    const username = recipient.replace(/^@/, "");
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(username))
      throw new Error("invalid X recipient");
    const response = await xGet<{ data?: XUser }>(
      `/users/by/username/${encodeURIComponent(username)}`,
      new URLSearchParams({
        "user.fields": "id,username,verified,verified_type,subscription_type",
      }),
    );
    const user = response.data;
    if (!user?.id) throw new Error("that X account could not be found");
    await ctx.runMutation(internal.wallets.upsertXUser, {
      xUserId: user.id,
      username: user.username,
      verified: Boolean(user.verified),
      ...(user.verified_type ? { verifiedType: user.verified_type } : {}),
      ...(user.subscription_type
        ? { subscriptionType: user.subscription_type }
        : {}),
    });
    const wallet = await ctx.runAction(internal.wallets.ensureWallet, {
      xUserId: user.id,
    });
    if (!wallet?.address)
      throw new Error("the recipient wallet could not be prepared");
    return wallet.address;
  },
});

async function fetchReferencedPhoto(postId: string) {
  if (!/^\d+$/.test(postId)) return undefined;
  const query = new URLSearchParams({
    expansions: "attachments.media_keys",
    "tweet.fields": "attachments",
    "media.fields": "media_key,type,url",
  });
  const response = await xGet<{
    data?: { attachments?: { media_keys?: string[] } };
    includes?: { media?: Media[] };
  }>(`/tweets/${postId}`, query, 5_000);
  return firstPhotoUrl(
    response.data?.attachments?.media_keys,
    response.includes?.media,
  );
}

async function prepareReferencedLaunchImage(
  ctx: ActionCtx,
  input: {
    postId: string;
    text: string;
    isLaunch: boolean;
    mediaUrl?: string;
    referencedPostId?: string;
    referencedPostType?: XReferenceType;
  },
): Promise<{ mediaUrl?: string; lookupFailed?: boolean }> {
  // A direct attachment (or an image already bound during an earlier attempt)
  // is final. Do not inspect phrases or touch a referenced post in that case.
  if (input.mediaUrl) return { mediaUrl: input.mediaUrl };
  if (
    !input.isLaunch ||
    !requestsReferencedLaunchImage(input.text) ||
    !input.referencedPostId ||
    !input.referencedPostType
  )
    return {};
  try {
    const mediaUrl = await fetchReferencedPhoto(input.referencedPostId);
    if (!mediaUrl) return {};
    const bound = await ctx.runMutation(
      internal.xReplies.bindInteractionMedia,
      {
        postId: input.postId,
        mediaUrl,
        mediaSource: input.referencedPostType,
        referencedPostId: input.referencedPostId,
      },
    );
    return { mediaUrl: bound };
  } catch (error) {
    console.error("x_referenced_image_lookup_failed", {
      postId: input.postId,
      referencedPostId: input.referencedPostId,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { lookupFailed: true };
  }
}

export const getRetryContext = internalQuery({
  args: { postId: v.string() },
  handler: async (ctx, { postId }) => {
    const interaction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", postId))
      .unique();
    if (!interaction) return null;
    const user = await ctx.db
      .query("xReplyUsers")
      .withIndex("by_x_user_id", (q) =>
        q.eq("xUserId", interaction.authorXUserId),
      )
      .unique();
    return { interaction, user };
  },
});

export const scheduleInteractionRetry = internalMutation({
  args: { postId: v.string(), safeError: v.string() },
  handler: async (ctx, args) => {
    const interaction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", args.postId))
      .unique();
    if (
      !interaction || interaction.publicationQueued ||
      interaction.status === "completed" ||
      interaction.status === "rejected"
    )
      return;
    // Once publication begins, a network or persistence failure is ambiguous:
    // X may already have accepted the reply. Never auto-republish it.
    if (interaction.status === "publishing") {
      await ctx.db.patch(interaction._id, {
        status: "failed",
        nextRetryAt: undefined,
        safeError: "reply publication outcome requires manual review",
        updatedAt: Date.now(),
      });
      return;
    }
    if (args.safeError === "claim workflow continuation required" || args.safeError === "automated fee workflow continuation required") {
      const delay = args.safeError === "automated fee workflow continuation required" ? 15_000 : 5_000;
      await ctx.db.patch(interaction._id, {
        status: "failed",
        nextRetryAt: Date.now() + delay,
        safeError: args.safeError,
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(delay, internal.xReplies.retryInteraction, {
        postId: args.postId,
      });
      return;
    }
    const retryCount = (interaction.retryCount || 0) + 1;
    if (retryCount > 5) {
      await ctx.db.patch(interaction._id, {
        status: "failed",
        retryCount,
        nextRetryAt: undefined,
        safeError: args.safeError,
        updatedAt: Date.now(),
      });
      return;
    }
    const delay = Math.min(15 * 60_000, 30_000 * 2 ** (retryCount - 1));
    await ctx.db.patch(interaction._id, {
      status: "failed",
      retryCount,
      nextRetryAt: Date.now() + delay,
      safeError: args.safeError,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(delay, internal.xReplies.retryInteraction, {
      postId: args.postId,
    });
  },
});

export const retryInteraction = internalAction({
  args: { postId: v.string() },
  handler: async (ctx, { postId }) => {
    if (!repliesEnabled()) return;
    const current = await ctx.runQuery(internal.xReplies.getRetryContext, {
      postId,
    });
    if (
      !current?.user ||
      current.interaction.publicationQueued ||
      ["completed", "rejected", "publishing"].includes(
        current.interaction.status,
      ) ||
      current.interaction.responsePostId ||
      (current.interaction.retryCount || 0) > 5
    )
      return;
    const floodGuard = await ctx.runMutation(internal.xFloodProtection.guardQueued, { postId });
    if (floodGuard.suppressed) return;
    if (
      standaloneMentionsEnabled() &&
      current.interaction.createdAt < standaloneMentionsSince()
    ) {
      await ctx.runMutation(internal.xReplies.updateInteraction, {
        postId,
        status: "rejected",
        safeError: "interaction predates temporary standalone-mention mode",
      });
      return;
    }
    // X can prepend every participant in a reply chain. Strip only that leading
    // invocation block; never read or append parent/quoted post text.
    const directText = directPostCommandText(current.interaction.text);
    const guidedHelpThread = await ctx.runQuery(internal.xReplies.guidedHelpContext, {
      ownerXUserId: current.user.xUserId,
      parentPostId: current.interaction.parentPostId,
    });
    if (guidedHelpThread && !guidedHelpThread.allowed) {
      await ctx.runMutation(internal.xReplies.updateInteraction, {
        postId, status: "rejected", commandKind: "guided_help_foreign_thread",
        safeError: "another account cannot continue this guided-help chain",
      });
      return;
    }
    const guidedHelp = guidedHelpThread?.allowed ? guidedHelpThread : null;
    const guidedClaimChoice = guidedHelp?.operation === "claim"
      ? guidedHelpClaimSelection(directText)
      : null;
    const guidedLpOfferChoice = guidedHelp?.operation === "claim_lp_offer"
      ? guidedHelpClaimLpOfferSelection(directText)
      : null;
    const guidedLiquidityText = guidedClaimChoice === "lp" || guidedLpOfferChoice === "lp"
      ? "claim LP fees"
      : directText;
    const guidedLaunchContinuation = guidedHelp?.operation === "launch";
    const lpThread = await ctx.runMutation(internal.liquidity.guardThread, { ownerXUserId: current.user.xUserId, parentPostId: current.interaction.parentPostId, postId, text: directText });
    if (lpThread) {
      if (lpThread === "redirect") {
        const { LIQUIDITY_RESPONSES } = await import("../lib/liquidity-responses");
        try {
          const responsePostId = await publishReplyOnce(ctx, LIQUIDITY_RESPONSES.foreignThread, postId, undefined, true, { kind: "liquidity" });
          await ctx.runMutation(internal.liquidity.guardThread, { ownerXUserId: current.user.xUserId, parentPostId: postId, postId: responsePostId, text: "" });
          await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "completed", commandKind: "liquidity", responsePostId });
        } catch (error) {
          if (!(error instanceof ReplyPublicationQueuedError || error instanceof ReplyPublicationSuppressedError || error instanceof ReplyPublicationUncertainError)) throw error;
        }
      } else await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "rejected", commandKind: "liquidity_foreign_thread" });
      return;
    }
    const liquidityContinuation = !guidedLaunchContinuation && !isOrdinaryWalletCommand(guidedLiquidityText) && await ctx.runQuery(internal.liquidity.isContinuation, { ownerXUserId: current.user.xUserId, parentPostId: current.interaction.parentPostId });
    const liquidityRequest = !guidedLaunchContinuation && (isLiquidityMessage(guidedLiquidityText) || liquidityContinuation || current.interaction.commandKind === "liquidity");
    if (liquidityRequest && !liquidityOwnerAllowed(current.user.xUserId)) {
      await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "rejected", commandKind: "liquidity_unavailable" }); return;
    }
    const houdiniDecision = parseXHoudiniDecision(directText);
    // Cross-chain swaps execute directly from the original, tightly parsed
    // command. Legacy quote replies must never revive an old pending quote.
    if (houdiniDecision && !liquidityRequest && guidedHelp?.operation !== "cross_chain_privacy"
      && guidedHelp?.operation !== "claim_lp_offer") {
      await ctx.runMutation(internal.xReplies.updateInteraction, {
        postId,
        status: "rejected",
        commandKind: "houdini_legacy_decision_ignored",
        safeError: "the X confirmation workflow has been retired",
      });
      return;
    }
    if (
      isPassiveBotChainReply(
        current.interaction.text,
        current.interaction.referencedPostId &&
          current.interaction.referencedPostType
          ? [
              {
                id: current.interaction.referencedPostId,
                type: current.interaction.referencedPostType,
              },
            ]
          : undefined,
      ) &&
      !shouldHandlePassiveChainText(directText) && !liquidityRequest && !guidedHelp
    ) {
      await ctx.runMutation(internal.xReplies.updateInteraction, {
        postId,
        status: "rejected",
        commandKind: "passive_chain",
        safeError: "passive conversation reply did not invoke the bot",
      });
      return;
    }
    if (shouldSuppressXResponse(directText)) {
      await ctx.runMutation(internal.xReplies.updateInteraction, {
        postId,
        status: "rejected",
        safeError: "response suppressed by user",
      });
      return;
    }
    await ctx.runMutation(internal.xReplies.updateInteraction, {
      postId,
      status: "processing",
      commandKind: guidedHelp ? guidedHelpCommandKind("root") : current.interaction.commandKind,
    });
    try {
      let guidedLaunchExecution: Extract<GuidedLaunchAdvance, { kind: "execute" }> | null = null;
      if (liquidityRequest) {
        // A first liquidity request is also a wallet-provisioning event, just
        // like other Pons Bot wallet commands. Continuations are idempotent.
        try { await ctx.runAction(internal.wallets.ensureWallet, { xUserId: current.user.xUserId }); }
        catch {
          const message = "⚠️ I couldn’t create your Pons Bot wallet just now. Reply with your liquidity request again shortly.";
          const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, true, { kind: "liquidity" });
          await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "completed", commandKind: "liquidity", responsePostId });
          return;
        }
        const result = await ctx.runAction(internal.liquidity.handle, { ownerXUserId: current.user.xUserId, source: "x", scope: `x:${current.user.xUserId}`, requestKey: `x:${postId}`, text: guidedLiquidityText, parentPostId: current.interaction.parentPostId });
        if (result.handled) {
          await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "processing", commandKind: "liquidity" });
          if (result.deferred) return;
          if (result.message && !result.silent) {
            const responsePostId = await publishReplyOnce(ctx, result.message, postId, undefined, true, { kind: "liquidity" });
            await ctx.runMutation(internal.liquidity.attachPrompt, { requestKey: `x:${postId}`, responsePostId });
            await ctx.runMutation(internal.xReplies.updateInteraction, {
              postId,
              status: "completed",
              responsePostId,
              ...(isGuidedHelpCompletion(result.message)
                ? { commandKind: guidedHelpCommandKind("root") }
                : {}),
            });
          } else await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "rejected" });
          return;
        }
      }
      if (guidedHelp && !guidedLaunchContinuation && guidedHelpCancelled(directText)) {
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId, status: "processing", commandKind: "guided_help:cancelled",
        });
        const message = "Guided help cancelled.";
        const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: true, kind: "reply" });
        await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "completed", responsePostId });
        return;
      }
      if (guidedHelp?.operation === "claim_lp_offer" && guidedLpOfferChoice === "cancel") {
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId, status: "processing", commandKind: "guided_help:cancelled",
        });
        const responsePostId = await publishReplyOnce(ctx, "Okay.", postId, undefined, false, { ok: true, kind: "reply" });
        await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "completed", responsePostId });
        return;
      }
      if (guidedHelp?.operation === "claim_lp_offer" && !guidedLpOfferChoice) {
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId, status: "processing", commandKind: guidedHelpCommandKind("claim_lp_offer"),
        });
        const responsePostId = await publishReplyOnce(ctx, CLAIM_LP_FEE_OFFER, postId, undefined, false, { ok: true, kind: "reply" });
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId, status: "completed", commandKind: guidedHelpCommandKind("claim_lp_offer"), responsePostId,
        });
        return;
      }
      if (guidedHelp?.operation === "claim" && guidedClaimChoice === "creator") {
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId, status: "processing", commandKind: guidedHelpCommandKind("claim_fees"),
        });
        const message = guidedHelpPrompt("claim_fees");
        const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: true, kind: "reply" });
        await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "completed", responsePostId });
        return;
      }
      if (guidedHelp?.operation === "root" && guidedLaunchRequested(directText)) {
        if (!guidedHelp.sourceExplicitMention) {
          const message = "🚀 Start the guided launch from a how-to reply that was requested with an explicit @Ponsbotfamily mention.";
          const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: false, kind: "reply" });
          await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "rejected", commandKind: guidedHelpCommandKind("root"), responsePostId, safeError: message });
          return;
        }
        if (!current.user.verified) {
          const message = "🔒 Token launches are currently available to verified X accounts. Once verified, you'll be ready to launch!";
          const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: false, kind: "reply" });
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "rejected", commandKind: guidedHelpCommandKind("root"), responsePostId, safeError: message,
          });
          return;
        }
        const launchWallet = await ctx.runQuery(internal.wallets.getXUserAndWallet, { xUserId: current.user.xUserId });
        if (launchWallet?.wallet?.launchEnabled === false) {
          const message = "❌ I couldn't complete that wallet request. Check the details, then reply with the request again!";
          const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: false, kind: "reply" });
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "rejected", commandKind: guidedHelpCommandKind("root"), responsePostId, safeError: "launch unavailable",
          });
          return;
        }
        const state = createGuidedLaunchState(true);
        const message = guidedLaunchPrompt("name");
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId, status: "processing", commandKind: guidedHelpCommandKind("launch"), guidedHelpStateJson: JSON.stringify(state),
        });
        const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: true, kind: "reply" });
        await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "completed", responsePostId, guidedHelpStateJson: JSON.stringify(state) });
        return;
      }
      if (guidedLaunchContinuation) {
        const state = decodeGuidedLaunchState(guidedHelp.guidedHelpStateJson);
        if (!state) {
          const message = "⚠️ This guided launch has expired or lost its place. Reply “launch” to the original how-to message to start again.";
          const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: false, kind: "reply" });
          await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "rejected", commandKind: guidedHelpCommandKind("root"), responsePostId, safeError: message });
          return;
        }
        const claimedStep = current.interaction.parentPostId && await ctx.runMutation(internal.xReplies.claimGuidedLaunchStep, {
          ownerXUserId: current.user.xUserId, parentPostId: current.interaction.parentPostId, consumerPostId: postId,
        });
        if (!claimedStep) {
          const message = "⚠️ That guided launch step was already answered. Continue from the newest Pons Bot prompt.";
          const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: false, kind: "reply" });
          await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "rejected", commandKind: "guided_help:stale", responsePostId, safeError: message });
          return;
        }
        let launchMediaUrl = current.interaction.mediaUrl;
        if (state.phase === "artwork" && !launchMediaUrl && requestsReferencedLaunchImage(directText)) {
          const prepared = await prepareReferencedLaunchImage(ctx, {
            postId, text: directText, isLaunch: true,
            mediaUrl: current.interaction.mediaUrl,
            referencedPostId: current.interaction.referencedPostId,
            referencedPostType: current.interaction.referencedPostType,
          });
          if (prepared.lookupFailed) {
            const message = `${REFERENCED_IMAGE_FAILURE}\n\n${guidedLaunchPrompt("artwork")}`;
            await ctx.runMutation(internal.xReplies.updateInteraction, {
              postId, status: "processing", commandKind: guidedHelpCommandKind("launch"), guidedHelpStateJson: JSON.stringify(state),
            });
            const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: false, kind: "reply" });
            await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "completed", responsePostId, guidedHelpStateJson: JSON.stringify(state) });
            return;
          }
          launchMediaUrl = prepared.mediaUrl;
        }
        const advanced = advanceGuidedLaunch(state, directText, launchMediaUrl);
        if (advanced.kind === "cancelled") {
          const responsePostId = await publishReplyOnce(ctx, advanced.message, postId, undefined, false, { ok: true, kind: "reply" });
          await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "completed", commandKind: "guided_help:cancelled", responsePostId });
          return;
        }
        if (advanced.kind === "prompt") {
          const stateJson = JSON.stringify(advanced.state);
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "processing", commandKind: guidedHelpCommandKind("launch"), guidedHelpStateJson: stateJson,
          });
          const responsePostId = await publishReplyOnce(ctx, advanced.message, postId, undefined, advanced.allowLong === true, { ok: true, kind: "reply" });
          await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "completed", responsePostId, guidedHelpStateJson: stateJson });
          return;
        }
        guidedLaunchExecution = advanced;
      }
      const guidedSelection = guidedHelp && !guidedLaunchExecution ? guidedHelpSelection(directText) : null;
      const immediateGuidedCommand = guidedHelpImmediateCommand(guidedSelection);
      if (guidedSelection && !immediateGuidedCommand) {
        const reassignState = guidedSelection === "reassign_fees"
          ? JSON.stringify({ version: 1, type: "reassign_fees" })
          : undefined;
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId, status: "processing", commandKind: guidedHelpCommandKind(guidedSelection),
          ...(reassignState ? { guidedHelpStateJson: reassignState } : {}),
        });
        const message = guidedSelection === "reassign_fees"
          ? GUIDED_REASSIGN_TOKEN_PROMPT
          : guidedHelpPrompt(guidedSelection);
        const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: true, kind: "reply" });
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId, status: "completed", responsePostId,
          ...(reassignState ? { guidedHelpStateJson: reassignState } : {}),
        });
        return;
      }
      let guidedReassignCommand: string | null = null;
      if (guidedHelp?.operation === "reassign_fees") {
        const state = decodeGuidedReassignState(guidedHelp.guidedHelpStateJson);
        if (!state?.token) {
          if (guidedHelpQuestion(directText)) {
            const message = `${guidedHelpExplanation("reassign_fees")}\n\n${GUIDED_REASSIGN_TOKEN_PROMPT}`;
            const stateJson = JSON.stringify(state || { version: 1, type: "reassign_fees" });
            const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: true, kind: "reply" });
            await ctx.runMutation(internal.xReplies.updateInteraction, {
              postId, status: "completed", commandKind: guidedHelpCommandKind("reassign_fees"),
              guidedHelpStateJson: stateJson, responsePostId,
            });
            return;
          }
          const token = guidedReassignTokenSelection(directText);
          if (!token) {
            const stateJson = JSON.stringify(state || { version: 1, type: "reassign_fees" });
            const responsePostId = await publishReplyOnce(ctx, GUIDED_REASSIGN_TOKEN_PROMPT, postId, undefined, false, { ok: true, kind: "reply" });
            await ctx.runMutation(internal.xReplies.updateInteraction, {
              postId, status: "completed", commandKind: guidedHelpCommandKind("reassign_fees"),
              guidedHelpStateJson: stateJson, responsePostId,
            });
            return;
          }
          const stateJson = JSON.stringify({ version: 1, type: "reassign_fees", token });
          const responsePostId = await publishReplyOnce(ctx, guidedHelpPrompt("reassign_fees"), postId, undefined, false, { ok: true, kind: "reply" });
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "completed", commandKind: guidedHelpCommandKind("reassign_fees"),
            guidedHelpStateJson: stateJson, responsePostId,
          });
          return;
        }
        if (guidedHelpQuestion(directText)) {
          const message = guidedHelpQuestionResponse("reassign_fees");
          const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: true, kind: "reply" });
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "completed", commandKind: guidedHelpCommandKind("reassign_fees"),
            guidedHelpStateJson: JSON.stringify(state), responsePostId,
          });
          return;
        }
        const recipient = guidedReassignRecipientSelection(directText);
        if (!recipient) {
          const responsePostId = await publishReplyOnce(ctx, guidedHelpPrompt("reassign_fees"), postId, undefined, false, { ok: true, kind: "reply" });
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "completed", commandKind: guidedHelpCommandKind("reassign_fees"),
            guidedHelpStateJson: JSON.stringify(state), responsePostId,
          });
          return;
        }
        guidedReassignCommand = `reassign ${state.token} fees to ${recipient}`;
      }
      const gasResumeState = decodeGasResumeState(current.interaction.guidedHelpStateJson);
      let workflowText = gasResumeState?.sourceText || guidedLaunchExecution?.commandText || immediateGuidedCommand || (guidedHelp
        ? guidedReassignCommand || guidedHelpCommandText(directText, guidedHelp.operation)
        : directText);
      if (guidedHelp?.operation === "cross_chain_privacy") {
        const privacy = guidedHelpPrivacySelection(directText);
        if (!privacy) {
          const message = guidedHelpPrompt("cross_chain_privacy");
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "processing", commandKind: guidedHelpCommandKind("cross_chain_privacy"),
          });
          const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: true, kind: "reply" });
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "completed", commandKind: guidedHelpCommandKind("cross_chain_privacy"), responsePostId,
          });
          return;
        }
        const sourceCommand = guidedHelpCommandText(guidedHelp.sourceText, "cross_chain");
        workflowText = privacy === "private" && !/\bprivat(?:e|ely)\b/i.test(sourceCommand)
          ? `private ${sourceCommand}`
          : sourceCommand;
      }
      const houdiniCommand = parseXHoudiniCommand(workflowText);
      if (houdiniCommand) {
        if (guidedHelp && !houdiniCommand.privateMode
          && (guidedHelp.operation === "root" || guidedHelp.operation === "cross_chain")) {
          const message = guidedHelpPrompt("cross_chain_privacy");
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "processing", commandKind: guidedHelpCommandKind("cross_chain_privacy"),
          });
          const responsePostId = await publishReplyOnce(ctx, message, postId, undefined, false, { ok: true, kind: "reply" });
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "completed", commandKind: guidedHelpCommandKind("cross_chain_privacy"), responsePostId,
          });
          return;
        }
        if (
          !hasExplicitBotMention(
            current.interaction.text,
            current.interaction.referencedPostId &&
              current.interaction.referencedPostType
              ? [
                  {
                    id: current.interaction.referencedPostId,
                    type: current.interaction.referencedPostType,
                  },
                ]
              : undefined,
          ) && !guidedHelp?.sourceExplicitMention
        ) {
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId,
            status: "rejected",
            commandKind: "houdini_missing_direct_mention",
            safeError:
              "cross-chain request did not explicitly mention @Ponsbotfamily",
          });
          return;
        }
        const quoteLimit = await ctx.runMutation(
          internal.xHoudini.consumeQuoteLimit,
          { ownerXUserId: current.user.xUserId },
        );
        if (!quoteLimit.allowed) {
          const responsePostId = await publishReplyOnce(
            ctx,
            "⏳ You've requested several cross-chain swaps. Please wait a few minutes, then reply with the request again.",
            postId,
          );
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId,
            status: "rejected",
            commandKind: guidedHelpCommandKind("root"),
            responsePostId,
            safeError: "Houdini quote rate limit reached",
          });
          return;
        }
        const wallet = await ctx.runAction(internal.wallets.ensureWallet, {
          xUserId: current.user.xUserId,
        });
        if (!wallet?.address)
          throw new Error("the wallet could not be prepared");
        let quote;
        try {
          quote = await ctx.runAction(internal.xHoudini.createQuote, {
            requestPostId: postId,
            ownerXUserId: current.user.xUserId,
            walletAddress: wallet.address,
            commandJson: workflowText,
          });
        } catch (error) {
          const minimumAmount = houdiniMinimumAmountReply(error);
          const unavailable =
            error instanceof Error &&
            /destination is not currently available|did not return a usable quote/i.test(
              error.message,
            );
          const message =
            (isEmptyNativeGasBalanceError(error) ? noNativeGasMessage(wallet.address, "complete this cross-chain swap") : undefined) || minimumAmount ||
            (unavailable
              ? "⚠️ Houdini doesn't currently have a usable route for that destination. Reply with the full request using another supported asset or network."
              : "❌ I couldn't prepare that cross-chain route right now. No funds were moved. Reply with the request again shortly.");
          const responsePostId = await publishReplyOnce(ctx, message, postId);
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId,
            status: "rejected",
            commandKind: guidedHelpCommandKind("root"),
            responsePostId,
            safeError: message,
            ...(isEmptyNativeGasBalanceError(error) ? { guidedHelpStateJson: JSON.stringify({
              type: "gas_resume", sourceText: workflowText.slice(0, 800), explicitMentionAuthorized: true,
            }) } : {}),
          });
          return;
        }
        const activated = await ctx.runMutation(
          internal.xHoudini.startImmediateExecution,
          {
            quoteId: quote.quoteId as any,
            ownerXUserId: current.user.xUserId,
            sourcePostId: postId,
          },
        );
        if (!activated)
          throw new Error("the Houdini quote could not be reserved safely");
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId,
          status: "processing",
          commandKind: guidedHelp
            ? guidedHelpPendingCommandKind("houdini")
            : "houdini_execute",
        });
        await ctx.scheduler.runAfter(0, internal.xHoudini.executeConfirmed, {
          quoteId: quote.quoteId as any,
          confirmationPostId: postId,
          walletAddress: wallet.address,
          ownerXUserId: current.user.xUserId,
        });
        return;
      }
      if (looksLikeXHoudiniCommand(workflowText)) {
        const responsePostId = await publishReplyOnce(
          ctx,
          "⚠️ I couldn't safely read that cross-chain request. Reply with the full request, such as “Send $25 to WALLET ADDRESS as ASSET on CHAIN” or “Private send 0.01 ETH to WALLET ADDRESS as ETH on Base.”",
          postId,
        );
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId,
          status: "rejected",
          commandKind: guidedHelpCommandKind("root"),
          responsePostId,
          safeError: "strict cross-chain format validation failed",
        });
        return;
      }
      if (straightforwardCommandOperation(workflowText) === "upgrade_fees"
        && !automatedFeeUpgradeCommandsEnabled()) {
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId,
          status: "rejected",
          commandKind: "automated_fee_upgrade_unreleased",
          safeError: "automated fee upgrade requests are not publicly enabled",
        });
        return;
      }
      let intent: XWalletIntent;
      if (guidedLaunchExecution) {
        intent = { kind: "command", command: guidedLaunchExecution.command };
      } else if (current.interaction.parsedIntentJson) {
        intent = decodePersistedXWalletIntent(
          current.interaction.parsedIntentJson,
        );
      } else {
        const parsed = await parseXWalletIntent(
          workflowText,
          Boolean(current.interaction.mediaUrl),
        );
        const bound = await ctx.runMutation(
          internal.xReplies.bindInteractionIntent,
          {
            postId,
            parsedIntentJson: JSON.stringify(parsed),
          },
        );
        intent = decodePersistedXWalletIntent(bound);
      }
      // Recheck parsed wallet-address intent before provisioning; balance/help
      // have no category admission budgets.
      const parsedBudget = await ctx.runMutation(internal.xFloodProtection.guardQueued, { postId });
      if (parsedBudget.suppressed) return;
      if (intent.kind === "command" && intent.command.kind === "upgrade_fees"
        && !automatedFeeUpgradeCommandsEnabled()) {
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId,
          status: "rejected",
          commandKind: "automated_fee_upgrade_unreleased",
          safeError: "automated fee upgrade requests are not publicly enabled",
        });
        return;
      }
      let reply: string;
      let ok = true;
      let guidedContinuationOperation: Exclude<NonNullable<typeof guidedHelp>["operation"], "root"> | null = null;
      if (
        intent.kind === "command" &&
        intent.command.kind === "launch" &&
        !launchPostAuthorized(
          current.interaction.text,
          current.interaction.referencedPostId &&
            current.interaction.referencedPostType
            ? [
                {
                  id: current.interaction.referencedPostId,
                  type: current.interaction.referencedPostType,
                },
              ]
            : undefined,
          current.interaction.botParentAuthorized === true,
        ) &&
        !guidedLaunchExecution?.state.explicitMentionAuthorized &&
        !gasResumeAuthorized(current.interaction.guidedHelpStateJson)
      ) {
        // Reject silently. This is a safety boundary, not a prompt for another
        // automated reply inside a conversation that did not invoke the bot.
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId,
          status: "rejected",
          commandKind: "launch_missing_direct_mention",
          safeError: "launch post did not explicitly mention @Ponsbotfamily",
        });
        return;
      }
      if (current.interaction.nestedReply && intent.kind !== "command" && !guidedHelp) {
        await ctx.runMutation(internal.xReplies.updateInteraction, {
          postId,
          status: "rejected",
          commandKind: "nested_reply_suppressed",
          safeError:
            "non-executable nested reply was intentionally not published",
        });
        return;
      }
      if (intent.kind === "irrelevant") {
        if (!guidedHelp) {
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId,
            status: "rejected",
            commandKind: "irrelevant_suppressed",
            safeError:
              "irrelevant conversational response intentionally not published",
          });
          return;
        }
        if (guidedHelp.operation !== "root" && guidedHelpQuestion(directText)) {
          guidedContinuationOperation = guidedHelp.operation;
          reply = guidedHelpQuestionResponse(guidedHelp.operation);
        } else reply = X_GENERAL_GUIDED_HELP_MESSAGE;
      } else if (intent.kind === "help") {
        const guidedOperation = guidedHelp
          ? guidedHelpOperationFromHelp(directText, intent.topic)
          : null;
        if (guidedHelp && guidedHelp.operation !== "root" && intent.topic !== "capabilities") {
          guidedContinuationOperation = guidedHelp.operation;
          reply = guidedHelpQuestionResponse(
            guidedHelp.operation,
            await helpReply(ctx, intent.topic),
          );
        } else if (intent.topic === "capabilities") {
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "processing", commandKind: guidedHelpCommandKind("root"),
          });
          reply = X_GENERAL_GUIDED_HELP_MESSAGE;
        } else if (intent.topic === "launch") {
          // A launch-help response is also the parent prompt for the guided
          // launch flow. Persist the owner-bound root marker before queuing the
          // response so an affirmative reply can safely start at the name step.
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "processing", commandKind: guidedHelpCommandKind("root"),
          });
          reply = await helpReply(ctx, intent.topic);
        } else if (guidedOperation) {
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "processing", commandKind: guidedHelpCommandKind(guidedOperation),
          });
          reply = guidedHelpPrompt(guidedOperation);
        } else reply = await helpReply(ctx, intent.topic);
      }
      else if (intent.kind === "unknown_wallet") {
        if (guidedHelp?.operation && guidedHelp.operation !== "root") {
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId, status: "processing", commandKind: guidedHelpCommandKind(guidedHelp.operation),
          });
          guidedContinuationOperation = guidedHelp.operation;
          reply = guidedHelpQuestion(directText)
            ? guidedHelpQuestionResponse(guidedHelp.operation)
            : guidedHelpPrompt(guidedHelp.operation);
        } else {
        if (standaloneMentionsEnabled()) {
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId,
            status: "rejected",
            commandKind: "ambiguous_suppressed",
            safeError:
              "generic ambiguity response suppressed in standalone-mention mode",
          });
          return;
        }
        reply = unknownWalletMessage();
        ok = false;
        }
      } else {
        const preparedMedia = guidedLaunchExecution
          ? { mediaUrl: guidedLaunchExecution.imageUrl, lookupFailed: false }
          : await prepareReferencedLaunchImage(ctx, {
              postId,
              text: directText,
              isLaunch: intent.command.kind === "launch",
              mediaUrl: current.interaction.mediaUrl,
              referencedPostId: current.interaction.referencedPostId,
              referencedPostType: current.interaction.referencedPostType,
            });
        if (preparedMedia.lookupFailed) {
          // Reaching this point means the direct post was accepted as an
          // executable launch command. Return its specific media error even in
          // a restricted reply chain; passive chatter and non-command intents
          // have already been discarded above.
          const responsePostId = await publishReplyOnce(
            ctx,
            REFERENCED_IMAGE_FAILURE,
            postId,
          );
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId,
            status: "rejected",
            commandKind: guidedHelpCommandKind("root"),
            responsePostId,
            safeError: "referenced image could not be prepared",
          });
          return;
        }
        await ctx.runAction(internal.wallets.ensureWallet, {
          xUserId: current.user.xUserId,
        });
        const recipient =
          intent.command.kind === "send" ||
          intent.command.kind === "buy_and_send" ||
          intent.command.kind === "reassign_fees"
            ? intent.command.recipient
            : intent.command.kind === "launch"
              ? intent.command.feeRecipient
              : undefined;
        const recipientAddress =
          recipient && recipient.toLowerCase() !== "holders"
            ? current.interaction.recipientAddress ||
              (/^0x[a-fA-F0-9]{40}$/.test(recipient)
                ? recipient
                : await resolveXRecipient(ctx, postId, recipient))
            : undefined;
        const result = await ctx.runAction(internal.wallets.executeCommand, {
          sourcePostId: postId,
          xUserId: current.user.xUserId,
          text: workflowText,
          parsedCommandJson: JSON.stringify(intent.command),
          ...(preparedMedia.mediaUrl
            ? { mediaUrl: preparedMedia.mediaUrl }
            : {}),
          ...(recipientAddress ? { recipientAddress } : {}),
        });
        if (result.pending || result.deferred) {
          await ctx.runMutation(internal.xReplies.scheduleInteractionRetry, {
            postId,
            safeError: intent.command.kind === "upgrade_fees" || intent.command.kind === "reassign_fees"
              ? AUTOMATED_FEE_WORKFLOW_CONTINUATION
              : intent.command.kind === "claim_fees" ? "claim workflow continuation required" : "wallet confirmation is pending",
          });
          return;
        }
        reply = result.message;
        ok = result.ok;
      }
      // Specific failures from genuine commands are useful and safe to return.
      // Restricted reply chains still suppress chatter, help, ambiguity, and
      // non-command intents before wallet execution, but no longer hide a
      // validation or execution error for an admitted command.
      // Multi-vault receipts and the requested V2 reminder must not be silently
      // clipped to 280 characters. These are templated financial results, not
      // unbounded model output; use the existing long-response queue support.
      const guidedCommandCompleted = Boolean(
        guidedHelp && ok && intent.kind === "command" && !reply.trim().endsWith(CLAIM_LP_FEE_OFFER),
      );
      const failedCommandContinuation = Boolean(guidedHelp && !ok && intent.kind === "command");
      if (guidedCommandCompleted) reply = withGuidedHelpCompletion(reply);
      // Top-five results intentionally contain five independently readable
      // result blocks and token links. They are eligible for X long-post
      // publishing instead of being compressed into a 280-character reply.
      const longCommandResult = intent.kind === "command" &&
        (intent.command.kind === "claim_fees" || intent.command.kind === "buy_top_five");
      const outcomeCommandKind = reply.trim().endsWith(CLAIM_LP_FEE_OFFER)
        ? guidedHelpCommandKind("claim_lp_offer")
        : guidedCommandCompleted || failedCommandContinuation
          ? guidedHelpCommandKind("root")
          : guidedContinuationOperation
            ? guidedHelpCommandKind(guidedContinuationOperation)
            : undefined;
      const gasResumeStateJson = isInsufficientEthReply(reply) && intent.kind === "command"
        ? JSON.stringify({
            type: "gas_resume", sourceText: workflowText.slice(0, 800),
            explicitMentionAuthorized: current.interaction.botParentAuthorized === true || hasExplicitBotMention(current.interaction.text, undefined) || Boolean(guidedHelp?.sourceExplicitMention),
          })
        : undefined;
      if (outcomeCommandKind || gasResumeStateJson) await ctx.runMutation(internal.xReplies.updateInteraction, {
        postId, status: "processing", ...(outcomeCommandKind ? { commandKind: outcomeCommandKind } : {}),
        ...(gasResumeStateJson ? { guidedHelpStateJson: gasResumeStateJson } : {}),
        ...(!ok ? { safeError: reply } : {}),
      });
      const responsePostId = await publishReplyOnce(ctx, reply, postId, undefined, longCommandResult || guidedCommandCompleted, {
        ok,
        // A completed on-chain action must outrank prompts even though it was
        // initiated inside a B-tier guided conversation.
        kind: guidedCommandCompleted ? "guided_execution" : "reply",
      });
      await ctx.runMutation(internal.xReplies.updateInteraction, {
        postId,
        status: ok ? "completed" : "rejected",
        responsePostId,
        ...(outcomeCommandKind ? { commandKind: outcomeCommandKind } : {}),
        ...(gasResumeStateJson ? { guidedHelpStateJson: gasResumeStateJson } : {}),
        ...(!ok ? { safeError: reply } : {}),
      });
    } catch (error) {
      if (error instanceof ReplyPublicationSuppressedError || error instanceof ReplyPublicationQueuedError) return;
      console.error("x_reply_retry_failed", {
        postId,
        message: error instanceof Error ? error.message : "unknown",
      });
      if (error instanceof ReplyPublicationUncertainError) return;
      if (error instanceof ReplyPublicationDeferredError) {
        const delay = error.waitMs;
        const nextRetryAt = await ctx.runMutation(
          internal.xReplies.deferInteractionPublication,
          {
            postId,
            delayMs: delay,
            safeError: "queued by X publication pacing",
          },
        );
        if (nextRetryAt)
          await ctx.scheduler.runAfter(
            Math.max(60_000, delay),
            internal.xReplies.retryInteraction,
            { postId },
          );
        return;
      }
      if (
        error instanceof ReplyPublicationRejectedError &&
        temporarilyWriteRestricted(error.status, error.message)
      ) {
        await ctx.runMutation(
          internal.xReplies.markPublicationTerminalFailure,
          {
            postId,
            safeError: `X explicitly rejected the reply (${error.status}); automatic replay disabled`,
          },
        );
        return;
      }
      if (error instanceof ReplyPublicationRejectedError && !error.retryable) {
        await ctx.runMutation(
          internal.xReplies.markPublicationTerminalFailure,
          {
            postId,
            safeError: `X explicitly rejected the reply (${error.status})`,
          },
        );
        return;
      }
      await ctx.runMutation(internal.xReplies.scheduleInteractionRetry, {
        postId,
        safeError:
          isAutomatedFeeWorkflowContinuation(error) ? AUTOMATED_FEE_WORKFLOW_CONTINUATION
            : error instanceof Error && error.message === "claim workflow continuation required" ? error.message
            : "the reply workflow failed before confirmation",
      });
    }
  },
});

export const deliverLiquidityResult = internalAction({
  args: { postId: v.string(), executionId: v.id("liquidityExecutions") },
  handler: async (ctx, args): Promise<boolean> => {
    const context = await ctx.runQuery(internal.liquidity.executionContext, { executionId: args.executionId });
    if (!context?.execution.response || context.turn?.requestKey !== `x:${args.postId}` || !liquidityOwnerAllowed(context.execution.ownerXUserId)) return false;
    const current = await ctx.runQuery(internal.xReplies.getRetryContext, { postId: args.postId });
    if (!current?.user || current.user.xUserId !== context.execution.ownerXUserId) return false;
    const handedOff = (interaction: typeof current.interaction) => Boolean(interaction.responsePostId || interaction.publicationQueued
      || ["completed", "rejected", "publishing"].includes(interaction.status));
    // Terminal/cancelled interactions must stay terminal. A queued/publication
    // reservation is already owned by X's deduplicated delivery machinery.
    if (handedOff(current.interaction)) return true;
    // Reuse the normal publication reservation/retry logic. The saved LP turn
    // supplies the final result; it cannot restart the underlying operation.
    await ctx.runAction(internal.xReplies.retryInteraction, { postId: args.postId });
    const after = await ctx.runQuery(internal.xReplies.getRetryContext, { postId: args.postId });
    return Boolean(after && handedOff(after.interaction));
  },
});

// A verified operator recovery may complete after the original partial-failure
// reply was already published. Queue one idempotent success reply to the same
// confirmation post without reopening the command or replaying wallet work.
export const publishLiquidityRecoveryOutcome = internalAction({
  args: { postId: v.string(), text: v.string(), executionId: v.id("liquidityExecutions") },
  handler: async (ctx, args) => {
    try {
      await publishReplyOnce(ctx, args.text, args.postId, `liquidity-recovery:${args.executionId}`, true, { ok: true, kind: "liquidity" });
    } catch (error) {
      // Queued replies are already owned by the durable X outbox. Any terminal
      // suppression remains visible in that queue and must not resend here.
      if (error instanceof ReplyPublicationQueuedError || error instanceof ReplyPublicationSuppressedError) return;
      throw error;
    }
  },
});

export const publishHoudiniOutcome = internalAction({
  args: {
    postId: v.string(),
    text: v.string(),
    ok: v.boolean(),
    publicationKey: v.optional(v.string()),
    houdiniQuoteId: v.optional(v.id("xHoudiniQuotes")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: "queued" | "published" | "deferred" | "uncertain" | "rejected";
    responsePostId?: string;
    waitMs?: number;
    retryable?: boolean;
    error?: string;
  }> => {
    try {
      const current = await ctx.runQuery(internal.xReplies.getRetryContext, {
        postId: args.postId,
      });
      const guidedCompletion = Boolean(
        args.ok && isGuidedHelpPendingCommandKind(current?.interaction.commandKind),
      );
      const replyText = guidedCompletion
        ? withGuidedHelpCompletion(args.text)
        : args.text;
      const responsePostId = await publishReplyOnce(
        ctx,
        replyText,
        args.postId,
        args.publicationKey,
        guidedCompletion,
        { ok: args.ok, kind: "houdini_final", houdiniQuoteId: args.houdiniQuoteId },
      );
      await ctx.runMutation(internal.xReplies.updateInteraction, {
        postId: args.postId,
        status: args.ok ? "completed" : "rejected",
        commandKind: guidedCompletion
          ? guidedHelpCommandKind("root")
          : "houdini_result",
        responsePostId,
        ...(!args.ok ? { safeError: replyText } : {}),
      });
      return { status: "published", responsePostId };
    } catch (error) {
      if (error instanceof ReplyPublicationQueuedError) return { status: "queued" };
      if (error instanceof ReplyPublicationSuppressedError)
        return { status: "rejected", retryable: false, error: `X response silently suppressed: ${error.message}` };
      if (error instanceof ReplyPublicationDeferredError)
        return { status: "deferred", waitMs: error.waitMs };
      if (error instanceof ReplyPublicationRejectedError)
        return {
          status: "rejected",
          retryable: error.retryable,
          error: error.message,
        };
      return {
        status: "uncertain",
        error:
          error instanceof Error
            ? error.message
            : "X publication outcome is unknown",
      };
    }
  },
});

export const publishHoudiniProgress = internalAction({
  args: { postId: v.string(), text: v.string(), houdiniQuoteId: v.optional(v.id("xHoudiniQuotes")) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: "queued" | "published" | "deferred" | "uncertain" | "rejected";
    responsePostId?: string;
    waitMs?: number;
    retryable?: boolean;
    error?: string;
  }> => {
    try {
      const responsePostId = await publishReplyOnce(ctx, args.text, args.postId, undefined, false, { kind: "houdini_progress", ok: true, houdiniQuoteId: args.houdiniQuoteId });
      return { status: "published", responsePostId };
    } catch (error) {
      if (error instanceof ReplyPublicationQueuedError) return { status: "queued" };
      if (error instanceof ReplyPublicationSuppressedError)
        return { status: "rejected", retryable: false, error: `X response silently suppressed: ${error.message}` };
      if (error instanceof ReplyPublicationDeferredError)
        return { status: "deferred", waitMs: error.waitMs };
      if (error instanceof ReplyPublicationRejectedError)
        return {
          status: "rejected",
          retryable: error.retryable,
          error: error.message,
        };
      return {
        status: "uncertain",
        error: error instanceof Error ? error.message : "X outcome is unknown",
      };
    }
  },
});

/** Manually replays replies that X explicitly rejected during a temporary write outage. */
export const replayRejectedPublicationsSince = internalMutation({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    const failed = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .collect();
    const candidates = failed
      .filter(
        (interaction) =>
          interaction.createdAt >= since &&
          interaction.safeError === "X explicitly rejected the reply (403)" &&
          !interaction.responsePostId,
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    const now = Date.now();
    for (const [index, interaction] of candidates.entries()) {
      await ctx.db.patch(interaction._id, {
        status: "failed",
        retryCount: 0,
        nextRetryAt: now + index * 3_000,
        publicationAttempted: false,
        safeError: "manual replay after temporary X write rejection",
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        index * 3_000,
        internal.xReplies.retryInteraction,
        { postId: interaction.postId },
      );
    }
    return {
      scheduled: candidates.length,
      postIds: candidates.map((interaction) => interaction.postId),
    };
  },
});

export const resumeRejectedPublication = internalMutation({
  args: { postId: v.string() },
  handler: async (ctx, { postId }) => {
    const interaction = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_post_id", (q) => q.eq("postId", postId))
      .unique();
    if (
      !interaction ||
      interaction.responsePostId ||
      interaction.status === "completed" ||
      interaction.status === "rejected"
    )
      return false;
    await ctx.db.patch(interaction._id, {
      status: "failed",
      retryCount: 0,
      nextRetryAt: Date.now(),
      publicationAttempted: false,
      safeError: "deferred manual replay after X write window",
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.xReplies.retryInteraction, {
      postId,
    });
    return true;
  },
});

export const deferRejectedPublicationsSince = internalMutation({
  args: { since: v.number(), delayMs: v.number(), spacingMs: v.number() },
  handler: async (ctx, { since, delayMs, spacingMs }) => {
    const failed = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .collect();
    const candidates = failed.filter(
      (interaction) =>
        interaction.createdAt >= since &&
        !interaction.responsePostId &&
        (interaction.safeError === "X explicitly rejected the reply (403)" ||
          interaction.safeError ===
            "manual replay after temporary X write rejection" ||
          interaction.safeError === "deferred after renewed X write rejection"),
    );
    const now = Date.now();
    for (const [index, interaction] of candidates
      .sort((a, b) => a.createdAt - b.createdAt)
      .entries()) {
      const scheduledAt = now + delayMs + index * spacingMs;
      await ctx.db.patch(interaction._id, {
        status: "failed",
        retryCount: 6,
        nextRetryAt: scheduledAt,
        publicationAttempted: false,
        safeError: "deferred after renewed X write rejection",
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(
        delayMs + index * spacingMs,
        internal.xReplies.resumeRejectedPublication,
        { postId: interaction.postId },
      );
    }
    return { deferred: candidates.length };
  },
});

/** Cancels stale scheduled/publication retries while preserving audit rows. */
export const cancelPublicationBacklogBefore = internalMutation({
  args: { before: v.number() },
  handler: async (ctx, { before }) => {
    const failed = await ctx.db
      .query("xReplyInteractions")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .collect();
    const candidates = failed.filter(
      (interaction) =>
        interaction.createdAt < before &&
        !interaction.responsePostId &&
        (interaction.nextRetryAt !== undefined ||
          /X explicitly rejected|temporary X write restriction|manual replay|deferred after renewed X write rejection|queued by X publication pacing/i.test(
            interaction.safeError || "",
          )),
    );
    const now = Date.now();
    for (const interaction of candidates) {
      await ctx.db.patch(interaction._id, {
        status: "rejected",
        nextRetryAt: undefined,
        publicationAttempted: true,
        safeError: "stale X publication backlog cancelled",
        updatedAt: now,
      });
    }
    return { cancelled: candidates.length };
  },
});

export const publishRateLimitNotice = internalAction({
  args: {
    postId: v.string(),
    reason: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!repliesEnabled()) return;
    const attempt = args.attempt || 0;
    try {
      const responsePostId = await publishReplyOnce(
        ctx,
        rateLimitMessage(args.reason),
        args.postId,
      );
      await ctx.runMutation(internal.xReplies.updateInteraction, {
        postId: args.postId,
        status: "rejected",
        commandKind: "rate_limited",
        responsePostId,
        safeError: args.reason,
      });
    } catch (error) {
      if (error instanceof ReplyPublicationUncertainError || error instanceof ReplyPublicationSuppressedError || error instanceof ReplyPublicationQueuedError) return;
      if (error instanceof ReplyPublicationDeferredError) {
        const delay = error.waitMs;
        const nextRetryAt = await ctx.runMutation(
          internal.xReplies.deferInteractionPublication,
          {
            postId: args.postId,
            delayMs: delay,
            safeError: "rate-limit notice queued by X publication pacing",
          },
        );
        if (nextRetryAt)
          await ctx.scheduler.runAfter(
            Math.max(60_000, delay),
            internal.xReplies.publishRateLimitNotice,
            {
              postId: args.postId,
              reason: args.reason,
              attempt,
            },
          );
        return;
      }
      if (
        error instanceof ReplyPublicationRejectedError &&
        temporarilyWriteRestricted(error.status, error.message)
      ) {
        await ctx.runMutation(
          internal.xReplies.markPublicationTerminalFailure,
          {
            postId: args.postId,
            safeError: `X explicitly rejected the rate-limit notice (${error.status}); automatic replay disabled`,
          },
        );
        return;
      }
      if (
        error instanceof ReplyPublicationRejectedError &&
        error.retryable &&
        attempt < 5
      ) {
        const delay = Math.min(15 * 60_000, 30_000 * 2 ** attempt);
        await ctx.runMutation(internal.xReplies.markRateLimitPublicationRetry, {
          postId: args.postId,
          reason: args.reason,
          attempt: attempt + 1,
          nextRetryAt: Date.now() + delay,
        });
        await ctx.scheduler.runAfter(
          delay,
          internal.xReplies.publishRateLimitNotice,
          {
            postId: args.postId,
            reason: args.reason,
            attempt: attempt + 1,
          },
        );
        return;
      }
      await ctx.runMutation(internal.xReplies.markPublicationTerminalFailure, {
        postId: args.postId,
        safeError: "X explicitly rejected the rate-limit notice",
      });
    }
  },
});

export const reserveStaleInteractions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const interruptedCutoff = now - 20 * 60_000;
    const missedRetryCutoff = now - 10 * 60_000;
    const [received, processing, failed] = await Promise.all([
      ctx.db
        .query("xReplyInteractions")
        .withIndex("by_status_updated_at", (q) =>
          q.eq("status", "received").lte("updatedAt", interruptedCutoff),
        )
        .take(200),
      ctx.db
        .query("xReplyInteractions")
        .withIndex("by_status_updated_at", (q) =>
          q.eq("status", "processing").lte("updatedAt", interruptedCutoff),
        )
        .take(200),
      ctx.db
        .query("xReplyInteractions")
        .withIndex("by_status_next_retry", (q) =>
          q
            .eq("status", "failed")
            .gt("nextRetryAt", 0)
            .lte("nextRetryAt", missedRetryCutoff),
        )
        .take(200),
    ]);
    const candidates = [...received, ...processing, ...failed];
    const recovered: Array<{
      postId: string;
      commandKind?: string;
      safeError?: string;
      retryCount?: number;
    }> = [];
    for (const interaction of candidates) {
      if (interaction.publicationQueued || !shouldRecoverXInteraction({ ...interaction, now })) continue;
      await ctx.db.patch(interaction._id, {
        status: "failed",
        nextRetryAt: Date.now(),
        safeError: "stale interaction recovered after interrupted processing",
        updatedAt: Date.now(),
      });
      recovered.push({
        postId: interaction.postId,
        commandKind: interaction.commandKind,
        safeError: interaction.safeError,
        retryCount: interaction.retryCount,
      });
    }
    return recovered;
  },
});

export const recoverStaleInteractions = internalAction({
  args: {},
  handler: async (ctx): Promise<{ recovered: number }> => {
    const recovered: Array<{
      postId: string;
      commandKind?: string;
      safeError?: string;
      retryCount?: number;
    }> = await ctx.runMutation(internal.xReplies.reserveStaleInteractions, {});
    await Promise.all(
      recovered.map((item) =>
        item.commandKind === "rate_limited"
          ? ctx.scheduler.runAfter(
              0,
              internal.xReplies.publishRateLimitNotice,
              {
                postId: item.postId,
                reason: item.safeError || "user cooldown",
                attempt: item.retryCount || 0,
              },
            )
          : ctx.scheduler.runAfter(0, internal.xReplies.retryInteraction, {
              postId: item.postId,
            }),
      ),
    );
    return { recovered: recovered.length };
  },
});

type XUser = {
  id: string;
  username: string;
  verified?: boolean;
  verified_type?: string;
  subscription_type?: string;
};
type XUrlEntity = { url: string; expanded_url?: string; unwound_url?: string };
type Mention = {
  id: string;
  text: string;
  author_id: string;
  attachments?: { media_keys?: string[] };
  referenced_tweets?: Array<{
    type: "replied_to" | "quoted" | "retweeted";
    id: string;
  }>;
  entities?: { urls?: XUrlEntity[] };
};
type Media = { media_key: string; type: string; url?: string };

const PASSIVE_CHAIN_OPERATIONS = new Set([
  "create_wallet",
  "show_wallet",
  "show_balance",
  "send",
  "burn",
  "buy",
  "buy_and_send",
  "buy_and_burn",
  "buy_top_five",
  "swap_token_for_token",
  "sell",
  "claim_fees",
  "launch",
  "reassign_fees",
  "upgrade_fees",
]);

export function isReplyToReply(
  mention: Pick<Mention, "referenced_tweets">,
  includedTweets: Map<string, Pick<Mention, "referenced_tweets">>,
) {
  const parentId = mention.referenced_tweets?.find(
    (reference) => reference.type === "replied_to",
  )?.id;
  if (!parentId) return false;
  return Boolean(
    includedTweets
      .get(parentId)
      ?.referenced_tweets?.some((reference) => reference.type === "replied_to"),
  );
}

export function includedReplyDepth(
  mention: Pick<Mention, "referenced_tweets">,
  includedTweets: Map<string, Pick<Mention, "referenced_tweets">>,
) {
  let depth = 0;
  let current: Pick<Mention, "referenced_tweets"> | undefined = mention;
  const visited = new Set<string>();
  while (current) {
    const parentId = current.referenced_tweets?.find(
      (reference) => reference.type === "replied_to",
    )?.id;
    if (!parentId || visited.has(parentId)) break;
    visited.add(parentId);
    depth += 1;
    current = includedTweets.get(parentId);
  }
  return depth;
}

export function shouldHandlePassiveChainText(text: string) {
  const direct = directPostCommandText(text);
  if (parseXHoudiniDecision(direct) || parseXHoudiniCommand(direct))
    return true;
  // A carried bare "wallet" mention is ambiguous chatter, not a self-wallet
  // request. Explicit forms such as "what's my wallet?" and "show my wallet"
  // remain executable below.
  if (/^(?:wallet|my wallet|wallet address)$/i.test(direct.trim())) return false;
  const straightforward = straightforwardCommandOperation(direct);
  if (straightforward && PASSIVE_CHAIN_OPERATIONS.has(straightforward))
    return true;
  // Preserve clear transaction attempts whose parameters are incomplete and
  // therefore require the normal validation response. Exclude instructional
  // or hypothetical questions so passive conversation does not summon help.
  if (
    /\b(?:how\s+(?:do|does|can|would)|what\s+(?:can|does|if)|would\b[\s\S]{0,60}\bwork|can\s+i|could\s+i|explain|tell\s+me\s+about)\b/i.test(
      direct,
    )
  )
    return false;
  return requestedOperations(direct).some((operation) =>
    PASSIVE_CHAIN_OPERATIONS.has(operation),
  );
}

export function shouldHandleDirectedChainHelp(
  text: string,
  replyDepth: number,
  passiveBotReply: boolean,
) {
  if (passiveBotReply || replyDepth > 2) return false;
  const direct = directPostCommandText(text);
  // Only a recognizable information request qualifies. Greetings, praise,
  // promotional chatter, and generic mentions have no help topic and remain
  // silent even when they contain the bot's handle.
  return explicitInformationalTopic(direct) !== null;
}

export function expandXUrls(mention: Mention) {
  let text = mention.text;
  for (const entity of mention.entities?.urls || []) {
    const expanded = entity.unwound_url || entity.expanded_url;
    if (!expanded?.startsWith("https://")) continue;
    // X includes an attachment's synthetic t.co/photo URL in otherwise plain
    // post text. It is transport metadata, not part of a launch name or any
    // user-supplied social field, so never pass it to the command parser.
    const attachmentOnly =
      Boolean(mention.attachments?.media_keys?.length) &&
      /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+\/(?:photo|video)\/\d+(?:\?.*)?$/i.test(
        expanded,
      );
    text = text.replaceAll(entity.url, attachmentOnly ? "" : expanded);
  }
  return text.replace(/\s+/g, " ").trim();
}

export const pollMentions = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    enabled: boolean;
    processed: number;
    skipped?: string;
    backlogRemaining?: boolean;
  }> => {
    if (!repliesEnabled()) return { enabled: false, processed: 0 };
    const acquired = await ctx.runMutation(
      internal.xReplies.acquirePollLease,
      {},
    );
    if (!acquired)
      return { enabled: true, processed: 0, skipped: "poll already running" };
    const botUserId = process.env.X_BOT_USER_ID;
    try {
      if (!botUserId) throw new Error("X_BOT_USER_ID is not configured");
      const state: {
        newestSeenPostId?: string;
        backlogPaginationToken?: string;
        backlogNewestPostId?: string;
        backlogVisitedPaginationTokens?: string[];
        effectiveFilters: ReturnType<typeof effectiveXIntakeFilters>;
      } | null = await ctx.runMutation(internal.xReplies.preparePollSource, {});
      // Keep the endpoint, query and pagination on one immutable snapshot.
      if (!state?.effectiveFilters) throw new Error("X intake filter snapshot unavailable");
      const intakeFilters = state.effectiveFilters;
      let admissionFilters = intakeFilters;
      const restrictedIntake = intakeFilters.restricted;
      const mentions: Mention[] = [];
      const media = new Map<string, Media>();
      let paginationToken: string | undefined = state?.backlogPaginationToken;
      let newestFetchedPostId = state?.backlogNewestPostId;
      let visitedPaginationTokens = state?.backlogVisitedPaginationTokens;
      for (let pageIndex = 0; pageIndex < X_MENTION_PAGES_PER_POLL; pageIndex += 1) {
        const requestedPaginationToken = paginationToken;
        const query = new URLSearchParams({
          max_results: String(X_MENTION_PAGE_SIZE),
          expansions: "attachments.media_keys",
          // Reference IDs permit an explicit, launch-only image lookup. Referenced
          // text and the wider conversation are never retrieved or used as AI input.
          "tweet.fields":
            "author_id,attachments,created_at,entities,referenced_tweets",
          "media.fields": "media_key,type,url",
        });
        if (state?.newestSeenPostId)
          query.set("since_id", state.newestSeenPostId);
        if (restrictedIntake) {
          query.set("query", restrictedXSearchQuery(intakeFilters.excludeWalletBalance, intakeFilters.verifiedOnly, intakeFilters.countries, intakeFilters.excludeShowMyWallet));
          query.set("sort_order", "recency");
        }
        if (paginationToken) query.set(restrictedIntake ? "next_token" : "pagination_token", paginationToken);
        let page: {
          data?: Mention[];
          includes?: { media?: Media[] };
          meta?: { newest_id?: string; next_token?: string };
        };
        try {
          // Never fall back to unfiltered mentions when search fails: that would
          // defeat the operator's explicit read-cost restriction.
          page = await xGet<typeof page>(restrictedIntake ? "/tweets/search/recent" : `/users/${botUserId}/mentions`, query);
        } catch (error) {
          if (state?.backlogPaginationToken)
            await ctx.runMutation(
              internal.xReplies.recordBacklogPaginationFailure,
              {},
            );
          throw error;
        }
        mentions.push(...(page.data || []));
        if (xAutoIntakeGuardEnabled()) admissionFilters = await ctx.runMutation(internal.xReplies.observeIntakeTraffic, {
          postIds: (page.data || []).filter(m => m.author_id !== botUserId).map(m => m.id),
        });
        for (const item of page.includes?.media || [])
          media.set(item.media_key, item);
        if (!state?.backlogPaginationToken && pageIndex === 0)
          newestFetchedPostId = page.meta?.newest_id;
        const progress = mentionPaginationProgress(
          requestedPaginationToken,
          page.meta?.next_token,
          visitedPaginationTokens,
        );
        paginationToken = progress.nextToken;
        visitedPaginationTokens = progress.visitedTokens;
        if (!paginationToken) break;
      }
      let processed = 0;
      let dispatchIndex = 0;
      // These reads already happened, but don't spend profiles/AI on wallet or
      // balance posts from the page that just triggered emergency protection.
      if (admissionFilters.excludeWalletBalance && !intakeFilters.excludeWalletBalance) {
        for (let i = mentions.length - 1; i >= 0; i--)
          if (/\b(?:wallet|balance)\b/i.test(mentions[i].text)) mentions.splice(i, 1);
      }
      const prioritized = mentions.map(mention => { const text = expandXUrls(mention); return {
        mention, id: mention.id, text, verified: false,
        operation: straightforwardCommandOperation(directPostCommandText(text)) ?? undefined,
      }; }).sort(compareXPriority);
      const eligibleReferences = new Set(prioritized.filter(({ mention, text }) =>
        mention.author_id !== botUserId && !shouldSuppressXResponse(text) &&
        (hasExplicitBotMention(text, mention.referenced_tweets) || shouldHandlePassiveChainText(text) || isLiquidityMessage(directPostCommandText(text)))
      ).map(({ id }) => id));
      const { references: referencedTweets, depths: persistedDepths } = await loadReplyMetadata(
        mentions, eligibleReferences,
        async parentPostId => (await ctx.runQuery(internal.xReplies.replyDepthFromParent, { parentPostId })) ?? undefined,
        async ids => {
          const result = await xGet<{ data?: ReferencePost[]; errors?: unknown[] }>("/tweets",
            new URLSearchParams({ ids: ids.join(","), "tweet.fields": "author_id,referenced_tweets" }), 5_000);
          // Deleted/inaccessible parents may be omitted, just as they were in
          // expansions. Do not let one deleted post stall every new mention.
          // Transport/rate-limit failures still throw and retain the poll cursor.
          return result.data ?? [];
        },
      );
      const admitted: Array<{
        mention: Mention; directText: string; restrictedReply: boolean; directedHelp: boolean;
        contextualGasHelp: boolean; parentPostId?: string; replyDepth: number;
        botParentAuthorized: boolean;
        gasResume?: { parsedIntentJson?: string; mediaUrl?: string; recipientAddress?: string; explicitMentionAuthorized: boolean; resumable: boolean; sourceText?: string };
        workflowCooldownNotice?: boolean;
      }> = [];
      const lpThreadGuards = new Map<string, "silent" | "redirect" | null>();
      const mentionsById = new Map(mentions.map(m => [m.id, m]));
      const inspectLpThread = async (mention: Mention, visited = new Set<string>()): Promise<"silent" | "redirect" | null> => {
        if (lpThreadGuards.has(mention.id)) return lpThreadGuards.get(mention.id)!;
        if (visited.has(mention.id) || visited.size >= 32) return "silent";
        visited.add(mention.id);
        const parentPostId = mention.referenced_tweets?.find(r => r.type === "replied_to")?.id;
        const parent = parentPostId ? mentionsById.get(parentPostId) : undefined;
        // Priority sorting may put a child's command ahead of its parent. Bind
        // the already-fetched parent first; no extra X reads or profile calls.
        if (parent) await inspectLpThread(parent, visited);
        const guard = parentPostId ? await ctx.runMutation(internal.liquidity.guardThread, { ownerXUserId: mention.author_id || "", parentPostId, postId: mention.id, text: directPostCommandText(expandXUrls(mention)) }) : null;
        lpThreadGuards.set(mention.id, guard); return guard;
      };
      for (const { mention } of prioritized) {
        if (!/^\d+$/.test(mention.author_id) || mention.author_id === botUserId) continue;
        // This guard runs before persistence, wallet provisioning, parsing, AI,
        // transaction execution, or reply publication. Parent/thread text is
        // never considered: `mention.text` is the direct post's text from X.
        const directText = expandXUrls(mention);
        const directParentId = mention.referenced_tweets?.find(r => r.type === "replied_to")?.id;
        const knownDepth = directParentId ? persistedDepths.get(directParentId) : undefined;
        const nestedReply = (knownDepth ?? 0) >= 2 || isReplyToReply(mention, referencedTweets);
        const passiveBotReply = isPassiveBotChainReply(
          directText,
          mention.referenced_tweets,
        );
        // A first-level reply can reach the mentions timeline because X carries
        // the bot forward as a participant even when the author did not address
        // it directly. Give those replies the same transaction/wallet-only
        // treatment as deeper replies: deterministic filtering happens here,
        // then the persisted flag suppresses non-command intents, validation
        // failures, cooldown notices, and referenced-image errors after parsing.
        const restrictedReply = shouldRestrictChainReply(
          directText,
          mention.referenced_tweets,
          nestedReply,
        );
        const parentPostId = mention.referenced_tweets?.find(
          (reference) => reference.type === "replied_to",
        )?.id;
        const persistedReplyDepth = parentPostId ? persistedDepths.get(parentPostId) : undefined;
        const replyDepth = Math.max(
          includedReplyDepth(mention, referencedTweets),
          persistedReplyDepth || 0,
        );
        // Hard stop before persistence, rate limiting, AI, wallet work, or X
        // publication. This prevents automated accounts from sustaining loops.
        const lpThread = await inspectLpThread(mention);
        if (lpThread === "silent") continue;
        const guidedHelpContinuation = await ctx.runQuery(internal.xReplies.guidedHelpContext, {
          ownerXUserId: mention.author_id || "",
          parentPostId,
        });
        if (guidedHelpContinuation && !guidedHelpContinuation.allowed) continue;
        const insufficientContext = parentPostId
          ? await ctx.runQuery(internal.xReplies.insufficientEthResumeContext, {
              ownerXUserId: mention.author_id || "",
              parentPostId,
            })
          : null;
        const gasResume = isResumeReply(directText) && insufficientContext?.resumable
          ? insufficientContext
          : undefined;
        const contextualGasHelp = Boolean(
          parentPostId &&
          isContextualGasCostFollowup(directText) &&
          insufficientContext,
        );
        const liquidityContinuation = !isOrdinaryWalletCommand(directText) && await ctx.runQuery(internal.liquidity.isContinuation, { ownerXUserId: mention.author_id || "", parentPostId });
        const liquidityRequest = isLiquidityMessage(directText) || lpThread === "redirect";
        const ownedBotReply = await ctx.runQuery(internal.xReplies.ownedBotReplyContext, {
          ownerXUserId: mention.author_id || "",
          parentPostId,
        });
        const directBotReply = await ctx.runQuery(internal.xReplies.botReplyContext, {
          parentPostId,
        });
        // A clear launch may be issued as a direct reply to a bot-authored
        // post. Persist this proof so processing retries and guided follow-ups
        // do not depend on X returning the parent a second time. A persisted
        // responsePostId proves a bot reply; author_id covers original bot
        // posts that were not created by this interaction table.
        const botParentAuthorized = Boolean(parentPostId && (
          directBotReply || referencedTweets.get(parentPostId)?.author_id === botUserId
        ));
        const workflowAdmission = guidedHelpContinuation?.allowed || liquidityContinuation || ownedBotReply
          ? await ctx.runMutation(internal.xReplies.admitWorkflowContinuation, {
              ownerXUserId: mention.author_id || "", postId: mention.id,
            })
          : { allowed: true, notify: false };
        if (!workflowAdmission.allowed && !workflowAdmission.notify) continue;
        const workflowCooldownNotice = !workflowAdmission.allowed && workflowAdmission.notify;
        if (liquidityRequest && !liquidityOwnerAllowed(mention.author_id || "") && lpThread !== "redirect") continue;
        if (exceedsXReplyDepthLimit({
          replyDepth,
          maximumDepth: MAX_X_REPLY_DEPTH,
          guidedWorkflow: Boolean(guidedHelpContinuation?.allowed || liquidityContinuation),
          liquidityRequest,
          contextualGasHelp,
          gasResume: Boolean(gasResume),
        })) continue;
        if (shouldSuppressXResponse(directText)) continue;
        // Replies can inherit every participant in a long conversation and
        // consequently appear in the mentions timeline without addressing the
        // bot. Drop passive chatter before persistence, rate limiting, AI, or
        // publication. Transactions and self-wallet requests remain eligible.
        const directedHelp =
          restrictedReply &&
          (contextualGasHelp || Boolean(gasResume) || shouldHandleDirectedChainHelp(
            directText,
            replyDepth,
            passiveBotReply,
          ));
        if (
          restrictedReply &&
          !directedHelp &&
          !liquidityContinuation && !liquidityRequest && !guidedHelpContinuation?.allowed && !gasResume &&
          !shouldHandlePassiveChainText(directText)
        )
          continue;
        if (!workflowCooldownNotice && !await ctx.runMutation(internal.xFloodProtection.admitBeforeProfile, {
          postId: mention.id, authorXUserId: mention.author_id, text: directText, parentPostId,
        })) continue;
        admitted.push({ mention, directText, restrictedReply, directedHelp, contextualGasHelp, gasResume, workflowCooldownNotice, parentPostId, replyDepth, botParentAuthorized });
      }
      // No profiles for ignored thread chatter, duplicate posts or flood-limited
      // lookups. Transport failures throw before executable interactions exist,
      // preserving the poll cursor; unavailable authors are never impersonated.
      const users = await loadAuthorProfiles(admitted.map(item => item.mention.author_id), async ids => {
        const result = await xGet<{ data?: XUser[] }>("/users", new URLSearchParams({
          ids: ids.join(","), "user.fields": "id,username,verified,verified_type,subscription_type",
        }), 10_000);
        return result.data ?? [];
      });
      admitted.sort((a, b) => compareXPriority(
        { id: a.mention.id, text: a.directText, verified: users.get(a.mention.author_id)?.verified === true, operation: straightforwardCommandOperation(directPostCommandText(a.directText)) ?? undefined },
        { id: b.mention.id, text: b.directText, verified: users.get(b.mention.author_id)?.verified === true, operation: straightforwardCommandOperation(directPostCommandText(b.directText)) ?? undefined },
      ));
      for (const { mention, directText, restrictedReply, directedHelp, contextualGasHelp, gasResume, workflowCooldownNotice, parentPostId, replyDepth, botParentAuthorized } of admitted) {
        const user = users.get(mention.author_id);
        if (!user || user.id === botUserId) continue;
        // Search indexing can lag badge changes. Fail closed on the freshly
        // fetched profile rather than treating is:verified as authorization.
        if (admissionFilters.verifiedOnly && user.verified !== true) continue;
        const firstMedia = mention.attachments?.media_keys
          ?.map((key) => media.get(key))
          .find((item) => item?.type === "photo" && item.url);
        // Direct media wins absolutely. Only when it is absent do we even retain
        // a deterministic quote/reply candidate for a possible launch lookup.
        const imageReference = firstMedia?.url
          ? undefined
          : selectLaunchImageReference(mention.referenced_tweets);
        const reserved = await ctx.runMutation(
          internal.xReplies.reserveInteraction,
          {
            postId: mention.id,
            authorXUserId: user.id,
            authorVerified: user.verified === true,
            text: directText,
            ...(restrictedReply && !directedHelp ? { nestedReply: true } : {}),
            ...(botParentAuthorized ? { botParentAuthorized: true } : {}),
            ...(contextualGasHelp ? { parsedIntentJson: JSON.stringify({ kind: "help", topic: "gas" }) } : {}),
            ...(gasResume?.parsedIntentJson ? { parsedIntentJson: gasResume.parsedIntentJson } : {}),
            ...(gasResume?.mediaUrl ? { mediaUrl: gasResume.mediaUrl, mediaSource: "direct" as const } : {}),
            ...(gasResume?.recipientAddress ? { recipientAddress: gasResume.recipientAddress } : {}),
            ...(gasResume ? { guidedHelpStateJson: JSON.stringify({
              type: "gas_resume", sourceText: gasResume.sourceText || directText,
              explicitMentionAuthorized: gasResume.explicitMentionAuthorized,
            }) } : {}),
            ...(parentPostId ? { parentPostId, replyDepth } : {}),
            ...(firstMedia?.url
              ? { mediaUrl: firstMedia.url, mediaSource: "direct" as const }
              : {}),
            ...(imageReference
              ? {
                  referencedPostId: imageReference.id,
                  referencedPostType: imageReference.type,
                }
              : {}),
          },
        );
        if (!reserved) continue;
        if (workflowCooldownNotice) {
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId: mention.id, status: "processing", commandKind: "guided_help:cooldown",
            safeError: "guided workflow reached 20 replies in 15 minutes",
          });
          await ctx.runMutation(internal.xReplyQueue.enqueue, {
            key: mention.id, postId: mention.id,
            text: "⏳ You've reached 20 workflow replies in 15 minutes. Please wait 15 minutes, then start again.",
            ok: false, kind: "guided_reply", allowLong: false,
          });
          processed += 1;
          continue;
        }
        const floodGuard = await ctx.runMutation(internal.xFloodProtection.guardQueued, { postId: mention.id });
        if (floodGuard.suppressed) { processed += 1; continue; }
        // Charge the cheap, deterministic limiter before either AI stage or
        // wallet provisioning so irrelevant/ambiguous spam cannot create AI cost.
        const rate = await ctx.runMutation(
          internal.xReplies.consumeReplyLimit,
          {
            xUserId: user.id,
            premium: premiumSubscription(user.subscription_type),
            postId: mention.id,
          },
        );
        if (!rate.allowed) {
          const shouldNotify = Boolean(rate.shouldNotify);
          if (restrictedReply) {
            await ctx.runMutation(internal.xReplies.updateInteraction, {
              postId: mention.id,
              status: "rejected",
              commandKind: "rate_limited",
              safeError: "rate-limit notice suppressed for nested reply",
            });
            processed += 1;
            continue;
          }
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId: mention.id,
            status: shouldNotify ? "processing" : "rejected",
            commandKind: "rate_limited",
            safeError: rate.reason,
          });
          if (shouldNotify)
            await ctx.scheduler.runAfter(
              0,
              internal.xReplies.publishRateLimitNotice,
              {
                postId: mention.id,
                reason: rate.reason,
                attempt: 0,
              },
            );
          processed += 1;
          continue;
        }
        await ctx.runMutation(internal.wallets.upsertXUser, {
          xUserId: user.id,
          username: user.username,
          verified: Boolean(user.verified),
          ...(user.verified_type ? { verifiedType: user.verified_type } : {}),
          ...(user.subscription_type
            ? { subscriptionType: user.subscription_type }
            : {}),
        });
        if (gasResume && parentPostId && !await ctx.runMutation(internal.xReplies.claimInsufficientEthResume, {
          ownerXUserId: user.id, parentPostId, consumerPostId: mention.id,
        })) {
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId: mention.id, status: "rejected", commandKind: "gas_resume_expired_or_consumed",
            safeError: "gas resume expired or was already consumed",
          });
          processed += 1;
          continue;
        }
        // Keep polling cheap and bounded. Each interaction runs independently,
        // while the per-wallet execution lease still serializes transactions.
        const dispatchDelay = xInteractionDispatchDelay(
          dispatchIndex,
          X_DISPATCH_BATCH_SIZE,
          X_DISPATCH_BATCH_DELAY_MS,
        );
        await ctx.scheduler.runAfter(
          dispatchDelay,
          internal.xReplies.retryInteraction,
          { postId: mention.id },
        );
        dispatchIndex += 1;
        processed += 1;
      }
      const backlogRemaining: boolean = Boolean(paginationToken);
      await ctx.runMutation(
        internal.xReplies.updatePollState,
        backlogRemaining
          ? {
              newestSeenPostId: state?.newestSeenPostId,
              backlogPaginationToken: paginationToken,
              backlogNewestPostId: newestFetchedPostId,
              backlogPaginationFailures: 0,
              backlogVisitedPaginationTokens: visitedPaginationTokens,
            }
          : {
              newestSeenPostId:
                newestFetchedPostId ||
                state?.backlogNewestPostId ||
                state?.newestSeenPostId,
              backlogPaginationFailures: 0,
              clearBacklog: true,
            },
      );
      return { enabled: true, processed, backlogRemaining };
    } finally {
      await ctx.runMutation(internal.xReplies.releasePollLease, {});
    }
  },
});
