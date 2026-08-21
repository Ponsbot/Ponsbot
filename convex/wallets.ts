import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { isTerminalCommand, isValueMovingCommand, normalizeLaunchFeeOptions, normalizeLaunchLinks, normalizeLaunchTelegram, normalizeTelegramUrl, normalizeWebsiteUrl, normalizeXUrl, parseWalletCommand, validateStructuredWalletCommand, type WalletCommand } from "./walletCommands";
import { parseXWalletIntent, unknownWalletMessage, walletHelpMessage } from "./xWalletIntent";
import { formatUnits } from "viem";
import { walletCanLaunch } from "../lib/wallet-launch-policy";
import { applyProtectedLaunchProfile, launchTickerAllowed } from "../lib/special-launch-policy";

const ROBINHOOD_CHAIN_ID = 4663;
const NON_PREMIUM_DAILY_LIMIT = 50;
const PREMIUM_DAILY_LIMIT = 1_000;
const PROVISIONING_LEASE_MS = 2 * 60_000;
const MAX_RECONCILIATION_ATTEMPTS = 20;
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";
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
  toAddress?: string;
  callKind?: string;
  approvalRequired?: boolean;
  approvalTokenAddress?: string;
  claimedDisplay?: string;
  tradeOutputDisplay?: string;
  tradeOutputTokenAddress?: string;
  tradeOutputBalanceBefore?: string;
  involvedPairTokenAddress?: string;
};
type CommandResult = { ok: boolean; message: string; transactionHash?: string };
type RuntimeRegistry = { contracts: Record<string, string>; pairs: Array<{ address: string; symbol: string; pairApproved: boolean; active: boolean }> };
type PonsPairInfo = { isPons: boolean; pairToken?: string; nativePair?: boolean; phase?: number };

function operationDestination(operation: Record<string, unknown>) {
  const destination = operation.type === "pons_v2_launch" ? operation.factoryAddress
    : operation.type === "pons_v2_launch_and_buy" ? operation.launchAndBuyRouter
      : operation.type === "pons_v2_create_holder_distributor" ? operation.distributorFactoryAddress
        : operation.type === "pons_v2_transfer_creator_fee_recipient" ? operation.factoryAddress
      : operation.recipient || operation.routerAddress || operation.lockerAddress || operation.padAddress || operation.deadAddress;
  if (typeof destination !== "string" || !safeAddress(destination)) {
    throw new Error("transaction destination is missing or invalid");
  }
  return destination;
}

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

function ponsBotTokenUrl(address: string) {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "");
  return `${site || "https://ponsbot-one.vercel.app"}/launch/${address}`;
}

function destinationLabel(recipient: string) {
  return safeAddress(recipient) ? addressUrl(recipient) : recipient;
}

function assetLabel(token: string | undefined, fallback = "ETH") {
  if (!token) return fallback;
  if (/^eth$/i.test(token)) return "ETH";
  if (safeAddress(token)) return "token";
  return `$${token.replace(/^\$/, "").toUpperCase()}`;
}

function tradeDisplayAmount(display: string) {
  const amount = display.trim().match(/^([0-9]+(?:\.[0-9]+)?)/)?.[1];
  if (!amount || Number(amount) <= 0) throw new Error("trade output amount was not verified");
  return amount;
}

function replyCommand(command: WalletCommand, tokenSymbol: string | undefined, registry: RuntimeRegistry): WalletCommand {
  const displayToken = (value: string | undefined) => {
    if (!value || !safeAddress(value)) return value;
    if (tokenSymbol) return tokenSymbol;
    return registry.pairs.find((item) => item.address.toLowerCase() === value.toLowerCase())?.symbol || "token";
  };
  if (command.kind === "send" && command.token) return { ...command, token: displayToken(command.token) };
  if (command.kind === "burn" || command.kind === "sell" || command.kind === "claim_fees" || command.kind === "buy_and_send" || command.kind === "buy_and_burn") {
    return { ...command, ...(command.token ? { token: displayToken(command.token) } : {}) } as WalletCommand;
  }
  if (command.kind === "buy") return { ...command, token: displayToken(command.token)!, pairAsset: displayToken(command.pairAsset) };
  if (command.kind === "swap_token_for_token") return {
    ...command, fromToken: displayToken(command.fromToken)!, toToken: displayToken(command.toToken)!,
  };
  if (command.kind === "show_balance" && command.token) return { ...command, token: displayToken(command.token) };
  if (command.kind === "launch" && command.pairToken) return { ...command, pairToken: displayToken(command.pairToken) };
  return command;
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
  if (command.kind === "buy") return `Bought ${command.unit === "usd" ? `$${command.amount}` : command.unit === "eth" ? `${command.amount} ETH` : `${command.amount} ${assetLabel(command.pairAsset)}`} of ${assetLabel(command.token)}!`;
  if (command.kind === "buy_and_send") return `Bought ${command.unit === "usd" ? `$${command.amount}` : command.unit === "eth" ? `${command.amount} ETH` : `${command.amount} ${assetLabel(command.pairAsset)}`} of ${assetLabel(command.token)} and sent the purchased tokens to ${destinationLabel(command.recipient)}!`;
  if (command.kind === "buy_and_burn") return `Bought ${command.unit === "usd" ? `$${command.amount}` : command.unit === "eth" ? `${command.amount} ETH` : `${command.amount} ${assetLabel(command.pairAsset)}`} of ${assetLabel(command.token)} and burned the purchased tokens!`;
  if (command.kind === "swap_token_for_token") return `Swapped $${command.amount} of ${assetLabel(command.fromToken)} for ${assetLabel(command.toToken)}!`;
  if (command.kind === "sell") return `Sold ${command.unit === "percent" ? `${command.amount}% of ` : `${command.amount} `}${assetLabel(command.token)}!`;
  if (command.kind === "claim_fees") return `Claimed creator fees${command.token ? ` for ${assetLabel(command.token)}` : ""}!`;
  if (command.kind === "launch") {
    const pair = command.pairToken && !/^eth$/i.test(command.pairToken)
      ? `, paired with ${safeAddress(command.pairToken) ? addressUrl(command.pairToken) : `$${command.pairToken.replace(/^\$/, "")}`}`
      : "";
    const fees = command.holderFeeSharing ? ", with holder fee sharing"
      : command.feeRecipient ? `, with creator fees assigned${command.feeRecipient.startsWith("@") ? ` to ${command.feeRecipient}` : " to the selected wallet"}` : "";
    return `Launched ${command.name} (${command.symbol}) on Pons V2${pair}${fees}! 🚀`;
  }
  return "Transaction submitted!";
}

function transactionMessage(command: WalletCommand, transactionHash: string, tokenAddress?: string, claimedDisplay?: string, tradeOutputDisplay?: string) {
  const summary = command.kind === "claim_fees" && claimedDisplay
    ? `Claimed ${claimedDisplay} in creator fees${command.token ? ` for ${assetLabel(command.token)}` : ""}!`
    : commandSummary(command);
  const tokenLine = command.kind === "launch" && tokenAddress ? `\nView Token: ${ponsBotTokenUrl(tokenAddress)}` : "";
  const outputLine = (command.kind === "buy" || command.kind === "sell") && tradeOutputDisplay ? `\nReceived: ${tradeOutputDisplay}` : "";
  return `✅ Success! ${summary}${outputLine}${tokenLine}\nYour TXN: ${transactionUrl(transactionHash)}`;
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

async function signerRequest<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  const { baseUrl, token } = signerConfiguration();

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || (path.endsWith("/execute") ? 45_000 : 20_000)),
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
      if (existing.walletId) await ctx.db.patch(existing.walletId, { xUsername: args.username, updatedAt: now });
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
    const normalizedAddress = args.address.toLowerCase();
    const addressOwner = await ctx.db.query("cryptoWallets").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", normalizedAddress)).unique()
      || await ctx.db.query("cryptoWallets").withIndex("by_address", (q) => q.eq("address", args.address)).unique();
    if (addressOwner && addressOwner.ownerXUserId !== args.xUserId) throw new Error("wallet address is already bound to another X user");
    if (existing && (existing.address.toLowerCase() !== args.address.toLowerCase()
      || existing.signerWalletRef.toLowerCase() !== args.signerWalletRef.toLowerCase()
      || existing.chainId !== ROBINHOOD_CHAIN_ID)) throw new Error("canonical X wallet binding mismatch");
    const now = Date.now();
    const walletId = existing?._id || await ctx.db.insert("cryptoWallets", {
      ownerXUserId: args.xUserId, xUsername: user.username, address: args.address, normalizedAddress, signerWalletRef: args.signerWalletRef,
      chainId: ROBINHOOD_CHAIN_ID, status: "active", launchEnabled: true, createdAt: now, updatedAt: now,
    });
    if (existing && existing.xUsername !== user.username) await ctx.db.patch(existing._id, { xUsername: user.username, updatedAt: now });
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
  args: { requestId: v.string(), sourcePostId: v.string(), ownerXUserId: v.string(), walletId: v.id("cryptoWallets"), kind: v.string(), normalizedJson: v.string(), source: v.optional(v.union(v.literal("x"), v.literal("terminal"))), channel: v.optional(v.union(v.literal("x_reply"), v.literal("terminal_chat"), v.literal("terminal_form"))) },
  handler: async (ctx, args) => {
    const duplicate = await ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (duplicate) {
      if (duplicate.status === "failed" && !duplicate.transactionHash && Date.now() - duplicate.updatedAt >= 30_000) {
        await ctx.db.patch(duplicate._id, { status: "accepted", safeError: undefined, updatedAt: Date.now() });
        return { inserted: true, retried: true, request: await ctx.db.get(duplicate._id) };
      }
      return { inserted: false, retried: false, request: duplicate };
    }
    const related = (!args.source || !args.channel)
      ? await ctx.db.query("walletRequests").withIndex("by_source_post_id", (q) => q.eq("sourcePostId", args.sourcePostId)).collect()
      : [];
    const parent = related.find((item) => item.ownerXUserId === args.ownerXUserId
      && item.walletId === args.walletId && item.source && item.channel);
    const now = Date.now();
    const id = await ctx.db.insert("walletRequests", {
      ...args,
      ...(args.source ? {} : parent?.source ? { source: parent.source } : {}),
      ...(args.channel ? {} : parent?.channel ? { channel: parent.channel } : {}),
      status: "accepted", createdAt: now, updatedAt: now,
    });
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
    if (request) {
      const patch: { status: typeof args.status; updatedAt: number; safeError?: string; transactionHash?: string } = {
        status: args.status,
        updatedAt: Date.now(),
      };
      if (args.safeError !== undefined) patch.safeError = args.safeError;
      if (args.transactionHash !== undefined) patch.transactionHash = args.transactionHash;
      await ctx.db.patch(request._id, patch);
    }
  },
});

export const getWalletRequest = internalQuery({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique(),
});

const launchRecordValidator = v.object({
  ownerXUserId: v.string(), launcherUsername: v.optional(v.string()), launchMode: v.literal("pons"),
  name: v.string(), symbol: v.string(), imageUri: v.string(), devBuyWei: v.string(),
  description: v.optional(v.string()), website: v.optional(v.string()),
  twitter: v.optional(v.string()),
  telegram: v.optional(v.string()),
  pairToken: v.optional(v.string()),
  tokenAddress: v.optional(v.string()), normalizedTokenAddress: v.optional(v.string()), poolAddress: v.optional(v.string()),
  positionId: v.optional(v.string()), devBuySucceeded: v.optional(v.boolean()),
  creatorFeeRecipient: v.optional(v.string()), normalizedCreatorFeeRecipient: v.optional(v.string()),
  holderFeeSharing: v.optional(v.boolean()), holderFeeDistributor: v.optional(v.string()),
  holderFeeSharingStatus: v.optional(v.union(v.literal("pending"), v.literal("enabled"), v.literal("retrying"), v.literal("failed"))),
  holderFeeSharingAttempts: v.optional(v.number()), holderFeeSharingLastError: v.optional(v.string()), holderFeeSharingNextAttemptAt: v.optional(v.number()),
});

