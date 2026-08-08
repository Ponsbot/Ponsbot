import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { isValueMovingCommand, parseWalletCommand, validateStructuredWalletCommand, type WalletCommand } from "./walletCommands";
import { discoverPonsV2PairAssets, PONS_V2_FACTORY, PONS_V2_LAUNCH_AND_BUY_ROUTER } from "./ponsV2";

const ROBINHOOD_CHAIN_ID = 4663;
const NON_PREMIUM_DAILY_LIMIT = 10;
const PREMIUM_DAILY_LIMIT = 50;
const PROVISIONING_LEASE_MS = 2 * 60_000;
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const VERIFIED_SWAP_ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
const VERIFIED_SWAP_QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
const VERIFIED_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const DEFAULT_LAUNCH_WEBSITE = "";
const DEFAULT_LAUNCH_DESCRIPTION = "Launched from an X reply through Pons.";
const ROBINHOOD_EXPLORER_TX_BASE = "https://robinhoodchain.blockscout.com/tx";
const ROBINHOOD_EXPLORER_ADDRESS_BASE = "https://robinhoodchain.blockscout.com/address";

type SignerWallet = { walletRef: string; address: string };
type SubmittedTransaction = {
  transactionHash: string;
  status: "prepared" | "broadcast" | "pending" | "confirmed" | "reverted";
  signedTransaction?: string;
  blockNumber?: string;
  valueWei?: string;
  tokenAddress?: string;
  poolAddress?: string;
  positionId?: string;
  devBuySucceeded?: boolean;
};
type CommandResult = { ok: boolean; message: string; transactionHash?: string };

function executionEnabled() {
  return process.env.X_CRYPTO_EXECUTION_ENABLED === "true";
}

function safeAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function transactionUrl(transactionHash: string) {
  return `${ROBINHOOD_EXPLORER_TX_BASE}/${transactionHash}`;
}

function addressUrl(address: string) {
  return `${ROBINHOOD_EXPLORER_ADDRESS_BASE}/${address}`;
}

function destinationLabel(recipient: string) {
  return safeAddress(recipient) ? addressUrl(recipient) : recipient;
}

function assetLabel(token: string | undefined, fallback = "ETH") {
  return token ? destinationLabel(token) : fallback;
}

function commandSummary(command: WalletCommand) {
  if (command.kind === "send") {
    const amount = command.unit === "usd" ? `$${command.amount} of ${assetLabel(command.token)}`
      : command.unit === "percent" ? `${command.amount}% of ${assetLabel(command.token)}`
        : `${command.amount} ${assetLabel(command.token)}`;
    return `Sent ${amount} to ${destinationLabel(command.recipient)}!`;
  }
  if (command.kind === "burn") {
    const amount = command.unit === "usd" ? `$${command.amount} of ${assetLabel(command.token)}`
      : command.unit === "percent" ? `${command.amount}% of ${assetLabel(command.token)}` : `${command.amount} ${assetLabel(command.token)}`;
    return `Burned ${amount}!`;
  }
  if (command.kind === "buy") return `Bought ${command.unit === "usd" ? `$${command.amount}` : `${command.amount} ETH`} of ${assetLabel(command.token)}!`;
  if (command.kind === "sell") return `Sold ${command.unit === "percent" ? `${command.amount}% of ` : `${command.amount} `}${assetLabel(command.token)}!`;
  if (command.kind === "claim_fees") return `Claimed creator fees${command.token ? ` for ${assetLabel(command.token)}` : ""}!`;
  if (command.kind === "launch") return `Launched ${command.name} (${command.symbol}) on Pons! 🚀`;
  return "Transaction submitted!";
}

function transactionMessage(command: WalletCommand, transactionHash: string, status: "submitted" | "confirmed", tokenAddress?: string) {
  const summary = commandSummary(command);
  const tokenLine = command.kind === "launch" && tokenAddress ? `\nYour token: ${addressUrl(tokenAddress)}` : "";
  const heading = status === "confirmed" ? "✅ Success!" : "⏳ Submitted!";
  return `${heading} ${summary}${tokenLine}\nYour TXN: ${transactionUrl(transactionHash)}`;
}

function fundingMessage(message: string, walletAddress: string) {
  return /Add ETH for gas/i.test(message) ? `${message}\nYour wallet: ${addressUrl(walletAddress)}` : message;
}

function signerConfiguration() {
  const explicitUrl = process.env.WALLET_SIGNER_URL?.trim();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const baseUrl = (explicitUrl || (siteUrl ? `${siteUrl.replace(/\/$/, "")}/api/wallet-signer` : "")).replace(/\/$/, "");
  const token = process.env.WALLET_SIGNER_TOKEN;
  if (!baseUrl || !token) throw new Error("secure wallet signer is not configured");
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("secure wallet signer must use HTTPS");
  }
  return { baseUrl, token };
}

