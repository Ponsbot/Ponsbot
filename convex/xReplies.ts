import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { parseWalletCommand } from "./walletCommands";
import { shouldSuppressXResponse } from "./xReplyPolicy";
import { parseXWalletIntent, unknownWalletMessage, walletHelpMessage } from "./xWalletIntent";
import { fitXReply, xWeightedLength } from "./xText";

const X_API = "https://api.x.com/2";
const X_MENTION_PAGE_SIZE = 100;
const X_MENTION_MAX_PAGES_PER_POLL = 1;
const X_POLL_LEASE_MS = 15 * 60_000;

function repliesEnabled() {
  return process.env.X_REPLIES_ENABLED === "true";
}

function positiveInteger(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function replyLimits() {
  return {
    userDaily: positiveInteger("X_REPLY_USER_DAILY_LIMIT", 30, 1_000),
    globalDaily: positiveInteger("X_REPLY_GLOBAL_DAILY_LIMIT", 250, 100_000),
    userWindow: positiveInteger("X_REPLY_USER_WINDOW_LIMIT", 5, 100),
    globalWindow: positiveInteger("X_REPLY_GLOBAL_WINDOW_LIMIT", 25, 10_000),
    windowMs: positiveInteger("X_REPLY_WINDOW_MINUTES", 10, 60) * 60_000,
    cooldownMs: positiveInteger("X_REPLY_COOLDOWN_SECONDS", 30, 3_600) * 1_000,
  };
}

function rateLimitMessage(reason: string) {
  if (reason === "user cooldown") return "⏳ One moment! Please wait briefly before sending another wallet request.";
  if (reason === "user daily limit") return "⏰ You've reached today's wallet request limit. It resets at 00:00 UTC!";
  if (reason === "user burst limit") return "⚡ You're moving fast! Please wait a few minutes, then try again.";
  return "🛠️ I'm handling lots of wallet requests right now. Please try again shortly!";
}

async function helpReply(ctx: ActionCtx, topic: Parameters<typeof walletHelpMessage>[0]) {
  if (topic !== "pairs") return walletHelpMessage(topic);
  const labels = ["NVDA", "SPCX", "GOOGL", "TSLA", "GME", "AAPL", "SPY", "SNDK", "AMD", "AMZN", "MSFT", "META", "CRCL", "COIN", "MU", "PLTR", "USDG", "ETH"];
  return `🔗 You can pair your Pons V2 launch with: ${labels.join(", ")}.`;
}

function oauthEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function hmacSha1Base64(key: string, value: string) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
  return btoa(String.fromCharCode(...bytes));
}