export const recordPreparedExecution = internalMutation({
  args: {
    requestId: v.string(), walletId: v.id("cryptoWallets"), to: v.string(), valueWei: v.string(),
    callKind: v.string(), transactionHash: v.string(), signedTransaction: v.string(), launch: v.optional(launchRecordValidator),
    tradeOutputTokenAddress: v.optional(v.string()), tradeOutputBalanceBefore: v.optional(v.string()), involvedPairTokenAddress: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db.query("walletTransactions").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!existing) await ctx.db.insert("walletTransactions", {
      requestId: args.requestId, walletId: args.walletId, chainId: ROBINHOOD_CHAIN_ID,
      to: args.to, valueWei: args.valueWei, callKind: args.callKind,
      transactionHash: args.transactionHash, signedTransaction: args.signedTransaction,
      tradeOutputTokenAddress: args.tradeOutputTokenAddress, tradeOutputBalanceBefore: args.tradeOutputBalanceBefore,
      involvedPairTokenAddress: args.involvedPairTokenAddress,
      status: "prepared", createdAt: now, updatedAt: now,
    });
    if (args.launch) {
      const launch = await ctx.db.query("tokenLaunches").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
      if (!launch) await ctx.db.insert("tokenLaunches", {
        requestId: args.requestId, walletId: args.walletId, transactionHash: args.transactionHash,
        ...args.launch, ...(args.launch.tokenAddress ? { normalizedTokenAddress: args.launch.tokenAddress.toLowerCase() } : {}), createdAt: now, updatedAt: now,
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

export const acquireWalletExecutionLock = internalMutation({
  args: { walletId: v.id("cryptoWallets"), requestId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const current = await ctx.db.query("walletExecutionLocks").withIndex("by_wallet_id", (q) => q.eq("walletId", args.walletId)).unique();
    if (current && current.requestId !== args.requestId && current.leaseUntil > now) return false;
    const value = { requestId: args.requestId, leaseUntil: now + 5 * 60_000, updatedAt: now };
    if (current) await ctx.db.patch(current._id, value);
    else await ctx.db.insert("walletExecutionLocks", { walletId: args.walletId, ...value });
    return true;
  },
});

export const releaseWalletExecutionLock = internalMutation({
  args: { walletId: v.id("cryptoWallets"), requestId: v.string() },
  handler: async (ctx, args) => {
    const current = await ctx.db.query("walletExecutionLocks").withIndex("by_wallet_id", (q) => q.eq("walletId", args.walletId)).unique();
    if (current?.requestId === args.requestId) await ctx.db.delete(current._id);
  },
});

export const recordApprovalPrepared = internalMutation({
  args: { requestId: v.string(), walletId: v.id("cryptoWallets"), tokenAddress: v.string(), transactionHash: v.string(), signedTransaction: v.string() },
  handler: async (ctx, args) => {
    const approvalRequestId = `${args.requestId}:approval`;
    const existing = await ctx.db.query("walletTransactions").withIndex("by_request_id", (q) => q.eq("requestId", approvalRequestId)).unique();
    if (existing) return existing;
    const now = Date.now();
    const id = await ctx.db.insert("walletTransactions", {
      requestId: approvalRequestId, walletId: args.walletId, chainId: ROBINHOOD_CHAIN_ID,
      to: args.tokenAddress.toLowerCase(), valueWei: "0", callKind: "erc20_approval",
      transactionHash: args.transactionHash, signedTransaction: args.signedTransaction,
      status: "prepared", createdAt: now, updatedAt: now,
    });
    return await ctx.db.get(id);
  },
});

export const updateApprovalStatus = internalMutation({
  args: {
    requestId: v.string(),
    status: v.union(v.literal("broadcast"), v.literal("confirmed"), v.literal("reverted"), v.literal("invalid")),
    blockNumber: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const transaction = await ctx.db.query("walletTransactions")
      .withIndex("by_request_id", (q) => q.eq("requestId", `${args.requestId}:approval`)).unique();
    if (transaction) await ctx.db.patch(transaction._id, { status: args.status, blockNumber: args.blockNumber, updatedAt: Date.now() });
  },
});

export const resolveKnownToken = internalQuery({
  args: { identifier: v.string(), walletId: v.optional(v.id("cryptoWallets")) },
  handler: async (ctx, { identifier, walletId }) => {
    const normalized = identifier.replace(/^\$/, "").toLowerCase();
    if (safeAddress(normalized)) return identifier;
    const matches = new Set<string>();
    if (walletId) {
      const walletTokens = await ctx.db.query("walletTokenIndex").withIndex("by_wallet", (q) => q.eq("walletId", walletId)).collect();
      for (const item of walletTokens) if (item.symbol.toLowerCase() === normalized) matches.add(item.tokenAddress);
    }
    const registered = await ctx.db.query("tokenRegistry").withIndex("by_symbol", (q) => q.eq("symbol", normalized.toUpperCase())).collect();
    for (const item of registered) if (item.active) matches.add(item.address);
    const launches = await ctx.db.query("tokenLaunches").withIndex("by_symbol", (q) => q.eq("symbol", normalized.toUpperCase())).take(100);
    for (const launch of launches) if (launch.tokenAddress) matches.add(launch.tokenAddress);
    if (matches.size > 1) throw new Error("that ticker matches more than one token; use the contract address");
    return [...matches][0] || identifier;
  },
});

export const listKnownTokenMatches = internalQuery({
  args: { identifier: v.string(), walletId: v.optional(v.id("cryptoWallets")) },
  handler: async (ctx, { identifier, walletId }) => {
    const normalized = identifier.replace(/^\$/, "").toLowerCase();
    if (safeAddress(normalized)) return [identifier];
    const matches = new Set<string>();
    if (walletId) {
      const walletTokens = await ctx.db.query("walletTokenIndex").withIndex("by_wallet", (q) => q.eq("walletId", walletId)).collect();
      for (const item of walletTokens) if (item.symbol.toLowerCase() === normalized) matches.add(item.tokenAddress);
    }
    const registered = await ctx.db.query("tokenRegistry").withIndex("by_symbol", (q) => q.eq("symbol", normalized.toUpperCase())).collect();
    for (const item of registered) if (item.active) matches.add(item.address);
    const launches = await ctx.db.query("tokenLaunches").withIndex("by_symbol", (q) => q.eq("symbol", normalized.toUpperCase())).take(100);
    for (const launch of launches) if (launch.tokenAddress) matches.add(launch.tokenAddress);
    return [...matches];
  },
});

export const listWalletTokenAddresses = internalQuery({
  args: { walletId: v.id("cryptoWallets") },
  handler: async (ctx, { walletId }) => (await ctx.db.query("walletTokenIndex").withIndex("by_wallet", (q) => q.eq("walletId", walletId)).collect())
    .map((item) => item.tokenAddress),
});

export const listOwnedLaunchTokens = internalQuery({
  args: { xUserId: v.string() },
  handler: async (ctx, { xUserId }) => {
    const wallet = await ctx.db.query("cryptoWallets").withIndex("by_owner_x_user_id", (q) => q.eq("ownerXUserId", xUserId)).unique();
    const owned = await ctx.db.query("tokenLaunches").withIndex("by_owner_created_at", (q) => q.eq("ownerXUserId", xUserId)).collect();
    const beneficiary = wallet ? await ctx.db.query("tokenLaunches")
      .withIndex("by_creator_fee_recipient", (q) => q.eq("normalizedCreatorFeeRecipient", wallet.address.toLowerCase())).collect() : [];
    const launches = [...new Map([...owned, ...beneficiary].map((launch) => [launch._id, launch])).values()];
    // claim() collects the ETH escrow at once. Non-ETH pair escrows require
    // claimToken(pair) and deliberately remain individual token claims.
    return launches.flatMap((launch) => launch.tokenAddress && !launch.holderFeeSharing
      && (!launch.creatorFeeRecipient || launch.creatorFeeRecipient.toLowerCase() === wallet?.address.toLowerCase())
      && (!launch.pairToken || /^0x0{40}$/i.test(launch.pairToken)) ? [launch.tokenAddress] : []);
  },
});

export const indexWalletToken = internalMutation({
  args: {
    walletId: v.id("cryptoWallets"), tokenAddress: v.string(), symbol: v.string(),
    involvedByLaunch: v.boolean(), involvedByTransaction: v.boolean(),
  },
  handler: async (ctx, args) => {
    const normalizedTokenAddress = args.tokenAddress.toLowerCase();
    const existing = await ctx.db.query("walletTokenIndex").withIndex("by_wallet_token", (q) => q.eq("walletId", args.walletId).eq("normalizedTokenAddress", normalizedTokenAddress)).unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        symbol: args.symbol.toUpperCase(), involvedByLaunch: existing.involvedByLaunch || args.involvedByLaunch,
        involvedByTransaction: existing.involvedByTransaction || args.involvedByTransaction, updatedAt: now,
      });
    } else {
      await ctx.db.insert("walletTokenIndex", {
        walletId: args.walletId, tokenAddress: args.tokenAddress, normalizedTokenAddress,
        symbol: args.symbol.toUpperCase(), involvedByLaunch: args.involvedByLaunch,
        involvedByTransaction: args.involvedByTransaction, createdAt: now, updatedAt: now,
      });
    }
  },
});

export const recordBroadcastExecution = internalMutation({
  args: {
    requestId: v.string(), walletId: v.id("cryptoWallets"), to: v.string(), valueWei: v.string(),
    callKind: v.string(), transactionHash: v.string(), launch: v.optional(launchRecordValidator),
    tradeOutputTokenAddress: v.optional(v.string()), tradeOutputBalanceBefore: v.optional(v.string()), involvedPairTokenAddress: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db.query("walletTransactions").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!existing) await ctx.db.insert("walletTransactions", {
      requestId: args.requestId, walletId: args.walletId, chainId: ROBINHOOD_CHAIN_ID,
      to: args.to, valueWei: args.valueWei, callKind: args.callKind,
      transactionHash: args.transactionHash, status: "broadcast",
      tradeOutputTokenAddress: args.tradeOutputTokenAddress, tradeOutputBalanceBefore: args.tradeOutputBalanceBefore,
      involvedPairTokenAddress: args.involvedPairTokenAddress, createdAt: now, updatedAt: now,
    });
    if (args.launch) {
      const launch = await ctx.db.query("tokenLaunches").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
      if (!launch) await ctx.db.insert("tokenLaunches", {
        requestId: args.requestId, walletId: args.walletId, transactionHash: args.transactionHash,
        ...args.launch, ...(args.launch.tokenAddress ? { normalizedTokenAddress: args.launch.tokenAddress.toLowerCase() } : {}), createdAt: now, updatedAt: now,
      });
    }
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (request) await ctx.db.patch(request._id, {
      status: "broadcast", transactionHash: args.transactionHash, reconciliationAttempts: 0,
      nextReconcileAt: now + 15_000, safeError: undefined, updatedAt: now,
    });
    await ctx.scheduler.runAfter(15_000, internal.wallets.reconcileTransaction, { requestId: args.requestId });
  },
});

export const recordConfirmedExecution = internalMutation({
  args: {
    requestId: v.string(), walletId: v.id("cryptoWallets"), to: v.string(), valueWei: v.string(),
    callKind: v.string(), transactionHash: v.string(), blockNumber: v.optional(v.string()), claimedDisplay: v.optional(v.string()),
    tradeOutputDisplay: v.optional(v.string()), tradeOutputTokenAddress: v.optional(v.string()),
    tradeOutputBalanceBefore: v.optional(v.string()), involvedPairTokenAddress: v.optional(v.string()),
    launch: v.optional(launchRecordValidator),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("walletTransactions").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    const now = Date.now();
    if (!existing) await ctx.db.insert("walletTransactions", {
      requestId: args.requestId, walletId: args.walletId, chainId: ROBINHOOD_CHAIN_ID,
      to: args.to, valueWei: args.valueWei, callKind: args.callKind,
      transactionHash: args.transactionHash, status: "confirmed", blockNumber: args.blockNumber, claimedDisplay: args.claimedDisplay,
      tradeOutputDisplay: args.tradeOutputDisplay, tradeOutputTokenAddress: args.tradeOutputTokenAddress,
      tradeOutputBalanceBefore: args.tradeOutputBalanceBefore, involvedPairTokenAddress: args.involvedPairTokenAddress,
      createdAt: now, updatedAt: now,
    });
    else await ctx.db.patch(existing._id, {
      status: "confirmed", blockNumber: args.blockNumber, claimedDisplay: args.claimedDisplay,
      tradeOutputDisplay: args.tradeOutputDisplay, tradeOutputTokenAddress: args.tradeOutputTokenAddress || existing.tradeOutputTokenAddress,
      tradeOutputBalanceBefore: args.tradeOutputBalanceBefore || existing.tradeOutputBalanceBefore,
      involvedPairTokenAddress: args.involvedPairTokenAddress || existing.involvedPairTokenAddress, updatedAt: now,
    });
    if (args.launch) {
      const launchWallet = await ctx.db.get(args.walletId);
      const launchPair = args.launch.pairToken ? await ctx.db.query("tokenRegistry").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", args.launch!.pairToken!.toLowerCase())).unique() : null;
      const publicFields = { creatorAddress: launchWallet?.address, pairSymbol: args.launch.pairToken === "0x0000000000000000000000000000000000000000" ? "ETH" : launchPair?.symbol };
      const launch = await ctx.db.query("tokenLaunches").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
      if (!launch) await ctx.db.insert("tokenLaunches", {
        requestId: args.requestId, walletId: args.walletId, transactionHash: args.transactionHash,
        ...args.launch, ...publicFields, ...(args.launch.tokenAddress ? { normalizedTokenAddress: args.launch.tokenAddress.toLowerCase(), graduationAnnouncementStatus: "monitoring" as const } : {}), createdAt: now, updatedAt: now,
      });
      if (launch) await ctx.db.patch(launch._id, {
        ...args.launch, ...publicFields,
        ...(args.launch.tokenAddress ? {
          normalizedTokenAddress: args.launch.tokenAddress.toLowerCase(),
          ...(launch.graduationAnnouncementStatus ? {} : { graduationAnnouncementStatus: "monitoring" as const }),
        } : {}), updatedAt: now,
      });
      if (args.launch.holderFeeSharing && args.launch.tokenAddress) {
        await ctx.scheduler.runAfter(30_000, internal.wallets.resumeHolderFeeSharing, { requestId: args.requestId });
      }
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
    if (args.attempt >= MAX_RECONCILIATION_ATTEMPTS) {
      await ctx.db.patch(request._id, {
        status: "failed", safeError: "transaction status requires manual review",
        reconciliationAttempts: args.attempt, nextReconcileAt: undefined, updatedAt: Date.now(),
      });
      return;
    }
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

export const deferHolderFeeSharing = internalMutation({
  args: { requestId: v.string(), safeError: v.string() },
  handler: async (ctx, args) => {
    const launch = await ctx.db.query("tokenLaunches").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!launch || !launch.holderFeeSharing || launch.holderFeeDistributor) return;
    const attempts = (launch.holderFeeSharingAttempts || 0) + 1;
    if (attempts >= 8) {
      await ctx.db.patch(launch._id, {
        holderFeeSharingStatus: "failed", holderFeeSharingAttempts: attempts,
        holderFeeSharingLastError: args.safeError.slice(0, 240), holderFeeSharingNextAttemptAt: undefined, updatedAt: Date.now(),
      });
      return;
    }
    const delay = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
    await ctx.db.patch(launch._id, {
      holderFeeSharingStatus: "retrying", holderFeeSharingAttempts: attempts,
      holderFeeSharingLastError: args.safeError.slice(0, 240), holderFeeSharingNextAttemptAt: Date.now() + delay, updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(delay, internal.wallets.resumeHolderFeeSharing, { requestId: args.requestId });
  },
});

export const resumeHolderFeeSharing = internalAction({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => {
    const current = await ctx.runQuery(internal.wallets.getReconciliationContext, { requestId });
    if (!current?.wallet || !current.launch?.tokenAddress || !current.launch.holderFeeSharing || current.launch.holderFeeDistributor) return;
    const lockRequestId = `${requestId}:holder-resume:${Date.now()}`;
    const locked = await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, { walletId: current.wallet._id, requestId: lockRequestId });
    if (!locked) {
      await ctx.runMutation(internal.wallets.deferHolderFeeSharing, { requestId, safeError: "wallet is busy with another transaction" });
      return;
    }
    try {
      const registry = await ctx.runQuery(internal.registry.runtimeConfig, {});
      const command: Extract<WalletCommand, { kind: "launch" }> = {
        kind: "launch", launchMode: "pons", name: current.launch.name, symbol: current.launch.symbol,
        holderFeeSharing: true,
      };
      await enableHolderFeeSharing(ctx, current.wallet, current.launch.ownerXUserId, current.request.sourcePostId, requestId, command, current.launch.tokenAddress, registry);
    } catch (error) {
      await ctx.runMutation(internal.wallets.deferHolderFeeSharing, {
        requestId, safeError: error instanceof Error ? error.message : "holder fee sharing recovery failed",
      });
    } finally {
      await ctx.runMutation(internal.wallets.releaseWalletExecutionLock, { walletId: current.wallet._id, requestId: lockRequestId });
    }
  },
});

export const recordHolderFeeDistributor = internalMutation({
  args: { requestId: v.string(), distributor: v.string() },
  handler: async (ctx, args) => {
    const launch = await ctx.db.query("tokenLaunches").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (launch) await ctx.db.patch(launch._id, {
      holderFeeSharing: true, holderFeeDistributor: args.distributor,
      creatorFeeRecipient: args.distributor, normalizedCreatorFeeRecipient: args.distributor.toLowerCase(),
      holderFeeSharingStatus: "enabled", holderFeeSharingLastError: undefined, holderFeeSharingNextAttemptAt: undefined, updatedAt: Date.now(),
    });
  },
});

export const recordInvalidReceipt = internalMutation({
  args: { requestId: v.string(), safeError: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    const transaction = await ctx.db.query("walletTransactions").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (request) await ctx.db.patch(request._id, { status: "failed", safeError: args.safeError, nextReconcileAt: undefined, updatedAt: now });
    if (transaction) await ctx.db.patch(transaction._id, { status: "invalid", updatedAt: now });
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
        expectedTo: current.transaction.to,
        ...(current.transaction.tradeOutputTokenAddress ? { tradeOutputTokenAddress: current.transaction.tradeOutputTokenAddress } : {}),
        ...(current.transaction.tradeOutputBalanceBefore ? { tradeOutputBalanceBefore: current.transaction.tradeOutputBalanceBefore } : {}),
        ...(current.transaction.involvedPairTokenAddress ? { involvedPairTokenAddress: current.transaction.involvedPairTokenAddress } : {}),
      };
      const expectedFactory = current.transaction.callKind.startsWith("pons_v2_launch")
        ? (await ctx.runQuery(internal.registry.runtimeConfig, {})).contracts.pons_v2_factory
        : undefined;
      const verifiedStatusBody = expectedFactory ? { ...statusBody, expectedFactory } : statusBody;
      const result = current.request.status === "prepared"
        ? await signerRequest<SubmittedTransaction>("/v1/transactions/broadcast", {
          ...verifiedStatusBody, signedTransaction: current.transaction.signedTransaction,
        })
        : await signerRequest<SubmittedTransaction>("/v1/transactions/status", verifiedStatusBody);
      if (result.status === "broadcast" || result.status === "pending") {
        if (current.request.status === "prepared") await ctx.runMutation(internal.wallets.markTransactionBroadcast, { requestId: args.requestId });
        else await ctx.runMutation(internal.wallets.deferReconciliation, { requestId: args.requestId, attempt: (current.request.reconciliationAttempts || 0) + 1 });
        return;
      }
      if (result.status === "reverted") {
        await ctx.runMutation(internal.wallets.recordRevertedExecution, { requestId: args.requestId, blockNumber: result.blockNumber });
        return;
      }
      if (current.transaction.callKind.startsWith("pons_v2_launch") && (!result.tokenAddress || !result.poolAddress)) throw new Error("launch receipt was incomplete");
      const launch = current.launch ? {
        ownerXUserId: current.launch.ownerXUserId, launcherUsername: current.launch.launcherUsername, launchMode: current.launch.launchMode,
        name: current.launch.name, symbol: current.launch.symbol, imageUri: current.launch.imageUri,
        description: current.launch.description, website: current.launch.website, twitter: current.launch.twitter, telegram: current.launch.telegram,
        devBuyWei: result.valueWei || current.launch.devBuyWei,
        tokenAddress: result.tokenAddress || current.launch.tokenAddress,
        poolAddress: result.poolAddress || current.launch.poolAddress,
        positionId: result.positionId || current.launch.positionId,
        devBuySucceeded: result.devBuySucceeded,
      } : undefined;
      await ctx.runMutation(internal.wallets.recordConfirmedExecution, {
        requestId: args.requestId, walletId: current.wallet._id, to: current.transaction.to,
        valueWei: result.valueWei || current.transaction.valueWei, callKind: current.transaction.callKind,
        transactionHash: current.request.transactionHash, blockNumber: result.blockNumber, claimedDisplay: result.claimedDisplay,
        tradeOutputDisplay: result.tradeOutputDisplay, tradeOutputTokenAddress: result.tradeOutputTokenAddress,
        tradeOutputBalanceBefore: current.transaction.tradeOutputBalanceBefore,
        involvedPairTokenAddress: result.involvedPairTokenAddress || current.transaction.involvedPairTokenAddress, launch,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      console.error("wallet_reconciliation_failed", { requestId: args.requestId, message });
      if (/mismatch|verified Pons launch event|verified opening developer buy event|verified creator fee claim event/i.test(message)) {
        await ctx.runMutation(internal.wallets.recordInvalidReceipt, { requestId: args.requestId, safeError: "on-chain receipt verification failed" });
        return;
      }
      await ctx.runMutation(internal.wallets.deferReconciliation, { requestId: args.requestId, attempt: (current.request.reconciliationAttempts || 0) + 1 });
    }
  },
});

function isPremium(subscriptionType?: string) {
  return subscriptionType === "Premium" || subscriptionType === "PremiumPlus";
}

export const persistLaunchPrediction = internalMutation({
  args: { requestId: v.string(), preparedLaunchSalt: v.string(), predictedTokenAddress: v.string(), predictedCurveAddress: v.string() },
  handler: async (ctx, args) => {
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!request) throw new Error("wallet request not found");
    if (request.preparedLaunchSalt) {
      if (request.preparedLaunchSalt !== args.preparedLaunchSalt
        || request.predictedTokenAddress?.toLowerCase() !== args.predictedTokenAddress.toLowerCase()
        || request.predictedCurveAddress?.toLowerCase() !== args.predictedCurveAddress.toLowerCase()) throw new Error("launch prediction changed during retry");
      return;
    }
    await ctx.db.patch(request._id, { preparedLaunchSalt: args.preparedLaunchSalt, predictedTokenAddress: args.predictedTokenAddress, predictedCurveAddress: args.predictedCurveAddress, updatedAt: Date.now() });
  },
});

async function prepareAndPersistLaunch(
  ctx: ActionCtx, wallet: Doc<"cryptoWallets">, xUserId: string, requestId: string, operation: Record<string, unknown>,
) {
  const saved = await ctx.runQuery(internal.wallets.getWalletRequest, { requestId });
  if (saved?.preparedLaunchSalt && saved.predictedTokenAddress && saved.predictedCurveAddress) return {
    ...operation, preparedSalt: saved.preparedLaunchSalt,
    predictedTokenAddress: saved.predictedTokenAddress, predictedCurveAddress: saved.predictedCurveAddress,
  };
  const prediction = await signerRequest<{ preparedSalt: string; predictedTokenAddress: string; predictedCurveAddress: string }>("/v1/transactions/prepare-launch", {
    idempotencyKey: requestId, ownerReference: `x:${xUserId}`, chainId: ROBINHOOD_CHAIN_ID,
    walletRef: wallet.signerWalletRef, expectedFrom: wallet.address, requireSimulation: true, operation,
  }, 240_000);
  if (!/^0x[a-fA-F0-9]{64}$/.test(prediction.preparedSalt) || !safeAddress(prediction.predictedTokenAddress)
    || !safeAddress(prediction.predictedCurveAddress) || !prediction.predictedTokenAddress.toLowerCase().endsWith("b07")) throw new Error("signer returned an invalid b07 launch prediction");
  await ctx.runMutation(internal.wallets.persistLaunchPrediction, {
    requestId, preparedLaunchSalt: prediction.preparedSalt,
    predictedTokenAddress: prediction.predictedTokenAddress, predictedCurveAddress: prediction.predictedCurveAddress,
  });
  return { ...operation, ...prediction };
}

function walletPageUrl(address: string) {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  return site ? `${site}/wallet/${address}` : addressUrl(address);
}

function safeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "wallet request failed";
  if (/^The buy completed, but the send did not\./i.test(message)) return `⚠️ ${message}`;
  if (/^The .+ sale completed, but the purchase of /i.test(message)) return `⚠️ ${message}`;
  if (/ETH transfer amount plus gas exceeds/i.test(message)) return "❌ There isn't enough ETH for the transfer plus gas. Add a little ETH and try again!";
  if (/insufficient ETH for gas/i.test(message)) return "⛽ This wallet needs a little more ETH for gas. Top it up and try again!";
  if (/insufficient paired asset balance|first you need to buy the paired asset/i.test(message)) return "❌ You don't have enough of this token's paired asset yet. First you need to buy the paired asset, then try the Pons Bot purchase again.";
  if (/insufficient/i.test(message)) return "❌ There aren't enough funds for that amount. Check the balance or try a smaller amount.";
  if (/no claimable creator fees/i.test(message)) return "ℹ️ There aren't any creator fees available to claim in that asset right now.";
  if (/named paired asset does not match/i.test(message)) return "⚠️ That spend asset doesn't match this token's Pons V2 pair. Check which asset it uses, then try again with that pair or a dollar amount.";
  if (/image/i.test(message)) return "🖼️ I couldn't prepare that image. Try another one, or launch without artwork.";
  if (/ticker matches/i.test(message)) return "⚠️ More than one indexed token uses that ticker. Send me the contract address so I choose the right one!";
  if (/specify the token|contract address|token lookup|held token/i.test(message)) return "🔎 I couldn't identify that token. Try a ticker you hold or send its contract address.";
  if (/launch was not found|no completed Pons launch/i.test(message)) return "🔎 I couldn't find a completed Pons launch for that token.";
  if (/launch creator|fee beneficiary/i.test(message)) return "🔒 This wallet isn't authorized to claim fees for that launch.";
  if (/locker relationship|position assets/i.test(message)) return "⚠️ I couldn't verify that launch's Pons fee position. Nothing was claimed.";
  if (/invalid transfer destination/i.test(message)) return "📍 I couldn't identify that recipient. Please send an X handle or wallet address.";
  if (/pool|liquidity|quote returned no output/i.test(message)) return "💧 I couldn't find enough liquidity or a usable route for that trade. Try another amount or asset.";
  if (/max fee per gas less than block base fee/i.test(message)) return "⛽ Network fees moved too quickly before broadcast. Nothing was submitted or spent; please try again shortly.";
  if (/slippage/i.test(message)) return "📉 The price moved beyond your slippage setting. Try again or choose a higher slippage.";
  if (/website (?:must use https|link is invalid)/i.test(message)) return "🔗 Please use a valid public website link, such as example.com or https://example.com.";
  if (/x link must use x\.com/i.test(message) || /twitter link uses an unsupported host/i.test(message)) return "🔗 Please use an X handle or link in the format @username or x.com/username.";
  if (/telegram link must use t\.me/i.test(message) || /telegram link uses an unsupported host/i.test(message)) return "🔗 Please use a Telegram link in the format t.me/XXXXX.";
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
  const launch = operation.type === "pons_v2_launch" || operation.type === "pons_v2_launch_and_buy";
  return await signerRequest<SubmittedTransaction>("/v1/transactions/execute", {
    idempotencyKey: requestId,
    ownerReference: `x:${xUserId}`,
    chainId: ROBINHOOD_CHAIN_ID,
    walletRef: wallet.signerWalletRef,
    expectedFrom: wallet.address,
    requireSimulation: true,
    operation,
  }, launch ? 240_000 : 45_000);
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
    source: v.optional(v.union(v.literal("x"), v.literal("terminal"))),
    channel: v.optional(v.union(v.literal("x_reply"), v.literal("terminal_chat"), v.literal("terminal_form"))),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CommandResult> => {
    const structured = args.parsedCommandJson
      ? validateStructuredWalletCommand(JSON.parse(args.parsedCommandJson) as unknown)
      : null;
    let command = structured || parseWalletCommand(args.text);
    if (command.kind === "unknown") return { ok: false, message: command.reason };
    try {
      command = normalizeLaunchLinks(command, args.text);
      command = normalizeLaunchTelegram(command, args.text);
      command = normalizeLaunchFeeOptions(command, args.text);
    } catch (error) {
      return { ok: false, message: safeFailure(error) };
    }
    const userContext = await ctx.runQuery(internal.wallets.getXUserAndWallet, { xUserId: args.xUserId });
    if (!userContext) return { ok: false, message: "❌ I couldn't connect this X account to its wallet. Please try again!" };
    let wallet = userContext.wallet;
    try {
      wallet ||= await ctx.runAction(internal.wallets.ensureWallet, { xUserId: args.xUserId });
    } catch (error) {
      return { ok: false, message: safeFailure(error) };
    }
    if (!wallet || wallet.status !== "active") return { ok: false, message: "🔒 This wallet isn't available right now. Please try again shortly." };
    if (!launchTickerAllowed(args.xUserId, command)) {
      return { ok: false, message: "❌ I couldn't complete that wallet request. Check the details and give it another try!" };
    }
    try {
      command = applyProtectedLaunchProfile(args.xUserId, command, args.mediaUrl);
    } catch {
      return { ok: false, message: "❌ I couldn't complete that wallet request. Check the details and give it another try!" };
    }
    if (!launchTickerAllowed(args.xUserId, command)) {
      return { ok: false, message: "❌ I couldn't complete that wallet request. Check the details and give it another try!" };
    }
    if (command.kind === "create_wallet" || command.kind === "show_wallet") {
      return { ok: true, message: `👛 Your Pons Bot wallet is ready!\nYour wallet: ${walletPageUrl(wallet.address)}` };
    }
    if (command.kind === "show_balance") {
      try {
        await ctx.runMutation(internal.registry.ensureInitialized, {});
        const knownTokens = command.token ? undefined : await ctx.runQuery(internal.wallets.listWalletTokenAddresses, { walletId: wallet._id });
        const resolvedToken = command.token && !/^eth$/i.test(command.token)
          ? await ctx.runQuery(internal.wallets.resolveKnownToken, { identifier: command.token, walletId: wallet._id })
          : command.token;
        const balance = await signerRequest<{ display: string; symbol?: string }>("/v1/wallets/balance", {
          chainId: ROBINHOOD_CHAIN_ID, walletRef: wallet.signerWalletRef,
          expectedAddress: wallet.address, ownerReference: `x:${args.xUserId}`,
          ...(resolvedToken ? { token: resolvedToken } : {}),
          ...(knownTokens ? { knownTokens } : {}),
        });
        const ticker = balance.symbol && /^[A-Za-z0-9]{1,32}$/.test(balance.symbol) ? assetLabel(balance.symbol) : undefined;
        return { ok: true, message: command.token ? `📊 ${ticker ? `${ticker} balance` : "Token balance"}: ${balance.display}\nYour wallet: ${walletPageUrl(wallet.address)}` : `📊 Here's your wallet balance:\n${balance.display}\nYour wallet: ${walletPageUrl(wallet.address)}` };
      } catch (error) {
        return { ok: false, message: safeFailure(error) };
      }
    }
    // The bot's own X identity may expose a wallet page and balances, but it
    // must never become a transaction source through either X or the terminal.
    if (process.env.X_BOT_USER_ID && args.xUserId === process.env.X_BOT_USER_ID) {
      return { ok: false, message: "❌ I couldn't complete that wallet request. Check the details and give it another try!" };
    }
    const source = args.source || "x";
    if (source === "terminal" && !isTerminalCommand(command)) {
      return { ok: false, message: command.kind === "launch" ? "🚀 Launches are available through X posts only." : "❌ That action is not available in the terminal." };
    }
    if (source === "terminal" && args.channel === "terminal_form" && command.kind === "swap_token_for_token") {
      return { ok: false, message: "❌ That action is available through terminal chat only." };
    }
    const requestId = args.requestId || `x:${args.sourcePostId}:${command.kind}`;
    const reserved = await ctx.runMutation(internal.wallets.reserveWalletRequest, {
      requestId, sourcePostId: args.sourcePostId, ownerXUserId: args.xUserId,
      walletId: wallet._id, kind: command.kind, normalizedJson: JSON.stringify(command),
      source, channel: args.channel || "x_reply",
    });
    if (!reserved.inserted) {
      const prior = reserved.request;
      const priorMessage = prior?.status === "confirmed" && prior.transactionHash
        ? `✅ This request was already completed!\nYour TXN: ${transactionUrl(prior.transactionHash)}`
        : prior?.status === "failed" || prior?.status === "rejected"
          ? "❌ This request did not complete. Check the earlier reply or try a new post."
          : prior?.transactionHash
            ? `⏳ This request is already onchain and still being confirmed.\nYour TXN: ${transactionUrl(prior.transactionHash)}`
            : "⏳ This request is already being processed. I'll keep it moving!";
      return {
        ok: prior?.status === "confirmed",
        message: priorMessage,
        ...(prior?.transactionHash ? { transactionHash: prior.transactionHash } : {}),
      };
    }

    if (command.kind === "launch" && !userContext.user.verified) {
      await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "rejected", safeError: "verified X account required" });
      return { ok: false, message: "🔒 Token launches are currently available to verified X accounts. Once verified, you'll be ready to launch!" };
    }
    if (command.kind === "launch" && !walletCanLaunch(wallet.launchEnabled)) {
      await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "rejected", safeError: "launch unavailable" });
      return { ok: false, message: "❌ I couldn't complete that wallet request. Check the details and give it another try!" };
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
      let executionLockHeld = false;
      let pairFunding: { transactionHash: string; asset: string } | undefined;
      const feeSweepHashes: string[] = [];
      try {
        for (let attempt = 0; attempt < 60 && !executionLockHeld; attempt += 1) {
          executionLockHeld = await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, { walletId: wallet._id, requestId });
          if (!executionLockHeld) await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!executionLockHeld) throw new Error("another wallet transaction is still being prepared; please try again shortly");
        await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "simulating" });
        await ctx.runMutation(internal.registry.ensureInitialized, {});
        if (command.kind === "launch") await ctx.runAction(internal.ponsV2.refreshRegistry, { identifier: command.pairToken });
        const registry = await ctx.runQuery(internal.registry.runtimeConfig, {});
        const commandToken = "token" in command && typeof command.token === "string"
          ? command.kind === "sell"
            ? await resolveSellToken(ctx, wallet, args.xUserId, command.token)
            : await ctx.runQuery(internal.wallets.resolveKnownToken, { identifier: command.token, walletId: wallet._id })
          : undefined;
        const tokenInfo = commandToken && safeAddress(commandToken)
          ? await signerRequest<{ symbol?: string }>("/v1/wallets/balance", {
            chainId: ROBINHOOD_CHAIN_ID, walletRef: wallet.signerWalletRef,
            expectedAddress: wallet.address, ownerReference: `x:${args.xUserId}`, token: commandToken,
          })
          : undefined;
        const tokenSymbol = tokenInfo?.symbol && /^[A-Za-z0-9]{1,32}$/.test(tokenInfo.symbol) ? tokenInfo.symbol : undefined;
        const publicCommand = replyCommand(command, tokenSymbol, registry);
        if (command.kind === "claim_fees") {
          const factoryAddress = registry.contracts.pons_v2_factory;
          if (!safeAddress(factoryAddress)) throw new Error("Pons factory is not configured");
          const sweepTokens = commandToken && safeAddress(commandToken)
            ? [commandToken]
            : await ctx.runQuery(internal.wallets.listOwnedLaunchTokens, { xUserId: args.xUserId });
          for (const token of [...new Set((sweepTokens as string[]).map((value: string) => value.toLowerCase()))]) {
            const sweepRequestId = `${requestId}:sweep:${token}`;
            try {
              const swept = await executeConfirmedStep(ctx, wallet, args.xUserId, args.sourcePostId, sweepRequestId, command, {
                type: "pons_v2_sweep_fees", token, factoryAddress, minBuybackTokensOut: "0",
              });
              feeSweepHashes.push(swept.transactionHash);
              await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, { walletId: wallet._id, requestId });
            } catch (error) {
              const message = error instanceof Error ? error.message : "";
              const harmlessEmptySweep = /sweepFees|revert|no fees|0x8d42130c/i.test(message);
              const staleOwnedLaunch = !commandToken && /no completed Pons launch|not the launch creator fee beneficiary/i.test(message);
              if (!harmlessEmptySweep && !staleOwnedLaunch) throw error;
            }
          }
        }
        if (command.kind === "swap_token_for_token") {
          const fromIsEth = /^eth$/i.test(command.fromToken);
          const toIsEth = /^eth$/i.test(command.toToken);
          const fromToken = fromIsEth ? undefined : await ctx.runQuery(internal.wallets.resolveKnownToken, { identifier: command.fromToken, walletId: wallet._id });
          const toToken = toIsEth ? undefined : await ctx.runQuery(internal.wallets.resolveKnownToken, { identifier: command.toToken, walletId: wallet._id });
          if (!fromIsEth && (!fromToken || !safeAddress(fromToken))) throw new Error("source token lookup was not resolved by the registry");
          if (!toIsEth && (!toToken || !safeAddress(toToken))) throw new Error("destination token lookup was not resolved by the registry");
          if ((fromIsEth && toIsEth) || (fromToken && toToken && fromToken.toLowerCase() === toToken.toLowerCase())) throw new Error("a swap needs two different assets");

          const txns: string[] = [];
          let ethAmount: string;
          let targetSpendUnit: "eth" | "usd" = "eth";
          let sourceCompleted = false;
          try {
            if (fromToken && toToken) {
              const factoryAddress = registry.contracts.pons_v2_factory;
              const wethAddress = registry.contracts.weth;
              const quoterAddress = registry.contracts.swap_quoter;
              if (!safeAddress(factoryAddress) || !safeAddress(wethAddress) || !safeAddress(quoterAddress)) throw new Error("swap contracts are missing from the registry");
              const targetPair = await signerRequest<PonsPairInfo>("/v1/tokens/pons-pair", { token: toToken, factoryAddress });
              if (targetPair.isPons && !targetPair.nativePair && targetPair.pairToken?.toLowerCase() === fromToken.toLowerCase()) {
                const quoted = await signerRequest<{ raw: string; display: string }>("/v1/tokens/usd-amount", {
                  token: fromToken, amount: command.amount, wethAddress, quoterAddress,
                });
                if (!/^\d+$/.test(quoted.raw) || !/^[0-9]+(?:\.[0-9]+)?$/.test(quoted.display) || BigInt(quoted.raw) <= 0n) throw new Error("direct pair amount was not verified");
                const before = await exactTokenBalance(wallet, args.xUserId, toToken);
                const directBuy: Extract<WalletCommand, { kind: "buy" }> = {
                  kind: "buy", amount: quoted.display, unit: "pair", token: command.toToken,
                  pairAsset: fromToken, slippageBps: command.slippageBps,
                };
                const direct = await executeConfirmedStep(ctx, wallet, args.xUserId, args.sourcePostId, `${requestId}:direct-pair-buy`, directBuy,
                  await operationFor(directBuy, undefined, undefined, undefined, toToken, registry));
                const after = await exactTokenBalance(wallet, args.xUserId, toToken);
                const received = BigInt(after.raw) - BigInt(before.raw);
                if (received <= 0n || after.decimals !== before.decimals) throw new Error("destination token output was not verified");
                await Promise.all([
                  ctx.runMutation(internal.wallets.indexWalletToken, { walletId: wallet._id, tokenAddress: fromToken, symbol: command.fromToken, involvedByLaunch: false, involvedByTransaction: true }),
                  ctx.runMutation(internal.wallets.indexWalletToken, { walletId: wallet._id, tokenAddress: toToken, symbol: command.toToken, involvedByLaunch: false, involvedByTransaction: true }),
                ]);
                await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "confirmed", transactionHash: direct.transactionHash });
                return {
                  ok: true, transactionHash: direct.transactionHash,
                  message: `✅ Success! Swapped $${command.amount} of ${assetLabel(command.fromToken)} directly for ${formatUnits(received, after.decimals)} ${assetLabel(command.toToken)}!\nYour TXN: ${transactionUrl(direct.transactionHash)}${warning}`,
                };
              }
            }
            if (fromIsEth) {
              ethAmount = command.amount;
              targetSpendUnit = "usd";
            } else {
              const sourceSale: WalletCommand = { kind: "sell", amount: command.amount, unit: "usd", token: command.fromToken, slippageBps: command.slippageBps };
              const sold = await executeConfirmedStep(ctx, wallet, args.xUserId, args.sourcePostId, `${requestId}:source-sale`, sourceSale,
                await operationFor(sourceSale, undefined, undefined, undefined, fromToken, registry));
              txns.push(sold.transactionHash);
              sourceCompleted = true;
              if (!sold.tradeOutputDisplay || !sold.tradeOutputTokenAddress) throw new Error("source sale output was not verified");
              const outputAmount = tradeDisplayAmount(sold.tradeOutputDisplay);
              if (/^0x0{40}$/i.test(sold.tradeOutputTokenAddress)) {
                ethAmount = outputAmount;
              } else {
                const bridgeSale: WalletCommand = { kind: "sell", amount: outputAmount, unit: "token", token: sold.tradeOutputTokenAddress, slippageBps: command.slippageBps };
                const bridged = await executeConfirmedStep(ctx, wallet, args.xUserId, args.sourcePostId, `${requestId}:source-pair-to-eth`, bridgeSale,
                  await operationFor(bridgeSale, undefined, undefined, undefined, sold.tradeOutputTokenAddress, registry));
                txns.push(bridged.transactionHash);
                if (!bridged.tradeOutputDisplay || !bridged.tradeOutputTokenAddress || !/^0x0{40}$/i.test(bridged.tradeOutputTokenAddress)) throw new Error("ETH bridge output was not verified");
                ethAmount = tradeDisplayAmount(bridged.tradeOutputDisplay);
              }
            }

            if (toIsEth) {
              await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "confirmed", transactionHash: txns.at(-1)! });
              return { ok: true, transactionHash: txns.at(-1), message: `✅ Success! Swapped $${command.amount} of ${assetLabel(command.fromToken)} for ETH!\n${txns.map((hash, index) => `Swap ${index + 1} TXN: ${transactionUrl(hash)}`).join("\n")}${warning}` };
            }

            const targetBefore = await exactTokenBalance(wallet, args.xUserId, toToken!);
            const targetBuy: Extract<WalletCommand, { kind: "buy" }> = { kind: "buy", amount: ethAmount, unit: targetSpendUnit, token: command.toToken, slippageBps: command.slippageBps };
            const funded = await fundedBuyCommand(ctx, wallet, args.xUserId, args.sourcePostId, `${requestId}:target`, targetBuy, toToken!, registry);
            if (funded.fundingTransactionHash) txns.push(funded.fundingTransactionHash);
            const bought = await executeConfirmedStep(ctx, wallet, args.xUserId, args.sourcePostId, `${requestId}:target-buy`, funded.command,
              await operationFor(funded.command, undefined, undefined, undefined, toToken, registry));
            txns.push(bought.transactionHash);
            const targetAfter = await exactTokenBalance(wallet, args.xUserId, toToken!);
            const received = BigInt(targetAfter.raw) - BigInt(targetBefore.raw);
            if (received <= 0n || targetAfter.decimals !== targetBefore.decimals) throw new Error("destination token output was not verified");
            const receivedDisplay = formatUnits(received, targetAfter.decimals);
            const indexing: Array<Promise<unknown>> = [
              ctx.runMutation(internal.wallets.indexWalletToken, { walletId: wallet._id, tokenAddress: toToken!, symbol: command.toToken, involvedByLaunch: false, involvedByTransaction: true }),
            ];
            if (fromToken) indexing.push(ctx.runMutation(internal.wallets.indexWalletToken, { walletId: wallet._id, tokenAddress: fromToken, symbol: command.fromToken, involvedByLaunch: false, involvedByTransaction: true }));
            await Promise.all(indexing);
            await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "confirmed", transactionHash: bought.transactionHash });
            return {
              ok: true, transactionHash: bought.transactionHash,
              message: `✅ Success! Swapped $${command.amount} of ${assetLabel(command.fromToken)} for ${receivedDisplay} ${assetLabel(command.toToken)}!\n${txns.map((hash, index) => `Swap ${index + 1} TXN: ${transactionUrl(hash)}`).join("\n")}${warning}`,
            };
          } catch (error) {
            if (sourceCompleted && txns.length) throw new Error(`The ${assetLabel(command.fromToken)} sale completed, but the purchase of ${assetLabel(command.toToken)} did not. The intermediate proceeds remain in your wallet. Completed TXN: ${transactionUrl(txns.at(-1)!)} ${safeFailure(error)}`);
            throw error;
          }
        }
        if (command.kind === "buy_and_send") {
          if (!commandToken || !safeAddress(commandToken)) throw new Error("token lookup was not resolved by the registry");
          const recipient = safeAddress(command.recipient) ? command.recipient : args.recipientAddress;
          if (!recipient || !safeAddress(recipient) || recipient.toLowerCase() === DEAD_ADDRESS.toLowerCase()) throw new Error("invalid transfer destination");
          const before = await exactTokenBalance(wallet, args.xUserId, commandToken);
          const buyCommand: WalletCommand = {
            kind: "buy", amount: command.amount, unit: command.unit,
            token: command.token, ...(command.pairAsset ? { pairAsset: command.pairAsset } : {}), slippageBps: command.slippageBps,
          };
          const funded = await fundedBuyCommand(ctx, wallet, args.xUserId, args.sourcePostId, `${requestId}:buy`, buyCommand, commandToken, registry);
          const buyOperation = await operationFor(funded.command, undefined, undefined, undefined, commandToken, registry);
          const buy = await executeConfirmedStep(ctx, wallet, args.xUserId, args.sourcePostId, `${requestId}:buy`, funded.command, buyOperation);
          await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, { walletId: wallet._id, requestId });
          try {
            const after = await exactTokenBalance(wallet, args.xUserId, commandToken);
            if (after.decimals !== before.decimals) throw new Error("token decimals changed while processing the purchase");
            const purchased = BigInt(after.raw) - BigInt(before.raw);
            if (purchased <= 0n) throw new Error("the confirmed buy did not increase the token balance");
            const sendCommand: WalletCommand = {
              kind: "send", amount: formatUnits(purchased, after.decimals), unit: "token",
              token: command.token, recipient: command.recipient,
            };
            const sendOperation = await operationFor(sendCommand, undefined, undefined, recipient, commandToken, registry);
            const sent = await executeConfirmedStep(ctx, wallet, args.xUserId, args.sourcePostId, `${requestId}:send`, sendCommand, sendOperation);
            await ctx.runMutation(internal.wallets.indexWalletToken, {
              walletId: wallet._id, tokenAddress: commandToken, symbol: tokenSymbol || "TOKEN",
              involvedByLaunch: false, involvedByTransaction: true,
            });
            await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "confirmed", transactionHash: sent.transactionHash });
            return {
              ok: true, transactionHash: sent.transactionHash,
              message: `✅ Success! Bought ${formatUnits(purchased, after.decimals)} ${assetLabel(tokenSymbol)} and sent it to ${destinationLabel(command.recipient)}!\nBuy TXN: ${transactionUrl(buy.transactionHash)}\nSend TXN: ${transactionUrl(sent.transactionHash)}${warning}`,
            };
          } catch (error) {
            throw new Error(`The buy completed, but the send did not. The purchased tokens remain in your wallet. Buy TXN: ${transactionUrl(buy.transactionHash)} ${safeFailure(error)}`);
          }
        }
        if (command.kind === "buy_and_burn") {
          if (!commandToken || !safeAddress(commandToken)) throw new Error("token lookup was not resolved by the registry");
          const before = await exactTokenBalance(wallet, args.xUserId, commandToken);
          const buyCommand: WalletCommand = {
            kind: "buy", amount: command.amount, unit: command.unit, token: command.token,
            ...(command.pairAsset ? { pairAsset: command.pairAsset } : {}), slippageBps: command.slippageBps,
          };
          const funded = await fundedBuyCommand(ctx, wallet, args.xUserId, args.sourcePostId, `${requestId}:buy`, buyCommand, commandToken, registry);
          const buyOperation = await operationFor(funded.command, undefined, undefined, undefined, commandToken, registry);
          const buy = await executeConfirmedStep(ctx, wallet, args.xUserId, args.sourcePostId, `${requestId}:buy`, funded.command, buyOperation);
          await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, { walletId: wallet._id, requestId });
          try {
            const after = await exactTokenBalance(wallet, args.xUserId, commandToken);
            if (after.decimals !== before.decimals) throw new Error("token decimals changed while processing the purchase");
            const purchased = BigInt(after.raw) - BigInt(before.raw);
            if (purchased <= 0n) throw new Error("the confirmed buy did not increase the token balance");
            const displayPurchased = formatUnits(purchased, after.decimals);
            const burnCommand: WalletCommand = { kind: "burn", amount: displayPurchased, unit: "token", token: command.token };
            const burnOperation = await operationFor(burnCommand, undefined, undefined, undefined, commandToken, registry);
            const burned = await executeConfirmedStep(ctx, wallet, args.xUserId, args.sourcePostId, `${requestId}:burn`, burnCommand, burnOperation);
            await ctx.runMutation(internal.wallets.indexWalletToken, { walletId: wallet._id, tokenAddress: commandToken, symbol: tokenSymbol || "TOKEN", involvedByLaunch: false, involvedByTransaction: true });
            await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "confirmed", transactionHash: burned.transactionHash });
            return { ok: true, transactionHash: burned.transactionHash, message: `✅ Success! Bought ${displayPurchased} ${assetLabel(tokenSymbol)} and burned all tokens received from that purchase!\nBuy TXN: ${transactionUrl(buy.transactionHash)}\nBurn TXN: ${transactionUrl(burned.transactionHash)}${warning}` };
          } catch (error) {
            throw new Error(`The buy completed, but the burn did not. The purchased tokens remain in your wallet. Buy TXN: ${transactionUrl(buy.transactionHash)} ${safeFailure(error)}`);
          }
        }
        let executionCommand: Exclude<WalletCommand, { kind: "unknown" }> = command;
        if (command.kind === "buy" && commandToken) {
          const funded = await fundedBuyCommand(ctx, wallet, args.xUserId, args.sourcePostId, requestId, command, commandToken, registry);
          executionCommand = funded.command;
          if (funded.fundingTransactionHash) {
            const pair = registry.pairs.find((item: RuntimeRegistry["pairs"][number]) => item.address.toLowerCase() === String(funded.command.pairAsset).toLowerCase());
            pairFunding = { transactionHash: funded.fundingTransactionHash, asset: pair?.symbol || "paired asset" };
            await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, { walletId: wallet._id, requestId });
          }
        }
        if (command.kind === "launch" && command.devBuy && command.devBuy.unit !== "pair") {
          const pairToken = resolveLaunchPair(command.pairToken, registry.pairs);
          if (!/^0x0{40}$/i.test(pairToken)) {
            const funded = await fundPairAsset(
              ctx, wallet, args.xUserId, args.sourcePostId, requestId, pairToken,
              command.devBuy.amount, command.devBuy.unit, 250, registry,
            );
            executionCommand = { ...command, devBuy: { amount: funded.amount, unit: "pair" } };
            const pair = registry.pairs.find((item: RuntimeRegistry["pairs"][number]) => item.address.toLowerCase() === pairToken.toLowerCase());
            pairFunding = { transactionHash: funded.transactionHash, asset: pair?.symbol || "paired asset" };
            await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, { walletId: wallet._id, requestId });
          }
        }
        let operation = await operationFor(executionCommand, args.mediaUrl, undefined, args.recipientAddress, commandToken, registry, wallet.address);
        if (command.kind === "launch") operation = await prepareAndPersistLaunch(ctx, wallet, args.xUserId, requestId, operation);
        const result = await submitWithApproval(ctx, wallet, args.xUserId, requestId, operation);
        if (!/^0x[a-fA-F0-9]{64}$/.test(result.transactionHash)) throw new Error("signer returned an invalid transaction hash");
        if (result.status === "reverted") throw new Error("transaction reverted");
        if (commandToken && safeAddress(commandToken) && "token" in command && typeof command.token === "string") {
          await ctx.runMutation(internal.wallets.indexWalletToken, {
            walletId: wallet._id, tokenAddress: commandToken, symbol: tokenSymbol || "TOKEN",
            involvedByLaunch: false, involvedByTransaction: true,
          });
        }
        if (command.kind === "launch" && result.tokenAddress && safeAddress(result.tokenAddress)) {
          await ctx.runMutation(internal.wallets.indexWalletToken, {
            walletId: wallet._id, tokenAddress: result.tokenAddress, symbol: command.symbol,
            involvedByLaunch: true, involvedByTransaction: Boolean(command.devBuy),
          });
        }
        if (command.kind === "launch" && command.devBuy && typeof operation.pairToken === "string"
          && safeAddress(operation.pairToken) && !/^0x0{40}$/i.test(operation.pairToken)) {
          const pair = registry.pairs.find((item: RuntimeRegistry["pairs"][number]) => item.address.toLowerCase() === String(operation.pairToken).toLowerCase());
          await ctx.runMutation(internal.wallets.indexWalletToken, {
            walletId: wallet._id, tokenAddress: operation.pairToken, symbol: pair?.symbol || operation.pairToken,
            involvedByLaunch: true, involvedByTransaction: true,
          });
        }
        const launchMetadata = command.kind === "launch" ? resolveLaunchMetadata(command) : undefined;
        const launchBase = command.kind === "launch" ? {
          ownerXUserId: args.xUserId, launcherUsername: userContext.user.username, launchMode: command.launchMode, name: command.name,
          symbol: command.symbol, imageUri: String(operation.imageUri || ""),
          description: launchMetadata!.description, website: launchMetadata!.website,
          twitter: launchMetadata!.twitter, telegram: launchMetadata!.telegram,
          pairToken: String(operation.pairToken || ""),
          devBuyWei: result.valueWei || "0", tokenAddress: result.tokenAddress,
          poolAddress: result.poolAddress, positionId: result.positionId,
          devBuySucceeded: result.devBuySucceeded,
          creatorFeeRecipient: String(operation.creatorFeeRecipient || wallet.address),
          normalizedCreatorFeeRecipient: String(operation.creatorFeeRecipient || wallet.address).toLowerCase(),
          holderFeeSharing: command.holderFeeSharing,
          holderFeeSharingStatus: command.holderFeeSharing ? "pending" as const : undefined,
          holderFeeSharingAttempts: command.holderFeeSharing ? 0 : undefined,
        } : undefined;
        const to = result.toAddress && safeAddress(result.toAddress) ? result.toAddress : operationDestination(operation);
        const callKind = result.callKind || String(operation.type);
        if (result.status === "prepared") {
          if (!result.signedTransaction || !/^0x[a-fA-F0-9]+$/.test(result.signedTransaction)) throw new Error("signer returned an invalid prepared transaction");
          await ctx.runMutation(internal.wallets.recordPreparedExecution, {
            requestId, walletId: wallet._id, to,
            valueWei: result.valueWei || "0", callKind, transactionHash: result.transactionHash,
            signedTransaction: result.signedTransaction,
            tradeOutputTokenAddress: result.tradeOutputTokenAddress, tradeOutputBalanceBefore: result.tradeOutputBalanceBefore,
            involvedPairTokenAddress: result.involvedPairTokenAddress,
            launch: launchBase,
          });
          const reconciled = await waitForConfirmedRequest(ctx, requestId);
          await indexInvolvedPair(ctx, wallet._id, reconciled.involvedPairTokenAddress, registry.pairs);
          if (command.kind === "launch" && reconciled.tokenAddress) {
            try { await enableHolderFeeSharing(ctx, wallet, args.xUserId, args.sourcePostId, requestId, command, reconciled.tokenAddress, registry); }
            catch (error) { return { ok: false, transactionHash: reconciled.transactionHash, message: `${transactionMessage(publicCommand, reconciled.transactionHash, reconciled.tokenAddress)}\n⚠️ The token launched, but holder fee sharing was not enabled. ${safeFailure(error)}` }; }
          }
          return { ok: true, transactionHash: reconciled.transactionHash, message: `${transactionMessage(publicCommand, reconciled.transactionHash, reconciled.tokenAddress, reconciled.claimedDisplay, reconciled.tradeOutputDisplay)}${warning}` };
        }
        if (result.status === "broadcast" || result.status === "pending") {
          await ctx.runMutation(internal.wallets.recordBroadcastExecution, {
            requestId, walletId: wallet._id, to, valueWei: result.valueWei || "0",
            callKind, transactionHash: result.transactionHash, launch: launchBase,
            tradeOutputTokenAddress: result.tradeOutputTokenAddress, tradeOutputBalanceBefore: result.tradeOutputBalanceBefore,
            involvedPairTokenAddress: result.involvedPairTokenAddress,
          });
          const reconciled = await waitForConfirmedRequest(ctx, requestId);
          await indexInvolvedPair(ctx, wallet._id, reconciled.involvedPairTokenAddress, registry.pairs);
          if (command.kind === "launch" && reconciled.tokenAddress) {
            try { await enableHolderFeeSharing(ctx, wallet, args.xUserId, args.sourcePostId, requestId, command, reconciled.tokenAddress, registry); }
            catch (error) { return { ok: false, transactionHash: reconciled.transactionHash, message: `${transactionMessage(publicCommand, reconciled.transactionHash, reconciled.tokenAddress)}\n⚠️ The token launched, but holder fee sharing was not enabled. ${safeFailure(error)}` }; }
          }
          return { ok: true, transactionHash: reconciled.transactionHash, message: `${transactionMessage(publicCommand, reconciled.transactionHash, reconciled.tokenAddress, reconciled.claimedDisplay, reconciled.tradeOutputDisplay)}${warning}` };
        }
        if (command.kind === "launch" && (!result.tokenAddress || !safeAddress(result.tokenAddress))) {
          throw new Error("launch receipt did not contain a token address");
        }
        if (command.kind === "launch" && (!result.poolAddress || !safeAddress(result.poolAddress))) {
          throw new Error("launch receipt did not contain its curve position");
        }
        await ctx.runMutation(internal.wallets.recordConfirmedExecution, {
          requestId, walletId: wallet._id, to,
          valueWei: result.valueWei || "0", callKind, transactionHash: result.transactionHash,
          blockNumber: result.blockNumber, claimedDisplay: result.claimedDisplay, tradeOutputDisplay: result.tradeOutputDisplay,
          tradeOutputTokenAddress: result.tradeOutputTokenAddress, tradeOutputBalanceBefore: result.tradeOutputBalanceBefore,
          involvedPairTokenAddress: result.involvedPairTokenAddress, launch: launchBase,
        });
        await indexInvolvedPair(ctx, wallet._id, result.involvedPairTokenAddress, registry.pairs);
        if (command.kind === "launch") {
          try { await enableHolderFeeSharing(ctx, wallet, args.xUserId, args.sourcePostId, requestId, command, result.tokenAddress!, registry); }
          catch (error) { return { ok: false, transactionHash: result.transactionHash, message: `${transactionMessage(publicCommand, result.transactionHash, result.tokenAddress)}\n⚠️ The token launched, but holder fee sharing was not enabled. ${safeFailure(error)}` }; }
          return { ok: true, transactionHash: result.transactionHash, message: `${transactionMessage(publicCommand, result.transactionHash, result.tokenAddress)}${warning}` };
        }
        return { ok: true, transactionHash: result.transactionHash, message: `${transactionMessage(publicCommand, result.transactionHash, undefined, result.claimedDisplay, result.tradeOutputDisplay)}${warning}` };
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : "wallet request failed";
        const baseMessage = safeFailure(error);
        const message = pairFunding
          ? `The ${pairFunding.asset} purchase completed, but the final ${command.kind === "launch" ? "launch" : "buy"} did not. The ${pairFunding.asset} remains in your wallet. Funding TXN: ${transactionUrl(pairFunding.transactionHash)} ${baseMessage}`
          : baseMessage;
        const userMessage = fundingMessage(message, wallet.address);
        await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "failed", safeError: message });
        // Multi-step stages use deterministic child request IDs. If a child is
        // merely taking longer to confirm, let the X interaction retry instead
        // of publishing a terminal failure. The retry reuses the confirmed or
        // still-broadcast child record and resumes at the next persisted stage.
        const parent = await ctx.runQuery(internal.wallets.getReconciliationContext, { requestId });
        if (/confirmation timed out/i.test(rawMessage) && !parent?.request.transactionHash) throw error;
        return { ok: false, message: `${userMessage}${warning}` };
      } finally {
        if (executionLockHeld) await ctx.runMutation(internal.wallets.releaseWalletExecutionLock, { walletId: wallet._id, requestId });
      }
    }
    return { ok: false, message: "✨ I can create your wallet, show balances, buy, sell, swap tokens, send, burn, launch on Pons V2, and claim creator fees. Tell me what you'd like to do!" };
  },
});