async function signerRequest<T>(path: string, body: unknown): Promise<T> {
  const { baseUrl, token } = signerConfiguration();

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();

  let payload: (T & { error?: string; message?: string }) | null = null;

  try {
    payload = raw
      ? (JSON.parse(raw) as T & { error?: string; message?: string })
      : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(
      payload?.error ||
        payload?.message ||
        `signer request failed (${response.status}): ${raw || response.statusText}`,
    );
  }

  if (!payload) {
    throw new Error(
      `signer returned invalid or empty JSON (${response.status}): ${raw}`,
    );
  }

  return payload;
}

async function provisionSignerWallet(xUserId: string): Promise<SignerWallet> {
  const wallet = await signerRequest<SignerWallet>("/v1/wallets", {
    idempotencyKey: `x:${xUserId}:robinhood`,
    ownerReference: `x:${xUserId}`,
    chainId: ROBINHOOD_CHAIN_ID,
  });
  if (!wallet.walletRef || !safeAddress(wallet.address)) throw new Error("signer returned an invalid wallet");
  return wallet;
}

async function normalizeImage(mediaUrl?: string) {
  if (!mediaUrl) return "";
  const url = new URL(mediaUrl);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "pbs.twimg.com") {
    throw new Error("token image must be an attached X image");
  }
  return url.toString();
}

export const upsertXUser = internalMutation({
  args: {
    xUserId: v.string(), username: v.string(), verified: v.boolean(),
    verifiedType: v.optional(v.string()), subscriptionType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", (q) => q.eq("xUserId", args.xUserId)).unique();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("xReplyUsers", { ...args, walletStatus: "none", createdAt: now, updatedAt: now });
  },
});

export const getXUserAndWallet = internalQuery({
  args: { xUserId: v.string() },
  handler: async (ctx, { xUserId }) => {
    const user = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", (q) => q.eq("xUserId", xUserId)).unique();
    const wallet = user?.walletId ? await ctx.db.get(user.walletId) : null;
    return user ? { user, wallet } : null;
  },
});

export const resolveClaimToken = internalQuery({
  args: { ownerXUserId: v.string(), identifier: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const launches = await ctx.db.query("tokenLaunches")
      .withIndex("by_owner_created_at", (q) => q.eq("ownerXUserId", args.ownerXUserId))
      .order("desc")
      .take(100);
    const completed = launches.filter((launch) => launch.tokenAddress);
    const identifier = args.identifier?.trim();
    if (!identifier) {
      if (completed.length === 1) return completed[0].tokenAddress!;
      throw new Error(completed.length ? "specify the token contract or ticker for the fee claim" : "no completed Pons launch was found for this wallet");
    }
    const normalized = identifier.replace(/^\$/, "").toLowerCase();
    const matches = completed.filter((launch) =>
      launch.tokenAddress!.toLowerCase() === normalized || launch.symbol.toLowerCase() === normalized,
    );
    if (matches.length !== 1) throw new Error(matches.length ? "that ticker matches more than one launch; use the token contract" : "that launch was not found for this wallet");
    return matches[0].tokenAddress!;
  },
});

export const beginWalletProvisioning = internalMutation({
  args: { xUserId: v.string() },
  handler: async (ctx, { xUserId }) => {
    const user = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", (q) => q.eq("xUserId", xUserId)).unique();
    if (!user) throw new Error("X user is not registered");
    if (user.walletId) return { needed: false, walletId: user.walletId };
    if (user.walletStatus === "provisioning" && Date.now() - user.updatedAt < PROVISIONING_LEASE_MS) return { needed: false };
    await ctx.db.patch(user._id, { walletStatus: "provisioning", updatedAt: Date.now() });
    return { needed: true };
  },
});

export const finishWalletProvisioning = internalMutation({
  args: { xUserId: v.string(), address: v.string(), signerWalletRef: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", (q) => q.eq("xUserId", args.xUserId)).unique();
    if (!user) throw new Error("X user is not registered");
    if (user.walletId) {
      const linked = await ctx.db.get(user.walletId);
      if (!linked || linked.ownerXUserId !== args.xUserId || linked.chainId !== ROBINHOOD_CHAIN_ID
        || linked.address.toLowerCase() !== args.address.toLowerCase()
        || linked.signerWalletRef.toLowerCase() !== args.signerWalletRef.toLowerCase()) {
        throw new Error("canonical X wallet binding mismatch");
      }
      return linked._id;
    }
    const existing = await ctx.db.query("cryptoWallets").withIndex("by_owner_x_user_id", (q) => q.eq("ownerXUserId", args.xUserId)).unique();
    const addressOwner = await ctx.db.query("cryptoWallets").withIndex("by_address", (q) => q.eq("address", args.address)).unique();
    if (addressOwner && addressOwner.ownerXUserId !== args.xUserId) throw new Error("wallet address is already bound to another X user");
    if (existing && (existing.address.toLowerCase() !== args.address.toLowerCase()
      || existing.signerWalletRef.toLowerCase() !== args.signerWalletRef.toLowerCase()
      || existing.chainId !== ROBINHOOD_CHAIN_ID)) throw new Error("canonical X wallet binding mismatch");
    const now = Date.now();
    const walletId = existing?._id || await ctx.db.insert("cryptoWallets", {
      ownerXUserId: args.xUserId, address: args.address, signerWalletRef: args.signerWalletRef,
      chainId: ROBINHOOD_CHAIN_ID, status: "active", createdAt: now, updatedAt: now,
    });
    await ctx.db.patch(user._id, { walletId, walletStatus: "active", updatedAt: now });
    return walletId;
  },
});