async function xAuthorization(method: "GET" | "POST", url: string, query: URLSearchParams = new URLSearchParams()) {
  const consumerKey = process.env.X_API_KEY;
  const consumerSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) throw new Error("X OAuth credentials are not configured");
  const oauth: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomUUID().replaceAll("-", ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1_000)),
    oauth_token: accessToken,
    oauth_version: "1.0",
  };
  const parameters = [...Object.entries(oauth), ...query.entries()]
    .sort(([ak, av], [bk, bv]) => ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk))
    .map(([key, value]) => `${oauthEncode(key)}=${oauthEncode(value)}`).join("&");
  const signatureBase = `${method}&${oauthEncode(url)}&${oauthEncode(parameters)}`;
  oauth.oauth_signature = await hmacSha1Base64(`${oauthEncode(consumerSecret)}&${oauthEncode(accessTokenSecret)}`, signatureBase);
  return `OAuth ${Object.entries(oauth).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`).join(", ")}`;
}

async function xGet<T>(path: string, query: URLSearchParams): Promise<T> {
  const url = `${X_API}${path}`;
  const response = await fetch(`${url}?${query}`, { headers: { authorization: await xAuthorization("GET", url, query) }, signal: AbortSignal.timeout(20_000) });
  const payload = await response.json().catch(() => ({})) as T & { detail?: string };
  if (!response.ok) throw new Error(payload.detail || `X GET failed (${response.status})`);
  return payload;
}

async function publishReply(text: string, sourcePostId: string) {
  // X counts every HTTP(S) URL as a fixed-length t.co link. Validate the
  // weighted length instead of slicing raw text, which could cut an explorer
  // URL in half.
  text = fitXReply(text);
  const weightedLength = xWeightedLength(text);
  if (weightedLength > 280) throw new Error("X reply exceeded 280 characters");
  const url = `${X_API}/tweets`;
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: await xAuthorization("POST", url), "content-type": "application/json" },
    body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: sourcePostId } }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as { data?: { id?: string }; detail?: string };
  if (!response.ok || !payload.data?.id) throw new Error(payload.detail || `X reply failed (${response.status})`);
  return payload.data.id;
}

class ReplyPublicationUncertainError extends Error {}

async function publishReplyOnce(ctx: ActionCtx, text: string, sourcePostId: string) {
  const reserved = await ctx.runMutation(internal.xReplies.beginReplyPublication, { postId: sourcePostId });
  if (!reserved) throw new ReplyPublicationUncertainError("reply publication was already attempted");
  try {
    return await publishReply(text, sourcePostId);
  } catch (error) {
    await ctx.runMutation(internal.xReplies.updateInteraction, {
      postId: sourcePostId, status: "failed", safeError: "reply publication outcome requires manual review",
    });
    throw new ReplyPublicationUncertainError(error instanceof Error ? error.message : "X reply outcome is unknown");
  }
}

export const getPollState = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("xReplyState").withIndex("by_key", (q) => q.eq("key", "mentions")).unique(),
});

export const consumeReplyLimit = internalMutation({
  args: { xUserId: v.string() },
  handler: async (ctx, { xUserId }) => {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const limits = replyLimits();
    const keys = [`user:${xUserId}`, "global"];
    const records = await Promise.all(keys.map((key) => ctx.db.query("xReplyRateLimits").withIndex("by_key", (q) => q.eq("key", key)).unique()));
    const states = records.map((record) => {
      const sameDay = record?.utcDay === day;
      const sameWindow = Boolean(record && now - record.windowStartedAt < limits.windowMs);
      return {
        dailyCount: sameDay ? record!.dailyCount : 0,
        windowCount: sameWindow ? record!.windowCount : 0,
        windowStartedAt: sameWindow ? record!.windowStartedAt : now,
        lastAcceptedAt: record?.lastAcceptedAt || 0,
      };
    });
    if (now - states[0].lastAcceptedAt < limits.cooldownMs) return { allowed: false, reason: "user cooldown" };
    if (states[0].dailyCount >= limits.userDaily) return { allowed: false, reason: "user daily limit" };
    if (states[1].dailyCount >= limits.globalDaily) return { allowed: false, reason: "global daily limit" };
    if (states[0].windowCount >= limits.userWindow) return { allowed: false, reason: "user burst limit" };
    if (states[1].windowCount >= limits.globalWindow) return { allowed: false, reason: "global burst limit" };
    for (let index = 0; index < keys.length; index += 1) {
      const value = {
        utcDay: day, dailyCount: states[index].dailyCount + 1,
        windowStartedAt: states[index].windowStartedAt, windowCount: states[index].windowCount + 1,
        lastAcceptedAt: now, updatedAt: now,
      };
      if (records[index]) await ctx.db.patch(records[index]!._id, value);
      else await ctx.db.insert("xReplyRateLimits", { key: keys[index], ...value });
    }
    return { allowed: true, reason: "accepted" };
  },
});

export const updatePollState = internalMutation({
  args: { newestSeenPostId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const state = await ctx.db.query("xReplyState").withIndex("by_key", (q) => q.eq("key", "mentions")).unique();
    if (state) await ctx.db.patch(state._id, { ...args, leaseUntil: undefined, lastPolledAt: now, updatedAt: now });
    else await ctx.db.insert("xReplyState", { key: "mentions", ...args, lastPolledAt: now, updatedAt: now });
  },
});

export const acquirePollLease = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const state = await ctx.db.query("xReplyState").withIndex("by_key", (q) => q.eq("key", "mentions")).unique();
    if (state?.leaseUntil && state.leaseUntil > now) return false;
    if (state) await ctx.db.patch(state._id, { leaseUntil: now + X_POLL_LEASE_MS, updatedAt: now });
    else await ctx.db.insert("xReplyState", { key: "mentions", leaseUntil: now + X_POLL_LEASE_MS, updatedAt: now });
    return true;
  },
});

export const releasePollLease = internalMutation({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query("xReplyState").withIndex("by_key", (q) => q.eq("key", "mentions")).unique();
    if (state) await ctx.db.patch(state._id, { leaseUntil: undefined, updatedAt: Date.now() });
  },
});

export const reserveInteraction = internalMutation({
  args: { postId: v.string(), authorXUserId: v.string(), text: v.string(), mediaUrl: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", (q) => q.eq("postId", args.postId)).unique();
    if (existing) return false;
    const now = Date.now();
    await ctx.db.insert("xReplyInteractions", { ...args, status: "received", createdAt: now, updatedAt: now });
    return true;
  },
});

export const updateInteraction = internalMutation({
  args: {
    postId: v.string(),
    status: v.union(v.literal("received"), v.literal("processing"), v.literal("publishing"), v.literal("completed"), v.literal("rejected"), v.literal("failed")),
    commandKind: v.optional(v.string()), responsePostId: v.optional(v.string()), safeError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const interaction = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", (q) => q.eq("postId", args.postId)).unique();
    if (interaction) await ctx.db.patch(interaction._id, { status: args.status, commandKind: args.commandKind, responsePostId: args.responsePostId, safeError: args.safeError, updatedAt: Date.now() });
  },
});

export const beginReplyPublication = internalMutation({
  args: { postId: v.string() },
  handler: async (ctx, { postId }) => {
    const interaction = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", (q) => q.eq("postId", postId)).unique();
    if (!interaction || interaction.publicationAttempted || interaction.status === "publishing" || interaction.responsePostId
      || interaction.status === "completed" || interaction.status === "rejected") return false;
    await ctx.db.patch(interaction._id, { status: "publishing", publicationAttempted: true, updatedAt: Date.now() });
    return true;
  },
});

export const bindInteractionRecipient = internalMutation({
  args: { postId: v.string(), recipientXUserId: v.string(), recipientAddress: v.string() },
  handler: async (ctx, args) => {
    const interaction = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", (q) => q.eq("postId", args.postId)).unique();
    if (!interaction) throw new Error("X interaction was not reserved");
    if (interaction.recipientXUserId || interaction.recipientAddress) {
      if (interaction.recipientXUserId !== args.recipientXUserId || interaction.recipientAddress?.toLowerCase() !== args.recipientAddress.toLowerCase()) {
        throw new Error("X recipient binding mismatch");
      }
      return { recipientXUserId: interaction.recipientXUserId, recipientAddress: interaction.recipientAddress };
    }
    await ctx.db.patch(interaction._id, {
      recipientXUserId: args.recipientXUserId,
      recipientAddress: args.recipientAddress,
      updatedAt: Date.now(),
    });
    return { recipientXUserId: args.recipientXUserId, recipientAddress: args.recipientAddress };
  },
});

async function resolveXRecipient(ctx: ActionCtx, postId: string, recipient: string) {
  if (/^0x[a-fA-F0-9]{40}$/.test(recipient)) return recipient;
  const username = recipient.replace(/^@/, "");
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(username)) throw new Error("invalid X recipient");
  const query = new URLSearchParams({ "user.fields": "id,username,verified,verified_type,subscription_type" });
  const response = await xGet<{ data?: XUser }>(`/users/by/username/${encodeURIComponent(username)}`, query);
  const user = response.data;
  if (!user?.id) throw new Error("that X account could not be found");
  await ctx.runMutation(internal.wallets.upsertXUser, {
    xUserId: user.id, username: user.username, verified: Boolean(user.verified),
    ...(user.verified_type ? { verifiedType: user.verified_type } : {}),
    ...(user.subscription_type ? { subscriptionType: user.subscription_type } : {}),
  });
  const wallet = await ctx.runAction(internal.wallets.ensureWallet, { xUserId: user.id });
  if (!wallet?.address) throw new Error("the recipient wallet could not be prepared");
  const bound = await ctx.runMutation(internal.xReplies.bindInteractionRecipient, {
    postId, recipientXUserId: user.id, recipientAddress: wallet.address,
  });
  return bound.recipientAddress;
}

export const getRetryContext = internalQuery({
  args: { postId: v.string() },
  handler: async (ctx, { postId }) => {
    const interaction = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", (q) => q.eq("postId", postId)).unique();
    if (!interaction) return null;
    const user = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", (q) => q.eq("xUserId", interaction.authorXUserId)).unique();
    return { interaction, user };
  },
});

export const scheduleInteractionRetry = internalMutation({
  args: { postId: v.string(), safeError: v.string() },
  handler: async (ctx, args) => {
    const interaction = await ctx.db.query("xReplyInteractions").withIndex("by_post_id", (q) => q.eq("postId", args.postId)).unique();
    if (!interaction || interaction.status === "completed" || interaction.status === "rejected") return;
    // Once publication begins, a network or persistence failure is ambiguous:
    // X may already have accepted the reply. Never auto-republish it.
    if (interaction.status === "publishing") {
      await ctx.db.patch(interaction._id, {
        status: "failed", nextRetryAt: undefined,
        safeError: "reply publication outcome requires manual review", updatedAt: Date.now(),
      });
      return;
    }
    const retryCount = (interaction.retryCount || 0) + 1;
    if (retryCount > 5) {
      await ctx.db.patch(interaction._id, { status: "failed", retryCount, nextRetryAt: undefined, safeError: args.safeError, updatedAt: Date.now() });
      return;
    }
    const delay = Math.min(15 * 60_000, 30_000 * 2 ** (retryCount - 1));
    await ctx.db.patch(interaction._id, { status: "failed", retryCount, nextRetryAt: Date.now() + delay, safeError: args.safeError, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(delay, internal.xReplies.retryInteraction, { postId: args.postId });
  },
});

export const retryInteraction = internalAction({
  args: { postId: v.string() },
  handler: async (ctx, { postId }) => {
    if (!repliesEnabled()) return;
    const current = await ctx.runQuery(internal.xReplies.getRetryContext, { postId });
    if (!current?.user || current.interaction.status !== "failed" || (current.interaction.retryCount || 0) > 5) return;
    if (shouldSuppressXResponse(current.interaction.text)) {
      await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "rejected", safeError: "response suppressed by user" });
      return;
    }
    await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "processing", commandKind: current.interaction.commandKind });
    try {
      const intent = await parseXWalletIntent(current.interaction.text, Boolean(current.interaction.mediaUrl));
      if (intent.kind === "irrelevant") {
        await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: "rejected", commandKind: "irrelevant", safeError: "not a wallet request" });
        return;
      }
      let reply: string;
      let ok = true;
      if (intent.kind === "help") reply = await helpReply(ctx, intent.topic);
      else if (intent.kind === "unknown_wallet") { reply = unknownWalletMessage(); ok = false; }
      else {
        await ctx.runAction(internal.wallets.ensureWallet, { xUserId: current.user.xUserId });
        const recipientAddress = intent.command.kind === "send" || intent.command.kind === "buy_and_send"
          ? current.interaction.recipientAddress || await resolveXRecipient(ctx, postId, intent.command.recipient)
          : undefined;
        const result = await ctx.runAction(internal.wallets.executeCommand, {
          sourcePostId: postId, xUserId: current.user.xUserId, text: current.interaction.text,
          parsedCommandJson: JSON.stringify(intent.command),
          ...(current.interaction.mediaUrl ? { mediaUrl: current.interaction.mediaUrl } : {}),
          ...(recipientAddress ? { recipientAddress } : {}),
        });
        reply = result.message;
        ok = result.ok;
      }
      const responsePostId = await publishReplyOnce(ctx, reply, postId);
      await ctx.runMutation(internal.xReplies.updateInteraction, { postId, status: ok ? "completed" : "rejected", responsePostId, ...(!ok ? { safeError: reply } : {}) });
    } catch (error) {
      console.error("x_reply_retry_failed", { postId, message: error instanceof Error ? error.message : "unknown" });
      if (error instanceof ReplyPublicationUncertainError) return;
      await ctx.runMutation(internal.xReplies.scheduleInteractionRetry, { postId, safeError: "the reply workflow failed before confirmation" });
    }
  },
});

type XUser = { id: string; username: string; verified?: boolean; verified_type?: string; subscription_type?: string };
type XUrlEntity = { url: string; expanded_url?: string; unwound_url?: string };
type Mention = {
  id: string;
  text: string;
  author_id: string;
  attachments?: { media_keys?: string[] };
  entities?: { urls?: XUrlEntity[] };
};
type Media = { media_key: string; type: string; url?: string };

function expandXUrls(mention: Mention) {
  let text = mention.text;
  for (const entity of mention.entities?.urls || []) {
    const expanded = entity.unwound_url || entity.expanded_url;
    if (expanded?.startsWith("https://")) text = text.replaceAll(entity.url, expanded);
  }
  return text;
}

export const pollMentions = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!repliesEnabled()) return { enabled: false, processed: 0 };
    const acquired = await ctx.runMutation(internal.xReplies.acquirePollLease, {});
    if (!acquired) return { enabled: true, processed: 0, skipped: "poll already running" };
    const botUserId = process.env.X_BOT_USER_ID;
    try {
      if (!botUserId) throw new Error("X_BOT_USER_ID is not configured");
      const state = await ctx.runQuery(internal.xReplies.getPollState, {});
      const mentions: Mention[] = [];
      const users = new Map<string, XUser>();
      const media = new Map<string, Media>();
      let paginationToken: string | undefined;
      let newestFetchedPostId: string | undefined;
      for (let pageNumber = 0; pageNumber < X_MENTION_MAX_PAGES_PER_POLL; pageNumber += 1) {
        const query = new URLSearchParams({
          max_results: String(X_MENTION_PAGE_SIZE),
          expansions: "author_id,attachments.media_keys",
          // Deliberately request only the direct post. Never retrieve or assemble
          // the parent post, quoted post, or wider conversation as bot input.
          "tweet.fields": "author_id,attachments,created_at,entities",
          "user.fields": "id,username,verified,verified_type,subscription_type",
          "media.fields": "media_key,type,url",
        });
        if (state?.newestSeenPostId) query.set("since_id", state.newestSeenPostId);
        if (paginationToken) query.set("pagination_token", paginationToken);
        const page = await xGet<{
          data?: Mention[];
          includes?: { users?: XUser[]; media?: Media[] };
          meta?: { newest_id?: string; next_token?: string };
        }>(`/users/${botUserId}/mentions`, query);
        mentions.push(...(page.data || []));
        for (const user of page.includes?.users || []) users.set(user.id, user);
        for (const item of page.includes?.media || []) media.set(item.media_key, item);
        if (pageNumber === 0) newestFetchedPostId = page.meta?.newest_id;
        paginationToken = page.meta?.next_token;
        if (!paginationToken) break;
        if (pageNumber === X_MENTION_MAX_PAGES_PER_POLL - 1) {
          throw new Error(`X mention backlog exceeded ${X_MENTION_PAGE_SIZE * X_MENTION_MAX_PAGES_PER_POLL} posts; poll cursor was not advanced`);
        }
      }
      let processed = 0;
      for (const mention of mentions.sort((left, right) => {
        const leftId = BigInt(left.id);
        const rightId = BigInt(right.id);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      })) {
        // This guard runs before persistence, wallet provisioning, parsing, AI,
        // transaction execution, or reply publication. Parent/thread text is
        // never considered: `mention.text` is the direct post's text from X.
        const directText = expandXUrls(mention);
        if (shouldSuppressXResponse(directText)) continue;
        const user = users.get(mention.author_id);
        if (!user || user.id === botUserId) continue;
        const firstMedia = mention.attachments?.media_keys?.map((key) => media.get(key)).find((item) => item?.type === "photo" && item.url);
        const reserved = await ctx.runMutation(internal.xReplies.reserveInteraction, {
          postId: mention.id, authorXUserId: user.id, text: directText, ...(firstMedia?.url ? { mediaUrl: firstMedia.url } : {}),
        });
        if (!reserved) continue;
        // Charge the cheap, deterministic limiter before either AI stage or
        // wallet provisioning so irrelevant/ambiguous spam cannot create AI cost.
        const rate = await ctx.runMutation(internal.xReplies.consumeReplyLimit, { xUserId: user.id });
        if (!rate.allowed) {
          const reply = rateLimitMessage(rate.reason);
          const responsePostId = await publishReplyOnce(ctx, reply, mention.id);
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId: mention.id, status: "rejected", commandKind: "rate_limited", responsePostId, safeError: rate.reason,
          });
          processed += 1;
          continue;
        }
        const intent = await parseXWalletIntent(directText, Boolean(firstMedia?.url));
        if (intent.kind === "irrelevant") {
          await ctx.runMutation(internal.xReplies.updateInteraction, {
            postId: mention.id, status: "rejected", commandKind: "irrelevant", safeError: "not a wallet request",
          });
          continue;
        }
        await ctx.runMutation(internal.wallets.upsertXUser, {
          xUserId: user.id, username: user.username, verified: Boolean(user.verified),
          ...(user.verified_type ? { verifiedType: user.verified_type } : {}),
          ...(user.subscription_type ? { subscriptionType: user.subscription_type } : {}),
        });
        try {
          await ctx.runAction(internal.wallets.ensureWallet, { xUserId: user.id });
        } catch (error) {
          console.error("x_wallet_provisioning_failed", { postId: mention.id, message: error instanceof Error ? error.message : "unknown" });
          await ctx.runMutation(internal.xReplies.scheduleInteractionRetry, { postId: mention.id, safeError: "the wallet request could not be prepared" });
          continue;
        }
        const intentKind = intent.kind === "command" ? intent.command.kind : intent.kind === "help" ? `help:${intent.topic}` : "unknown_wallet";
        await ctx.runMutation(internal.xReplies.updateInteraction, { postId: mention.id, status: "processing", commandKind: intentKind });
        try {
          if (intent.kind === "help") {
            const reply = await helpReply(ctx, intent.topic);
            const responsePostId = await publishReplyOnce(ctx, reply, mention.id);
            await ctx.runMutation(internal.xReplies.updateInteraction, {
              postId: mention.id, status: "completed", commandKind: `help:${intent.topic}`, responsePostId,
            });
            processed += 1;
            continue;
          }
          if (intent.kind === "unknown_wallet") {
            const reply = unknownWalletMessage();
            const responsePostId = await publishReplyOnce(ctx, reply, mention.id);
            await ctx.runMutation(internal.xReplies.updateInteraction, { postId: mention.id, status: "rejected", commandKind: "unknown_wallet", responsePostId, safeError: "wallet intent was ambiguous" });
            processed += 1;
            continue;
          }
          const command = intent.command;
          const recipientAddress = command.kind === "send" || command.kind === "buy_and_send"
            ? await resolveXRecipient(ctx, mention.id, command.recipient)
            : undefined;
          const result = await ctx.runAction(internal.wallets.executeCommand, {
            sourcePostId: mention.id, xUserId: user.id, text: directText,
            parsedCommandJson: JSON.stringify(command),
            ...(firstMedia?.url ? { mediaUrl: firstMedia.url } : {}),
            ...(recipientAddress ? { recipientAddress } : {}),
          });
          const responsePostId = await publishReplyOnce(ctx, result.message, mention.id);
          await ctx.runMutation(internal.xReplies.updateInteraction, { postId: mention.id, status: result.ok ? "completed" : "rejected", commandKind: command.kind, responsePostId, ...(!result.ok ? { safeError: result.message } : {}) });
          processed += 1;
        } catch (error) {
          console.error("x_reply_processing_failed", { postId: mention.id, message: error instanceof Error ? error.message : "unknown" });
          if (error instanceof ReplyPublicationUncertainError) continue;
          await ctx.runMutation(internal.xReplies.scheduleInteractionRetry, { postId: mention.id, safeError: "the reply workflow failed before confirmation" });
        }
      }
      await ctx.runMutation(internal.xReplies.updatePollState, { newestSeenPostId: newestFetchedPostId || state?.newestSeenPostId });
      return { enabled: true, processed };
    } finally {
      await ctx.runMutation(internal.xReplies.releasePollLease, {});
    }
  },
});