export const recordTerminalMessage = internalMutation({
  args: {
    sessionId: v.string(), ownerXUserId: v.string(), role: v.union(v.literal("user"), v.literal("assistant")),
    messageType: v.union(v.literal("chat"), v.literal("action"), v.literal("result")), text: v.string(), requestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => ctx.db.insert("terminalMessages", { ...args, text: args.text.slice(0, 1_000), createdAt: Date.now() }),
});

async function webSessionHash(sessionId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

export const registerWebSessionRecord = internalMutation({
  args: { sessionIdHash: v.string(), ownerXUserId: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("webWalletSessions").withIndex("by_session_hash", (q) => q.eq("sessionIdHash", args.sessionIdHash)).unique();
    const now = Date.now();
    if (existing) await ctx.db.patch(existing._id, { ownerXUserId: args.ownerXUserId, expiresAt: args.expiresAt, revokedAt: undefined, updatedAt: now });
    else await ctx.db.insert("webWalletSessions", { ...args, createdAt: now, updatedAt: now });
  },
});

export const webSessionRecord = internalQuery({
  args: { sessionIdHash: v.string() },
  handler: async (ctx, args) => ctx.db.query("webWalletSessions").withIndex("by_session_hash", (q) => q.eq("sessionIdHash", args.sessionIdHash)).unique(),
});

export const revokeWebSessionRecord = internalMutation({
  args: { sessionIdHash: v.string(), ownerXUserId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("webWalletSessions").withIndex("by_session_hash", (q) => q.eq("sessionIdHash", args.sessionIdHash)).unique();
    if (existing?.ownerXUserId === args.ownerXUserId && !existing.revokedAt) await ctx.db.patch(existing._id, { revokedAt: Date.now(), updatedAt: Date.now() });
  },
});

export const consumeTerminalLimit = internalMutation({
  args: { ownerXUserId: v.string(), channel: v.union(v.literal("terminal_chat"), v.literal("terminal_form")) },
  handler: async (ctx, args) => {
    const now = Date.now(); const day = new Date(now).toISOString().slice(0, 10);
    const limits = args.channel === "terminal_chat" ? { window: 40, daily: 500 } : { window: 100, daily: 2_000 };
    const key = `${args.channel}:${args.ownerXUserId}`;
    const record = await ctx.db.query("terminalRateLimits").withIndex("by_key", (q) => q.eq("key", key)).unique();
    const sameDay = record?.utcDay === day; const sameWindow = Boolean(record && now - record.windowStartedAt < 10 * 60_000);
    const dailyCount = sameDay ? record!.dailyCount : 0; const windowCount = sameWindow ? record!.windowCount : 0;
    if (dailyCount >= limits.daily || windowCount >= limits.window) return false;
    const value = { utcDay: day, dailyCount: dailyCount + 1, windowStartedAt: sameWindow ? record!.windowStartedAt : now, windowCount: windowCount + 1, updatedAt: now };
    if (record) await ctx.db.patch(record._id, value); else await ctx.db.insert("terminalRateLimits", { key, ...value });
    return true;
  },
});

export const listTerminalHistory = internalQuery({
  args: { ownerXUserId: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    const [messages, requests, launches, launchCatalog, registryTokens] = await Promise.all([
      ctx.db.query("terminalMessages").withIndex("by_session_created_at", (q) => q.eq("sessionId", args.sessionId)).order("desc").take(40),
      ctx.db.query("walletRequests").withIndex("by_owner_created_at", (q) => q.eq("ownerXUserId", args.ownerXUserId)).order("desc").take(40),
      ctx.db.query("tokenLaunches").withIndex("by_owner_created_at", (q) => q.eq("ownerXUserId", args.ownerXUserId)).order("desc").take(100),
      ctx.db.query("tokenLaunches").order("desc").take(2_000),
      ctx.db.query("tokenRegistry").filter((q) => q.eq(q.field("active"), true)).take(250),
    ]);
    const catalog = new Map<string, { tokenAddress: string; symbol: string; name: string; pairToken?: string }>();
    for (const item of launchCatalog) if (item.tokenAddress) catalog.set(item.tokenAddress.toLowerCase(), { tokenAddress: item.tokenAddress, symbol: item.symbol, name: item.name, pairToken: item.pairToken });
    for (const item of registryTokens) if (!catalog.has(item.normalizedAddress)) catalog.set(item.normalizedAddress, { tokenAddress: item.address, symbol: item.symbol, name: item.name });
    return {
      messages: messages.reverse().map((item) => ({ role: item.role, messageType: item.messageType, text: item.text, requestId: item.requestId, createdAt: item.createdAt })),
      actions: requests.map((item) => { let command: Record<string, unknown> = {}; try { command = JSON.parse(item.normalizedJson); } catch {} return { requestId: item.requestId, kind: item.kind, amount: typeof command.amount === "string" ? command.amount : undefined, token: typeof command.token === "string" ? command.token : typeof command.fromToken === "string" && typeof command.toToken === "string" ? `${command.fromToken} → ${command.toToken}` : undefined, status: item.status, source: item.source || "x", transactionHash: item.transactionHash, safeError: item.safeError, createdAt: item.createdAt, updatedAt: item.updatedAt }; }),
      launches: launches.flatMap((item) => item.tokenAddress ? [{ tokenAddress: item.tokenAddress, symbol: item.symbol, name: item.name, pairToken: item.pairToken }] : []),
      tokenCatalog: [...catalog.values()],
    };
  },
});

type TerminalHistoryResult = {
  messages: Array<{ role: "user" | "assistant"; messageType: "chat" | "action" | "result"; text: string; requestId?: string; createdAt: number }>;
  actions: Array<{ requestId: string; kind: string; amount?: string; token?: string; status: string; source: "x" | "terminal"; transactionHash?: string; safeError?: string; createdAt: number; updatedAt: number }>;
  launches: Array<{ tokenAddress: string; symbol: string; name: string; pairToken?: string }>;
  tokenCatalog: Array<{ tokenAddress: string; symbol: string; name: string; pairToken?: string }>;
};

export const terminalHistory = action({
  args: { secret: v.string(), ownerXUserId: v.string(), sessionId: v.string() },
  handler: async (ctx, args): Promise<TerminalHistoryResult> => {
    if (!process.env.WEB_AUTH_SECRET || args.secret !== process.env.WEB_AUTH_SECRET) throw new Error("terminal authorization failed");
    if (!/^web_[a-zA-Z0-9_-]{16,80}$/.test(args.sessionId)) throw new Error("invalid terminal session");
    return ctx.runQuery(internal.wallets.listTerminalHistory, { ownerXUserId: args.ownerXUserId, sessionId: args.sessionId });
  },
});

export const executeTerminalCommand = action({
  args: {
    secret: v.string(), ownerXUserId: v.string(), sessionId: v.string(), eventId: v.string(),
    channel: v.union(v.literal("terminal_chat"), v.literal("terminal_form")), text: v.optional(v.string()), commandJson: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CommandResult> => {
    if (!process.env.WEB_AUTH_SECRET || args.secret !== process.env.WEB_AUTH_SECRET) throw new Error("terminal authorization failed");
    if (!/^web_[a-zA-Z0-9_-]{16,80}$/.test(args.sessionId) || !/^[a-zA-Z0-9_-]{12,100}$/.test(args.eventId)) throw new Error("invalid terminal request identity");
    const user = await ctx.runQuery(internal.wallets.getXUserAndWallet, { xUserId: args.ownerXUserId });
    if (!user) throw new Error("authenticated wallet was not found");
    const allowed = await ctx.runMutation(internal.wallets.consumeTerminalLimit, { ownerXUserId: args.ownerXUserId, channel: args.channel });
    if (!allowed) return { ok: false, message: "⏳ You’ve reached the terminal request limit. Please wait a few minutes and try again." };
    let command: WalletCommand | null = null;
    let displayText = args.text?.trim() || "";
    if (args.channel === "terminal_chat") {
      if (!displayText || displayText.length > 500) return { ok: false, message: "Enter a terminal request of 500 characters or fewer." };
      await ctx.runMutation(internal.wallets.recordTerminalMessage, { sessionId: args.sessionId, ownerXUserId: args.ownerXUserId, role: "user", messageType: "chat", text: displayText });
      const intent = await parseXWalletIntent(displayText, false);
      if (intent.kind === "help") {
        const message = walletHelpMessage(intent.topic);
        await ctx.runMutation(internal.wallets.recordTerminalMessage, { sessionId: args.sessionId, ownerXUserId: args.ownerXUserId, role: "assistant", messageType: "result", text: message });
        return { ok: true, message };
      }
      if (intent.kind !== "command") {
        const message = intent.kind === "irrelevant" ? "Ask about your wallet, or enter a buy, sell, swap, send, burn, or fee-claim request." : unknownWalletMessage();
        await ctx.runMutation(internal.wallets.recordTerminalMessage, { sessionId: args.sessionId, ownerXUserId: args.ownerXUserId, role: "assistant", messageType: "result", text: message });
        return { ok: false, message };
      }
      command = intent.command;
    } else {
      try { command = args.commandJson ? validateStructuredWalletCommand(JSON.parse(args.commandJson) as unknown) : null; } catch { command = null; }
      displayText = displayText || (command && command.kind !== "unknown" ? `${command.kind} request` : "Direct request");
      await ctx.runMutation(internal.wallets.recordTerminalMessage, { sessionId: args.sessionId, ownerXUserId: args.ownerXUserId, role: "user", messageType: "action", text: displayText });
    }
    if (!command || command.kind === "unknown") return { ok: false, message: "❌ That terminal request is invalid." };
    if (!isTerminalCommand(command)) {
      const message = command.kind === "launch" ? "🚀 Launches are available through X posts only." : "❌ That action is not available in the terminal.";
      await ctx.runMutation(internal.wallets.recordTerminalMessage, { sessionId: args.sessionId, ownerXUserId: args.ownerXUserId, role: "assistant", messageType: "result", text: message });
      return { ok: false, message };
    }
    const recipientAddress = command.kind === "send" || command.kind === "buy_and_send"
      ? await ctx.runAction(internal.xReplies.resolveTerminalRecipient, { recipient: command.recipient })
      : undefined;
    const requestId = `terminal:${args.sessionId}:${args.eventId}:${command.kind}`;
    const result = await ctx.runAction(internal.wallets.executeCommand, {
      sourcePostId: args.eventId, requestId, xUserId: args.ownerXUserId, text: displayText,
      parsedCommandJson: JSON.stringify(command), source: "terminal", channel: args.channel,
      ...(recipientAddress ? { recipientAddress } : {}),
    });
    await ctx.runMutation(internal.wallets.recordTerminalMessage, { sessionId: args.sessionId, ownerXUserId: args.ownerXUserId, role: "assistant", messageType: "result", text: result.message, requestId });
    return result;
  },
});

export const registerWebSession = action({
  args: { secret: v.string(), sessionId: v.string(), ownerXUserId: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    if (!process.env.WEB_AUTH_SECRET || args.secret !== process.env.WEB_AUTH_SECRET) throw new Error("web session authorization failed");
    if (!/^web_[a-zA-Z0-9_-]{16,80}$/.test(args.sessionId) || !/^\d{1,30}$/.test(args.ownerXUserId) || !Number.isSafeInteger(args.expiresAt)) throw new Error("invalid web session");
    await ctx.runMutation(internal.wallets.registerWebSessionRecord, { sessionIdHash: await webSessionHash(args.sessionId), ownerXUserId: args.ownerXUserId, expiresAt: args.expiresAt });
    return true;
  },
});

export const verifyWebSession = action({
  args: { secret: v.string(), sessionId: v.string(), ownerXUserId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    if (!process.env.WEB_AUTH_SECRET || args.secret !== process.env.WEB_AUTH_SECRET) return false;
    const record: Doc<"webWalletSessions"> | null = await ctx.runQuery(internal.wallets.webSessionRecord, { sessionIdHash: await webSessionHash(args.sessionId) });
    return Boolean(record && record.ownerXUserId === args.ownerXUserId && !record.revokedAt && record.expiresAt > Math.floor(Date.now() / 1_000));
  },
});

export const revokeWebSession = action({
  args: { secret: v.string(), sessionId: v.string(), ownerXUserId: v.string() },
  handler: async (ctx, args) => {
    if (!process.env.WEB_AUTH_SECRET || args.secret !== process.env.WEB_AUTH_SECRET) throw new Error("web session authorization failed");
    await ctx.runMutation(internal.wallets.revokeWebSessionRecord, { sessionIdHash: await webSessionHash(args.sessionId), ownerXUserId: args.ownerXUserId });
    return true;
  },
});

export const provisionWebWallet = action({
  args: {
    secret: v.string(),
    xUserId: v.string(),
    username: v.string(),
    verified: v.boolean(),
    verifiedType: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ address: string }> => {
    if (!process.env.WEB_AUTH_SECRET || args.secret !== process.env.WEB_AUTH_SECRET) {
      throw new Error("web wallet authorization failed");
    }
    if (!/^\d{1,30}$/.test(args.xUserId) || !/^[A-Za-z0-9_]{1,15}$/.test(args.username)) {
      throw new Error("invalid authenticated X identity");
    }
    await ctx.runMutation(internal.wallets.upsertXUser, {
      xUserId: args.xUserId,
      username: args.username,
      verified: args.verified,
      ...(args.verifiedType ? { verifiedType: args.verifiedType } : {}),
    });
    const wallet = await ctx.runAction(internal.wallets.ensureWallet, { xUserId: args.xUserId });
    if (!wallet || !safeAddress(wallet.address) || wallet.ownerXUserId !== args.xUserId) {
      throw new Error("authenticated X wallet provisioning failed");
    }
    return { address: wallet.address };
  },
});

async function exactTokenBalance(wallet: Doc<"cryptoWallets">, xUserId: string, token: string) {
  const balance = await signerRequest<{ display: string; raw?: string; decimals?: number }>("/v1/wallets/balance", {
    chainId: ROBINHOOD_CHAIN_ID, walletRef: wallet.signerWalletRef,
    expectedAddress: wallet.address, ownerReference: `x:${xUserId}`, token,
  });
  if (!balance.raw || !/^\d+$/.test(balance.raw) || !Number.isInteger(balance.decimals) || balance.decimals! < 0 || balance.decimals! > 255) {
    throw new Error("signer did not return an exact token balance");
  }
  return { raw: balance.raw, decimals: balance.decimals! };
}

async function resolveSellToken(ctx: ActionCtx, wallet: Doc<"cryptoWallets">, xUserId: string, identifier: string) {
  if (safeAddress(identifier)) return identifier;
  const matches: string[] = await ctx.runQuery(internal.wallets.listKnownTokenMatches, { identifier, walletId: wallet._id });
  if (matches.length <= 1) return matches[0] || identifier;
  const balances = await Promise.all(matches.map(async (token) => {
    try {
      const balance = await exactTokenBalance(wallet, xUserId, token);
      return BigInt(balance.raw) > 0n ? token : undefined;
    } catch {
      return undefined;
    }
  }));
  const held = balances.filter((token): token is string => Boolean(token));
  if (held.length === 1) return held[0];
  throw new Error("that ticker matches more than one token; use the contract address");
}

async function fundPairAsset(
  ctx: ActionCtx,
  wallet: Doc<"cryptoWallets">,
  xUserId: string,
  sourcePostId: string,
  parentRequestId: string,
  pairToken: string,
  amount: string,
  unit: "eth" | "usd",
  slippageBps: number,
  registry: RuntimeRegistry,
) {
  const before = await exactTokenBalance(wallet, xUserId, pairToken);
  const fundingCommand: WalletCommand = { kind: "buy", amount, unit, token: pairToken, slippageBps };
  const fundingOperation = await operationFor(fundingCommand, undefined, undefined, undefined, pairToken, registry);
  const funding = await executeConfirmedStep(
    ctx, wallet, xUserId, sourcePostId, `${parentRequestId}:pair-funding`, fundingCommand, fundingOperation,
  );
  const after = await exactTokenBalance(wallet, xUserId, pairToken);
  if (after.decimals !== before.decimals) throw new Error("paired asset decimals changed during funding");
  const received = BigInt(after.raw) - BigInt(before.raw);
  if (received <= 0n) throw new Error("the confirmed funding swap did not increase the paired asset balance");
  return { amount: formatUnits(received, after.decimals), transactionHash: funding.transactionHash };
}

async function fundedBuyCommand(
  ctx: ActionCtx,
  wallet: Doc<"cryptoWallets">,
  xUserId: string,
  sourcePostId: string,
  parentRequestId: string,
  command: Extract<WalletCommand, { kind: "buy" }>,
  tokenAddress: string,
  registry: RuntimeRegistry,
) {
  if (command.unit === "pair") return { command };
  const factoryAddress = registry.contracts.pons_v2_factory;
  if (!safeAddress(factoryAddress)) throw new Error("Pons factory is not configured");
  const pair = await signerRequest<PonsPairInfo>("/v1/tokens/pons-pair", { token: tokenAddress, factoryAddress });
  if (!pair.isPons || pair.nativePair) return { command };
  if (!pair.pairToken || !safeAddress(pair.pairToken)) throw new Error("Pons returned an invalid paired asset");
  const funded = await fundPairAsset(
    ctx, wallet, xUserId, sourcePostId, parentRequestId, pair.pairToken,
    command.amount, command.unit, command.slippageBps, registry,
  );
  return {
    command: { ...command, amount: funded.amount, unit: "pair" as const, pairAsset: pair.pairToken },
    fundingTransactionHash: funded.transactionHash,
  };
}

async function waitForConfirmedRequest(ctx: ActionCtx, requestId: string) {
  await ctx.runAction(internal.wallets.reconcileTransaction, { requestId });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await ctx.runQuery(internal.wallets.getReconciliationContext, { requestId });
    if (current?.request.status === "confirmed" && current.request.transactionHash) {
      return {
        transactionHash: current.request.transactionHash, tokenAddress: current.launch?.tokenAddress,
        claimedDisplay: current.transaction?.claimedDisplay, tradeOutputDisplay: current.transaction?.tradeOutputDisplay,
        tradeOutputTokenAddress: current.transaction?.tradeOutputTokenAddress,
        involvedPairTokenAddress: current.transaction?.involvedPairTokenAddress,
      };
    }
    if (current?.request.status === "failed" || current?.request.status === "rejected") {
      throw new Error(current.request.safeError || "transaction failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("transaction confirmation timed out");
}

async function enableHolderFeeSharing(
  ctx: ActionCtx, wallet: Doc<"cryptoWallets">, xUserId: string, sourcePostId: string,
  parentRequestId: string, command: Extract<WalletCommand, { kind: "launch" }>, tokenAddress: string,
  registry: RuntimeRegistry,
) {
  if (!command.holderFeeSharing) return undefined;
  const distributorFactoryAddress = registry.contracts.pons_holder_distributor_factory;
  const factoryAddress = registry.contracts.pons_v2_factory;
  if (!safeAddress(distributorFactoryAddress || "") || !safeAddress(factoryAddress || "")) throw new Error("holder fee sharing contracts are not configured");
  let info = await signerRequest<{ distributor: string | null; creatorFeeRecipient: string | null }>("/v1/tokens/holder-distributor", { token: tokenAddress, distributorFactoryAddress, ponsFactoryAddress: factoryAddress });
  let createHash: string | undefined;
  if (!info.distributor) {
    const created = await executeConfirmedStep(ctx, wallet, xUserId, sourcePostId, `${parentRequestId}:holder-distributor`, command, {
      type: "pons_v2_create_holder_distributor", token: tokenAddress, distributorFactoryAddress,
    });
    createHash = created.transactionHash;
    info = await signerRequest<{ distributor: string | null; creatorFeeRecipient: string | null }>("/v1/tokens/holder-distributor", { token: tokenAddress, distributorFactoryAddress, ponsFactoryAddress: factoryAddress });
  }
  if (!info.distributor || !safeAddress(info.distributor)) throw new Error("holder fee distributor was not created");
  const routed = await executeConfirmedStep(ctx, wallet, xUserId, sourcePostId, `${parentRequestId}:holder-fee-route`, command, {
    type: "pons_v2_transfer_creator_fee_recipient", token: tokenAddress, newRecipient: info.distributor, factoryAddress,
  });
  info = await signerRequest<{ distributor: string | null; creatorFeeRecipient: string | null }>("/v1/tokens/holder-distributor", { token: tokenAddress, distributorFactoryAddress, ponsFactoryAddress: factoryAddress });
  if (!info.creatorFeeRecipient || info.creatorFeeRecipient.toLowerCase() !== info.distributor?.toLowerCase()) throw new Error("Pons did not confirm the holder distributor as creator fee recipient");
  await ctx.runMutation(internal.wallets.recordHolderFeeDistributor, { requestId: parentRequestId, distributor: info.distributor });
  return { distributor: info.distributor, createHash, routeHash: routed.transactionHash };
}

async function executeConfirmedStep(
  ctx: ActionCtx,
  wallet: Doc<"cryptoWallets">,
  xUserId: string,
  sourcePostId: string,
  requestId: string,
  command: WalletCommand,
  operation: Record<string, unknown>,
) {
  const reserved = await ctx.runMutation(internal.wallets.reserveWalletRequest, {
    requestId, sourcePostId, ownerXUserId: xUserId, walletId: wallet._id,
    kind: command.kind, normalizedJson: JSON.stringify(command),
  });
  if (!reserved.inserted) {
    if (reserved.request?.status === "confirmed" && reserved.request.transactionHash) {
      const current = await ctx.runQuery(internal.wallets.getReconciliationContext, { requestId });
      return {
        transactionHash: reserved.request.transactionHash,
        tradeOutputDisplay: current?.transaction?.tradeOutputDisplay,
        tradeOutputTokenAddress: current?.transaction?.tradeOutputTokenAddress,
        involvedPairTokenAddress: current?.transaction?.involvedPairTokenAddress,
      };
    }
    if (reserved.request?.status === "failed" || reserved.request?.status === "rejected") {
      throw new Error(reserved.request.safeError || `${command.kind} step failed`);
    }
  } else {
    await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "simulating" });
    let result: Awaited<ReturnType<typeof submitWithApproval>>;
    try {
      result = await submitWithApproval(ctx, wallet, xUserId, requestId, operation);
    } catch (error) {
      await ctx.runMutation(internal.wallets.updateWalletRequest, {
        requestId, status: "failed", safeError: error instanceof Error ? error.message : `${command.kind} step failed`,
      });
      throw error;
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(result.transactionHash)) throw new Error("signer returned an invalid transaction hash");
    if (result.status === "reverted") throw new Error("transaction reverted");
    const to = result.toAddress && safeAddress(result.toAddress) ? result.toAddress : operationDestination(operation);
    const callKind = result.callKind || String(operation.type);
    if (result.status === "confirmed") {
      await ctx.runMutation(internal.wallets.recordConfirmedExecution, {
        requestId, walletId: wallet._id, to, valueWei: result.valueWei || "0", callKind,
        transactionHash: result.transactionHash, blockNumber: result.blockNumber, claimedDisplay: result.claimedDisplay,
        tradeOutputDisplay: result.tradeOutputDisplay, tradeOutputTokenAddress: result.tradeOutputTokenAddress,
        tradeOutputBalanceBefore: result.tradeOutputBalanceBefore, involvedPairTokenAddress: result.involvedPairTokenAddress,
      });
      return {
        transactionHash: result.transactionHash, tradeOutputDisplay: result.tradeOutputDisplay,
        tradeOutputTokenAddress: result.tradeOutputTokenAddress, involvedPairTokenAddress: result.involvedPairTokenAddress,
      };
    }
    if (result.status === "prepared") {
      if (!result.signedTransaction || !/^0x[a-fA-F0-9]+$/.test(result.signedTransaction)) throw new Error("signer returned an invalid prepared transaction");
      await ctx.runMutation(internal.wallets.recordPreparedExecution, {
        requestId, walletId: wallet._id, to, valueWei: result.valueWei || "0", callKind,
        transactionHash: result.transactionHash, signedTransaction: result.signedTransaction,
        tradeOutputTokenAddress: result.tradeOutputTokenAddress, tradeOutputBalanceBefore: result.tradeOutputBalanceBefore,
        involvedPairTokenAddress: result.involvedPairTokenAddress,
      });
    } else {
      await ctx.runMutation(internal.wallets.recordBroadcastExecution, {
        requestId, walletId: wallet._id, to, valueWei: result.valueWei || "0", callKind,
        transactionHash: result.transactionHash, tradeOutputTokenAddress: result.tradeOutputTokenAddress,
        tradeOutputBalanceBefore: result.tradeOutputBalanceBefore, involvedPairTokenAddress: result.involvedPairTokenAddress,
      });
    }
  }

  return await waitForConfirmedRequest(ctx, requestId);
}

async function operationFor(
  command: Exclude<WalletCommand, { kind: "unknown" }>,
  mediaUrl?: string,
  claimToken?: string,
  recipientAddress?: string,
  tokenOverride?: string,
  registry?: { contracts: Record<string, string>; pairs: Array<{ address: string; symbol: string; pairApproved: boolean; active: boolean }> },
  launchOwnerAddress?: string,
): Promise<Record<string, unknown>> {
  if (command.kind === "send") {
    const recipient = safeAddress(command.recipient) ? command.recipient : recipientAddress;
    if (!recipient || !safeAddress(recipient) || recipient.toLowerCase() === DEAD_ADDRESS.toLowerCase()) throw new Error("invalid transfer destination");
    const nativeEth = !command.token || /^eth$/i.test(command.token);
    if (nativeEth) return { type: "eth_transfer", recipient, amount: command.amount, unit: command.unit };
    const quoterAddress = registry?.contracts.swap_quoter;
    const wethAddress = registry?.contracts.weth;
    if (!quoterAddress || !wethAddress || !safeAddress(quoterAddress) || !safeAddress(wethAddress)) throw new Error("swap contracts are missing from the registry");
    return { type: "erc20_transfer", recipient, amount: command.amount, unit: command.unit, token: tokenOverride || command.token, quoterAddress, wethAddress, fee: 10_000 };
  }
  if (command.kind === "burn") {
    const quoterAddress = registry?.contracts.swap_quoter;
    const wethAddress = registry?.contracts.weth;
    if (!quoterAddress || !wethAddress || !safeAddress(quoterAddress) || !safeAddress(wethAddress)) throw new Error("swap contracts are missing from the registry");
    return { type: "erc20_burn_to_dead", deadAddress: DEAD_ADDRESS, amount: command.amount, unit: command.unit, token: tokenOverride || command.token, quoterAddress, wethAddress, fee: 10_000 };
  }
  if (command.kind === "buy" || command.kind === "sell") {
    const routerAddress = registry?.contracts.swap_router;
    const quoterAddress = registry?.contracts.swap_quoter;
    const wethAddress = registry?.contracts.weth;
    const ponsFactoryAddress = registry?.contracts.pons_v2_factory;
    const v4QuoterAddress = registry?.contracts.v4_quoter;
    const universalRouterAddress = registry?.contracts.universal_router;
    const permit2Address = registry?.contracts.permit2;
    if (!routerAddress || !quoterAddress || !wethAddress || !ponsFactoryAddress || !v4QuoterAddress || !universalRouterAddress || !permit2Address
      || !safeAddress(routerAddress) || !safeAddress(quoterAddress) || !safeAddress(wethAddress) || !safeAddress(ponsFactoryAddress)
      || !safeAddress(v4QuoterAddress) || !safeAddress(universalRouterAddress) || !safeAddress(permit2Address)) {
      throw new Error("swap contracts are missing from the registry");
    }
    return {
      type: command.kind === "buy" ? "uniswap_v3_buy" : "uniswap_v3_sell",
      token: tokenOverride || command.token, amount: command.amount, unit: command.unit, slippageBps: command.slippageBps,
      ...(command.kind === "buy" && command.unit === "pair" ? { pairAsset: resolveTradingPair(command.pairAsset, registry?.pairs || []) } : {}),
      routerAddress, quoterAddress, wethAddress, ponsFactoryAddress, v4QuoterAddress, universalRouterAddress, permit2Address, fee: 10_000,
    };
  }
  if (command.kind === "claim_fees") {
    const factoryAddress = registry?.contracts.pons_v2_factory || "";
    if (!safeAddress(factoryAddress)) throw new Error("Pons factory is not configured");
    const token = claimToken || tokenOverride;
    return { type: "pons_v2_claim_fees", ...(token ? { token } : {}), factoryAddress };
  }
  if (command.kind === "launch") {
    const factoryAddress = registry?.contracts.pons_v2_factory || "";
    const launchAndBuyRouter = registry?.contracts.pons_v2_launch_router || "";
    const quoterAddress = registry?.contracts.swap_quoter || "";
    const wethAddress = registry?.contracts.weth || "";
    if (!safeAddress(factoryAddress)) throw new Error("Pons factory is not configured");
    if (!safeAddress(launchAndBuyRouter)) throw new Error("Pons launch-and-buy router is not configured");
    if (!safeAddress(quoterAddress) || !safeAddress(wethAddress)) throw new Error("swap contracts are missing from the registry");
    const imageUri = await normalizeImage(mediaUrl);
    const metadata = resolveLaunchMetadata(command);
    const pairToken = resolveLaunchPair(command.pairToken, registry?.pairs || []);
    const creatorFeeRecipient = command.feeRecipient
      ? (safeAddress(command.feeRecipient) ? command.feeRecipient : recipientAddress)
      : launchOwnerAddress;
    if (!creatorFeeRecipient || !safeAddress(creatorFeeRecipient)) throw new Error("creator fee recipient could not be resolved");
    return {
      type: command.devBuy ? "pons_v2_launch_and_buy" : "pons_v2_launch", launchMode: command.launchMode,
      factoryAddress, launchAndBuyRouter,
      name: command.name, symbol: command.symbol, imageUri,
      description: metadata.description,
      devBuy: command.devBuy || null,
      socials: { website: metadata.website, twitter: metadata.twitter, telegram: metadata.telegram },
      feeWalletSource: "reply_wallet",
      creatorFeeRecipient,
      launchConfigId: process.env.PONS_LAUNCH_CONFIG_ID || "0",
      pairToken, quoterAddress, wethAddress,
      method: command.devBuy ? "launchAndBuy" : "launchToken",
    };
  }
  throw new Error("operation is read-only");
}

async function submitWithApproval(
  ctx: ActionCtx,
  wallet: Doc<"cryptoWallets">,
  xUserId: string,
  requestId: string,
  operation: Record<string, unknown>,
) {
  let result = await submit(wallet, xUserId, requestId, operation);
  if (!result.approvalRequired) return result;
  if (!result.approvalTokenAddress || !safeAddress(result.approvalTokenAddress)
    || !result.signedTransaction || !/^0x[a-fA-F0-9]+$/.test(result.signedTransaction)
    || !/^0x[a-fA-F0-9]{64}$/.test(result.transactionHash)) {
    throw new Error("signer returned invalid approval metadata");
  }
  const approvalRecord = await ctx.runMutation(internal.wallets.recordApprovalPrepared, {
    requestId, walletId: wallet._id, tokenAddress: result.approvalTokenAddress,
    transactionHash: result.transactionHash, signedTransaction: result.signedTransaction,
  });
  const requestBody = {
    chainId: ROBINHOOD_CHAIN_ID, ownerReference: `x:${xUserId}`,
    walletRef: wallet.signerWalletRef, expectedFrom: wallet.address,
    expectedTo: result.approvalTokenAddress, transactionHash: result.transactionHash,
    operationType: "erc20_approval", expectedValueWei: "0",
  };
  if (approvalRecord?.status === "confirmed") {
    result = await submit(wallet, xUserId, requestId, operation);
    if (result.approvalRequired) throw new Error("confirmed token approval did not satisfy the requested operation");
    return result;
  }
  if (approvalRecord?.status === "reverted" || approvalRecord?.status === "invalid") throw new Error("previous token approval failed");
  if (!approvalRecord || approvalRecord.status === "prepared") {
    const broadcast = await signerRequest<SubmittedTransaction>("/v1/transactions/broadcast", {
      ...requestBody, signedTransaction: result.signedTransaction,
    });
    if (broadcast.status === "reverted") {
      await ctx.runMutation(internal.wallets.updateApprovalStatus, { requestId, status: "reverted" });
      throw new Error("token approval reverted");
    }
    await ctx.runMutation(internal.wallets.updateApprovalStatus, { requestId, status: "broadcast" });
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await signerRequest<SubmittedTransaction>("/v1/transactions/status", requestBody);
    if (status.status === "confirmed") {
      await ctx.runMutation(internal.wallets.updateApprovalStatus, { requestId, status: "confirmed", blockNumber: status.blockNumber });
      result = await submit(wallet, xUserId, requestId, operation);
      if (result.approvalRequired) throw new Error("token approval did not satisfy the requested operation");
      return result;
    }
    if (status.status === "reverted") {
      await ctx.runMutation(internal.wallets.updateApprovalStatus, { requestId, status: "reverted", blockNumber: status.blockNumber });
      throw new Error("token approval reverted");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("token approval confirmation timed out; retrying later is safe");
}

function resolveLaunchPair(identifier: string | undefined, assets: Array<{ address: string; symbol: string; pairApproved: boolean; active: boolean }>) {
  if (!identifier || /^eth$/i.test(identifier)) return "0x0000000000000000000000000000000000000000";
  const normalized = identifier.replace(/^\$/, "").toLowerCase();
  const match = assets.find((asset) => asset.active && asset.pairApproved
    && (asset.symbol.toLowerCase() === normalized || asset.address.toLowerCase() === normalized));
  if (!match) throw new Error("requested Pons V2 pair is not currently approved");
  return match.address;
}

function resolveTradingPair(identifier: string | undefined, assets: Array<{ address: string; symbol: string; active: boolean }>) {
  if (!identifier) throw new Error("paired asset is required");
  const normalized = identifier.replace(/^\$/, "").toLowerCase();
  const match = assets.find((asset) => asset.active
    && (asset.symbol.toLowerCase() === normalized || asset.address.toLowerCase() === normalized));
  if (!match) throw new Error("paired asset was not found in the registry");
  return match.address;
}

async function indexInvolvedPair(
  ctx: ActionCtx,
  walletId: Doc<"cryptoWallets">["_id"],
  address: string | undefined,
  pairs: Array<{ address: string; symbol: string }>,
) {
  if (!address || !safeAddress(address) || /^0x0{40}$/i.test(address)) return;
  const pair = pairs.find((item) => item.address.toLowerCase() === address.toLowerCase());
  await ctx.runMutation(internal.wallets.indexWalletToken, {
    walletId, tokenAddress: address, symbol: pair?.symbol || address,
    involvedByLaunch: false, involvedByTransaction: true,
  });
}

function resolveLaunchMetadata(command: Extract<WalletCommand, { kind: "launch" }>) {
  return {
    description: command.description?.trim() || "",
    website: command.website ? normalizeWebsiteUrl(command.website) : "",
    twitter: command.twitter ? normalizeXUrl(command.twitter) : "",
    telegram: command.telegram ? normalizeTelegramUrl(command.telegram) : "",
  };
}