export const resetWalletProvisioning = internalMutation({
  args: { xUserId: v.string() },
  handler: async (ctx, { xUserId }) => {
    const user = await ctx.db.query("xReplyUsers").withIndex("by_x_user_id", (q) => q.eq("xUserId", xUserId)).unique();
    if (user && !user.walletId) await ctx.db.patch(user._id, { walletStatus: "none", updatedAt: Date.now() });
  },
});

export const consumeWalletLimit = internalMutation({
  args: { xUserId: v.string(), premium: v.boolean() },
  handler: async (ctx, args) => {
    const dailyLimit = args.premium ? PREMIUM_DAILY_LIMIT : NON_PREMIUM_DAILY_LIMIT;
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const record = await ctx.db.query("walletRateLimits").withIndex("by_owner_x_user_id", (q) => q.eq("ownerXUserId", args.xUserId)).unique();
    const current = record?.day === day ? record.count : 0;
    if (current >= dailyLimit) return { allowed: false, count: current, remaining: 0 };
    const count = current + 1;
    if (record) await ctx.db.patch(record._id, { day, count, updatedAt: now });
    else await ctx.db.insert("walletRateLimits", { ownerXUserId: args.xUserId, day, count, updatedAt: now });
    return { allowed: true, count, remaining: dailyLimit - count };
  },
});

export const reserveWalletRequest = internalMutation({
  args: { requestId: v.string(), sourcePostId: v.string(), ownerXUserId: v.string(), walletId: v.id("cryptoWallets"), kind: v.string(), normalizedJson: v.string() },
  handler: async (ctx, args) => {
    const duplicate = await ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (duplicate) {
      if (duplicate.status === "failed" && !duplicate.transactionHash && Date.now() - duplicate.updatedAt >= 30_000) {
        await ctx.db.patch(duplicate._id, { status: "accepted", safeError: undefined, updatedAt: Date.now() });
        return { inserted: true, retried: true, request: await ctx.db.get(duplicate._id) };
      }
      return { inserted: false, retried: false, request: duplicate };
    }
    const now = Date.now();
    const id = await ctx.db.insert("walletRequests", { ...args, status: "accepted", createdAt: now, updatedAt: now });
    return { inserted: true, retried: false, request: await ctx.db.get(id) };
  },
});

export const updateWalletRequest = internalMutation({
  args: {
    requestId: v.string(),
    status: v.union(v.literal("accepted"), v.literal("simulating"), v.literal("prepared"), v.literal("broadcast"), v.literal("confirmed"), v.literal("rejected"), v.literal("failed")),
    safeError: v.optional(v.string()), transactionHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (request) await ctx.db.patch(request._id, { status: args.status, safeError: args.safeError, transactionHash: args.transactionHash, updatedAt: Date.now() });
  },
});

const launchRecordValidator = v.object({
  ownerXUserId: v.string(), launchMode: v.literal("pons"),
  name: v.string(), symbol: v.string(), imageUri: v.string(), devBuyWei: v.string(),
  description: v.optional(v.string()), website: v.optional(v.string()),
  twitter: v.optional(v.string()),
  pairToken: v.optional(v.string()),
  tokenAddress: v.optional(v.string()), poolAddress: v.optional(v.string()),
  positionId: v.optional(v.string()), devBuySucceeded: v.optional(v.boolean()),
});

export const recordPreparedExecution = internalMutation({
  args: {
    requestId: v.string(), walletId: v.id("cryptoWallets"), to: v.string(), valueWei: v.string(),
    callKind: v.string(), transactionHash: v.string(), signedTransaction: v.string(), launch: v.optional(launchRecordValidator),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db.query("walletTransactions").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!existing) await ctx.db.insert("walletTransactions", {
      requestId: args.requestId, walletId: args.walletId, chainId: ROBINHOOD_CHAIN_ID,
      to: args.to, valueWei: args.valueWei, callKind: args.callKind,
      transactionHash: args.transactionHash, signedTransaction: args.signedTransaction,
      status: "prepared", createdAt: now, updatedAt: now,
    });
    if (args.launch) {
      const launch = await ctx.db.query("tokenLaunches").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
      if (!launch) await ctx.db.insert("tokenLaunches", {
        requestId: args.requestId, walletId: args.walletId, transactionHash: args.transactionHash,
        ...args.launch, createdAt: now, updatedAt: now,
      });
    }
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (request) await ctx.db.patch(request._id, {
      status: "prepared", transactionHash: args.transactionHash, reconciliationAttempts: 0,
      nextReconcileAt: now, updatedAt: now,
    });
  },
});

export const markTransactionBroadcast = internalMutation({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => {
    const now = Date.now();
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique();
    if (request && request.status === "prepared") await ctx.db.patch(request._id, { status: "broadcast", nextReconcileAt: now + 15_000, updatedAt: now });
    const transaction = await ctx.db.query("walletTransactions").withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique();
    if (transaction && transaction.status === "prepared") await ctx.db.patch(transaction._id, { status: "broadcast", updatedAt: now });
    await ctx.scheduler.runAfter(15_000, internal.wallets.reconcileTransaction, { requestId });
  },
});

export const recordConfirmedExecution = internalMutation({
  args: {
    requestId: v.string(), walletId: v.id("cryptoWallets"), to: v.string(), valueWei: v.string(),
    callKind: v.string(), transactionHash: v.string(), blockNumber: v.optional(v.string()),
    launch: v.optional(launchRecordValidator),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("walletTransactions").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    const now = Date.now();
    if (!existing) await ctx.db.insert("walletTransactions", {
      requestId: args.requestId, walletId: args.walletId, chainId: ROBINHOOD_CHAIN_ID,
      to: args.to, valueWei: args.valueWei, callKind: args.callKind,
      transactionHash: args.transactionHash, status: "confirmed", blockNumber: args.blockNumber,
      createdAt: now, updatedAt: now,
    });
    else await ctx.db.patch(existing._id, { status: "confirmed", blockNumber: args.blockNumber, updatedAt: now });
    if (args.launch) {
      const launch = await ctx.db.query("tokenLaunches").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
      if (!launch) await ctx.db.insert("tokenLaunches", {
        requestId: args.requestId, walletId: args.walletId, transactionHash: args.transactionHash,
        ...args.launch, createdAt: now, updatedAt: now,
      });
      if (launch) await ctx.db.patch(launch._id, { ...args.launch, updatedAt: now });
    }
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (request) await ctx.db.patch(request._id, { status: "confirmed", transactionHash: args.transactionHash, nextReconcileAt: undefined, updatedAt: now });
  },
});

export const getReconciliationContext = internalQuery({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => {
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique();
    if (!request) return null;
    const wallet = await ctx.db.get(request.walletId);
    const transaction = await ctx.db.query("walletTransactions").withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique();
    const launch = await ctx.db.query("tokenLaunches").withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique();
    return { request, wallet, transaction, launch };
  },
});

export const deferReconciliation = internalMutation({
  args: { requestId: v.string(), attempt: v.number() },
  handler: async (ctx, args) => {
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!request || (request.status !== "prepared" && request.status !== "broadcast")) return;
    const delay = Math.min(15 * 60_000, 15_000 * 2 ** Math.min(args.attempt, 6));
    await ctx.db.patch(request._id, { reconciliationAttempts: args.attempt, nextReconcileAt: Date.now() + delay, updatedAt: Date.now() });
    await ctx.scheduler.runAfter(delay, internal.wallets.reconcileTransaction, { requestId: args.requestId });
  },
});

export const recordRevertedExecution = internalMutation({
  args: { requestId: v.string(), blockNumber: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (request) await ctx.db.patch(request._id, { status: "failed", safeError: "transaction reverted", nextReconcileAt: undefined, updatedAt: now });
    const transaction = await ctx.db.query("walletTransactions").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (transaction) await ctx.db.patch(transaction._id, { status: "reverted", blockNumber: args.blockNumber, updatedAt: now });
  },
});

export const reconcileTransaction = internalAction({
  args: { requestId: v.string() },
  handler: async (ctx, args) => {
    const current = await ctx.runQuery(internal.wallets.getReconciliationContext, args);
    if (!current?.wallet || !current.transaction || !["prepared", "broadcast"].includes(current.request.status) || !current.request.transactionHash) return;
    try {
      const statusBody = {
        chainId: ROBINHOOD_CHAIN_ID,
        ownerReference: `x:${current.request.ownerXUserId}`,
        walletRef: current.wallet.signerWalletRef,
        expectedFrom: current.wallet.address,
        transactionHash: current.request.transactionHash,
        operationType: current.transaction.callKind,
        expectedValueWei: current.transaction.valueWei,
      };
      const result = current.request.status === "prepared"
        ? await signerRequest<SubmittedTransaction>("/v1/transactions/broadcast", {
          ...statusBody, signedTransaction: current.transaction.signedTransaction,
        })
        : await signerRequest<SubmittedTransaction>("/v1/transactions/status", statusBody);
      if (result.status === "broadcast" || result.status === "pending") {
        if (current.request.status === "prepared") await ctx.runMutation(internal.wallets.markTransactionBroadcast, { requestId: args.requestId });
        else await ctx.runMutation(internal.wallets.deferReconciliation, { requestId: args.requestId, attempt: (current.request.reconciliationAttempts || 0) + 1 });
        return;
      }
      if (result.status === "reverted") {
        await ctx.runMutation(internal.wallets.recordRevertedExecution, { requestId: args.requestId, blockNumber: result.blockNumber });
        return;
      }
      if (current.request.kind === "launch" && (!result.tokenAddress || !result.poolAddress || !result.positionId)) throw new Error("launch receipt was incomplete");
      const launch = current.launch ? {
        ownerXUserId: current.launch.ownerXUserId, launchMode: current.launch.launchMode,
        name: current.launch.name, symbol: current.launch.symbol, imageUri: current.launch.imageUri,
        description: current.launch.description, website: current.launch.website, twitter: current.launch.twitter,
        devBuyWei: result.valueWei || current.launch.devBuyWei,
        tokenAddress: result.tokenAddress, poolAddress: result.poolAddress, positionId: result.positionId,
        devBuySucceeded: result.devBuySucceeded,
      } : undefined;
      await ctx.runMutation(internal.wallets.recordConfirmedExecution, {
        requestId: args.requestId, walletId: current.wallet._id, to: current.transaction.to,
        valueWei: result.valueWei || current.transaction.valueWei, callKind: current.transaction.callKind,
        transactionHash: current.request.transactionHash, blockNumber: result.blockNumber, launch,
      });
    } catch (error) {
      console.error("wallet_reconciliation_failed", { requestId: args.requestId, message: error instanceof Error ? error.message : "unknown" });
      await ctx.runMutation(internal.wallets.deferReconciliation, { requestId: args.requestId, attempt: (current.request.reconciliationAttempts || 0) + 1 });
    }
  },
});

function isPremium(subscriptionType?: string) {
  return subscriptionType === "Premium" || subscriptionType === "PremiumPlus";
}

function walletPageUrl(address: string) {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  return site ? `${site}/wallet/${address}` : addressUrl(address);
}

function safeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "wallet request failed";
  if (/ETH transfer amount plus gas exceeds/i.test(message)) return "❌ There isn't enough ETH for the transfer plus gas. Add a little ETH and try again!";
  if (/insufficient ETH for gas/i.test(message)) return "⛽ This wallet needs a little more ETH for gas. Top it up and try again!";
  if (/insufficient/i.test(message)) return "❌ There aren't enough funds for that amount. Check the balance or try a smaller amount.";
  if (/image/i.test(message)) return "🖼️ I couldn't prepare that image. Try another one, or launch without artwork.";
  if (/ticker matches/i.test(message)) return "⚠️ More than one held token uses that ticker. Send me the contract address so I choose the right one!";
  if (/specify the token|contract address|token lookup|held token/i.test(message)) return "🔎 I couldn't identify that token. Try a ticker you hold or send its contract address.";
  if (/launch was not found|no completed Pons launch/i.test(message)) return "🔎 I couldn't find a completed Pons launch for that token.";
  if (/launch creator|fee beneficiary/i.test(message)) return "🔒 This wallet isn't authorized to claim fees for that launch.";
  if (/locker relationship|position assets/i.test(message)) return "⚠️ I couldn't verify that launch's Pons fee position. Nothing was claimed.";
  if (/invalid transfer destination/i.test(message)) return "📍 I couldn't identify that recipient. Please send an X handle or wallet address.";
  if (/pool|liquidity|quote returned no output/i.test(message)) return "💧 I couldn't find enough liquidity or a usable route for that trade. Try another amount or asset.";
  if (/slippage/i.test(message)) return "📉 The price moved beyond your slippage setting. Try again or choose a higher slippage.";
  if (/0\.02627 ETH maximum|initial dev buy exceeds/i.test(message)) return "⚠️ That developer buy is above the current maximum of 0.02627 ETH.";
  if (/website must use https/i.test(message)) return "🔗 Please send a secure website link beginning with https://.";
  if (/twitter link uses an unsupported host/i.test(message)) return "🔗 Please use an x.com link for the X social field.";
  if (/disabled|not configured|unavailable/i.test(message)) {
    console.error("wallet_configuration_failure", { message });
    return "🛠️ The wallet service is taking a quick break. Please try again shortly!";
  }
  if (/revert|simulation/i.test(message)) return "❌ The transaction couldn't be completed, and nothing was confirmed onchain. Check the details and try again.";
  console.error("wallet_unclassified_failure", { message });
  return "❌ I couldn't complete that wallet request. Check the details and give it another try!";
}

async function submit(wallet: { signerWalletRef: string; address: string }, xUserId: string, requestId: string, operation: Record<string, unknown>) {
  if (!executionEnabled()) throw new Error("crypto execution is disabled");
  return await signerRequest<SubmittedTransaction>("/v1/transactions/execute", {
    idempotencyKey: requestId,
    ownerReference: `x:${xUserId}`,
    chainId: ROBINHOOD_CHAIN_ID,
    walletRef: wallet.signerWalletRef,
    expectedFrom: wallet.address,
    requireSimulation: true,
    operation,
  });
}

export const ensureWallet = internalAction({
  args: { xUserId: v.string() },
  handler: async (ctx, { xUserId }): Promise<Doc<"cryptoWallets"> | null> => {
    const current = await ctx.runQuery(internal.wallets.getXUserAndWallet, { xUserId });
    if (current?.wallet) {
      if (current.wallet.ownerXUserId !== xUserId || current.wallet.chainId !== ROBINHOOD_CHAIN_ID) {
        throw new Error("canonical X wallet binding mismatch");
      }
      return current.wallet;
    }
    const reservation = await ctx.runMutation(internal.wallets.beginWalletProvisioning, { xUserId });
    if (!reservation.needed) {
      // A concurrent delivery may be provisioning the same idempotent wallet.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return (await ctx.runQuery(internal.wallets.getXUserAndWallet, { xUserId }))?.wallet || null;
    }
    try {
      const wallet = await provisionSignerWallet(xUserId);
      await ctx.runMutation(internal.wallets.finishWalletProvisioning, { xUserId, address: wallet.address, signerWalletRef: wallet.walletRef });
      return (await ctx.runQuery(internal.wallets.getXUserAndWallet, { xUserId }))?.wallet || null;
    } catch (error) {
      await ctx.runMutation(internal.wallets.resetWalletProvisioning, { xUserId });
      throw error;
    }
  },
});

export const executeCommand = internalAction({
  args: {
    sourcePostId: v.string(), xUserId: v.string(), text: v.string(),
    mediaUrl: v.optional(v.string()), recipientAddress: v.optional(v.string()), parsedCommandJson: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CommandResult> => {
    const structured = args.parsedCommandJson
      ? validateStructuredWalletCommand(JSON.parse(args.parsedCommandJson) as unknown)
      : null;
    const command = structured || parseWalletCommand(args.text);
    const userContext = await ctx.runQuery(internal.wallets.getXUserAndWallet, { xUserId: args.xUserId });
    if (!userContext) return { ok: false, message: "❌ I couldn't connect this X account to its wallet. Please try again!" };
    let wallet = userContext.wallet;
    try {
      wallet ||= await ctx.runAction(internal.wallets.ensureWallet, { xUserId: args.xUserId });
    } catch (error) {
      return { ok: false, message: safeFailure(error) };
    }
    if (!wallet || wallet.status !== "active") return { ok: false, message: "🔒 This wallet isn't available right now. Please try again shortly." };
    if (command.kind === "create_wallet" || command.kind === "show_wallet") {
      return { ok: true, message: `👛 Your Robinhood Chain wallet is ready!\nYour wallet: ${walletPageUrl(wallet.address)}` };
    }
    if (command.kind === "show_balance") {
      try {
        const balance = await signerRequest<{ display: string }>("/v1/wallets/balance", {
          chainId: ROBINHOOD_CHAIN_ID, walletRef: wallet.signerWalletRef,
          expectedAddress: wallet.address, ownerReference: `x:${args.xUserId}`,
          ...(command.token ? { token: command.token } : {}),
        });
        return { ok: true, message: command.token ? `📊 ${command.token} balance: ${balance.display}\nYour wallet: ${walletPageUrl(wallet.address)}` : `📊 Here's your wallet balance:\n${balance.display}\nYour wallet: ${walletPageUrl(wallet.address)}` };
      } catch (error) {
        return { ok: false, message: safeFailure(error) };
      }
    }
    if (command.kind === "unknown") return { ok: false, message: command.reason };

    const requestId = `x:${args.sourcePostId}:${command.kind}`;
    const reserved = await ctx.runMutation(internal.wallets.reserveWalletRequest, {
      requestId, sourcePostId: args.sourcePostId, ownerXUserId: args.xUserId,
      walletId: wallet._id, kind: command.kind, normalizedJson: JSON.stringify(command),
    });
    if (!reserved.inserted) {
      const prior = reserved.request;
      return {
        ok: prior?.status === "confirmed",
        message: prior?.transactionHash
          ? `✅ This request was already completed!\nYour TXN: ${transactionUrl(prior.transactionHash)}`
          : "⏳ This request is already being processed. I'll keep it moving!",
        ...(prior?.transactionHash ? { transactionHash: prior.transactionHash } : {}),
      };
    }

    if (command.kind === "launch" && !userContext.user.verified) {
      await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "rejected", safeError: "verified X account required" });
      return { ok: false, message: "🔒 Token launches are currently available to verified X accounts. Once verified, you'll be ready to launch!" };
    }
    if (isValueMovingCommand(command)) {
      const limit = reserved.retried
        ? { allowed: true, count: 0, remaining: null as number | null }
        : await ctx.runMutation(internal.wallets.consumeWalletLimit, {
          xUserId: args.xUserId, premium: isPremium(userContext.user.subscriptionType),
        });
      if (!limit.allowed) {
        await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "rejected", safeError: "daily wallet limit reached" });
        return { ok: false, message: "⏰ You've reached today's wallet action limit. It resets at 00:00 UTC, then you're ready to go again!" };
      }
      const warning = limit.remaining === 2 ? "\n⚠️ 2 wallet actions remain today." : limit.remaining === 1 ? "\n⚠️ 1 wallet action remains today." : limit.remaining === 0 ? "\n⏰ Today's wallet limit is now reached." : "";
      try {
        await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "simulating" });
        const claimToken = command.kind === "claim_fees"
          ? await ctx.runQuery(internal.wallets.resolveClaimToken, { ownerXUserId: args.xUserId, identifier: command.token })
          : undefined;
        const operation = await operationFor(command, args.mediaUrl, claimToken, args.recipientAddress, userContext.user.username);
        const result = await submit(wallet, args.xUserId, requestId, operation);
        if (!/^0x[a-fA-F0-9]{64}$/.test(result.transactionHash)) throw new Error("signer returned an invalid transaction hash");
        if (result.status === "reverted") throw new Error("transaction reverted");
        const launchMetadata = command.kind === "launch" ? resolveLaunchMetadata(command, userContext.user.username) : undefined;
        const launchBase = command.kind === "launch" ? {
          ownerXUserId: args.xUserId, launchMode: command.launchMode, name: command.name,
          symbol: command.symbol, imageUri: String(operation.imageUri || ""),
          description: launchMetadata!.description, website: launchMetadata!.website,
          twitter: launchMetadata!.twitter,
          pairToken: String(operation.pairToken || ""),
          devBuyWei: result.valueWei || "0", tokenAddress: result.tokenAddress,
          poolAddress: result.poolAddress, positionId: result.positionId,
          devBuySucceeded: result.devBuySucceeded,
        } : undefined;
        if (result.status === "prepared") {
          if (!result.signedTransaction || !/^0x[a-fA-F0-9]+$/.test(result.signedTransaction)) throw new Error("signer returned an invalid prepared transaction");
          await ctx.runMutation(internal.wallets.recordPreparedExecution, {
            requestId, walletId: wallet._id, to: String(operation.recipient || operation.lockerAddress || operation.padAddress || operation.deadAddress || ""),
            valueWei: result.valueWei || "0", callKind: String(operation.type), transactionHash: result.transactionHash,
            signedTransaction: result.signedTransaction,
            launch: launchBase,
          });
          await ctx.runAction(internal.wallets.reconcileTransaction, { requestId });
          const reconciled = await ctx.runQuery(internal.wallets.getReconciliationContext, { requestId });
          if (reconciled?.request.status === "confirmed" && command.kind === "launch" && reconciled.launch?.tokenAddress) {
            return { ok: true, transactionHash: result.transactionHash, message: `${transactionMessage(command, result.transactionHash, "confirmed", reconciled.launch.tokenAddress)}${warning}` };
          }
          if (reconciled?.request.status === "failed") throw new Error(reconciled.request.safeError || "transaction reverted");
          return { ok: true, transactionHash: result.transactionHash, message: `${transactionMessage(command, result.transactionHash, "submitted")}${warning}` };
        }
        if (result.status === "broadcast" || result.status === "pending") throw new Error("signer returned an unpersisted broadcast");
        if (command.kind === "launch" && (!result.tokenAddress || !safeAddress(result.tokenAddress))) {
          throw new Error("launch receipt did not contain a token address");
        }
        if (command.kind === "launch" && (!result.poolAddress || !safeAddress(result.poolAddress) || !result.positionId)) {
          throw new Error("launch receipt did not contain its curve position");
        }
        await ctx.runMutation(internal.wallets.recordConfirmedExecution, {
          requestId, walletId: wallet._id, to: String(operation.recipient || operation.lockerAddress || operation.padAddress || operation.deadAddress || ""),
          valueWei: result.valueWei || "0", callKind: String(operation.type), transactionHash: result.transactionHash,
          blockNumber: result.blockNumber, launch: launchBase,
        });
        if (command.kind === "launch") {
          return { ok: true, transactionHash: result.transactionHash, message: `${transactionMessage(command, result.transactionHash, "confirmed", result.tokenAddress)}${warning}` };
        }
        return { ok: true, transactionHash: result.transactionHash, message: `${transactionMessage(command, result.transactionHash, "confirmed")}${warning}` };
      } catch (error) {
        const message = safeFailure(error);
        const userMessage = fundingMessage(message, wallet.address);
        await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "failed", safeError: message });
        return { ok: false, message: `${userMessage}${warning}` };
      }
    }
    return { ok: false, message: "✨ I can create your wallet, show balances, buy, sell, send, burn, and launch through Pons. Tell me what you'd like to do!" };
  },
});

async function operationFor(
  command: Exclude<WalletCommand, { kind: "unknown" }>,
  mediaUrl?: string,
  claimToken?: string,
  recipientAddress?: string,
  launcherUsername?: string,
): Promise<Record<string, unknown>> {
  if (command.kind === "send") {
    const recipient = safeAddress(command.recipient) ? command.recipient : recipientAddress;
    if (!recipient || !safeAddress(recipient) || recipient.toLowerCase() === DEAD_ADDRESS.toLowerCase()) throw new Error("invalid transfer destination");
    const nativeEth = !command.token || /^eth$/i.test(command.token);
    return { type: nativeEth ? "eth_transfer" : "erc20_transfer", recipient, amount: command.amount, unit: command.unit, ...(nativeEth ? {} : { token: command.token }) };
  }
  if (command.kind === "burn") {
    return { type: "erc20_burn_to_dead", deadAddress: DEAD_ADDRESS, amount: command.amount, unit: command.unit, token: command.token };
  }
  if (command.kind === "buy" || command.kind === "sell") {
    return {
      type: command.kind === "buy" ? "uniswap_v3_buy" : "uniswap_v3_sell",
      token: command.token, amount: command.amount, unit: command.unit, slippageBps: command.slippageBps,
      routerAddress: VERIFIED_SWAP_ROUTER, quoterAddress: VERIFIED_SWAP_QUOTER,
      wethAddress: VERIFIED_WETH, fee: 10_000,
    };
  }
  if (command.kind === "claim_fees") throw new Error("Pons creator-fee claims are not configured");
  if (command.kind === "launch") {
    const factoryAddress = process.env.PONS_V2_FACTORY_ADDRESS || PONS_V2_FACTORY;
    const launchAndBuyRouter = process.env.PONS_V2_LAUNCH_AND_BUY_ROUTER || PONS_V2_LAUNCH_AND_BUY_ROUTER;
    if (!safeAddress(factoryAddress)) throw new Error("Pons factory is not configured");
    if (!safeAddress(launchAndBuyRouter)) throw new Error("Pons launch-and-buy router is not configured");
    const imageUri = await normalizeImage(mediaUrl);
    const metadata = resolveLaunchMetadata(command, launcherUsername);
    const pairToken = await resolveLaunchPair(command.pairToken);
    return {
      type: command.devBuy ? "pons_v2_launch_and_buy" : "pons_v2_launch", launchMode: command.launchMode,
      factoryAddress, launchAndBuyRouter,
      name: command.name, symbol: command.symbol, imageUri,
      description: metadata.description,
      devBuy: command.devBuy || null,
      socials: { website: metadata.website, twitter: metadata.twitter },
      feeWalletSource: "reply_wallet",
      launchConfigId: process.env.PONS_LAUNCH_CONFIG_ID || "0",
      pairToken,
      method: command.devBuy ? "launchAndBuy" : "launchToken",
    };
  }
  throw new Error("operation is read-only");
}

async function resolveLaunchPair(identifier?: string) {
  if (!identifier || /^eth$/i.test(identifier)) return "0x0000000000000000000000000000000000000000";
  const assets = await discoverPonsV2PairAssets();
  const normalized = identifier.replace(/^\$/, "").toLowerCase();
  const match = assets.find((asset) => asset.symbol.toLowerCase() === normalized || asset.address.toLowerCase() === normalized);
  if (!match) throw new Error("requested Pons V2 pair is not currently approved");
  return match.address;
}

function resolveLaunchMetadata(command: Extract<WalletCommand, { kind: "launch" }>, launcherUsername?: string) {
  const fallbackTwitter = launcherUsername ? `https://x.com/${launcherUsername.replace(/^@/, "")}` : "";
  return {
    description: command.description?.trim() || DEFAULT_LAUNCH_DESCRIPTION,
    website: optionalUrl(command.website || DEFAULT_LAUNCH_WEBSITE, "website"),
    twitter: optionalSocialUrl(command.twitter || fallbackTwitter, "twitter", ["x.com", "twitter.com"]),
  };
}

function optionalUrl(value: string | undefined, label: string) {
  if (!value) return "";
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${label} must use https`);
  return url.toString();
}

function optionalSocialUrl(value: string | undefined, label: string, hosts: string[]) {
  const normalized = optionalUrl(value, label);
  if (!normalized) return "";
  const host = new URL(normalized).hostname.toLowerCase();
  if (!hosts.includes(host)) throw new Error(`${label} link uses an unsupported host`);
  return normalized;
}
