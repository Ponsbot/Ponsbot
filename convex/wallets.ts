import { v } from "convex/values";
import { geckoSharedFetch } from "../lib/gecko-shared";
import { terminalFeeReceipts } from "./lib/terminalFeeReceipts";
import type { TerminalFeeReceipt } from "../lib/terminal-fee-receipt";
import { internal } from "./_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  isTerminalCommand,
  isValueMovingCommand,
  normalizeLaunchFeeOptions,
  normalizeLaunchLinks,
  normalizeLaunchTelegram,
  normalizeOptionalTelegramUrl,
  normalizeWebsiteUrl,
  normalizeXUrl,
  parseWalletCommand,
  validateStructuredWalletCommand,
  type WalletCommand,
} from "./walletCommands";
import {
  conversationalWalletMessage,
  parseXWalletIntent,
  unknownWalletMessage,
  walletHelpMessage,
} from "./xWalletIntent";
import { formatUnits, parseTransaction } from "viem";
import { ethUsdPrice } from "../lib/wallet-signer/pricing";
import { claimUsdDisplay } from "../lib/vault-claim-response";
import { canSkipUnsubmittedSweep, legacyClaimSigningKey, LEGACY_CLAIM_SUPERSEDED, LEGACY_CLAIM_VERSION, resumableLegacyClaim, storedClaimWorkflow } from "../lib/legacy-claim-workflow";
import { walletCanLaunch } from "../lib/wallet-launch-policy";
import { reservedLaunchTickerMessage } from "../lib/special-launch-policy";
import {
  addNormalizedAddressMatch,
  isAddressLiteral,
  normalizedRpcAddress,
} from "../lib/address-normalization";
import { isTokenIndexExcluded } from "../lib/token-index-exclusions";
import { assertBuyTarget } from "../lib/buy-target-policy";
import { AUTOMATED_FEE_PAIR_ROUTES } from "../lib/automated-fee-pair-routes";
import { nativeTokenOperationError } from "../lib/native-token-operation";
import { EmptyNativeGasBalanceError, requireWalletNativeGas } from "../lib/wallet-native-gas";
import { confirmedAllEthDisplay } from "../lib/native-send-display";
import { isResumeReply } from "../lib/x-direct-post-policy";
import { existingFeeUpgradeState, feeUpgradeAlreadyMessage, feeUpgradeSuccessMessage, FEE_UPGRADE_RESPONSES } from "../lib/fee-upgrade-command";
import { recordVerifiedFeeOutcome } from "./automatedFeeOutcomes";
import { requestedVaultClaimsEnabled } from "./automatedFeeClaimInfo";
import { automatedFeeDeploymentConfirmed } from "../lib/automated-fee-policy";
import {
  GENERAL_GUIDED_HELP_MESSAGE,
  GUIDED_HELP_TTL_MS,
  guidedHelpCancelled,
  guidedHelpClaimLpOfferSelection,
  guidedHelpClaimSelection,
  guidedHelpCommandText,
  guidedHelpOperationFromHelp,
  guidedHelpOperationFromPrompt,
  guidedHelpPrompt,
  guidedHelpQuestion,
  guidedHelpQuestionResponse,
  guidedHelpSelection,
  withClaimLpFeeOffer,
} from "../lib/guided-help-workflow";
import {
  AUTOMATED_FEE_WORKFLOW_CONTINUATION,
  automatedFeeControllerTransactionMayExist,
} from "../lib/automated-fee-workflow";

const ROBINHOOD_CHAIN_ID = 4663;
// Transactions prepared before the broadcaster failover was introduced were
// already reported to users as failed. They must never become executable merely
// because a later deployment adds a working RPC route.
const LEGACY_PREPARED_CANCELLATION_CUTOFF_MS = 1_787_733_903_278;
const NON_PREMIUM_DAILY_LIMIT = 50;
const PREMIUM_DAILY_LIMIT = 1_000;
const PROVISIONING_LEASE_MS = 2 * 60_000;
const MAX_RECONCILIATION_ATTEMPTS = 20;
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const ROBINHOOD_EXPLORER_TX_BASE = "https://robinhoodchain.blockscout.com/tx";
const ROBINHOOD_EXPLORER_ADDRESS_BASE =
  "https://robinhoodchain.blockscout.com/address";
const CLAIM_WORKFLOW_CONTINUATION = "claim workflow continuation required";

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
  devBuyWei?: string;
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
  nonce?: number;
};
type CommandResult = {
  ok: boolean;
  message: string;
  transactionHash?: string;
  deferred?: boolean;
  pending?: boolean;
};
type RuntimeRegistry = {
  contracts: Record<string, string>;
  pairs: Array<{
    address: string;
    symbol: string;
    pairApproved: boolean;
    active: boolean;
  }>;
};
type PonsPairInfo = {
  isPons: boolean;
  pairToken?: string;
  nativePair?: boolean;
  phase?: number;
};

function operationDestination(operation: Record<string, unknown>) {
  const destination =
    operation.type === "pons_v2_launch"
      ? operation.factoryAddress
      : operation.type === "pons_v2_launch_and_buy"
        ? operation.launchAndBuyRouter
        : operation.type === "pons_v2_create_holder_distributor"
          ? operation.distributorFactoryAddress
          : operation.type === "pons_v2_transfer_creator_fee_recipient"
            ? operation.factoryAddress
            : operation.recipient ||
              operation.routerAddress ||
              operation.lockerAddress ||
              operation.padAddress ||
              operation.deadAddress;
  if (typeof destination !== "string" || !safeAddress(destination)) {
    throw new Error("transaction destination is missing or invalid");
  }
  return destination;
}

function executionEnabled() {
  return process.env.X_CRYPTO_EXECUTION_ENABLED === "true";
}

function safeAddress(value: string) {
  return isAddressLiteral(value);
}

function transactionUrl(transactionHash: string) {
  return `${ROBINHOOD_EXPLORER_TX_BASE}/${transactionHash}`;
}

function addressUrl(address: string) {
  return `${ROBINHOOD_EXPLORER_ADDRESS_BASE}/${address}`;
}

function ponsBotTokenUrl(address: string) {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "");
  return `${site || "https://www.ponsbot.family"}/launch/${address}`;
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
  if (!amount || Number(amount) <= 0)
    throw new Error("trade output amount was not verified");
  return amount;
}

function multiplyDecimalByInteger(value: string, multiplier: number) {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value) || !Number.isSafeInteger(multiplier) || multiplier < 0)
    throw new Error("amount could not be calculated");
  const [whole, fraction = ""] = value.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const raw = (BigInt(whole) * scale + BigInt(fraction || "0")) * BigInt(multiplier);
  const outputWhole = raw / scale;
  if (!fraction.length) return outputWhole.toString();
  const outputFraction = (raw % scale).toString().padStart(fraction.length, "0").replace(/0+$/, "");
  return outputFraction ? `${outputWhole}.${outputFraction}` : outputWhole.toString();
}

export function significantAmount(value: string, significantDigits = 6) {
  const normalized = value.replaceAll(",", "");
  if (!/^-?[0-9]+(?:\.[0-9]+)?$/.test(normalized)) return value;
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat("en-US", {
    useGrouping: false,
    maximumSignificantDigits: significantDigits,
  }).format(numeric);
}

function compactAssetDisplay(display: string | undefined) {
  if (!display) return display;
  return display.replace(
    /(^|\n)([0-9][0-9,]*(?:\.[0-9]+)?)(?=\s+[$A-Za-z])/g,
    (_match, prefix: string, amount: string) =>
      `${prefix}${significantAmount(amount)}`,
  );
}

function replyCommand(
  command: WalletCommand,
  tokenSymbol: string | undefined,
  registry: RuntimeRegistry,
): WalletCommand {
  const displayToken = (value: string | undefined) => {
    if (!value || !safeAddress(value)) return value;
    if (tokenSymbol) return tokenSymbol;
    return (
      registry.pairs.find(
        (item) => item.address.toLowerCase() === value.toLowerCase(),
      )?.symbol || "token"
    );
  };
  if (command.kind === "send" && command.token)
    return { ...command, token: displayToken(command.token) };
  if (
    command.kind === "burn" ||
    command.kind === "sell" ||
    command.kind === "claim_fees" ||
    command.kind === "reassign_fees" ||
    command.kind === "upgrade_fees" ||
    command.kind === "buy_and_send" ||
    command.kind === "buy_and_burn"
  ) {
    return {
      ...command,
      ...(command.token ? { token: displayToken(command.token) } : {}),
    } as WalletCommand;
  }
  if (command.kind === "buy")
    return {
      ...command,
      token: displayToken(command.token)!,
      pairAsset: displayToken(command.pairAsset),
    };
  if (command.kind === "swap_token_for_token")
    return {
      ...command,
      fromToken: displayToken(command.fromToken)!,
      toToken: displayToken(command.toToken)!,
    };
  if (command.kind === "show_balance" && command.token)
    return { ...command, token: displayToken(command.token) };
  if (command.kind === "launch" && command.pairToken)
    return { ...command, pairToken: displayToken(command.pairToken) };
  return command;
}

function commandSummary(command: WalletCommand) {
  if (command.kind === "send") {
    const amount =
      command.unit === "usd"
        ? `$${command.amount} of ${assetLabel(command.token)}`
        : command.unit === "eth" && command.token && !/^eth$/i.test(command.token)
          ? `approximately ${significantAmount(command.amount)} ETH worth of ${assetLabel(command.token)}`
        : command.unit === "percent"
          ? `${command.amount}% of ${assetLabel(command.token)}`
          : `${significantAmount(command.amount)} ${assetLabel(command.token)}`;
    return `Sent ${amount} to ${destinationLabel(command.recipient)}!`;
  }
  if (command.kind === "burn") {
    const amount =
      command.unit === "usd"
        ? `$${command.amount} of ${assetLabel(command.token)}`
        : command.unit === "eth" && !/^eth$/i.test(command.token)
          ? `approximately ${significantAmount(command.amount)} ETH worth of ${assetLabel(command.token)}`
        : command.unit === "percent"
          ? `${command.amount}% of ${assetLabel(command.token)}`
          : `${significantAmount(command.amount)} ${assetLabel(command.token)}`;
    return `Burned ${amount}!`;
  }
  if (command.kind === "buy")
    return `Bought ${command.unit === "usd" ? `$${command.amount}` : command.unit === "eth" ? `${command.amount} ETH` : command.unit === "token" ? `${command.amount} ${assetLabel(command.token)}` : `${command.amount} ${assetLabel(command.pairAsset)}`} of ${assetLabel(command.token)}!`;
  if (command.kind === "buy_and_send")
    return `Bought ${command.unit === "usd" ? `$${command.amount}` : command.unit === "eth" ? `${command.amount} ETH` : command.unit === "token" ? `${command.amount} ${assetLabel(command.token)}` : `${command.amount} ${assetLabel(command.pairAsset)}`} of ${assetLabel(command.token)} and sent the purchased tokens to ${destinationLabel(command.recipient)}!`;
  if (command.kind === "buy_and_burn")
    return `Bought ${command.unit === "usd" ? `$${command.amount}` : command.unit === "eth" ? `${command.amount} ETH` : command.unit === "token" ? `${command.amount} ${assetLabel(command.token)}` : `${command.amount} ${assetLabel(command.pairAsset)}`} of ${assetLabel(command.token)} and burned the purchased tokens!`;
  if (command.kind === "buy_top_five")
    return `${command.burn ? "Bought and burned" : "Bought"} $${command.amount} each of the top 5 Pons Bot tokens!`;
  if (command.kind === "swap_token_for_token")
    return `Swapped $${command.amount} of ${assetLabel(command.fromToken)} for ${assetLabel(command.toToken)}!`;
  if (command.kind === "sell")
    return `Sold ${command.unit === "percent" ? `${command.amount}% of ` : command.unit === "usd" ? `$${command.amount} of ` : command.unit === "eth" ? `${command.amount} ETH of ` : `${significantAmount(command.amount)} `}${assetLabel(command.token)}!`;
  if (command.kind === "claim_fees")
    return `Claimed creator fees${command.token ? ` for ${assetLabel(command.token)}` : ""}!`;
  if (command.kind === "reassign_fees")
    return `Reassigned future creator fees for ${assetLabel(command.token)} to ${destinationLabel(command.recipient)}!`;
  if (command.kind === "upgrade_fees")
    return `Upgraded ${assetLabel(command.token)} to automated creator-fee processing!`;
  if (command.kind === "launch") {
    const pair =
      command.pairToken && !/^eth$/i.test(command.pairToken)
        ? `, paired with ${safeAddress(command.pairToken) ? addressUrl(command.pairToken) : `$${command.pairToken.replace(/^\$/, "")}`}`
        : "";
    const fees = command.holderFeeSharing
      ? ", with holder fee sharing"
      : command.feeRecipient
        ? `, with creator fees assigned${command.feeRecipient.startsWith("@") ? ` to ${command.feeRecipient}` : " to the selected wallet"}`
        : "";
    return `Launched ${command.name} (${command.symbol}) on Pons V2${pair}${fees}! 🚀`;
  }
  return "Transaction submitted!";
}

function usdValueDisplay(value: number) {
  if (!Number.isFinite(value) || value < 0) return undefined;
  if (value === 0) return "$0";
  if (value >= 0.01)
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;
}

async function currentTokenUsdValue(
  tokenAddress?: string,
  tradeOutputDisplay?: string,
) {
  if (!tokenAddress || !safeAddress(tokenAddress) || !tradeOutputDisplay)
    return undefined;
  const amount = Number(tradeDisplayAmount(tradeOutputDisplay));
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  try {
    const response = await geckoSharedFetch(
      `https://api.geckoterminal.com/api/v2/simple/networks/robinhood/token_price/${tokenAddress.toLowerCase()}`,
      30_000, 4_000,
    );
    if (!response.ok) return undefined;
    const payload = (await response.json()) as {
      data?: { attributes?: { token_prices?: Record<string, string | null> } };
    };
    const prices = payload.data?.attributes?.token_prices || {};
    const rawPrice =
      prices[tokenAddress.toLowerCase()] ??
      Object.entries(prices).find(
        ([address]) => address.toLowerCase() === tokenAddress.toLowerCase(),
      )?.[1];
    if (typeof rawPrice !== "string" || !rawPrice.trim()) return undefined;
    const price = Number(rawPrice);
    return Number.isFinite(price) && price >= 0
      ? usdValueDisplay(amount * price)
      : undefined;
  } catch {
    // Pricing is display-only. A market-data timeout must never change the
    // confirmed status of an on-chain burn.
    return undefined;
  }
}

async function tokenUsdValueAtBlock(
  tokenAddress: string,
  amount: string,
  blockNumber?: string,
) {
  if (
    !safeAddress(tokenAddress) ||
    !blockNumber ||
    !/^\d{1,30}$/.test(blockNumber)
  )
    return undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await signerRequest<{ usdValue?: number }>(
        "/v1/tokens/value-at-block",
        { token: tokenAddress, amount, blockNumber },
      );
      if (typeof result.usdValue === "number")
        return usdValueDisplay(result.usdValue);
    } catch {
      if (attempt < 3)
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  return undefined;
}

async function transactionMessage(
  command: WalletCommand,
  transactionHash: string,
  tokenAddress?: string,
  claimedDisplay?: string,
  tradeOutputDisplay?: string,
  claimIncludesOtherLaunches = false,
  valuationTokenAddress?: string,
  confirmedValueWei?: string,
) {
  const compactClaimed = compactAssetDisplay(claimedDisplay);
  const compactOutput = compactAssetDisplay(tradeOutputDisplay);
  const sentEth = await confirmedAllEthDisplay(command, confirmedValueWei);
  const burnValue =
    command.kind === "burn"
      ? await currentTokenUsdValue(valuationTokenAddress, tradeOutputDisplay)
      : undefined;
  const claimedWithUsd = command.kind === "claim_fees" && compactClaimed
    ? await addClaimUsdValue(compactClaimed)
    : compactClaimed;
  const summary =
    command.kind === "send" && sentEth
      ? `Sent ${sentEth} to ${destinationLabel(command.recipient)}!`
      : command.kind === "claim_fees" && claimedWithUsd
      ? `Claimed ${claimedWithUsd} in creator fees${command.token ? ` from ${assetLabel(command.token)}${claimIncludesOtherLaunches ? " and other launches" : ""}` : ""}!`
      : command.kind === "burn" && compactOutput
        ? `Burned ${compactOutput}${burnValue ? ` (${burnValue})` : ""}!`
        : commandSummary(command);
  const tokenLine =
    command.kind === "launch" && tokenAddress
      ? `\nView Token: ${ponsBotTokenUrl(tokenAddress)}`
      : "";
  const outputLine =
    (command.kind === "buy" || command.kind === "sell") && compactOutput
      ? `\nReceived: ${compactOutput}`
      : "";
  return `✅ Success! ${summary}${outputLine}${tokenLine}\nYour TXN: ${transactionUrl(transactionHash)}`;
}

async function currentClaimEthUsd() {
  return ethUsdPrice(AbortSignal.timeout(4_000)).catch(() => undefined);
}

async function addClaimUsdValue(display: string) {
  const match = display.match(/^([0-9][0-9,.]*(?:\.[0-9]+)?)\s+ETH$/i);
  if (!match) return display;
  const amount = Number(match[1].replace(/,/g, ""));
  return `${display}${claimUsdDisplay(amount, await currentClaimEthUsd())}`;
}

function fundingMessage(message: string, walletAddress: string, requestId?: string) {
  return /(?:enough ETH|needs a little more ETH|Add ETH for gas|fund your wallet with ETH for gas)/i.test(message)
    ? `${message}\nYour wallet: ${walletPageUrl(walletAddress, requestId)}`
    : message;
}

function signerConfiguration() {
  const explicitUrl = process.env.WALLET_SIGNER_URL?.trim();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const baseUrl = (
    explicitUrl ||
    (siteUrl ? `${siteUrl.replace(/\/$/, "")}/api/wallet-signer` : "")
  ).replace(/\/$/, "");
  const token = process.env.WALLET_SIGNER_TOKEN;
  if (!baseUrl || !token)
    throw new Error("secure wallet signer is not configured");
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== "https:" &&
    parsed.hostname !== "localhost" &&
    parsed.hostname !== "127.0.0.1"
  ) {
    throw new Error("secure wallet signer must use HTTPS");
  }
  return { baseUrl, token };
}

async function signerRequest<T>(
  path: string,
  body: unknown,
  timeoutMs?: number,
): Promise<T> {
  const { baseUrl, token } = signerConfiguration();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        timeoutMs || (path.endsWith("/execute") ? 45_000 : 20_000),
      ),
    });
  } catch (error) {
    const timeout =
      error instanceof Error &&
      /timeout/i.test(`${error.name} ${error.message}`);
    throw new Error(
      `signer request failed [${path}] status=NETWORK code=${timeout ? "SIGNER_TIMEOUT" : "SIGNER_TRANSPORT_FAILURE"}`,
    );
  }

  const raw = await response.text();

  let payload:
    | (T & {
        error?: string;
        message?: string;
        diagnosticCode?: string;
        diagnosticDetail?: string;
      })
    | null = null;

  try {
    payload = raw
      ? (JSON.parse(raw) as T & {
          error?: string;
          message?: string;
          diagnosticCode?: string;
          diagnosticDetail?: string;
        })
      : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const code = payload?.diagnosticCode || `HTTP_${response.status}`;
    const detail =
      payload?.diagnosticDetail ||
      payload?.error ||
      payload?.message ||
      response.statusText;
    throw new Error(
      `signer request failed [${path}] status=${response.status} code=${code}: ${detail}`,
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
  if (!wallet.walletRef || !safeAddress(wallet.address))
    throw new Error("signer returned an invalid wallet");
  return wallet;
}

async function normalizeImage(mediaUrl?: string) {
  if (!mediaUrl) return "";
  const url = new URL(mediaUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "pbs.twimg.com"
  ) {
    throw new Error("token image must be an attached X image");
  }
  return url.toString();
}

export const upsertXUser = internalMutation({
  args: {
    xUserId: v.string(),
    username: v.string(),
    verified: v.boolean(),
    verifiedType: v.optional(v.string()),
    subscriptionType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("xReplyUsers")
      .withIndex("by_x_user_id", (q) => q.eq("xUserId", args.xUserId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt: now });
      if (existing.walletId)
        await ctx.db.patch(existing.walletId, {
          xUsername: args.username,
          updatedAt: now,
        });
      return existing._id;
    }
    return await ctx.db.insert("xReplyUsers", {
      ...args,
      hasSuccessfulLaunch: false,
      walletStatus: "none",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getXUserAndWallet = internalQuery({
  args: { xUserId: v.string() },
  handler: async (ctx, { xUserId }) => {
    const user = await ctx.db
      .query("xReplyUsers")
      .withIndex("by_x_user_id", (q) => q.eq("xUserId", xUserId))
      .unique();
    const wallet = user?.walletId ? await ctx.db.get(user.walletId) : null;
    return user ? { user, wallet } : null;
  },
});

export const beginWalletProvisioning = internalMutation({
  args: { xUserId: v.string() },
  handler: async (ctx, { xUserId }) => {
    const user = await ctx.db
      .query("xReplyUsers")
      .withIndex("by_x_user_id", (q) => q.eq("xUserId", xUserId))
      .unique();
    if (!user) throw new Error("X user is not registered");
    if (user.walletId) return { needed: false, walletId: user.walletId };
    if (
      user.walletStatus === "provisioning" &&
      Date.now() - user.updatedAt < PROVISIONING_LEASE_MS
    )
      return { needed: false };
    await ctx.db.patch(user._id, {
      walletStatus: "provisioning",
      updatedAt: Date.now(),
    });
    return { needed: true };
  },
});

export const finishWalletProvisioning = internalMutation({
  args: {
    xUserId: v.string(),
    address: v.string(),
    signerWalletRef: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("xReplyUsers")
      .withIndex("by_x_user_id", (q) => q.eq("xUserId", args.xUserId))
      .unique();
    if (!user) throw new Error("X user is not registered");
    if (user.walletId) {
      const linked = await ctx.db.get(user.walletId);
      if (
        !linked ||
        linked.ownerXUserId !== args.xUserId ||
        linked.chainId !== ROBINHOOD_CHAIN_ID ||
        linked.address.toLowerCase() !== args.address.toLowerCase() ||
        linked.signerWalletRef.toLowerCase() !==
          args.signerWalletRef.toLowerCase()
      ) {
        throw new Error("canonical X wallet binding mismatch");
      }
      return linked._id;
    }
    const existing = await ctx.db
      .query("cryptoWallets")
      .withIndex("by_owner_x_user_id", (q) =>
        q.eq("ownerXUserId", args.xUserId),
      )
      .unique();
    const normalizedAddress = args.address.toLowerCase();
    const addressOwner =
      (await ctx.db
        .query("cryptoWallets")
        .withIndex("by_normalized_address", (q) =>
          q.eq("normalizedAddress", normalizedAddress),
        )
        .unique()) ||
      (await ctx.db
        .query("cryptoWallets")
        .withIndex("by_address", (q) => q.eq("address", args.address))
        .unique());
    if (addressOwner && addressOwner.ownerXUserId !== args.xUserId)
      throw new Error("wallet address is already bound to another X user");
    if (
      existing &&
      (existing.address.toLowerCase() !== args.address.toLowerCase() ||
        existing.signerWalletRef.toLowerCase() !==
          args.signerWalletRef.toLowerCase() ||
        existing.chainId !== ROBINHOOD_CHAIN_ID)
    )
      throw new Error("canonical X wallet binding mismatch");
    const now = Date.now();
    const walletId =
      existing?._id ||
      (await ctx.db.insert("cryptoWallets", {
        ownerXUserId: args.xUserId,
        xUsername: user.username,
        address: args.address,
        normalizedAddress,
        signerWalletRef: args.signerWalletRef,
        chainId: ROBINHOOD_CHAIN_ID,
        status: "active",
        launchEnabled: true,
        createdAt: now,
        updatedAt: now,
      }));
    if (!existing) {
      const stats = await ctx.db.query("platformStatsCache").withIndex("by_key", (q) => q.eq("key", "public")).unique();
      if (stats) await ctx.db.patch(stats._id, { wallets: stats.wallets + 1, computedAt: now });
    }
    if (existing && existing.xUsername !== user.username)
      await ctx.db.patch(existing._id, {
        xUsername: user.username,
        updatedAt: now,
      });
    await ctx.db.patch(user._id, {
      walletId,
      walletStatus: "active",
      updatedAt: now,
    });
    return walletId;
  },
});

export const resetWalletProvisioning = internalMutation({
  args: { xUserId: v.string() },
  handler: async (ctx, { xUserId }) => {
    const user = await ctx.db
      .query("xReplyUsers")
      .withIndex("by_x_user_id", (q) => q.eq("xUserId", xUserId))
      .unique();
    if (user && !user.walletId)
      await ctx.db.patch(user._id, {
        walletStatus: "none",
        updatedAt: Date.now(),
      });
  },
});

export const consumeWalletLimit = internalMutation({
  args: { xUserId: v.string(), premium: v.boolean() },
  handler: async (ctx, args) => {
    const dailyLimit = args.premium
      ? PREMIUM_DAILY_LIMIT
      : NON_PREMIUM_DAILY_LIMIT;
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const record = await ctx.db
      .query("walletRateLimits")
      .withIndex("by_owner_x_user_id", (q) =>
        q.eq("ownerXUserId", args.xUserId),
      )
      .unique();
    const current = record?.day === day ? record.count : 0;
    if (current >= dailyLimit)
      return { allowed: false, count: current, remaining: 0 };
    const count = current + 1;
    if (record) await ctx.db.patch(record._id, { day, count, updatedAt: now });
    else
      await ctx.db.insert("walletRateLimits", {
        ownerXUserId: args.xUserId,
        day,
        count,
        updatedAt: now,
      });
    return { allowed: true, count, remaining: dailyLimit - count };
  },
});

export const reserveWalletRequest = internalMutation({
  args: {
    requestId: v.string(),
    sourcePostId: v.string(),
    ownerXUserId: v.string(),
    walletId: v.id("cryptoWallets"),
    kind: v.string(),
    normalizedJson: v.string(),
    source: v.optional(v.union(v.literal("x"), v.literal("terminal"))),
    channel: v.optional(
      v.union(
        v.literal("x_reply"),
        v.literal("terminal_chat"),
        v.literal("terminal_form"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const duplicate = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (duplicate) {
      if (args.kind === "buy_top_five" || duplicate.kind === "buy_top_five") {
        if (duplicate.ownerXUserId !== args.ownerXUserId || duplicate.walletId !== args.walletId
          || duplicate.sourcePostId !== args.sourcePostId || duplicate.kind !== args.kind
          || duplicate.normalizedJson !== args.normalizedJson
          || (args.source !== undefined && (duplicate.source ?? "x") !== args.source)
          || (args.channel !== undefined && (duplicate.channel ?? "x_reply") !== args.channel)) {
          throw new Error("wallet request identity mismatch");
        }
        // A child transaction may outlive one server action. Resume only this
        // same persisted request so confirmed child steps are reconciled rather
        // than submitted again, and so the frozen five-token snapshot is kept.
        if (duplicate.status === "simulating")
          return { inserted: true, retried: true, request: duplicate };
      }
      if (args.kind === "claim_fees" || duplicate.kind === "claim_fees") {
        if (duplicate.ownerXUserId !== args.ownerXUserId || duplicate.walletId !== args.walletId
          || duplicate.sourcePostId !== args.sourcePostId || duplicate.kind !== args.kind
          || duplicate.normalizedJson !== args.normalizedJson
          || (args.source !== undefined && (duplicate.source ?? "x") !== args.source)
          || (args.channel !== undefined && (duplicate.channel ?? "x_reply") !== args.channel)) {
          throw new Error("wallet request identity mismatch");
        }
        if (duplicate.diagnosticCode === LEGACY_CLAIM_SUPERSEDED) return { inserted: false, retried: false, request: duplicate };
        if (duplicate.vaultClaimPreparedAt && ["confirmed", "failed", "rejected", "skipped"].includes(duplicate.status))
          return { inserted: false, retried: false, request: duplicate };
        // Old stuck requests are deliberately not activated by deployment.
        // Recovery explicitly opts in the selected original request per wallet.
        if (resumableLegacyClaim(duplicate)) return { inserted: true, retried: true, request: duplicate };
      }
      if (args.kind === "upgrade_fees" && (duplicate.ownerXUserId !== args.ownerXUserId || duplicate.walletId !== args.walletId
        || duplicate.sourcePostId !== args.sourcePostId || duplicate.kind !== args.kind
        || duplicate.normalizedJson !== args.normalizedJson || (duplicate.source ?? "x") !== (args.source ?? "x"))) throw new Error("wallet request identity mismatch");
      // Resume only the same persisted upgrade, under the execution lease below.
      // A cancelled/rejected request can never enter this path or be recharged.
      if (duplicate.kind === "upgrade_fees" && duplicate.status === "simulating"
        && duplicate.diagnosticCode !== "UPGRADE_CANCELLED_BY_OPERATOR") {
        return { inserted: true, retried: true, request: duplicate };
      }
      if (
        (duplicate.status === "failed" || duplicate.status === "skipped") &&
        !duplicate.transactionHash
      ) {
        await ctx.db.patch(duplicate._id, {
          status: "accepted",
          safeError: undefined,
          finalMessage: undefined,
          diagnosticCode: undefined,
          diagnosticDetail: undefined,
          updatedAt: Date.now(),
        });
        return {
          inserted: true,
          retried: true,
          request: await ctx.db.get(duplicate._id),
        };
      }
      return { inserted: false, retried: false, request: duplicate };
    }
    const related =
      !args.source || !args.channel
        ? await ctx.db
            .query("walletRequests")
            .withIndex("by_source_post_id", (q) =>
              q.eq("sourcePostId", args.sourcePostId),
            )
            .collect()
        : [];
    const parent = related.find(
      (item) =>
        item.ownerXUserId === args.ownerXUserId &&
        item.walletId === args.walletId &&
        item.source &&
        item.channel,
    );
    const now = Date.now();
    const id = await ctx.db.insert("walletRequests", {
      ...args,
      ...(args.kind === "claim_fees" ? { vaultClaimVersion: 1 } : {}),
      ...(args.source ? {} : parent?.source ? { source: parent.source } : {}),
      ...(args.channel
        ? {}
        : parent?.channel
          ? { channel: parent.channel }
          : {}),
      status: "accepted",
      createdAt: now,
      updatedAt: now,
    });
    return { inserted: true, retried: false, request: await ctx.db.get(id) };
  },
});

export const updateWalletRequest = internalMutation({
  args: {
    requestId: v.string(),
    status: v.union(
      v.literal("accepted"),
      v.literal("simulating"),
      v.literal("prepared"),
      v.literal("broadcast"),
      v.literal("confirmed"),
      v.literal("rejected"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    safeError: v.optional(v.string()),
    finalMessage: v.optional(v.string()),
    transactionHash: v.optional(v.string()),
    workflowStage: v.optional(v.string()),
    diagnosticCode: v.optional(v.string()),
    diagnosticDetail: v.optional(v.string()),
    clearErrorState: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (request) {
      if (["UPGRADE_CANCELLED_BY_OPERATOR", LEGACY_CLAIM_SUPERSEDED].includes(request.diagnosticCode || "") && args.status !== "rejected") return;
      const patch: {
        status: typeof args.status;
        updatedAt: number;
        safeError?: string;
        finalMessage?: string;
        transactionHash?: string;
        workflowStage?: string;
        diagnosticCode?: string;
        diagnosticDetail?: string;
      } = {
        status: args.status,
        updatedAt: Date.now(),
      };
      if (args.safeError !== undefined) patch.safeError = args.safeError;
      if (args.finalMessage !== undefined)
        patch.finalMessage = args.finalMessage;
      if (args.transactionHash !== undefined)
        patch.transactionHash = args.transactionHash;
      if (args.workflowStage !== undefined)
        patch.workflowStage = args.workflowStage;
      if (args.diagnosticCode !== undefined)
        patch.diagnosticCode = args.diagnosticCode;
      if (args.diagnosticDetail !== undefined)
        patch.diagnosticDetail = args.diagnosticDetail;
      if (args.clearErrorState) {
        patch.safeError = undefined;
        patch.finalMessage = undefined;
        patch.diagnosticCode = undefined;
        patch.diagnosticDetail = undefined;
      }
      await ctx.db.patch(request._id, patch);
    }
  },
});

export const setWalletLaunchEnabled = internalMutation({
  args: { xUserId: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const wallet = await ctx.db
      .query("cryptoWallets")
      .withIndex("by_owner_x_user_id", (q) =>
        q.eq("ownerXUserId", args.xUserId),
      )
      .unique();
    if (!wallet) throw new Error("wallet not found");
    await ctx.db.patch(wallet._id, {
      launchEnabled: args.enabled,
      updatedAt: Date.now(),
    });
    return { address: wallet.address, launchEnabled: args.enabled };
  },
});

export const refundWalletLimitIfPreBroadcast = internalMutation({
  args: { requestId: v.string(), xUserId: v.string() },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (
      !request ||
      request.ownerXUserId !== args.xUserId ||
      request.limitRefundedAt
    )
      return false;
    const related = await ctx.db
      .query("walletRequests")
      .withIndex("by_source_post_id", (q) =>
        q.eq("sourcePostId", request.sourcePostId),
      )
      .collect();
    if (request.vaultClaimPreparedAt) {
      const claims = await ctx.db.query("automatedFeeClaimRequests").withIndex("by_request", q => q.eq("requestId", request.requestId)).collect();
      for (const claim of claims) {
        const run = claim.runId ? await ctx.db.get(claim.runId) : null;
        if (claim.status === "queued" || run?.sweepTransactionHash || run?.processingTransactionHash || run?.deliveryTransactionHash) return false;
      }
    }
    for (const item of related) {
      if (
        item.transactionHash ||
        item.status === "prepared" ||
        item.status === "broadcast" ||
        item.status === "confirmed"
      )
        return false;
      const transaction = await ctx.db
        .query("walletTransactions")
        .withIndex("by_request_id", (q) => q.eq("requestId", item.requestId))
        .unique();
      const approval = await ctx.db
        .query("walletTransactions")
        .withIndex("by_request_id", (q) =>
          q.eq("requestId", `${item.requestId}:approval`),
        )
        .unique();
      if (transaction || approval) return false;
    }
    const automatedFeeRequestIds = [
      request.requestId,
      `${request.requestId}:pause`,
      `${request.requestId}:exit`,
      `${request.requestId}:controller-sweep`,
      `${request.requestId}:former-beneficiary-delivery`,
    ];
    const automatedFeeChanges = await Promise.all(automatedFeeRequestIds.map((requestId) =>
      ctx.db.query("automatedFeeControllerChanges")
        .withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique(),
    ));
    if (automatedFeeChanges.some(automatedFeeControllerTransactionMayExist)) return false;
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const limit = await ctx.db
      .query("walletRateLimits")
      .withIndex("by_owner_x_user_id", (q) =>
        q.eq("ownerXUserId", args.xUserId),
      )
      .unique();
    if (limit?.day === day && limit.count > 0)
      await ctx.db.patch(limit._id, { count: limit.count - 1, updatedAt: now });
    await ctx.db.patch(request._id, { limitRefundedAt: now, updatedAt: now });
    return true;
  },
});

export const getWalletRequest = internalQuery({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) =>
    ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", requestId))
      .unique(),
});

export const prepareClaimWorkflow = internalMutation({
  args: { requestId: v.string(), tokenAddresses: v.array(v.string()) },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!request) throw new Error("claim request was not found");
    if (request.claimWorkflowJson) {
      return storedClaimWorkflow(request);
    }
    const tokenAddresses = [
      ...new Set(
        args.tokenAddresses
          .filter(safeAddress)
          .map((address) => address.toLowerCase()),
      ),
    ];
    await ctx.db.patch(request._id, {
      claimWorkflowJson: JSON.stringify(tokenAddresses),
      claimWorkflowCursor: 0,
      claimWorkflowVersion: LEGACY_CLAIM_VERSION,
      updatedAt: Date.now(),
    });
    return { tokenAddresses, cursor: 0 };
  },
});

export const advanceClaimWorkflow = internalMutation({
  args: { requestId: v.string(), expectedCursor: v.number() },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!request) throw new Error("claim request was not found");
    const { cursor, tokenAddresses } = storedClaimWorkflow(request);
    if (request.status !== "simulating" || request.transactionHash || request.diagnosticCode === LEGACY_CLAIM_SUPERSEDED)
      throw new Error("claim workflow is no longer active");
    if (cursor !== args.expectedCursor) return cursor;
    if (cursor >= tokenAddresses.length) return cursor;
    await ctx.db.patch(request._id, {
      claimWorkflowCursor: cursor + 1,
      updatedAt: Date.now(),
    });
    return cursor + 1;
  },
});

const launchRecordValidator = v.object({
  sourcePostId: v.optional(v.string()),
  ownerXUserId: v.string(),
  launcherUsername: v.optional(v.string()),
  launchMode: v.literal("pons"),
  name: v.string(),
  symbol: v.string(),
  imageUri: v.string(),
  devBuyWei: v.string(),
  description: v.optional(v.string()),
  website: v.optional(v.string()),
  twitter: v.optional(v.string()),
  telegram: v.optional(v.string()),
  pairToken: v.optional(v.string()),
  tokenAddress: v.optional(v.string()),
  normalizedTokenAddress: v.optional(v.string()),
  poolAddress: v.optional(v.string()),
  positionId: v.optional(v.string()),
  devBuySucceeded: v.optional(v.boolean()),
  creatorFeeRecipient: v.optional(v.string()),
  normalizedCreatorFeeRecipient: v.optional(v.string()),
  holderFeeSharing: v.optional(v.boolean()),
  holderFeeDistributor: v.optional(v.string()),
  holderFeeSharingStatus: v.optional(
    v.union(
      v.literal("pending"),
      v.literal("enabled"),
      v.literal("retrying"),
      v.literal("failed"),
    ),
  ),
  holderFeeSharingAttempts: v.optional(v.number()),
  holderFeeSharingLastError: v.optional(v.string()),
  holderFeeSharingNextAttemptAt: v.optional(v.number()),
});

export const recordPreparedExecution = internalMutation({
  args: {
    requestId: v.string(),
    walletId: v.id("cryptoWallets"),
    to: v.string(),
    valueWei: v.string(),
    callKind: v.string(),
    transactionHash: v.string(),
    signedTransaction: v.string(),
    launch: v.optional(launchRecordValidator),
    tradeOutputTokenAddress: v.optional(v.string()),
    tradeOutputBalanceBefore: v.optional(v.string()),
    involvedPairTokenAddress: v.optional(v.string()),
    feeReassignmentTokenAddress: v.optional(v.string()),
    feeReassignmentRecipientAddress: v.optional(v.string()),
    feeReassignmentUpdatesLaunch: v.optional(v.boolean()),
    claimIncludesOtherLaunches: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("walletTransactions")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!existing)
      await ctx.db.insert("walletTransactions", {
        requestId: args.requestId,
        walletId: args.walletId,
        chainId: ROBINHOOD_CHAIN_ID,
        to: args.to,
        valueWei: args.valueWei,
        callKind: args.callKind,
        transactionHash: args.transactionHash,
        signedTransaction: args.signedTransaction,
        tradeOutputTokenAddress: args.tradeOutputTokenAddress,
        tradeOutputBalanceBefore: args.tradeOutputBalanceBefore,
        involvedPairTokenAddress: args.involvedPairTokenAddress,
        feeReassignmentTokenAddress: args.feeReassignmentTokenAddress,
        feeReassignmentRecipientAddress: args.feeReassignmentRecipientAddress,
        feeReassignmentUpdatesLaunch: args.feeReassignmentUpdatesLaunch,
        claimIncludesOtherLaunches: args.claimIncludesOtherLaunches,
        status: "prepared",
        createdAt: now,
        updatedAt: now,
      });
    if (args.launch) {
      const launch = await ctx.db
        .query("tokenLaunches")
        .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
        .unique();
      if (!launch)
        await ctx.db.insert("tokenLaunches", {
          requestId: args.requestId,
          walletId: args.walletId,
          transactionHash: args.transactionHash,
          ...args.launch,
          ...(args.launch.tokenAddress
            ? { normalizedTokenAddress: args.launch.tokenAddress.toLowerCase() }
            : {}),
          createdAt: now,
          updatedAt: now,
        });
    }
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (request)
      await ctx.db.patch(request._id, {
        status: "prepared",
        transactionHash: args.transactionHash,
        reconciliationAttempts: 0,
        nextReconcileAt: now,
        updatedAt: now,
      });
  },
});

export const markTransactionBroadcast = internalMutation({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => {
    const now = Date.now();
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", requestId))
      .unique();
    if (request && request.status === "prepared")
      await ctx.db.patch(request._id, {
        status: "broadcast",
        nextReconcileAt: now + 15_000,
        updatedAt: now,
      });
    const transaction = await ctx.db
      .query("walletTransactions")
      .withIndex("by_request_id", (q) => q.eq("requestId", requestId))
      .unique();
    if (transaction && transaction.status === "prepared")
      await ctx.db.patch(transaction._id, {
        status: "broadcast",
        updatedAt: now,
      });
    await ctx.scheduler.runAfter(
      15_000,
      internal.wallets.reconcileTransaction,
      { requestId },
    );
  },
});

export const acquireWalletExecutionLock = internalMutation({
  args: {
    walletId: v.id("cryptoWallets"),
    requestId: v.string(),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const liquidityWork = (await Promise.all((["queued", "running", "reconciling", "manual_review"] as const).map(status => ctx.db.query("liquidityExecutions")
      .withIndex("by_wallet_status", q => q.eq("walletId", args.walletId).eq("status", status)).take(10)))).flat();
    if (liquidityWork.some(work => `liquidity:${work._id}` !== args.requestId &&
      (JSON.parse(work.stepsJson) as Array<{ confirmed?: boolean; reverted?: boolean }>).some(step => !step.confirmed && !step.reverted))) return false;
    const current = await ctx.db
      .query("walletExecutionLocks")
      .withIndex("by_wallet_id", (q) => q.eq("walletId", args.walletId))
      .unique();
    if (
      current &&
      current.leaseUntil > now &&
      (current.requestId !== args.requestId ||
        (current.leaseToken && current.leaseToken !== args.leaseToken))
    )
      return false;
    // An interrupted controller action stores its envelope outside
    // walletTransactions. Retain that nonce reservation even after its action
    // lease is released; only the original workflow may resume it.
    const wallet = await ctx.db.get(args.walletId);
    if (wallet) {
      const changes = (await Promise.all(
        (["prepared", "broadcast", "manual_review", "confirmed"] as const).map(status =>
          ctx.db.query("automatedFeeControllerChanges")
            .withIndex("by_owner_status", q => q.eq("ownerXUserId", wallet.ownerXUserId).eq("status", status))
            .filter(q => q.eq(q.field("workflowCompletedAt"), undefined)).take(26)),
      )).flat();
      if (changes.length > 25) return false;
      for (const change of changes) {
        if (change.requestId === args.requestId) continue;
        const userSteps = [change, ...await Promise.all(["pause", "exit"].map(step =>
          ctx.db.query("automatedFeeControllerChanges")
            .withIndex("by_request_id", q => q.eq("requestId", `${change.requestId}:${step}`)).unique()))];
        if (userSteps.some(step => step?.signedTransaction && !step.transactionSettledAt && step.status !== "confirmed")) return false;
      }
    }
    const value = {
      requestId: args.requestId,
      leaseToken: args.leaseToken,
      leaseUntil: now + 15 * 60_000,
      updatedAt: now,
    };
    if (current) await ctx.db.patch(current._id, value);
    else
      await ctx.db.insert("walletExecutionLocks", {
        walletId: args.walletId,
        ...value,
      });
    return true;
  },
});

export const releaseWalletExecutionLock = internalMutation({
  args: {
    walletId: v.id("cryptoWallets"),
    requestId: v.string(),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("walletExecutionLocks")
      .withIndex("by_wallet_id", (q) => q.eq("walletId", args.walletId))
      .unique();
    if (
      current?.requestId === args.requestId &&
      current.leaseToken === args.leaseToken
    )
      await ctx.db.delete(current._id);
  },
});

export const recordApprovalPrepared = internalMutation({
  args: {
    requestId: v.string(),
    walletId: v.id("cryptoWallets"),
    tokenAddress: v.string(),
    transactionHash: v.string(),
    signedTransaction: v.string(),
  },
  handler: async (ctx, args) => {
    const approvalRequestId = `${args.requestId}:approval`;
    const existing = await ctx.db
      .query("walletTransactions")
      .withIndex("by_request_id", (q) => q.eq("requestId", approvalRequestId))
      .unique();
    if (existing) return existing;
    const now = Date.now();
    const id = await ctx.db.insert("walletTransactions", {
      requestId: approvalRequestId,
      walletId: args.walletId,
      chainId: ROBINHOOD_CHAIN_ID,
      to: args.tokenAddress.toLowerCase(),
      valueWei: "0",
      callKind: "erc20_approval",
      transactionHash: args.transactionHash,
      signedTransaction: args.signedTransaction,
      status: "prepared",
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(id);
  },
});

export const updateApprovalStatus = internalMutation({
  args: {
    requestId: v.string(),
    status: v.union(
      v.literal("broadcast"),
      v.literal("confirmed"),
      v.literal("reverted"),
      v.literal("invalid"),
    ),
    blockNumber: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const transaction = await ctx.db
      .query("walletTransactions")
      .withIndex("by_request_id", (q) =>
        q.eq("requestId", `${args.requestId}:approval`),
      )
      .unique();
    if (transaction)
      await ctx.db.patch(transaction._id, {
        status: args.status,
        blockNumber: args.blockNumber,
        updatedAt: Date.now(),
      });
  },
});

export const resolveKnownToken = internalQuery({
  args: { identifier: v.string(), walletId: v.optional(v.id("cryptoWallets")) },
  handler: async (ctx, { identifier, walletId }) => {
    const normalized = identifier.replace(/^\$/, "").toLowerCase();
    if (safeAddress(normalized)) return normalizedRpcAddress(normalized);
    const registrySymbol = normalized === "btc" || normalized === "cbbtc"
      ? "cbBTC"
      : normalized.toUpperCase();
    const matches = new Set<string>();
    if (walletId) {
      const walletTokens = await ctx.db
        .query("walletTokenIndex")
        .withIndex("by_wallet", (q) => q.eq("walletId", walletId))
        .collect();
      for (const item of walletTokens) {
        if (isTokenIndexExcluded(item.tokenAddress)) continue;
        if (item.symbol.toLowerCase() !== normalized) continue;
        const launch = item.involvedByLaunch
          ? (
              await ctx.db
                .query("tokenLaunches")
                .withIndex("by_normalized_token_address", (q) =>
                  q.eq("normalizedTokenAddress", item.normalizedTokenAddress),
                )
                .collect()
            ).find((candidate) => candidate.publicPublished === true)
          : undefined;
        if (!item.involvedByLaunch || launch)
          addNormalizedAddressMatch(matches, item.tokenAddress);
      }
    }
    const registered = await ctx.db
      .query("tokenRegistry")
      .withIndex("by_symbol", (q) => q.eq("symbol", registrySymbol))
      .collect();
    for (const item of registered)
      if (item.active && !isTokenIndexExcluded(item.address)) addNormalizedAddressMatch(matches, item.address);
    const launches = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_symbol", (q) => q.eq("symbol", normalized.toUpperCase()))
      .take(100);
    for (const launch of launches)
      if (launch.publicPublished === true && launch.tokenAddress && !isTokenIndexExcluded(launch.tokenAddress))
        addNormalizedAddressMatch(matches, launch.tokenAddress);
    if (matches.size > 1)
      throw new Error(
        "that ticker matches more than one token; use the contract address",
      );
    return [...matches][0] || identifier;
  },
});

export const listKnownTokenMatches = internalQuery({
  args: { identifier: v.string(), walletId: v.optional(v.id("cryptoWallets")) },
  handler: async (ctx, { identifier, walletId }) => {
    const normalized = identifier.replace(/^\$/, "").toLowerCase();
    if (safeAddress(normalized)) return [normalizedRpcAddress(normalized)];
    const registrySymbol = normalized === "btc" || normalized === "cbbtc"
      ? "cbBTC"
      : normalized.toUpperCase();
    const matches = new Set<string>();
    if (walletId) {
      const walletTokens = await ctx.db
        .query("walletTokenIndex")
        .withIndex("by_wallet", (q) => q.eq("walletId", walletId))
        .collect();
      for (const item of walletTokens) {
        if (isTokenIndexExcluded(item.tokenAddress)) continue;
        if (item.symbol.toLowerCase() !== normalized) continue;
        const launch = item.involvedByLaunch
          ? (
              await ctx.db
                .query("tokenLaunches")
                .withIndex("by_normalized_token_address", (q) =>
                  q.eq("normalizedTokenAddress", item.normalizedTokenAddress),
                )
                .collect()
            ).find((candidate) => candidate.publicPublished === true)
          : undefined;
        if (!item.involvedByLaunch || launch)
          addNormalizedAddressMatch(matches, item.tokenAddress);
      }
    }
    const registered = await ctx.db
      .query("tokenRegistry")
      .withIndex("by_symbol", (q) => q.eq("symbol", registrySymbol))
      .collect();
    for (const item of registered)
      if (item.active && !isTokenIndexExcluded(item.address)) addNormalizedAddressMatch(matches, item.address);
    const launches = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_symbol", (q) => q.eq("symbol", normalized.toUpperCase()))
      .take(100);
    for (const launch of launches)
      if (launch.publicPublished === true && launch.tokenAddress && !isTokenIndexExcluded(launch.tokenAddress))
        addNormalizedAddressMatch(matches, launch.tokenAddress);
    return [...matches];
  },
});

export const listWalletTokenAddresses = internalQuery({
  args: { walletId: v.id("cryptoWallets") },
  handler: async (ctx, { walletId }) => {
    const tokens = await ctx.db
      .query("walletTokenIndex")
      .withIndex("by_wallet", (q) => q.eq("walletId", walletId))
      .collect();
    const visible: string[] = [];
    for (const item of tokens) {
      if (!item.involvedByLaunch) visible.push(item.tokenAddress);
      else {
        const launches = await ctx.db
          .query("tokenLaunches")
          .withIndex("by_normalized_token_address", (q) =>
            q.eq("normalizedTokenAddress", item.normalizedTokenAddress),
          )
          .collect();
        if (launches.some((launch) => launch.publicPublished === true))
          visible.push(item.tokenAddress);
      }
    }
    return visible;
  },
});

export const listOwnedLaunchTokens = internalQuery({
  args: { xUserId: v.string() },
  handler: async (ctx, { xUserId }) => {
    const wallet = await ctx.db
      .query("cryptoWallets")
      .withIndex("by_owner_x_user_id", (q) => q.eq("ownerXUserId", xUserId))
      .unique();
    const owned = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_owner_created_at", (q) => q.eq("ownerXUserId", xUserId))
      .collect();
    const beneficiary = wallet
      ? await ctx.db
          .query("tokenLaunches")
          .withIndex("by_creator_fee_recipient", (q) =>
            q.eq("normalizedCreatorFeeRecipient", wallet.address.toLowerCase()),
          )
          .collect()
      : [];
    const launches = [
      ...new Map(
        [...owned, ...beneficiary].map((launch) => [launch._id, launch]),
      ).values(),
    ].filter((launch) => launch.publicPublished === true);
    // Return broad candidates. Pair type and mutable creator-fee authority are
    // checked live on-chain by the signer when the claim plan is created.
    return launches.flatMap((launch) =>
      launch.tokenAddress &&
      !launch.holderFeeSharing
        ? [launch.tokenAddress]
        : [],
    );
  },
});

type TopFiveTarget = { tokenAddress: string; symbol: string; marketCapUsd: number };

export const currentTopFiveLaunchTokens = internalQuery({
  args: {},
  handler: async (ctx): Promise<TopFiveTarget[]> => {
    const launches = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_public_market_cap", (q) => q.eq("publicPublished", true))
      .order("desc")
      .take(30);
    const seen = new Set<string>();
    const targets: TopFiveTarget[] = [];
    for (const launch of launches) {
      if (!launch.tokenAddress || !safeAddress(launch.tokenAddress) || isTokenIndexExcluded(launch.tokenAddress)) continue;
      if (!Number.isFinite(launch.publicMarketCapUsd) || (launch.publicMarketCapUsd ?? 0) <= 0) continue;
      const normalized = launch.tokenAddress.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      targets.push({ tokenAddress: launch.tokenAddress, symbol: launch.symbol, marketCapUsd: launch.publicMarketCapUsd! });
      if (targets.length === 5) break;
    }
    return targets;
  },
});

export const prepareTopFiveWorkflow = internalMutation({
  args: { requestId: v.string(), targets: v.array(v.object({ tokenAddress: v.string(), symbol: v.string(), marketCapUsd: v.number() })) },
  handler: async (ctx, args): Promise<TopFiveTarget[]> => {
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", q => q.eq("requestId", args.requestId)).unique();
    if (!request || request.kind !== "buy_top_five") throw new Error("top-five request was not found");
    if (request.topFiveWorkflowJson) return JSON.parse(request.topFiveWorkflowJson) as TopFiveTarget[];
    if (args.targets.length !== 5) throw new Error("five eligible Pons Bot tokens were not available");
    const seen = new Set<string>();
    for (const target of args.targets) {
      if (!safeAddress(target.tokenAddress) || !/^[A-Za-z0-9]{1,32}$/.test(target.symbol) || !Number.isFinite(target.marketCapUsd) || target.marketCapUsd <= 0)
        throw new Error("top-five token snapshot was invalid");
      const normalized = target.tokenAddress.toLowerCase();
      if (seen.has(normalized)) throw new Error("top-five token snapshot contained a duplicate");
      seen.add(normalized);
    }
    await ctx.db.patch(request._id, { topFiveWorkflowJson: JSON.stringify(args.targets), updatedAt: Date.now() });
    return args.targets;
  },
});

export const creatorFeeClaimSourceSummary = internalQuery({
  args: { xUserId: v.string() },
  handler: async (ctx, { xUserId }) => {
    const wallet = await ctx.db
      .query("cryptoWallets")
      .withIndex("by_owner_x_user_id", q => q.eq("ownerXUserId", xUserId))
      .unique();
    const owned = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_owner_created_at", q => q.eq("ownerXUserId", xUserId))
      .collect();
    const beneficiary = wallet
      ? await ctx.db
          .query("tokenLaunches")
          .withIndex("by_creator_fee_recipient", q => q.eq("normalizedCreatorFeeRecipient", wallet.address.toLowerCase()))
          .collect()
      : [];
    return {
      hasLaunched: owned.some(launch => launch.publicPublished === true),
      hasCreatorFeeSource: [...owned, ...beneficiary].some(launch => launch.publicPublished === true && !launch.holderFeeSharing),
    };
  },
});

// Resolve a public launch independently of cached fee ownership. The upgrade
// workflow and signer verify the current on-chain recipient before any change.
export const resolveLaunchForFeeUpgrade = internalQuery({
  args: { identifier: v.string() },
  handler: async (ctx, { identifier }) => {
    const normalized = identifier.replace(/^\$/, "").toLowerCase();
    const candidates = safeAddress(normalized)
      ? await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", normalized)).take(101)
      : await ctx.db.query("tokenLaunches").withIndex("by_symbol", (q) => q.eq("symbol", normalized.toUpperCase())).take(101);
    const matches = [...new Map(candidates.filter((launch) => launch.publicPublished === true && launch.tokenAddress && !isTokenIndexExcluded(launch.tokenAddress))
      .map((launch) => [launch.tokenAddress!.toLowerCase(), launch])).values()];
    if (candidates.length === 101 || matches.length > 1) return { status: "ambiguous" as const };
    if (!matches.length) return { status: "not_found" as const };
    const launch = matches[0];
    return { status: "ok" as const, tokenAddress: launch.tokenAddress!, launchId: launch._id,
      pairTokenAddress: launch.pairToken || "0x0000000000000000000000000000000000000000" };
  },
});

export const resolveOwnedLaunchForFeeReassignment = internalQuery({
  args: { xUserId: v.string(), identifier: v.string() },
  handler: async (ctx, args) => {
    const wallet = await ctx.db
      .query("cryptoWallets")
      .withIndex("by_owner_x_user_id", (q) =>
        q.eq("ownerXUserId", args.xUserId),
      )
      .unique();
    if (!wallet) return { status: "unauthorized" as const };
    const normalizedWallet = wallet.address.toLowerCase();
    const [beneficiaryLaunches, controlledPrograms] = await Promise.all([
      ctx.db
        .query("tokenLaunches")
        .withIndex("by_creator_fee_recipient", (q) =>
          q.eq("normalizedCreatorFeeRecipient", normalizedWallet),
        )
        .collect(),
      ctx.db
        .query("automatedFeePrograms")
        .withIndex("by_controller", (q) =>
          q.eq("normalizedControllerAddress", normalizedWallet),
        )
        .collect(),
    ]);
    const controlledLaunches = await Promise.all(
      controlledPrograms
        .filter((program) => program.status !== "exited")
        .map((program) => program.launchId ? ctx.db.get(program.launchId) : null),
    );
    const owned = [
      ...new Map(
        [...beneficiaryLaunches, ...controlledLaunches]
          .filter(
            (launch): launch is NonNullable<typeof launch> =>
              Boolean(
                launch?.publicPublished === true && launch.tokenAddress,
              ),
          )
          .map((launch) => [launch._id, launch]),
      ).values(),
    ];
    const normalized = args.identifier.replace(/^\$/, "").toLowerCase();
    const matches = safeAddress(args.identifier)
      ? owned.filter(
          (launch) =>
            launch.tokenAddress!.toLowerCase() ===
            args.identifier.toLowerCase(),
        )
      : owned.filter((launch) => launch.symbol.toLowerCase() === normalized);
    if (matches.length === 0) return { status: "unauthorized" as const };
    if (matches.length > 1) return { status: "ambiguous" as const };
    const launch = matches[0];
    return {
      status: "ok" as const,
      tokenAddress: launch.tokenAddress!,
      launchId: launch._id,
      controllerAddress: wallet.address,
      pairTokenAddress:
        launch.pairToken || "0x0000000000000000000000000000000000000000",
    };
  },
});

export const recordAutomatedFeeUpgradeOutcome = internalMutation({
  args: {
    launchId: v.id("tokenLaunches"),
    programId: v.id("automatedFeePrograms"),
    assignmentTransactionHash: v.string(),
  },
  handler: async (ctx, args) => {
    const [launch, program] = await Promise.all([
      ctx.db.get(args.launchId),
      ctx.db.get(args.programId),
    ]);
    if (!launch || !program || program.launchId !== launch._id || program.status !== "enrolled"
      || program.enrollmentSource !== "upgrade"
      || program.enrollmentTransactionHash?.toLowerCase() !== args.assignmentTransactionHash.toLowerCase()) {
      throw new Error("verified automated fee upgrade outcome was not found");
    }
    await recordVerifiedFeeOutcome(ctx, program, launch, "upgrade", args.assignmentTransactionHash);
  },
});

export const claimMayIncludeOtherLaunches = internalQuery({
  args: { xUserId: v.string(), tokenAddress: v.string() },
  handler: async (ctx, args) => {
    const target = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_normalized_token_address", (q) =>
        q.eq("normalizedTokenAddress", args.tokenAddress.toLowerCase()),
      )
      .unique();
    const wallet = await ctx.db
      .query("cryptoWallets")
      .withIndex("by_owner_x_user_id", (q) =>
        q.eq("ownerXUserId", args.xUserId),
      )
      .unique();
    if (!target || !wallet) return false;
    const pair = (
      target.pairToken || "0x0000000000000000000000000000000000000000"
    ).toLowerCase();
    const owned = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_owner_created_at", (q) =>
        q.eq("ownerXUserId", args.xUserId),
      )
      .collect();
    const beneficiary = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_creator_fee_recipient", (q) =>
        q.eq("normalizedCreatorFeeRecipient", wallet.address.toLowerCase()),
      )
      .collect();
    return [
      ...new Map(
        [...owned, ...beneficiary].map((launch) => [launch._id, launch]),
      ).values(),
    ].some(
      (launch) =>
        launch.publicPublished === true &&
        launch.tokenAddress?.toLowerCase() !==
          args.tokenAddress.toLowerCase() &&
        (
          launch.pairToken || "0x0000000000000000000000000000000000000000"
        ).toLowerCase() === pair,
    );
  },
});

export const indexWalletToken = internalMutation({
  args: {
    walletId: v.id("cryptoWallets"),
    tokenAddress: v.string(),
    symbol: v.string(),
    involvedByLaunch: v.boolean(),
    involvedByTransaction: v.boolean(),
  },
  handler: async (ctx, args) => {
    const normalizedTokenAddress = args.tokenAddress.toLowerCase();
    if (isTokenIndexExcluded(normalizedTokenAddress)) return;
    const existing = await ctx.db
      .query("walletTokenIndex")
      .withIndex("by_wallet_token", (q) =>
        q
          .eq("walletId", args.walletId)
          .eq("normalizedTokenAddress", normalizedTokenAddress),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        symbol: args.symbol.toUpperCase(),
        involvedByLaunch: existing.involvedByLaunch || args.involvedByLaunch,
        involvedByTransaction:
          existing.involvedByTransaction || args.involvedByTransaction,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("walletTokenIndex", {
        walletId: args.walletId,
        tokenAddress: args.tokenAddress,
        normalizedTokenAddress,
        symbol: args.symbol.toUpperCase(),
        involvedByLaunch: args.involvedByLaunch,
        involvedByTransaction: args.involvedByTransaction,
        createdAt: now,
        updatedAt: now,
      });
    }
  },
});

export const recordBroadcastExecution = internalMutation({
  args: {
    requestId: v.string(),
    walletId: v.id("cryptoWallets"),
    to: v.string(),
    valueWei: v.string(),
    callKind: v.string(),
    transactionHash: v.string(),
    launch: v.optional(launchRecordValidator),
    tradeOutputTokenAddress: v.optional(v.string()),
    tradeOutputBalanceBefore: v.optional(v.string()),
    involvedPairTokenAddress: v.optional(v.string()),
    feeReassignmentTokenAddress: v.optional(v.string()),
    feeReassignmentRecipientAddress: v.optional(v.string()),
    feeReassignmentUpdatesLaunch: v.optional(v.boolean()),
    claimIncludesOtherLaunches: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("walletTransactions")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!existing)
      await ctx.db.insert("walletTransactions", {
        requestId: args.requestId,
        walletId: args.walletId,
        chainId: ROBINHOOD_CHAIN_ID,
        to: args.to,
        valueWei: args.valueWei,
        callKind: args.callKind,
        transactionHash: args.transactionHash,
        status: "broadcast",
        tradeOutputTokenAddress: args.tradeOutputTokenAddress,
        tradeOutputBalanceBefore: args.tradeOutputBalanceBefore,
        involvedPairTokenAddress: args.involvedPairTokenAddress,
        createdAt: now,
        updatedAt: now,
        feeReassignmentTokenAddress: args.feeReassignmentTokenAddress,
        feeReassignmentRecipientAddress: args.feeReassignmentRecipientAddress,
        feeReassignmentUpdatesLaunch: args.feeReassignmentUpdatesLaunch,
        claimIncludesOtherLaunches: args.claimIncludesOtherLaunches,
      });
    if (args.launch) {
      const launch = await ctx.db
        .query("tokenLaunches")
        .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
        .unique();
      if (!launch)
        await ctx.db.insert("tokenLaunches", {
          requestId: args.requestId,
          walletId: args.walletId,
          transactionHash: args.transactionHash,
          ...args.launch,
          ...(args.launch.tokenAddress
            ? { normalizedTokenAddress: args.launch.tokenAddress.toLowerCase() }
            : {}),
          createdAt: now,
          updatedAt: now,
        });
    }
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (request)
      await ctx.db.patch(request._id, {
        status: "broadcast",
        transactionHash: args.transactionHash,
        reconciliationAttempts: 0,
        nextReconcileAt: now + 15_000,
        safeError: undefined,
        updatedAt: now,
      });
    await ctx.scheduler.runAfter(
      15_000,
      internal.wallets.reconcileTransaction,
      { requestId: args.requestId },
    );
  },
});

export const recordConfirmedExecution = internalMutation({
  args: {
    requestId: v.string(),
    walletId: v.id("cryptoWallets"),
    to: v.string(),
    valueWei: v.string(),
    callKind: v.string(),
    transactionHash: v.string(),
    blockNumber: v.optional(v.string()),
    claimedDisplay: v.optional(v.string()),
    tradeOutputDisplay: v.optional(v.string()),
    tradeOutputTokenAddress: v.optional(v.string()),
    tradeOutputBalanceBefore: v.optional(v.string()),
    involvedPairTokenAddress: v.optional(v.string()),
    feeReassignmentTokenAddress: v.optional(v.string()),
    feeReassignmentRecipientAddress: v.optional(v.string()),
    feeReassignmentUpdatesLaunch: v.optional(v.boolean()),
    claimIncludesOtherLaunches: v.optional(v.boolean()),
    launch: v.optional(launchRecordValidator),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("walletTransactions")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    const now = Date.now();
    const newlyConfirmed = existing?.status !== "confirmed";
    if (!existing)
      await ctx.db.insert("walletTransactions", {
        requestId: args.requestId,
        walletId: args.walletId,
        chainId: ROBINHOOD_CHAIN_ID,
        to: args.to,
        valueWei: args.valueWei,
        callKind: args.callKind,
        transactionHash: args.transactionHash,
        status: "confirmed",
        blockNumber: args.blockNumber,
        claimedDisplay: args.claimedDisplay,
        tradeOutputDisplay: args.tradeOutputDisplay,
        tradeOutputTokenAddress: args.tradeOutputTokenAddress,
        tradeOutputBalanceBefore: args.tradeOutputBalanceBefore,
        involvedPairTokenAddress: args.involvedPairTokenAddress,
        feeReassignmentTokenAddress: args.feeReassignmentTokenAddress,
        feeReassignmentRecipientAddress: args.feeReassignmentRecipientAddress,
        feeReassignmentUpdatesLaunch: args.feeReassignmentUpdatesLaunch,
        claimIncludesOtherLaunches: args.claimIncludesOtherLaunches,
        createdAt: now,
        updatedAt: now,
      });
    else
      await ctx.db.patch(existing._id, {
        status: "confirmed",
        blockNumber: args.blockNumber,
        claimedDisplay: args.claimedDisplay,
        tradeOutputDisplay: args.tradeOutputDisplay,
        tradeOutputTokenAddress:
          args.tradeOutputTokenAddress || existing.tradeOutputTokenAddress,
        tradeOutputBalanceBefore:
          args.tradeOutputBalanceBefore || existing.tradeOutputBalanceBefore,
        involvedPairTokenAddress:
          args.involvedPairTokenAddress || existing.involvedPairTokenAddress,
        updatedAt: now,
        feeReassignmentTokenAddress:
          args.feeReassignmentTokenAddress ||
          existing.feeReassignmentTokenAddress,
        feeReassignmentRecipientAddress:
          args.feeReassignmentRecipientAddress ||
          existing.feeReassignmentRecipientAddress,
        feeReassignmentUpdatesLaunch:
          args.feeReassignmentUpdatesLaunch ??
          existing.feeReassignmentUpdatesLaunch,
        claimIncludesOtherLaunches:
          args.claimIncludesOtherLaunches ??
          existing.claimIncludesOtherLaunches,
      });
    if (args.launch) {
      const launchWallet = await ctx.db.get(args.walletId);
      const launchPair = args.launch.pairToken
        ? await ctx.db
            .query("tokenRegistry")
            .withIndex("by_normalized_address", (q) =>
              q.eq("normalizedAddress", args.launch!.pairToken!.toLowerCase()),
            )
            .unique()
        : null;
      const publicFields = {
        creatorAddress: launchWallet?.address,
        pairSymbol:
          args.launch.pairToken === "0x0000000000000000000000000000000000000000"
            ? "ETH"
            : launchPair?.symbol,
      };
      const launch = await ctx.db
        .query("tokenLaunches")
        .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
        .unique();
      const newlyPublishedLaunch = Boolean(args.launch.tokenAddress) && launch?.publicPublished !== true;
      if (!launch)
        await ctx.db.insert("tokenLaunches", {
          requestId: args.requestId,
          walletId: args.walletId,
          transactionHash: args.transactionHash,
          ...args.launch,
          ...publicFields,
          ...(args.launch.tokenAddress
            ? {
                normalizedTokenAddress: args.launch.tokenAddress.toLowerCase(),
                publicPublished: true,
                graduationAnnouncementStatus: "monitoring" as const,
                graduationMonitorNextCheckAt: now,
              }
            : {}),
          createdAt: now,
          updatedAt: now,
        });
      if (launch)
        await ctx.db.patch(launch._id, {
          ...args.launch,
          ...publicFields,
          ...(args.launch.tokenAddress
            ? {
                normalizedTokenAddress: args.launch.tokenAddress.toLowerCase(),
                publicPublished: true,
                ...(launch.graduationAnnouncementStatus
                  ? {}
                  : { graduationAnnouncementStatus: "monitoring" as const }),
                ...(launch.graduationMonitorNextCheckAt === undefined
                  ? { graduationMonitorNextCheckAt: now }
                  : {}),
              }
            : {}),
          updatedAt: now,
        });
      if (newlyPublishedLaunch) {
        const stats = await ctx.db.query("platformStatsCache").withIndex("by_key", (q) => q.eq("key", "public")).unique();
        if (stats) await ctx.db.patch(stats._id, { launches: stats.launches + 1, computedAt: now });
      }
      if (args.launch.holderFeeSharing && args.launch.tokenAddress) {
        await ctx.scheduler.runAfter(
          30_000,
          internal.wallets.resumeHolderFeeSharing,
          { requestId: args.requestId },
        );
      }
      if (args.launch.tokenAddress) {
        await ctx.scheduler.runAfter(0, internal.automatedFeeEngine.bindAndDeployNewLaunch, {
          requestId: args.requestId,
        });
        const normalizedTokenAddress = args.launch.tokenAddress.toLowerCase();
        const indexed = isTokenIndexExcluded(normalizedTokenAddress) ? null : await ctx.db
          .query("walletTokenIndex")
          .withIndex("by_wallet_token", (q) =>
            q
              .eq("walletId", args.walletId)
              .eq("normalizedTokenAddress", normalizedTokenAddress),
          )
          .unique();
        if (indexed) {
          await ctx.db.patch(indexed._id, {
            symbol: args.launch.symbol.toUpperCase(),
            involvedByLaunch: true,
            involvedByTransaction:
              indexed.involvedByTransaction || args.launch.devBuyWei !== "0",
            updatedAt: now,
          });
        } else if (!isTokenIndexExcluded(normalizedTokenAddress)) {
          await ctx.db.insert("walletTokenIndex", {
            walletId: args.walletId,
            tokenAddress: args.launch.tokenAddress,
            normalizedTokenAddress,
            symbol: args.launch.symbol.toUpperCase(),
            involvedByLaunch: true,
            involvedByTransaction: args.launch.devBuyWei !== "0",
            createdAt: now,
            updatedAt: now,
          });
        }
        const user = await ctx.db
          .query("xReplyUsers")
          .withIndex("by_x_user_id", (q) =>
            q.eq("xUserId", args.launch!.ownerXUserId),
          )
          .unique();
        if (user && !user.hasSuccessfulLaunch) {
          await ctx.db.patch(user._id, {
            hasSuccessfulLaunch: true,
            firstSuccessfulLaunchAt: user.firstSuccessfulLaunchAt || now,
            updatedAt: now,
          });
        }
        const freeLaunch = await ctx.db
          .query("freeLaunchRedemptions")
          .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
          .unique();
        if (freeLaunch?.status === "funded") {
          await ctx.db.patch(freeLaunch._id, {
            status: "completed",
            launchTransactionHash: args.transactionHash,
            updatedAt: now,
          });
          const campaign = await ctx.db
            .query("freeLaunchCampaigns")
            .withIndex("by_key", (q) => q.eq("key", "automatic"))
            .unique();
          if (campaign) await ctx.db.patch(campaign._id, {
            completedLaunches: campaign.completedLaunches + 1,
            updatedAt: now,
          });
        }
      }
    }
    if (newlyConfirmed && args.callKind === "pons_v2_claim_fees" && args.claimedDisplay) {
      // Accounting is independent of execution and never fetches prices here.
      await ctx.scheduler.runAfter(1_000, internal.creatorFeeHistory.recordLegacyClaim, { requestId: args.requestId });
    }
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    const reassignmentToken =
      args.feeReassignmentTokenAddress || existing?.feeReassignmentTokenAddress;
    const reassignmentRecipient =
      args.feeReassignmentRecipientAddress ||
      existing?.feeReassignmentRecipientAddress;
    const updatesReassignmentLaunch =
      args.feeReassignmentUpdatesLaunch ??
      existing?.feeReassignmentUpdatesLaunch;
    if (
      args.callKind === "pons_v2_transfer_creator_fee_recipient" &&
      updatesReassignmentLaunch &&
      reassignmentToken &&
      reassignmentRecipient
    ) {
      const launches = await ctx.db
        .query("tokenLaunches")
        .withIndex("by_normalized_token_address", (q) =>
          q.eq("normalizedTokenAddress", reassignmentToken.toLowerCase()),
        )
        .collect();
      const requestWallet = request
        ? await ctx.db
            .query("cryptoWallets")
            .withIndex("by_owner_x_user_id", (q) =>
              q.eq("ownerXUserId", request.ownerXUserId),
            )
            .unique()
        : null;
      const normalizedRequestWallet = requestWallet?.address.toLowerCase();
      const reassignedLaunch = launches.find(
        (item) =>
          item.publicPublished === true &&
          normalizedRequestWallet !== undefined &&
          item.normalizedCreatorFeeRecipient === normalizedRequestWallet,
      );
      if (!reassignedLaunch)
        throw new Error(
          "fee reassignment rights were not found during confirmation",
        );
      await ctx.db.patch(reassignedLaunch._id, {
        creatorFeeRecipient: reassignmentRecipient,
        normalizedCreatorFeeRecipient: reassignmentRecipient.toLowerCase(),
        holderFeeSharing: false,
        holderFeeDistributor: undefined,
        holderFeeSharingStatus: undefined,
        holderFeeSharingAttempts: undefined,
        holderFeeSharingLastError: undefined,
        holderFeeSharingNextAttemptAt: undefined,
        feesReassignedAt: now,
        feeReassignmentTransactionHash: args.transactionHash,
        updatedAt: now,
      });
    }
    if (request)
      await ctx.db.patch(request._id, {
        status: "confirmed",
        transactionHash: args.transactionHash,
        nextReconcileAt: undefined,
        updatedAt: now,
      });
  },
});

export const getReconciliationContext = internalQuery({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => {
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", requestId))
      .unique();
    if (!request) return null;
    const wallet = await ctx.db.get(request.walletId);
    const transaction = await ctx.db
      .query("walletTransactions")
      .withIndex("by_request_id", (q) => q.eq("requestId", requestId))
      .unique();
    const launch = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_request_id", (q) => q.eq("requestId", requestId))
      .unique();
    const related = await ctx.db
      .query("walletRequests")
      .withIndex("by_source_post_id", (q) =>
        q.eq("sourcePostId", request.sourcePostId),
      )
      .collect();
    const failedParent = related.find(
      (item) =>
        item.requestId !== requestId &&
        requestId.startsWith(`${item.requestId}:`) &&
        (item.status === "failed" || item.status === "rejected"),
    );
    return {
      request,
      wallet,
      transaction,
      launch,
      failedParent: failedParent || null,
    };
  },
});

export const cancelPreparedExecution = internalMutation({
  args: {
    requestId: v.string(),
    diagnosticCode: v.string(),
    diagnosticDetail: v.optional(v.string()),
    safeError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    const transaction = await ctx.db
      .query("walletTransactions")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (transaction?.status === "prepared")
      await ctx.db.patch(transaction._id, {
        status: "invalid",
        signedTransaction: undefined,
        updatedAt: now,
      });
    if (request && request.status !== "confirmed")
      await ctx.db.patch(request._id, {
        status: "failed",
        nextReconcileAt: undefined,
        reconciliationAttempts: request.reconciliationAttempts,
        diagnosticCode: args.diagnosticCode,
        diagnosticDetail: args.diagnosticDetail?.slice(0, 500),
        ...(args.safeError ? { safeError: args.safeError.slice(0, 240) } : {}),
        updatedAt: now,
      });
    const launch = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (launch && launch.publicPublished !== true)
      await ctx.db.patch(launch._id, {
        publicPublished: false,
        graduationAnnouncementStatus: "ignored",
        graduationAnnouncementNextAttemptAt: undefined,
        graduationMonitorNextCheckAt: undefined,
        updatedAt: now,
      });
    if (request) {
      const lock = await ctx.db
        .query("walletExecutionLocks")
        .withIndex("by_wallet_id", (q) => q.eq("walletId", request.walletId))
        .unique();
      if (
        lock &&
        (lock.requestId === request.requestId ||
          lock.requestId.startsWith(`${request.requestId}:`))
      )
        await ctx.db.delete(lock._id);
    }
    return Boolean(request || transaction);
  },
});

export const cancelLegacyPreparedExecutions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("walletTransactions")
      .withIndex("by_status_created_at", (q) =>
        q
          .eq("status", "prepared")
          .lte("createdAt", LEGACY_PREPARED_CANCELLATION_CUTOFF_MS),
      )
      .take(100);
    let cancelled = 0;
    for (const transaction of rows) {
      const request = await ctx.db
        .query("walletRequests")
        .withIndex("by_request_id", (q) =>
          q.eq("requestId", transaction.requestId),
        )
        .unique();
      await ctx.db.patch(transaction._id, {
        status: "invalid",
        signedTransaction: undefined,
        updatedAt: Date.now(),
      });
      if (request && request.status !== "confirmed")
        await ctx.db.patch(request._id, {
          status: "failed",
          nextReconcileAt: undefined,
          diagnosticCode: "PREEXISTING_PREPARED_CANCELLED",
          diagnosticDetail:
            "Prepared before RPC failover deployment; cancelled without publication",
          updatedAt: Date.now(),
        });
      const launch = await ctx.db
        .query("tokenLaunches")
        .withIndex("by_request_id", (q) =>
          q.eq("requestId", transaction.requestId),
        )
        .unique();
      if (launch && launch.publicPublished !== true)
        await ctx.db.patch(launch._id, {
          publicPublished: false,
          graduationAnnouncementStatus: "ignored",
          graduationAnnouncementNextAttemptAt: undefined,
          graduationMonitorNextCheckAt: undefined,
          updatedAt: Date.now(),
        });
      if (request) {
        const lock = await ctx.db
          .query("walletExecutionLocks")
          .withIndex("by_wallet_id", (q) => q.eq("walletId", request.walletId))
          .unique();
        if (
          lock &&
          (lock.requestId === request.requestId ||
            lock.requestId.startsWith(`${request.requestId}:`))
        )
          await ctx.db.delete(lock._id);
      }
      cancelled += 1;
    }
    return { cancelled, remaining: rows.length === 100 };
  },
});

export const deferReconciliation = internalMutation({
  args: { requestId: v.string(), attempt: v.number() },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (
      !request ||
      (request.status !== "prepared" && request.status !== "broadcast")
    )
      return;
    if (args.attempt >= MAX_RECONCILIATION_ATTEMPTS) {
      await ctx.db.patch(request._id, {
        status: "failed",
        safeError: "transaction status requires manual review",
        diagnosticCode: "RECONCILIATION_EXHAUSTED",
        diagnosticDetail:
          "Maximum confirmation attempts reached; transaction disabled",
        reconciliationAttempts: args.attempt,
        nextReconcileAt: undefined,
        updatedAt: Date.now(),
      });
      const transaction = await ctx.db
        .query("walletTransactions")
        .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
        .unique();
      if (transaction?.status === "prepared")
        await ctx.db.patch(transaction._id, {
          status: "invalid",
          signedTransaction: undefined,
          updatedAt: Date.now(),
        });
      const launch = await ctx.db
        .query("tokenLaunches")
        .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
        .unique();
      if (launch && launch.publicPublished !== true)
        await ctx.db.patch(launch._id, {
          publicPublished: false,
          graduationAnnouncementStatus: "ignored",
          graduationMonitorNextCheckAt: undefined,
          updatedAt: Date.now(),
        });
      return;
    }
    const delay = Math.min(
      15 * 60_000,
      15_000 * 2 ** Math.min(args.attempt, 6),
    );
    await ctx.db.patch(request._id, {
      reconciliationAttempts: args.attempt,
      nextReconcileAt: Date.now() + delay,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(delay, internal.wallets.reconcileTransaction, {
      requestId: args.requestId,
    });
  },
});

export const recordRevertedExecution = internalMutation({
  args: { requestId: v.string(), blockNumber: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (request)
      await ctx.db.patch(request._id, {
        status: "failed",
        safeError: "transaction reverted",
        nextReconcileAt: undefined,
        updatedAt: now,
      });
    const transaction = await ctx.db
      .query("walletTransactions")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (transaction)
      await ctx.db.patch(transaction._id, {
        status: "reverted",
        blockNumber: args.blockNumber,
        updatedAt: now,
      });
  },
});

export const deferHolderFeeSharing = internalMutation({
  args: { requestId: v.string(), safeError: v.string() },
  handler: async (ctx, args) => {
    const launch = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!launch || !launch.holderFeeSharing || launch.holderFeeDistributor)
      return;
    const attempts = (launch.holderFeeSharingAttempts || 0) + 1;
    if (attempts >= 8) {
      await ctx.db.patch(launch._id, {
        holderFeeSharingStatus: "failed",
        holderFeeSharingAttempts: attempts,
        holderFeeSharingLastError: args.safeError.slice(0, 240),
        holderFeeSharingNextAttemptAt: undefined,
        updatedAt: Date.now(),
      });
      return;
    }
    const delay = Math.min(
      15 * 60_000,
      30_000 * 2 ** Math.max(0, attempts - 1),
    );
    await ctx.db.patch(launch._id, {
      holderFeeSharingStatus: "retrying",
      holderFeeSharingAttempts: attempts,
      holderFeeSharingLastError: args.safeError.slice(0, 240),
      holderFeeSharingNextAttemptAt: Date.now() + delay,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      delay,
      internal.wallets.resumeHolderFeeSharing,
      { requestId: args.requestId },
    );
  },
});

export const resumeHolderFeeSharing = internalAction({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => {
    const current = await ctx.runQuery(
      internal.wallets.getReconciliationContext,
      { requestId },
    );
    if (
      !current?.wallet ||
      !current.launch?.tokenAddress ||
      !current.launch.holderFeeSharing ||
      current.launch.holderFeeDistributor
    )
      return;
    const lockRequestId = `${requestId}:holder-resume:${Date.now()}`;
    const leaseToken = crypto.randomUUID();
    const locked = await ctx.runMutation(
      internal.wallets.acquireWalletExecutionLock,
      { walletId: current.wallet._id, requestId: lockRequestId, leaseToken },
    );
    if (!locked) {
      await ctx.runMutation(internal.wallets.deferHolderFeeSharing, {
        requestId,
        safeError: "wallet is busy with another transaction",
      });
      return;
    }
    try {
      const registry = await ctx.runQuery(internal.registry.runtimeConfig, {});
      const command: Extract<WalletCommand, { kind: "launch" }> = {
        kind: "launch",
        launchMode: "pons",
        name: current.launch.name,
        symbol: current.launch.symbol,
        holderFeeSharing: true,
      };
      await enableHolderFeeSharing(
        ctx,
        current.wallet,
        current.launch.ownerXUserId,
        current.request.sourcePostId,
        requestId,
        command,
        current.launch.tokenAddress,
        registry,
      );
    } catch (error) {
      await ctx.runMutation(internal.wallets.deferHolderFeeSharing, {
        requestId,
        safeError:
          error instanceof Error
            ? error.message
            : "holder fee sharing recovery failed",
      });
    } finally {
      await ctx.runMutation(internal.wallets.releaseWalletExecutionLock, {
        walletId: current.wallet._id,
        requestId: lockRequestId,
        leaseToken,
      });
    }
  },
});

export const recordHolderFeeDistributor = internalMutation({
  args: { requestId: v.string(), distributor: v.string() },
  handler: async (ctx, args) => {
    const launch = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (launch) {
      const now = Date.now();
      await ctx.db.patch(launch._id, {
        holderFeeSharing: true,
        holderFeeDistributor: args.distributor,
        creatorFeeRecipient: args.distributor,
        normalizedCreatorFeeRecipient: args.distributor.toLowerCase(),
        holderFeeSharingStatus: "enabled",
        holderFeeSharingLastError: undefined,
        holderFeeSharingNextAttemptAt: undefined,
        updatedAt: now,
      });
      if (launch.tokenAddress) {
        const token = launch.tokenAddress.toLowerCase();
        const [program, reservation] = await Promise.all([
          ctx.db.query("automatedFeePrograms").withIndex("by_token", (q) => q.eq("normalizedTokenAddress", token)).unique(),
          ctx.db.query("automatedFeeEnrollmentReservations").withIndex("by_predicted_token", (q) => q.eq("normalizedPredictedTokenAddress", token)).unique(),
        ]);
        if (program && program.status !== "exited") await ctx.db.patch(program._id, {
          status: "exited",
          nextProcessAt: undefined,
          flywheelExemptionReason: "holder_fee_sharing",
          exemptedAt: now,
          updatedAt: now,
        });
        if (reservation?.status === "reserved") await ctx.db.patch(reservation._id, {
          status: "cancelled",
          updatedAt: now,
        });
      }
    }
  },
});

export const recordReassignedHolderFeeDistributor = internalMutation({
  args: {
    ownerXUserId: v.string(),
    controllerAddress: v.string(),
    tokenAddress: v.string(),
    distributor: v.string(),
    transactionHash: v.string(),
  },
  handler: async (ctx, args) => {
    const launch = await ctx.db
      .query("tokenLaunches")
      .withIndex("by_normalized_token_address", (q) =>
        q.eq("normalizedTokenAddress", args.tokenAddress.toLowerCase()),
      )
      .unique();
    if (
      !launch ||
      launch.normalizedCreatorFeeRecipient !==
        args.controllerAddress.toLowerCase() ||
      launch.publicPublished !== true
    ) {
      throw new Error("fee reassignment rights were not found");
    }
    const now = Date.now();
    await ctx.db.patch(launch._id, {
      holderFeeSharing: true,
      holderFeeDistributor: args.distributor,
      creatorFeeRecipient: args.distributor,
      normalizedCreatorFeeRecipient: args.distributor.toLowerCase(),
      holderFeeSharingStatus: "enabled",
      holderFeeSharingLastError: undefined,
      holderFeeSharingNextAttemptAt: undefined,
      feesReassignedAt: now,
      feeReassignmentTransactionHash: args.transactionHash,
      updatedAt: now,
    });
    const token = args.tokenAddress.toLowerCase();
    const [program, reservation] = await Promise.all([
      ctx.db.query("automatedFeePrograms").withIndex("by_token", (q) => q.eq("normalizedTokenAddress", token)).unique(),
      ctx.db.query("automatedFeeEnrollmentReservations").withIndex("by_predicted_token", (q) => q.eq("normalizedPredictedTokenAddress", token)).unique(),
    ]);
    if (program && program.status !== "exited") await ctx.db.patch(program._id, {
      status: "exited",
      nextProcessAt: undefined,
      flywheelExemptionReason: "holder_fee_sharing",
      exemptedAt: now,
      updatedAt: now,
    });
    if (reservation?.status === "reserved") await ctx.db.patch(reservation._id, {
      status: "cancelled",
      updatedAt: now,
    });
  },
});

export const recordAutomatedFeeControllerOutcome = internalMutation({
  args: {
    tokenAddress: v.string(), transactionHash: v.string(),
    outcome: v.union(v.literal("reassigned"), v.literal("holders")), recipient: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedToken = args.tokenAddress.toLowerCase();
    const normalizedRecipient = args.recipient.toLowerCase();
    const [program, launch] = await Promise.all([
      ctx.db.query("automatedFeePrograms").withIndex("by_token", (q) => q.eq("normalizedTokenAddress", normalizedToken)).unique(),
      ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", normalizedToken)).unique(),
    ]);
    if (!program || !launch || program.lastControllerChangeTransactionHash !== args.transactionHash.toLowerCase()) {
      throw new Error("verified automated fee controller outcome was not found");
    }
    if (args.outcome === "reassigned") {
      if (program.status !== "enrolled" || program.normalizedControllerAddress !== normalizedRecipient
        || program.normalizedBeneficiaryAddress !== normalizedRecipient) {
        throw new Error("automated fee reassignment state mismatch");
      }
      await recordVerifiedFeeOutcome(ctx, program, launch, "reassign", args.transactionHash);
      return;
    }
    if (program.status !== "exited" || program.distributionMode !== "holders") {
      throw new Error("automated holder fee-sharing state mismatch");
    }
    await recordVerifiedFeeOutcome(ctx, program, launch, "holders", args.transactionHash);
  },
});

export const recordInvalidReceipt = internalMutation({
  args: { requestId: v.string(), safeError: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    const transaction = await ctx.db
      .query("walletTransactions")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (request)
      await ctx.db.patch(request._id, {
        status: "failed",
        safeError: args.safeError,
        nextReconcileAt: undefined,
        updatedAt: now,
      });
    if (transaction)
      await ctx.db.patch(transaction._id, {
        status: "invalid",
        updatedAt: now,
      });
  },
});

export const reconcileTransaction = internalAction({
  args: { requestId: v.string() },
  handler: async (ctx, args) => {
    const current = await ctx.runQuery(
      internal.wallets.getReconciliationContext,
      args,
    );
    if (
      !current?.wallet ||
      !current.transaction ||
      !["prepared", "broadcast"].includes(current.request.status) ||
      !current.request.transactionHash
    )
      return;
    if (
      current.transaction.status === "prepared" &&
      current.transaction.createdAt <= LEGACY_PREPARED_CANCELLATION_CUTOFF_MS
    ) {
      await ctx.runMutation(internal.wallets.cancelPreparedExecution, {
        requestId: args.requestId,
        diagnosticCode: "PREEXISTING_PREPARED_CANCELLED",
        diagnosticDetail:
          "Prepared before RPC failover deployment; cancelled without publication",
      });
      return;
    }
    if (current.failedParent) {
      await ctx.runMutation(internal.wallets.cancelPreparedExecution, {
        requestId: args.requestId,
        diagnosticCode: "PARENT_WORKFLOW_ABORTED",
        diagnosticDetail: `Parent ${current.failedParent.requestId} is ${current.failedParent.status}`,
      });
      return;
    }
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
        ...(current.transaction.tradeOutputTokenAddress
          ? {
              tradeOutputTokenAddress:
                current.transaction.tradeOutputTokenAddress,
            }
          : {}),
        ...(current.transaction.tradeOutputBalanceBefore
          ? {
              tradeOutputBalanceBefore:
                current.transaction.tradeOutputBalanceBefore,
            }
          : {}),
        ...(current.transaction.involvedPairTokenAddress
          ? {
              involvedPairTokenAddress:
                current.transaction.involvedPairTokenAddress,
            }
          : {}),
        ...(current.transaction.feeReassignmentTokenAddress
          ? {
              expectedFeeReassignmentToken:
                current.transaction.feeReassignmentTokenAddress,
            }
          : {}),
        ...(current.transaction.feeReassignmentRecipientAddress
          ? {
              expectedFeeReassignmentRecipient:
                current.transaction.feeReassignmentRecipientAddress,
            }
          : {}),
      };
      const expectedFactory = current.transaction.callKind.startsWith(
        "pons_v2_launch",
      )
        ? (await ctx.runQuery(internal.registry.runtimeConfig, {})).contracts
            .pons_v2_factory
        : undefined;
      const expectedCreatorFeeRecipient =
        current.transaction.callKind.startsWith("pons_v2_launch")
          ? current.launch?.creatorFeeRecipient
          : undefined;
      const verifiedStatusBody = {
        ...statusBody,
        ...(expectedFactory ? { expectedFactory } : {}),
        ...(expectedCreatorFeeRecipient ? { expectedCreatorFeeRecipient } : {}),
      };
      const result =
        current.request.status === "prepared"
          ? await signerRequest<SubmittedTransaction>(
              "/v1/transactions/broadcast",
              {
                ...verifiedStatusBody,
                signedTransaction: current.transaction.signedTransaction,
              },
            )
          : await signerRequest<SubmittedTransaction>(
              "/v1/transactions/status",
              verifiedStatusBody,
            );
      if (result.status === "broadcast" || result.status === "pending") {
        if (current.request.status === "prepared")
          await ctx.runMutation(internal.wallets.markTransactionBroadcast, {
            requestId: args.requestId,
          });
        else
          await ctx.runMutation(internal.wallets.deferReconciliation, {
            requestId: args.requestId,
            attempt: (current.request.reconciliationAttempts || 0) + 1,
          });
        return;
      }
      if (result.status === "reverted") {
        await ctx.runMutation(internal.wallets.recordRevertedExecution, {
          requestId: args.requestId,
          blockNumber: result.blockNumber,
        });
        return;
      }
      if (
        current.transaction.callKind.startsWith("pons_v2_launch") &&
        (!result.tokenAddress || !result.poolAddress)
      )
        throw new Error("launch receipt was incomplete");
      const launch = current.launch
        ? {
            ownerXUserId: current.launch.ownerXUserId,
            launcherUsername: current.launch.launcherUsername,
            launchMode: current.launch.launchMode,
            name: current.launch.name,
            symbol: current.launch.symbol,
            imageUri: current.launch.imageUri,
            description: current.launch.description,
            website: current.launch.website,
            twitter: current.launch.twitter,
            telegram: current.launch.telegram,
            // The receipt value includes the Pons launch fee, so it must never
            // replace the opening-buy-only amount captured at preparation.
            devBuyWei: current.launch.devBuyWei,
            tokenAddress: result.tokenAddress || current.launch.tokenAddress,
            poolAddress: result.poolAddress || current.launch.poolAddress,
            positionId: result.positionId || current.launch.positionId,
            devBuySucceeded: result.devBuySucceeded,
          }
        : undefined;
      await ctx.runMutation(internal.wallets.recordConfirmedExecution, {
        requestId: args.requestId,
        walletId: current.wallet._id,
        to: current.transaction.to,
        valueWei: result.valueWei || current.transaction.valueWei,
        callKind: current.transaction.callKind,
        transactionHash: current.request.transactionHash,
        blockNumber: result.blockNumber,
        claimedDisplay: result.claimedDisplay,
        tradeOutputDisplay: result.tradeOutputDisplay,
        tradeOutputTokenAddress: result.tradeOutputTokenAddress,
        tradeOutputBalanceBefore: current.transaction.tradeOutputBalanceBefore,
        involvedPairTokenAddress:
          result.involvedPairTokenAddress ||
          current.transaction.involvedPairTokenAddress,
        launch,
        feeReassignmentTokenAddress:
          current.transaction.feeReassignmentTokenAddress,
        feeReassignmentRecipientAddress:
          current.transaction.feeReassignmentRecipientAddress,
        feeReassignmentUpdatesLaunch:
          current.transaction.feeReassignmentUpdatesLaunch,
        claimIncludesOtherLaunches:
          current.transaction.claimIncludesOtherLaunches,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      console.error("wallet_reconciliation_failed", {
        requestId: args.requestId,
        message,
      });
      if (
        /mismatch|verified Pons launch event|verified opening developer buy event|verified creator fee claim event/i.test(
          message,
        )
      ) {
        await ctx.runMutation(internal.wallets.recordInvalidReceipt, {
          requestId: args.requestId,
          safeError: "on-chain receipt verification failed",
        });
        return;
      }
      if (
        /RPC rejected the signed transaction parameters|RPC could not broadcast the signed transaction/i.test(
          message,
        )
      ) {
        await ctx.runMutation(internal.wallets.cancelPreparedExecution, {
          requestId: args.requestId,
          diagnosticCode: "RPC_BROADCAST_REJECTED",
          diagnosticDetail: sanitizedDiagnosticDetail(error),
        });
        return;
      }
      if (
        /total cost .*exceeds the balance|gas \* gas fee \+ value.*exceeds the balance|insufficient funds.*gas/i.test(
          message,
        )
      ) {
        await ctx.runMutation(internal.wallets.cancelPreparedExecution, {
          requestId: args.requestId,
          diagnosticCode: "INSUFFICIENT_FUNDS",
          diagnosticDetail: sanitizedDiagnosticDetail(error),
          safeError: message,
        });
        return;
      }
      await ctx.runMutation(internal.wallets.deferReconciliation, {
        requestId: args.requestId,
        attempt: (current.request.reconciliationAttempts || 0) + 1,
      });
    }
  },
});

function isPremium(subscriptionType?: string) {
  return subscriptionType === "Premium" || subscriptionType === "PremiumPlus";
}

async function reconstructConfirmedMessage(
  ctx: ActionCtx,
  request: Doc<"walletRequests">,
  wallet: Doc<"cryptoWallets">,
): Promise<string | undefined> {
  if (!request.transactionHash) return undefined;
  let command: WalletCommand | null = null;
  try {
    command = validateStructuredWalletCommand(
      JSON.parse(request.normalizedJson) as unknown,
    );
  } catch {
    command = null;
  }
  if (!command || command.kind === "unknown") return undefined;
  const current = await ctx.runQuery(
    internal.wallets.getReconciliationContext,
    { requestId: request.requestId },
  );
  if (!current?.transaction) return undefined;
  await ctx.runMutation(internal.registry.ensureInitialized, {});
  const registry = await ctx.runQuery(internal.registry.runtimeConfig, {});
  const identifier =
    "token" in command && typeof command.token === "string"
      ? command.token
      : undefined;
  let tokenSymbol: string | undefined;
  if (identifier && safeAddress(identifier)) {
    try {
      const balance = await signerRequest<{ symbol?: string }>(
        "/v1/wallets/balance",
        {
          chainId: ROBINHOOD_CHAIN_ID,
          walletRef: wallet.signerWalletRef,
          expectedAddress: wallet.address,
          ownerReference: `x:${request.ownerXUserId}`,
          token: identifier,
        },
      );
      tokenSymbol =
        balance.symbol && /^[A-Za-z0-9]{1,32}$/.test(balance.symbol)
          ? balance.symbol
          : undefined;
    } catch {
      /* The stored command still permits a safe generic reconstruction. */
    }
  }
  const publicCommand = replyCommand(command, tokenSymbol, registry);
  const message = await transactionMessage(
    publicCommand,
    request.transactionHash,
    current.launch?.tokenAddress,
    current.transaction.claimedDisplay,
    current.transaction.tradeOutputDisplay,
    current.transaction.claimIncludesOtherLaunches,
    current.transaction.tradeOutputTokenAddress,
    current.transaction.valueWei,
  );
  return combineVaultClaimMessage(ctx, request.requestId, command, message);
}

async function combineVaultClaimMessage(ctx: ActionCtx, requestId: string, command: WalletCommand, legacyMessage: string) {
  if (command.kind !== "claim_fees") return legacyMessage;
  const result = await ctx.runQuery(internal.automatedFeeClaimInfo.requestedClaimResult, {
    requestId, legacyMessage, ...await claimPriceArgument(),
  });
  return result.hasVaults ? result.message : legacyMessage;
}

async function claimPriceArgument() {
  const ethUsd = await currentClaimEthUsd();
  return ethUsd === undefined ? {} : { ethUsd };
}

export const persistLaunchPrediction = internalMutation({
  args: {
    requestId: v.string(),
    preparedLaunchSalt: v.string(),
    predictedTokenAddress: v.string(),
    predictedCurveAddress: v.string(),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("walletRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (!request) throw new Error("wallet request not found");
    if (request.preparedLaunchSalt) {
      if (
        request.preparedLaunchSalt !== args.preparedLaunchSalt ||
        request.predictedTokenAddress?.toLowerCase() !==
          args.predictedTokenAddress.toLowerCase() ||
        request.predictedCurveAddress?.toLowerCase() !==
          args.predictedCurveAddress.toLowerCase()
      )
        throw new Error("launch prediction changed during retry");
      return;
    }
    await ctx.db.patch(request._id, {
      preparedLaunchSalt: args.preparedLaunchSalt,
      predictedTokenAddress: args.predictedTokenAddress,
      predictedCurveAddress: args.predictedCurveAddress,
      updatedAt: Date.now(),
    });
  },
});

async function prepareAndPersistLaunch(
  ctx: ActionCtx,
  wallet: Doc<"cryptoWallets">,
  xUserId: string,
  requestId: string,
  operation: Record<string, unknown>,
) {
  const saved = await ctx.runQuery(internal.wallets.getWalletRequest, {
    requestId,
  });
  if (
    saved?.preparedLaunchSalt &&
    saved.predictedTokenAddress &&
    saved.predictedCurveAddress
  )
    return {
      ...operation,
      preparedSalt: saved.preparedLaunchSalt,
      predictedTokenAddress: saved.predictedTokenAddress,
      predictedCurveAddress: saved.predictedCurveAddress,
    };
  const prediction = await signerRequest<{
    preparedSalt: string;
    predictedTokenAddress: string;
    predictedCurveAddress: string;
  }>(
    "/v1/transactions/prepare-launch",
    {
      idempotencyKey: requestId,
      ownerReference: `x:${xUserId}`,
      chainId: ROBINHOOD_CHAIN_ID,
      walletRef: wallet.signerWalletRef,
      expectedFrom: wallet.address,
      requireSimulation: true,
      operation,
    },
    240_000,
  );
  if (
    !/^0x[a-fA-F0-9]{64}$/.test(prediction.preparedSalt) ||
    !safeAddress(prediction.predictedTokenAddress) ||
    !safeAddress(prediction.predictedCurveAddress) ||
    !prediction.predictedTokenAddress.toLowerCase().endsWith("b07")
  )
    throw new Error("signer returned an invalid b07 launch prediction");
  await ctx.runMutation(internal.wallets.persistLaunchPrediction, {
    requestId,
    preparedLaunchSalt: prediction.preparedSalt,
    predictedTokenAddress: prediction.predictedTokenAddress,
    predictedCurveAddress: prediction.predictedCurveAddress,
  });
  return { ...operation, ...prediction };
}

function walletPageUrl(address: string, requestId?: string) {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  return site
    ? `${site}/wallet/${address}${requestId ? `?request=${encodeURIComponent(requestId)}` : ""}`
    : addressUrl(address);
}

export function safeFailure(
  error: unknown,
  operationKind?: WalletCommand["kind"],
  tokenSymbol?: string,
) {
  const message =
    error instanceof Error ? error.message : "wallet request failed";
  if (message === "BUY_TARGET_NATIVE_ETH")
    return "⚠️ Your wallet already uses Robinhood Chain ETH. Choose a token to buy, or send ETH to your wallet to fund it.";
  if (message === "SELL_TARGET_NATIVE_ETH")
    return "⚠️ ETH is your wallet's base currency. To exchange it, ask to buy a token with ETH or swap ETH for a specific token.";
  if (message === "BURN_TARGET_NATIVE_ETH")
    return "⚠️ Burning native ETH isn't supported. Choose a token ticker or contract to burn instead.";
  if (message === "BUY_TARGET_UNRESOLVED")
    return "⚠️ I couldn't find that token. Reply with the full request using its contract address so I can identify it.";
  if (operationKind === "upgrade_fees") {
    if (/FEE_UPGRADE_NOT_FOUND|launch is not eligible/i.test(message)) return FEE_UPGRADE_RESPONSES.notFound;
    if (/FEE_UPGRADE_AMBIGUOUS|multiple owned launches use that ticker/i.test(message)) return FEE_UPGRADE_RESPONSES.ambiguous;
    if (/fee reassignment rights|not the current creator fee recipient|wallet no longer controls/i.test(message)) return FEE_UPGRADE_RESPONSES.unauthorized;
    if (/FEE_UPGRADE_ALREADY|already uses automated fee processing/i.test(message)) return feeUpgradeAlreadyMessage(tokenSymbol);
    if (/FEE_UPGRADE_IN_PROGRESS/i.test(message)) return FEE_UPGRADE_RESPONSES.inProgress;
    if (/FEE_UPGRADE_REVIEW|automated fee program already exists|deployment requires manual review/i.test(message)) return FEE_UPGRADE_RESPONSES.review;
    if (/holder fee sharing is already enabled/i.test(message)) return FEE_UPGRADE_RESPONSES.holders;
    if (/automated fee upgrades are not enabled/i.test(message)) return FEE_UPGRADE_RESPONSES.unavailable;
  }
  if (/^The buy completed, but the send did not\./i.test(message))
    return `⚠️ ${message}`;
  if (/^The .+ sale completed, but the purchase of /i.test(message))
    return `⚠️ ${message}`;
  const gasAction = operationKind === "launch" ? "launch"
    : operationKind === "buy" || operationKind === "buy_and_burn" || operationKind === "buy_and_send" || operationKind === "buy_top_five" ? "buy"
      : operationKind === "sell" ? "sell"
        : operationKind === "send" ? "send"
          : operationKind === "burn" ? "burn"
            : operationKind === "swap_token_for_token" ? "swap"
              : operationKind === "claim_fees" ? "claim creator fees"
                : operationKind === "reassign_fees" ? "reassign creator fees"
                  : operationKind === "upgrade_fees" ? "upgrade creator fees"
                    : "complete this transaction";
  const gasResume = `⛽ You'll need to fund your wallet with ETH for gas to ${gasAction}. Fund it, then reply “resume”.`;
  if (/ETH transfer amount plus gas exceeds/i.test(message)) return gasResume;
  if (
    /total cost .*exceeds the balance|gas \* gas fee \+ value.*exceeds the balance/i.test(
      message,
    )
  ) {
    return gasResume;
  }
  if (/insufficient ETH for gas/i.test(message)) return gasResume;
  if (
    /insufficient paired asset balance|first you need to buy the paired asset/i.test(
      message,
    )
  )
    return "❌ You don't have enough of this token's paired asset yet. Buy the paired asset, then reply with the Pons Bot purchase again.";
  if (/insufficient/i.test(message))
    return "❌ There aren't enough funds for that amount. Check the balance or try a smaller amount.";
  if (/no claimable creator fees/i.test(message))
    return "ℹ️ There aren't any creator fees available to claim in that asset right now.";
  if (/named paired asset does not match|paired with ETH; specify an ETH or dollar amount/i.test(message))
    return "⚠️ That spend asset doesn't match this token's Pons V2 pair. Reply with the full request using that pair or a dollar amount.";
  if (
    /requested Pons V2 pair (?:was not found in the registry|is not currently approved)/i.test(
      message,
    )
  )
    return "⚠️ That pairing asset isn't currently supported on Pons V2. Try a supported ticker, or ask “what assets can I pair with?”";
  if (/image/i.test(message))
    return "🖼️ I couldn't prepare that image. Try another one, or launch without artwork.";
  if (/ticker matches/i.test(message))
    return "⚠️ More than one indexed token uses that ticker. Reply with the full request using the contract address so I choose the right one!";
  if (
    /specify the token|contract address|token lookup|held token/i.test(message)
  )
    return "🔎 I couldn't identify that token. Reply with the full request using a ticker you hold or its contract address.";
  if (/launch was not found|no completed Pons launch/i.test(message))
    return "🔎 I couldn't find a completed Pons launch for that token.";
  if (/launch creator|fee beneficiary/i.test(message))
    return "🔒 This wallet isn't authorized to claim fees for that launch.";
  if (
    /fee reassignment rights|not the current creator fee recipient/i.test(
      message,
    )
  )
    return operationKind === "upgrade_fees"
      ? "🔒 You don't have the rights to upgrade creator fees for that Pons Bot launch."
      : "🔒 You don't have the rights to reassign fees for that Pons Bot launch.";
  if (/already uses automated fee processing/i.test(message))
    return "ℹ️ That launch already uses automated creator-fee processing.";
  if (/multiple owned launches use that ticker/i.test(message))
    return "⚠️ You launched more than one token with that ticker. Reply with the full request using the contract address.";
  if (/holder fee sharing is already enabled/i.test(message))
    return "ℹ️ That launch is already sharing future creator fees with holders.";
  if (/fee reassignment recipient/i.test(message))
    return "📍 Choose a different valid X handle or wallet address for the new fee recipient.";
  if (/locker relationship|position assets/i.test(message))
    return "⚠️ I couldn't verify that launch's Pons fee position. Nothing was claimed.";
  if (/invalid transfer destination/i.test(message))
    return "📍 I couldn't identify that recipient. Reply with the full request using an X handle or wallet address.";
  if (/pool|liquidity|quote returned no output/i.test(message))
    return "💧 I couldn't find enough liquidity or a usable route for that trade. Reply with the full request using another amount or asset.";
  if (/max fee per gas less than block base fee/i.test(message))
    return "⛽ Network fees moved too quickly before broadcast. Nothing was submitted or spent. Reply with the request again shortly.";
  if (
    /RPC rejected the signed transaction parameters|RPC could not broadcast/i.test(
      message,
    )
  )
    return "🌐 The network couldn't submit that transaction. Nothing was spent. Reply with the request again.";
  if (/slippage/i.test(message))
    return "📉 The price moved beyond your slippage setting. Reply with the request again or choose a higher slippage.";
  if (/website (?:must use https|link is invalid)/i.test(message))
    return "🔗 Reply with the launch request using a valid public website link, such as example.com or https://example.com.";
  if (
    /x link must use x\.com/i.test(message) ||
    /twitter link uses an unsupported host/i.test(message)
  )
    return "🔗 Reply with the launch request using an X handle or link in the format @username or x.com/username.";
  if (
    /telegram link must use t\.me/i.test(message) ||
    /telegram link uses an unsupported host/i.test(message)
  )
    return "🔗 Reply with the launch request using a Telegram link in the format t.me/XXXXX.";
  if (
    /another wallet transaction is still being prepared|wallet is busy with another transaction/i.test(
      message,
    )
  )
    return "⏳ Your wallet is still processing an earlier transaction. Wait for it to finish, then reply with the launch request again!";
  if (/disabled|not configured|unavailable/i.test(message)) {
    console.error("wallet_configuration_failure", { message });
    return "🛠️ The wallet service is taking a quick break. Reply with the request again shortly!";
  }
  if (/revert|simulation/i.test(message))
    return operationKind === "upgrade_fees" ? FEE_UPGRADE_RESPONSES.failed : "❌ The transaction couldn't be completed, and nothing was confirmed onchain. Check the details, then reply with the request again.";
  console.error("wallet_unclassified_failure", { message });
  if (operationKind === "upgrade_fees") return FEE_UPGRADE_RESPONSES.failed;
  return "❌ I couldn't complete that wallet request. Check the details, then reply with the request again!";
}

function privateDiagnosticCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/^(?:SELL|BURN)_TARGET_NATIVE_ETH$/.test(message)) return message;
  const signerCode = message.match(/\bcode=([A-Z][A-Z0-9_]+)\b/)?.[1];
  if (signerCode) return signerCode;
  if (/no claimable creator fees/i.test(message))
    return "NO_CLAIMABLE_CREATOR_FEES";
  if (/launch creator fee beneficiary|creator fee recipient/i.test(message))
    return "CREATOR_FEE_AUTHORIZATION_FAILED";
  if (/no completed Pons launch/i.test(message)) return "PONS_LAUNCH_NOT_FOUND";
  if (
    /wallet signer request failed|signer returned invalid|signer request failed/i.test(
      message,
    )
  )
    return "WALLET_SIGNER_FAILED";
  if (/requested Pons V2 pair/i.test(message)) return "UNSUPPORTED_LAUNCH_PAIR";
  if (/insufficient|exceeds the balance/i.test(message))
    return "INSUFFICIENT_FUNDS";
  if (/token lookup|not found in the registry|identify.*token/i.test(message))
    return "TOKEN_RESOLUTION_FAILED";
  if (/simulation|revert/i.test(message)) return "SIMULATION_OR_REVERT";
  if (/confirmation timed out/i.test(message)) return "CONFIRMATION_TIMEOUT";
  if (
    /RPC rejected the signed transaction parameters|RPC could not broadcast/i.test(
      message,
    )
  )
    return "RPC_BROADCAST_REJECTED";
  if (/image/i.test(message)) return "IMAGE_PREPARATION_FAILED";
  if (/approval/i.test(message)) return "TOKEN_APPROVAL_FAILED";
  if (/quote|liquidity|route/i.test(message)) return "ROUTE_OR_QUOTE_FAILED";
  if (/disabled|not configured|unavailable/i.test(message))
    return "SERVICE_CONFIGURATION";
  return "UNCLASSIFIED_WALLET_FAILURE";
}

function sanitizedDiagnosticDetail(error: unknown) {
  const message =
    error instanceof Error ? error.message : "wallet request failed";
  return message
    .replace(/https?:\/\/[^\s)]+/gi, "[rpc-url-redacted]")
    .replace(/\b0x[a-fA-F0-9]{128,}\b/g, "[signed-transaction-redacted]")
    .slice(0, 500);
}

async function submit(
  wallet: { signerWalletRef: string; address: string },
  xUserId: string,
  requestId: string,
  operation: Record<string, unknown>,
  minimumNonce?: number,
) {
  if (!executionEnabled()) throw new Error("crypto execution is disabled");
  const launch =
    operation.type === "pons_v2_launch" ||
    operation.type === "pons_v2_launch_and_buy";
  return await signerRequest<SubmittedTransaction>(
    "/v1/transactions/execute",
    {
      idempotencyKey: legacyClaimSigningKey(requestId, operation.type),
      ownerReference: `x:${xUserId}`,
      chainId: ROBINHOOD_CHAIN_ID,
      walletRef: wallet.signerWalletRef,
      expectedFrom: wallet.address,
      requireSimulation: true,
      ...(minimumNonce === undefined ? {} : { minimumNonce }),
      operation,
    },
    launch ? 240_000 : 45_000,
  );
}

export const ensureWallet = internalAction({
  args: { xUserId: v.string() },
  handler: async (ctx, { xUserId }): Promise<Doc<"cryptoWallets"> | null> => {
    const current = await ctx.runQuery(internal.wallets.getXUserAndWallet, {
      xUserId,
    });
    if (current?.wallet) {
      if (
        current.wallet.ownerXUserId !== xUserId ||
        current.wallet.chainId !== ROBINHOOD_CHAIN_ID
      ) {
        throw new Error("canonical X wallet binding mismatch");
      }
      return current.wallet;
    }
    const reservation = await ctx.runMutation(
      internal.wallets.beginWalletProvisioning,
      { xUserId },
    );
    if (!reservation.needed) {
      // A concurrent delivery may be provisioning the same idempotent wallet.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return (
        (await ctx.runQuery(internal.wallets.getXUserAndWallet, { xUserId }))
          ?.wallet || null
      );
    }
    try {
      const wallet = await provisionSignerWallet(xUserId);
      await ctx.runMutation(internal.wallets.finishWalletProvisioning, {
        xUserId,
        address: wallet.address,
        signerWalletRef: wallet.walletRef,
      });
      return (
        (await ctx.runQuery(internal.wallets.getXUserAndWallet, { xUserId }))
          ?.wallet || null
      );
    } catch (error) {
      await ctx.runMutation(internal.wallets.resetWalletProvisioning, {
        xUserId,
      });
      throw error;
    }
  },
});

export const executeCommand = internalAction({
  args: {
    sourcePostId: v.string(),
    xUserId: v.string(),
    text: v.string(),
    mediaUrl: v.optional(v.string()),
    recipientAddress: v.optional(v.string()),
    parsedCommandJson: v.optional(v.string()),
    source: v.optional(v.union(v.literal("x"), v.literal("terminal"))),
    channel: v.optional(
      v.union(
        v.literal("x_reply"),
        v.literal("terminal_chat"),
        v.literal("terminal_form"),
      ),
    ),
    terminalSessionId: v.optional(v.string()),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CommandResult> => {
    const structured = args.parsedCommandJson
      ? validateStructuredWalletCommand(
          JSON.parse(args.parsedCommandJson) as unknown,
        )
      : null;
    let command = structured || parseWalletCommand(args.text);
    if (command.kind === "unknown")
      return { ok: false, message: command.reason };
    if ((command.kind === "reassign_fees" || command.kind === "upgrade_fees") && args.source === "terminal") {
      return {
        ok: false,
        message:
          "💸 Creator-fee controls are available through X posts only.",
      };
    }
    if (command.kind === "reassign_fees" || command.kind === "upgrade_fees") {
      const exact = parseWalletCommand(args.text);
      if (
        exact.kind !== command.kind ||
        exact.token.toLowerCase() !== command.token.toLowerCase() ||
        (command.kind === "reassign_fees" &&
          (exact.kind !== "reassign_fees" || exact.recipient.toLowerCase() !== command.recipient.toLowerCase()))
      ) {
        return {
          ok: false,
          message:
            "❌ I couldn't complete that wallet request. Check the details, then reply with the request again!",
        };
      }
    }
    try {
      command = normalizeLaunchLinks(command, args.text);
      command = normalizeLaunchTelegram(command, args.text);
      command = normalizeLaunchFeeOptions(command, args.text);
    } catch (error) {
      return { ok: false, message: safeFailure(error) };
    }
    const userContext = await ctx.runQuery(internal.wallets.getXUserAndWallet, {
      xUserId: args.xUserId,
    });
    if (!userContext)
      return {
        ok: false,
        message:
          "❌ I couldn't connect this X account to its wallet. Reply with the request again shortly!",
      };
    let wallet = userContext.wallet;
    try {
      wallet ||= await ctx.runAction(internal.wallets.ensureWallet, {
        xUserId: args.xUserId,
      });
    } catch (error) {
      return { ok: false, message: safeFailure(error) };
    }
    if (!wallet || wallet.status !== "active")
      return {
        ok: false,
        message:
          "🔒 This wallet isn't available right now. Reply with the request again shortly.",
      };
    const reservedTickerMessage = reservedLaunchTickerMessage(command);
    if (reservedTickerMessage) {
      return {
        ok: false,
        message: reservedTickerMessage,
      };
    }
    if (command.kind === "create_wallet" || command.kind === "show_wallet") {
      return {
        ok: true,
        message: `👛 Your Pons Bot wallet is ready!\nWallet link: ${walletPageUrl(wallet.address, args.sourcePostId)}\nTap the link above to view holdings.`,
      };
    }
    if (command.kind === "show_balance") {
      try {
        await ctx.runMutation(internal.registry.ensureInitialized, {});
        const knownTokens = command.token
          ? undefined
          : await ctx.runQuery(internal.wallets.listWalletTokenAddresses, {
              walletId: wallet._id,
            });
        const resolvedToken =
          command.token && !/^eth$/i.test(command.token)
            ? await ctx.runQuery(internal.wallets.resolveKnownToken, {
                identifier: command.token,
                walletId: wallet._id,
              })
            : command.token;
        const balance = await signerRequest<{
          display: string;
          symbol?: string;
        }>("/v1/wallets/balance", {
          chainId: ROBINHOOD_CHAIN_ID,
          walletRef: wallet.signerWalletRef,
          expectedAddress: wallet.address,
          ownerReference: `x:${args.xUserId}`,
          ...(resolvedToken ? { token: resolvedToken } : {}),
          ...(knownTokens ? { knownTokens } : {}),
        });
        const ticker =
          balance.symbol && /^[A-Za-z0-9]{1,32}$/.test(balance.symbol)
            ? assetLabel(balance.symbol)
            : undefined;
        const compactBalance =
          compactAssetDisplay(balance.display) || balance.display;
        return {
          ok: true,
          message: command.token
            ? `📊 ${ticker ? `${ticker} balance` : "Token balance"}: ${compactBalance}\nYour wallet: ${walletPageUrl(wallet.address, args.sourcePostId)}`
            : `📊 Here's your wallet balance:\n${compactBalance}\nYour wallet: ${walletPageUrl(wallet.address, args.sourcePostId)}`,
        };
      } catch (error) {
        return { ok: false, message: safeFailure(error) };
      }
    }
    const source = args.source || "x";
    // Never let an X interaction spend from the bot's wallet. Its owner may
    // use the terminal, but source/channel labels alone are not authority:
    // require a live, same-owner session again at the execution boundary.
    if (
      process.env.X_BOT_USER_ID &&
      args.xUserId === process.env.X_BOT_USER_ID
    ) {
      if (source !== "terminal" || (args.channel !== "terminal_chat" && args.channel !== "terminal_form")) {
        return {
          ok: false,
          message:
            "❌ I couldn't complete that wallet request. Check the details, then reply with the request again!",
        };
      }
      if (!await hasActiveTerminalSession(ctx, args.xUserId, args.terminalSessionId)) {
        return { ok: false, message: "🔒 Reconnect X to use the terminal." };
      }
    }
    if (source === "terminal" && !isTerminalCommand(command)) {
      return {
        ok: false,
        message:
          command.kind === "launch"
            ? "🚀 Launches are available through X posts only."
            : "❌ That action is not available in the terminal.",
      };
    }
    if (
      source === "terminal" &&
      args.channel === "terminal_form" &&
      command.kind === "swap_token_for_token"
    ) {
      return {
        ok: false,
        message: "❌ That action is available through terminal chat only.",
      };
    }
    const requestId =
      args.requestId || `x:${args.sourcePostId}:${command.kind}`;
    const reserved = await ctx.runMutation(
      internal.wallets.reserveWalletRequest,
      {
        requestId,
        sourcePostId: args.sourcePostId,
        ownerXUserId: args.xUserId,
        walletId: wallet._id,
        kind: command.kind,
        normalizedJson: JSON.stringify(command),
        source,
        channel: args.channel || "x_reply",
      },
    );
    if (!reserved.inserted) {
      const prior = reserved.request;
      if (prior?.diagnosticCode === LEGACY_CLAIM_SUPERSEDED) return { ok: false, message: "", deferred: true };
      let recoveredMessage = prior?.finalMessage;
      if (
        prior?.status === "confirmed" &&
        prior.transactionHash &&
        !recoveredMessage
      ) {
        try {
          recoveredMessage = await reconstructConfirmedMessage(
            ctx,
            prior,
            wallet,
          );
          if (recoveredMessage)
            await ctx.runMutation(internal.wallets.updateWalletRequest, {
              requestId,
              status: "confirmed",
              transactionHash: prior.transactionHash,
              finalMessage: recoveredMessage,
            });
        } catch (error) {
          console.error("wallet_confirmation_reconstruction_failed", {
            requestId,
            message: error instanceof Error ? error.message : "unknown",
          });
        }
      }
      const priorMessage =
        (["confirmed", "failed", "rejected", "skipped"].includes(prior?.status || "") && recoveredMessage)
          ? recoveredMessage
          : prior?.status === "confirmed" && prior.transactionHash
            ? `✅ This request was already completed!\nYour TXN: ${transactionUrl(prior.transactionHash)}`
            : prior?.status === "failed" || prior?.status === "rejected"
              ? "❌ This request did not complete. Check the earlier reply or try a new post."
              : prior?.transactionHash
                ? `⏳ This request is already onchain and still being confirmed.\nYour TXN: ${transactionUrl(prior.transactionHash)}`
                : "⏳ This request is already being processed. I'll keep it moving!";
      return {
        ok: prior?.status === "confirmed",
        message: priorMessage,
        ...(!["confirmed", "failed", "rejected"].includes(prior?.status || "")
          ? { pending: true }
          : {}),
        ...(prior?.transactionHash
          ? { transactionHash: prior.transactionHash }
          : {}),
      };
    }

    if (command.kind === "launch" && !userContext.user.verified) {
      await ctx.runMutation(internal.wallets.updateWalletRequest, {
        requestId,
        status: "rejected",
        safeError: "verified X account required",
      });
      return {
        ok: false,
        message:
          "🔒 Token launches are currently available to verified X accounts. Once verified, you'll be ready to launch!",
      };
    }
    if (command.kind === "launch" && !walletCanLaunch(wallet.launchEnabled)) {
      await ctx.runMutation(internal.wallets.updateWalletRequest, {
        requestId,
        status: "rejected",
        safeError: "launch unavailable",
      });
      return {
        ok: false,
        message:
          "❌ I couldn't complete that wallet request. Check the details, then reply with the request again!",
      };
    }
    const nativeTargetError = nativeTokenOperationError(command.kind, "token" in command ? command.token : undefined);
    if (nativeTargetError && (!reserved.retried || reserved.request?.status === "accepted")) {
      const message = safeFailure(new Error(nativeTargetError), command.kind);
      await ctx.runMutation(internal.wallets.updateWalletRequest, {
        requestId, status: "rejected", safeError: message, diagnosticCode: nativeTargetError,
      });
      return { ok: false, message };
    }
    // Only new/reopened attempts are gated here. Existing workflow continuations
    // must still reconcile any transactions already sent before checking gas
    // for their next transaction at the signer.
    let vaultClaimEligible = false;
    let preflightClaimPlan: { tokenAddresses: string[]; hasClaimableFees: boolean } | undefined;
    let preflightResolvedClaimToken: string | undefined;
    if (command.kind === "claim_fees" && reserved.request?.vaultClaimVersion === 1 && requestedVaultClaimsEnabled()) {
      try {
        const tokenAddress = command.token ? await ctx.runQuery(internal.wallets.resolveKnownToken, { identifier: command.token, walletId: wallet._id }) : undefined;
        if (!command.token || (tokenAddress && safeAddress(tokenAddress))) vaultClaimEligible = await ctx.runQuery(
          internal.automatedFeeClaimInfo.requestedClaimEligibility, { walletId: wallet._id, ...(tokenAddress ? { tokenAddress } : {}) });
      } catch (error) {
        const message = safeFailure(error, command.kind);
        await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "rejected", safeError: message, finalMessage: message });
        return { ok: false, message };
      }
    }
    if (command.kind === "claim_fees" && !vaultClaimEligible && (!reserved.retried || reserved.request?.status === "accepted")) {
      try {
        await ctx.runMutation(internal.registry.ensureInitialized, {});
        const registry = await ctx.runQuery(internal.registry.runtimeConfig, {});
        const factoryAddress = registry.contracts.pons_v2_factory;
        if (!safeAddress(factoryAddress)) throw new Error("Pons factory is not configured");
        const tokenAddress = command.token
          ? await ctx.runQuery(internal.wallets.resolveKnownToken, { identifier: command.token, walletId: wallet._id })
          : undefined;
        if (command.token && (!tokenAddress || !safeAddress(tokenAddress)))
          throw new Error("specify the token contract address for this fee claim");
        preflightResolvedClaimToken = tokenAddress && safeAddress(tokenAddress) ? tokenAddress : undefined;
        const candidates = preflightResolvedClaimToken
          ? [preflightResolvedClaimToken]
          : await ctx.runQuery(internal.wallets.listOwnedLaunchTokens, { xUserId: args.xUserId });
        preflightClaimPlan = await signerRequest<{ tokenAddresses: string[]; hasClaimableFees: boolean }>(
          "/v1/fees/claim-plan",
          {
            chainId: ROBINHOOD_CHAIN_ID,
            ownerReference: `x:${args.xUserId}`,
            walletRef: wallet.signerWalletRef,
            expectedAddress: wallet.address,
            factoryAddress,
            tokenAddresses: candidates,
            ...(preflightResolvedClaimToken ? { specificTokenAddress: preflightResolvedClaimToken } : {}),
          },
        );
        // During a rolling deployment, an older signer returns only the sweep
        // list. Preserve the legacy gas-first path until the new boolean is
        // available rather than treating an absent field as "no fees".
        if (typeof preflightClaimPlan.hasClaimableFees !== "boolean") preflightClaimPlan = undefined;
        if (preflightClaimPlan?.hasClaimableFees === false) {
          const summary = await ctx.runQuery(internal.wallets.creatorFeeClaimSourceSummary, { xUserId: args.xUserId });
          if (!command.token && !summary.hasLaunched && !summary.hasCreatorFeeSource) {
            const message = withClaimLpFeeOffer("ℹ️ You haven't launched any tokens to generate creator fees.");
            await ctx.runMutation(internal.wallets.updateWalletRequest, {
              requestId, status: "skipped", finalMessage: message,
              workflowStage: "creator_fee_source_precheck", diagnosticCode: "NO_CREATOR_FEE_SOURCE",
            });
            return { ok: false, message };
          }
          const guidance = await ctx.runQuery(internal.automatedFeeClaimInfo.emptyLegacyClaimMessage, {
            walletId: wallet._id,
            ...(preflightResolvedClaimToken ? { tokenAddress: preflightResolvedClaimToken } : {}),
          }).catch(() => null);
          const base = guidance?.message || "ℹ️ There aren't any creator fees available to claim right now.";
          const message = withClaimLpFeeOffer(base);
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId, status: guidance?.kind && guidance.kind !== "legacy" ? "skipped" : "failed",
            finalMessage: message, safeError: message,
            workflowStage: "creator_fee_availability_precheck", diagnosticCode: "NO_CLAIMABLE_CREATOR_FEES",
          });
          return { ok: false, message };
        }
      } catch (error) {
        if (/specify the token|contract address|token lookup|held token|ticker matches/i.test(error instanceof Error ? error.message : "")) {
          const message = safeFailure(error, command.kind);
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId, status: "rejected", finalMessage: message, safeError: message,
            workflowStage: "creator_fee_availability_precheck", diagnosticCode: "CREATOR_FEE_PREFLIGHT_INVALID_TOKEN",
            diagnosticDetail: sanitizedDiagnosticDetail(error),
          });
          return { ok: false, message };
        }
        // Backward-compatible rolling deploy and transient-read fallback. The
        // normal claim path still checks gas and validates claimability again.
        preflightClaimPlan = undefined;
      }
    }
    // The keeper pays vault-cycle gas. Legacy claims still enforce gas at their
    // signer; an empty beneficiary wallet must not block its vault payout.
    if (isValueMovingCommand(command) && command.kind !== "claim_fees" && !vaultClaimEligible && (!reserved.retried || reserved.request?.status === "accepted")) {
      try {
        await requireWalletNativeGas(wallet.address);
      } catch (error) {
        const empty = error instanceof EmptyNativeGasBalanceError;
        const message = empty
          ? fundingMessage(safeFailure(error, command.kind), wallet.address, args.sourcePostId)
          : "⚠️ I couldn't check your ETH balance right now. Reply with the request again shortly.";
        await ctx.runMutation(internal.wallets.updateWalletRequest, {
          requestId, status: "rejected", safeError: message, finalMessage: message,
          workflowStage: "native_gas_precheck",
          diagnosticCode: empty ? "INSUFFICIENT_FUNDS" : "NATIVE_BALANCE_UNAVAILABLE",
          diagnosticDetail: empty ? "ZERO_NATIVE_ETH_BALANCE: stopped before estimates or sponsorship" : "Native ETH balance lookup failed; no estimates or execution attempted",
        });
        return { ok: false, message };
      }
    }
    if (command.kind === "claim_fees" && !vaultClaimEligible && (!reserved.retried || reserved.request?.status === "accepted")) {
      try {
        await requireWalletNativeGas(wallet.address);
      } catch (error) {
        const empty = error instanceof EmptyNativeGasBalanceError;
        const message = empty
          ? fundingMessage(safeFailure(error, command.kind), wallet.address, args.sourcePostId)
          : "⚠️ I couldn't check your ETH balance right now. Reply with the request again shortly.";
        await ctx.runMutation(internal.wallets.updateWalletRequest, {
          requestId, status: "rejected", safeError: message, finalMessage: message,
          workflowStage: "native_gas_precheck", diagnosticCode: empty ? "INSUFFICIENT_FUNDS" : "NATIVE_BALANCE_UNAVAILABLE",
          diagnosticDetail: empty ? "ZERO_NATIVE_ETH_BALANCE: creator fees exist but the legacy claim needs gas" : "Native ETH balance lookup failed after creator-fee availability was confirmed",
        });
        return { ok: false, message };
      }
    }
    if (isValueMovingCommand(command)) {
      const limit = reserved.retried
        ? { allowed: true, count: 0, remaining: null as number | null }
        : await ctx.runMutation(internal.wallets.consumeWalletLimit, {
            xUserId: args.xUserId,
            premium: isPremium(userContext.user.subscriptionType),
          });
      if (!limit.allowed) {
        await ctx.runMutation(internal.wallets.updateWalletRequest, {
          requestId,
          status: "rejected",
          safeError: "daily wallet limit reached",
        });
        return {
          ok: false,
          message:
            "⏰ You've reached today's wallet action limit. It resets at 00:00 UTC, then you're ready to go again!",
        };
      }
      const limitCharged = !reserved.retried;
      const warning =
        limit.remaining === 2
          ? "\n⚠️ 2 wallet actions remain today."
          : limit.remaining === 1
            ? "\n⚠️ 1 wallet action remains today."
            : limit.remaining === 0
              ? "\n⏰ Today's wallet limit is now reached."
              : "";
      let executionLockHeld = false;
      const executionLeaseToken = crypto.randomUUID();
      let pairFunding: { transactionHash: string; asset: string } | undefined;
      const feeSweepHashes: string[] = [];
      let workflowStage = "request_reserved";
      let resolvedReplySymbol: string | undefined;
      let resolvedClaimToken: string | undefined;
      try {
        for (
          let attempt = 0;
          attempt < 60 && !executionLockHeld;
          attempt += 1
        ) {
          executionLockHeld = await ctx.runMutation(
            internal.wallets.acquireWalletExecutionLock,
            {
              walletId: wallet._id,
              requestId,
              leaseToken: executionLeaseToken,
            },
          );
          if (!executionLockHeld)
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!executionLockHeld && command.kind === "claim_fees" && reserved.request?.claimWorkflowVersion === LEGACY_CLAIM_VERSION)
          throw new Error(CLAIM_WORKFLOW_CONTINUATION);
        if (!executionLockHeld)
          throw new Error(
            "another wallet transaction is still being prepared; please try again shortly",
          );
        const currentRequest = await ctx.runQuery(internal.wallets.getWalletRequest, { requestId });
        if (["UPGRADE_CANCELLED_BY_OPERATOR", LEGACY_CLAIM_SUPERSEDED].includes(currentRequest?.diagnosticCode || "")) {
          return { ok: false, message: "", deferred: true };
        }
        // A second continuation may have reserved before the first completed.
        // Recheck under the wallet lease before any new signing/submission.
        if (command.kind === "claim_fees" && currentRequest
          && (!["accepted", "simulating"].includes(currentRequest.status) || currentRequest.transactionHash)) {
          const done = ["confirmed", "failed", "rejected", "skipped"].includes(currentRequest.status);
          return { ok: currentRequest.status === "confirmed", message: done ? currentRequest.finalMessage || "This claim request has already finished." : "",
            ...(!done ? { pending: true, deferred: true } : {}),
            ...(currentRequest.transactionHash ? { transactionHash: currentRequest.transactionHash } : {}) };
        }
        workflowStage = "simulation_started";
        await ctx.runMutation(internal.wallets.updateWalletRequest, {
          requestId,
          status: "simulating",
          workflowStage,
        });
        workflowStage = "registry_refresh";
        await ctx.runMutation(internal.wallets.updateWalletRequest, {
          requestId,
          status: "simulating",
          workflowStage,
        });
        await ctx.runMutation(internal.registry.ensureInitialized, {});
        if (command.kind === "launch")
          await ctx.runAction(internal.ponsV2.refreshRegistry, {
            identifier: command.pairToken,
          });
        workflowStage = "asset_resolution";
        await ctx.runMutation(internal.wallets.updateWalletRequest, {
          requestId,
          status: "simulating",
          workflowStage,
        });
        const registry = await ctx.runQuery(
          internal.registry.runtimeConfig,
          {},
        );
        let controlledLaunch: {
          tokenAddress: string;
          launchId: Doc<"tokenLaunches">["_id"];
          controllerAddress: string;
          pairTokenAddress: string;
        } | undefined;
        if (command.kind === "upgrade_fees") {
          const launch = await ctx.runQuery(internal.wallets.resolveLaunchForFeeUpgrade, { identifier: command.token });
          if (launch.status === "not_found") throw new Error("FEE_UPGRADE_NOT_FOUND");
          if (launch.status === "ambiguous") throw new Error("FEE_UPGRADE_AMBIGUOUS");
          controlledLaunch = { ...launch, controllerAddress: wallet.address };
        } else if (command.kind === "reassign_fees") {
          const owned = await ctx.runQuery(
            internal.wallets.resolveOwnedLaunchForFeeReassignment,
            { xUserId: args.xUserId, identifier: command.token },
          );
          if (owned.status === "unauthorized")
            throw new Error("fee reassignment rights were not found");
          if (owned.status === "ambiguous")
            throw new Error("multiple owned launches use that ticker");
          controlledLaunch = owned;
        }
        const commandToken =
          "token" in command && typeof command.token === "string"
            ? command.kind === "reassign_fees" || command.kind === "upgrade_fees"
              ? controlledLaunch?.tokenAddress
              : command.kind === "sell"
                ? await resolveSellToken(
                    ctx,
                    wallet,
                    args.xUserId,
                    command.token,
                  )
                : await ctx.runQuery(internal.wallets.resolveKnownToken, {
                    identifier: command.token,
                    walletId: wallet._id,
                  })
            : undefined;
        if (command.kind === "buy" || command.kind === "buy_and_send" || command.kind === "buy_and_burn") {
          assertBuyTarget(commandToken);
        }
        if (command.kind === "claim_fees" && command.token && (!commandToken || !safeAddress(commandToken)))
          throw new Error("specify the token contract address for this fee claim");
        if (command.kind === "claim_fees" && commandToken && safeAddress(commandToken)) resolvedClaimToken = commandToken;
        const automatedFeeProgram = (command.kind === "reassign_fees" || command.kind === "upgrade_fees") && commandToken && safeAddress(commandToken)
          ? await ctx.runQuery(internal.automatedFeeEngine.programByToken, { tokenAddress: commandToken })
          : null;
        const tokenInfo =
          commandToken && safeAddress(commandToken)
            ? await signerRequest<{ symbol?: string }>("/v1/wallets/balance", {
                chainId: ROBINHOOD_CHAIN_ID,
                walletRef: wallet.signerWalletRef,
                expectedAddress: wallet.address,
                ownerReference: `x:${args.xUserId}`,
                token: commandToken,
              })
            : undefined;
        const tokenSymbol =
          tokenInfo?.symbol && /^[A-Za-z0-9]{1,32}$/.test(tokenInfo.symbol)
            ? tokenInfo.symbol
            : undefined;
        resolvedReplySymbol = tokenSymbol;
        const publicCommand = replyCommand(command, tokenSymbol, registry);
        if (command.kind === "buy_top_five") {
          workflowStage = "top_five_snapshot";
          await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "simulating", workflowStage });
          const liveTargets = await ctx.runQuery(internal.wallets.currentTopFiveLaunchTokens, {});
          const targets = await ctx.runMutation(internal.wallets.prepareTopFiveWorkflow, { requestId, targets: liveTargets });

          // Check the complete five-token spend plus a conservative allowance
          // for five buys, optional pair acquisition, and five burns before the
          // first transaction. Individual operations still estimate precisely.
          const wethAddress = registry.contracts.weth;
          const quoterAddress = registry.contracts.swap_quoter;
          if (!safeAddress(wethAddress) || !safeAddress(quoterAddress)) throw new Error("swap contracts are missing from the registry");
          if (!reserved.retried) {
            const totalUsd = multiplyDecimalByInteger(command.amount, 5);
            const required = await signerRequest<{ raw: string; display: string }>("/v1/tokens/usd-amount", {
              token: wethAddress, amount: totalUsd, wethAddress, quoterAddress,
            });
            if (!/^\d+$/.test(required.raw) || BigInt(required.raw) <= 0n || !/^[0-9]+(?:\.[0-9]+)?$/.test(required.display))
              throw new Error("top-five funding requirement could not be verified");
            await signerRequest("/v1/wallets/spendable-eth", {
              chainId: ROBINHOOD_CHAIN_ID,
              walletRef: wallet.signerWalletRef,
              expectedAddress: wallet.address,
              ownerReference: `x:${args.xUserId}`,
              requestedEth: required.display,
              // The signer accepts at most 3,000,000 units in one preflight.
              // This reserves a conservative transaction ceiling here; every
              // deterministic child buy, pair acquisition, and burn still
              // performs its own exact simulation and balance check.
              reservedGasUnits: 3_000_000,
            });
          }

          const completed: Array<{
            symbol: string;
            tokenAddress: string;
            amount: string;
            usdValue?: string;
            transactionHash: string;
            buyTransactionHash: string;
            burnTransactionHash?: string;
          }> = [];
          for (let index = 0; index < targets.length; index += 1) {
            const target = targets[index];
            assertBuyTarget(target.tokenAddress);
            workflowStage = `top_five_${index + 1}_${command.burn ? "buy_and_burn" : "buy"}`;
            await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "simulating", workflowStage });
            try {
              const buyCommand: Extract<WalletCommand, { kind: "buy" }> = {
                kind: "buy", amount: command.amount, unit: "usd", token: target.tokenAddress, slippageBps: command.slippageBps,
              };
              const stepBase = `${requestId}:top-five:${index + 1}`;
              const funded = await fundedBuyCommand(ctx, wallet, args.xUserId, args.sourcePostId, `${stepBase}:funding`, buyCommand,
                target.tokenAddress, registry, executionLeaseToken, requestId);
              const bought = await executeConfirmedStep(ctx, wallet, args.xUserId, args.sourcePostId, `${stepBase}:buy`, funded.command,
                await operationFor(funded.command, undefined, undefined, undefined, target.tokenAddress, registry));
              if (!(await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, {
                walletId: wallet._id, requestId, leaseToken: executionLeaseToken,
              }))) throw new Error("wallet execution lease was lost during the top-five purchase");
              const displayPurchased = tradeDisplayAmount(bought.tradeOutputDisplay || "");
              const purchaseValue = await tokenUsdValueAtBlock(target.tokenAddress, displayPurchased, bought.blockNumber);
              let finalHash = bought.transactionHash;
              let burnTransactionHash: string | undefined;
              if (command.burn) {
                const burnCommand: Extract<WalletCommand, { kind: "burn" }> = {
                  kind: "burn", amount: displayPurchased, unit: "token", token: target.tokenAddress,
                };
                const burned = await executeConfirmedStep(ctx, wallet, args.xUserId, args.sourcePostId, `${stepBase}:burn`, burnCommand,
                  await operationFor(burnCommand, undefined, undefined, undefined, target.tokenAddress, registry));
                finalHash = burned.transactionHash;
                burnTransactionHash = burned.transactionHash;
                if (!(await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, {
                  walletId: wallet._id, requestId, leaseToken: executionLeaseToken,
                }))) throw new Error("wallet execution lease was lost after a top-five burn");
              }
              await ctx.runMutation(internal.wallets.indexWalletToken, {
                walletId: wallet._id, tokenAddress: target.tokenAddress, symbol: target.symbol,
                involvedByLaunch: false, involvedByTransaction: true,
              });
              completed.push({ symbol: target.symbol, tokenAddress: target.tokenAddress, amount: displayPurchased,
                ...(purchaseValue ? { usdValue: purchaseValue } : {}), transactionHash: finalHash,
                buyTransactionHash: bought.transactionHash, ...(burnTransactionHash ? { burnTransactionHash } : {}) });
            } catch (error) {
              if (error instanceof Error && error.message === "transaction confirmation timed out") {
                await ctx.runMutation(internal.wallets.updateWalletRequest, {
                  requestId, status: "simulating", workflowStage: `${workflowStage}_awaiting_confirmation`,
                  diagnosticCode: "TOP_FIVE_CHILD_CONFIRMATION_PENDING",
                  diagnosticDetail: "A persisted child transaction is still awaiting confirmation.",
                });
                if (source === "terminal" && args.terminalSessionId) {
                  await ctx.scheduler.runAfter(15_000, internal.wallets.resumeTerminalCommand, {
                    sessionId: args.terminalSessionId,
                    ownerXUserId: args.xUserId,
                    sourcePostId: args.sourcePostId,
                    requestId,
                    text: args.text,
                    parsedCommandJson: args.parsedCommandJson || JSON.stringify(command),
                    channel: args.channel === "terminal_form" ? "terminal_form" : "terminal_chat",
                  });
                }
                return { ok: true, message: "", pending: true, deferred: true };
              }
              const lines = completed.map(item => `$${item.symbol}: ${significantAmount(item.amount)}${item.usdValue ? ` (${item.usdValue})` : ""}`);
              const message = `⚠️ ${completed.length} of 5 top-token ${command.burn ? "buy-and-burns" : "buys"} completed before $${target.symbol} failed.\n${lines.join("\n")}${lines.length ? "\n" : ""}${safeFailure(error, "buy_top_five")}`;
              await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "failed", workflowStage,
                safeError: message, finalMessage: message, transactionHash: completed.at(-1)?.transactionHash,
                diagnosticCode: privateDiagnosticCode(error), diagnosticDetail: sanitizedDiagnosticDetail(error) });
              return { ok: false, message, ...(completed.at(-1) ? { transactionHash: completed.at(-1)!.transactionHash } : {}) };
            }
          }
          const resultBlocks = completed.map(item => [
            `${command.burn ? "🔥" : "🟢"} $${item.symbol}: ${significantAmount(item.amount)} ${command.burn ? "burned" : "bought"}${item.usdValue ? ` (${item.usdValue})` : ""}`,
            ponsBotTokenUrl(item.tokenAddress),
          ].join("\n")).join("\n\n");
          const transactionLinks = completed.map(item => [
            `$${item.symbol}`,
            `Buy TXN: ${transactionUrl(item.buyTransactionHash)}`,
            ...(item.burnTransactionHash ? [`Burn TXN: ${transactionUrl(item.burnTransactionHash)}`] : []),
          ].join("\n")).join("\n\n");
          const lastHash = completed.at(-1)!.transactionHash;
          const message = `✅ ${command.burn ? "Bought and burned" : "Bought"} $${command.amount} each of the top 5 Pons Bot tokens!\n\n${resultBlocks}\n\nTransactions\n\n${transactionLinks}${warning}`;
          await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "confirmed", workflowStage: "top_five_confirmed",
            transactionHash: lastHash, finalMessage: message });
          return { ok: true, transactionHash: lastHash, message };
        }
        const claimIncludesOtherLaunches =
          command.kind === "claim_fees" &&
          command.token &&
          commandToken &&
          safeAddress(commandToken)
            ? await ctx.runQuery(
                internal.wallets.claimMayIncludeOtherLaunches,
                { xUserId: args.xUserId, tokenAddress: commandToken },
              )
            : false;
        if (command.kind === "claim_fees") {
          const factoryAddress = registry.contracts.pons_v2_factory;
          if (!safeAddress(factoryAddress))
            throw new Error("Pons factory is not configured");
          const existingClaimRequest = await ctx.runQuery(
            internal.wallets.getWalletRequest,
            { requestId },
          );
          let sweepTokens: string[] = [];
          if (!existingClaimRequest?.claimWorkflowJson) {
            if (preflightClaimPlan) {
              sweepTokens = preflightClaimPlan.tokenAddresses;
            } else {
              const candidates = await ctx.runQuery(
                internal.wallets.listOwnedLaunchTokens,
                { xUserId: args.xUserId },
              );
              const plan = await signerRequest<{ tokenAddresses: string[]; hasClaimableFees: boolean }>(
                "/v1/fees/claim-plan",
                {
                  chainId: ROBINHOOD_CHAIN_ID,
                  ownerReference: `x:${args.xUserId}`,
                  walletRef: wallet.signerWalletRef,
                  expectedAddress: wallet.address,
                  factoryAddress,
                  tokenAddresses: commandToken && safeAddress(commandToken) ? [commandToken] : candidates,
                  ...(commandToken && safeAddress(commandToken) ? { specificTokenAddress: commandToken } : {}),
                },
              );
              sweepTokens = plan.tokenAddresses;
            }
          }
          const workflow = await ctx.runMutation(
            internal.wallets.prepareClaimWorkflow,
            {
              requestId,
              tokenAddresses: sweepTokens as string[],
            },
          );
          if (currentRequest?.vaultClaimVersion === 1) {
            await ctx.runMutation(internal.automatedFeeClaimInfo.prepareRequestedClaims, {
              requestId, ...(resolvedClaimToken ? { tokenAddress: resolvedClaimToken } : {}),
            });
            const vaultClaim = await ctx.runQuery(internal.automatedFeeClaimInfo.requestedClaimResult, { requestId });
            if (vaultClaim.pending) {
              workflowStage = "vault_claim_cycle_wait";
              throw new Error(CLAIM_WORKFLOW_CONTINUATION);
            }
          }
          const token = workflow.tokenAddresses[workflow.cursor];
          if (token) {
            const sweepRequestId = `${requestId}:sweep:${token}`;
            workflowStage = "claim_sweep";
            await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "simulating", workflowStage });
            try {
              const swept = await executeConfirmedStep(
                ctx,
                wallet,
                args.xUserId,
                args.sourcePostId,
                sweepRequestId,
                command,
                {
                  type: "pons_v2_sweep_fees",
                  token,
                  factoryAddress,
                  minBuybackTokensOut: "0",
                },
              );
              feeSweepHashes.push(swept.transactionHash);
            } catch (error) {
              const child = await ctx.runQuery(internal.wallets.getReconciliationContext, { requestId: sweepRequestId });
              if (child?.transaction && ["prepared", "broadcast"].includes(child.transaction.status)) {
                // Never advance past a sweep that might still land. Reuse its
                // stored transaction and reconcile it on the next continuation.
                await ctx.runMutation(internal.wallets.updateWalletRequest, {
                  requestId: sweepRequestId, status: child.transaction.status === "prepared" ? "prepared" : "broadcast",
                  transactionHash: child.transaction.transactionHash,
                });
                throw new Error(CLAIM_WORKFLOW_CONTINUATION);
              }
              if (child?.request.transactionHash || !canSkipUnsubmittedSweep(error)) throw error;
              await ctx.runMutation(internal.wallets.updateWalletRequest, {
                requestId: sweepRequestId,
                status: "skipped",
                workflowStage: "preparatory_sweep_skipped",
                diagnosticCode: "PREPARATORY_SWEEP_SKIPPED",
                diagnosticDetail: sanitizedDiagnosticDetail(error),
                safeError:
                  "preparatory fee sweep was skipped; escrow claim continued",
              });
              console.warn("creator_fee_sweep_skipped", {
                requestId: sweepRequestId,
                diagnosticCode: privateDiagnosticCode(error),
                message: sanitizedDiagnosticDetail(error),
              });
            }
            // Reconciliation can release a child lease. Renew the parent only
            // after confirmation; a lost lease must not rewrite a confirmed
            // child as skipped or proceed to the final claim.
            if (!(await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, {
              walletId: wallet._id, requestId, leaseToken: executionLeaseToken,
            }))) throw new Error(CLAIM_WORKFLOW_CONTINUATION);
            const nextCursor = await ctx.runMutation(
              internal.wallets.advanceClaimWorkflow,
              { requestId, expectedCursor: workflow.cursor },
            );
            if (nextCursor < workflow.tokenAddresses.length) {
              workflowStage = "claim_continuation";
              throw new Error(CLAIM_WORKFLOW_CONTINUATION);
            }
          }
        }
        if (command.kind === "upgrade_fees") {
          if (
            process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() !== "true" ||
            process.env.AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED?.trim().toLowerCase() !== "true" ||
            process.env.AUTOMATED_FEE_BOT_COMMANDS_ENABLED?.trim().toLowerCase() !== "true"
          ) {
            throw new Error("automated fee upgrades are not enabled");
          }
          if (!controlledLaunch || !commandToken || !safeAddress(commandToken)) {
            throw new Error("fee reassignment rights were not found");
          }
          const upgradeState = existingFeeUpgradeState(automatedFeeProgram, requestId);
          if (upgradeState === "already") throw new Error("FEE_UPGRADE_ALREADY");
          if (upgradeState === "review") throw new Error("FEE_UPGRADE_REVIEW");
          if (upgradeState === "in_progress") throw new Error("FEE_UPGRADE_IN_PROGRESS");
          if (upgradeState === "confirmed_retry" && automatedFeeProgram?.enrollmentTransactionHash) {
              const message = `${feeUpgradeSuccessMessage(tokenSymbol || command.token, ponsBotTokenUrl(commandToken!))}${warning}`;
              await ctx.runMutation(internal.wallets.updateWalletRequest, {
                requestId, status: "confirmed", workflowStage: "automated_fee_upgrade_confirmed",
                transactionHash: automatedFeeProgram.enrollmentTransactionHash, finalMessage: message,
              });
              return { ok: true, transactionHash: automatedFeeProgram.enrollmentTransactionHash, message };
          }
          const factoryAddress = registry.contracts.pons_v2_factory;
          const distributorFactoryAddress = registry.contracts.pons_holder_distributor_factory;
          if (!safeAddress(factoryAddress) || !safeAddress(distributorFactoryAddress || "")) {
            throw new Error("Pons creator-fee contracts are not configured");
          }
          const liveLaunch = await signerRequest<{
            exists: boolean;
            creatorFeeRecipient: string | null;
            pairToken: string | null;
            distributor: string | null;
          }>("/v1/tokens/holder-distributor", {
            token: commandToken,
            distributorFactoryAddress,
            ponsFactoryAddress: factoryAddress,
          });
          if (!liveLaunch.exists || !liveLaunch.creatorFeeRecipient) throw new Error("FEE_UPGRADE_NOT_FOUND");
          if (liveLaunch.distributor && liveLaunch.creatorFeeRecipient.toLowerCase() === liveLaunch.distributor.toLowerCase()) {
            throw new Error("holder fee sharing is already enabled for this launch");
          }
          // A retry after the assignment was broadcast must verify that same
          // receipt, not reject the wallet because the vault is now recipient.
          if (upgradeState === "resume" && automatedFeeProgram
            && automatedFeeProgram.normalizedControllerAddress === wallet.address.toLowerCase()
            && liveLaunch.creatorFeeRecipient.toLowerCase() === automatedFeeProgram.normalizedVaultAddress) {
            const child = await ctx.runQuery(internal.wallets.getReconciliationContext, { requestId: `${requestId}:upgrade-assignment` });
            const hash = automatedFeeProgram.enrollmentTransactionHash || child?.request.transactionHash;
            if (!hash) throw new Error("FEE_UPGRADE_REVIEW");
            await ctx.runMutation(internal.automatedFeeEngine.markUpgradeAssignmentSubmitted, { programId: automatedFeeProgram._id, assignmentTransactionHash: hash });
            try {
              await ctx.runAction(internal.automatedFeeEngine.completeExistingLaunchUpgrade, { programId: automatedFeeProgram._id, assignmentTransactionHash: hash });
            } catch { throw new Error(AUTOMATED_FEE_WORKFLOW_CONTINUATION); }
            await ctx.runMutation(internal.wallets.recordAutomatedFeeUpgradeOutcome, { launchId: controlledLaunch.launchId, programId: automatedFeeProgram._id, assignmentTransactionHash: hash });
            const message = `${feeUpgradeSuccessMessage(tokenSymbol || command.token, ponsBotTokenUrl(commandToken!))}${warning}`;
            await ctx.runMutation(internal.wallets.updateWalletRequest, { requestId, status: "confirmed", workflowStage: "automated_fee_upgrade_confirmed", transactionHash: hash, finalMessage: message });
            return { ok: true, transactionHash: hash, message };
          }
          if (liveLaunch.creatorFeeRecipient.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("fee reassignment rights were not found");
          if (!liveLaunch.pairToken || !safeAddress(liveLaunch.pairToken)) {
            throw new Error("launch pair could not be verified");
          }
          workflowStage = "automated_fee_upgrade_vault_preparation";
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId, status: "simulating", workflowStage,
          });
          const upgrade = await ctx.runAction(
            internal.automatedFeeEngine.prepareExistingLaunchUpgrade,
            {
              launchId: controlledLaunch.launchId,
              requestId,
              controllerAddress: wallet.address,
              beneficiaryAddress: wallet.address,
              pairTokenAddress: liveLaunch.pairToken,
              ponsFactoryAddress: factoryAddress,
            },
          );
          if (upgrade.alreadyEnrolled) {
            throw new Error("this launch already uses automated fee processing");
          }
          let program = await ctx.runQuery(
            internal.automatedFeeEngine.enrollmentProgramStatus,
            { programId: upgrade.programId },
          );
          if (program?.status === "manual_review") {
            throw new Error("automated fee vault deployment requires manual review");
          }
          if (
            !program?.deploymentTransactionHash ||
            !automatedFeeDeploymentConfirmed(program)
          ) {
            throw new Error(AUTOMATED_FEE_WORKFLOW_CONTINUATION);
          }
          workflowStage = "automated_fee_upgrade_assignment";
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId, status: "simulating", workflowStage,
          });
          const assignment = await executeConfirmedStep(
            ctx,
            wallet,
            args.xUserId,
            args.sourcePostId,
            `${requestId}:upgrade-assignment`,
            command,
            {
              type: "pons_v2_transfer_creator_fee_recipient",
              token: commandToken,
              newRecipient: upgrade.vaultAddress,
              factoryAddress,
            },
          );
          await ctx.runMutation(internal.automatedFeeEngine.markUpgradeAssignmentSubmitted, {
            programId: upgrade.programId,
            assignmentTransactionHash: assignment.transactionHash,
          });
          if (
            !(await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, {
              walletId: wallet._id,
              requestId,
              leaseToken: executionLeaseToken,
            }))
          ) {
            throw new Error("wallet execution lease was lost before automated fee enrollment completed");
          }
          workflowStage = "automated_fee_upgrade_verification";
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId, status: "simulating", workflowStage,
          });
          try {
            await ctx.runAction(internal.automatedFeeEngine.completeExistingLaunchUpgrade, {
              programId: upgrade.programId,
              assignmentTransactionHash: assignment.transactionHash,
            });
          } catch {
            throw new Error(AUTOMATED_FEE_WORKFLOW_CONTINUATION);
          }
          await ctx.runMutation(internal.wallets.recordAutomatedFeeUpgradeOutcome, {
            launchId: controlledLaunch.launchId,
            programId: upgrade.programId,
            assignmentTransactionHash: assignment.transactionHash,
          });
          const message = `${feeUpgradeSuccessMessage(tokenSymbol || command.token, ponsBotTokenUrl(commandToken!))}${warning}`;
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId,
            status: "confirmed",
            workflowStage: "automated_fee_upgrade_confirmed",
            transactionHash: assignment.transactionHash,
            finalMessage: message,
          });
          return { ok: true, transactionHash: assignment.transactionHash, message };
        }
        if (
          command.kind === "reassign_fees" &&
          command.recipient === "holders"
        ) {
          if (!commandToken || !safeAddress(commandToken))
            throw new Error("token lookup was not resolved by the registry");
          const distributorFactoryAddress =
            registry.contracts.pons_holder_distributor_factory;
          const factoryAddress = registry.contracts.pons_v2_factory;
          if (
            !safeAddress(distributorFactoryAddress || "") ||
            !safeAddress(factoryAddress || "")
          ) {
            throw new Error("holder fee sharing contracts are not configured");
          }
          if (
            automatedFeeProgram &&
            (!(["enrolled", "paused"] as string[]).includes(automatedFeeProgram.status) ||
              process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() !== "true" ||
              process.env.AUTOMATED_FEE_BOT_COMMANDS_ENABLED?.trim().toLowerCase() !== "true")
          ) {
            throw new Error("automated fee controller commands are not enabled");
          }
          let info = await signerRequest<{
            distributor: string | null;
            creatorFeeRecipient: string | null;
          }>("/v1/tokens/holder-distributor", {
            token: commandToken,
            distributorFactoryAddress,
            ponsFactoryAddress: factoryAddress,
          });
          if (
            info.distributor &&
            info.creatorFeeRecipient?.toLowerCase() ===
              info.distributor.toLowerCase()
          ) {
            throw new Error(
              "holder fee sharing is already enabled for this launch",
            );
          }
          let createHash: string | undefined;
          if (!info.distributor) {
            const created = await executeConfirmedStep(
              ctx,
              wallet,
              args.xUserId,
              args.sourcePostId,
              `${requestId}:holder-distributor`,
              command,
              {
                type: "pons_v2_create_holder_distributor",
                token: commandToken,
                distributorFactoryAddress,
              },
            );
            createHash = created.transactionHash;
            if (
              !(await ctx.runMutation(
                internal.wallets.acquireWalletExecutionLock,
                {
                  walletId: wallet._id,
                  requestId,
                  leaseToken: executionLeaseToken,
                },
              ))
            ) {
              throw new Error(
                "wallet execution lease was lost before holder fee reassignment continued",
              );
            }
            info = await signerRequest<{
              distributor: string | null;
              creatorFeeRecipient: string | null;
            }>("/v1/tokens/holder-distributor", {
              token: commandToken,
              distributorFactoryAddress,
              ponsFactoryAddress: factoryAddress,
            });
          }
          if (!info.distributor || !safeAddress(info.distributor))
            throw new Error("holder fee distributor was not created");
          if (automatedFeeProgram) {
            if (
              !["enrolled", "paused"].includes(automatedFeeProgram.status) ||
              process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() !== "true" ||
              process.env.AUTOMATED_FEE_BOT_COMMANDS_ENABLED?.trim().toLowerCase() !== "true"
            ) {
              throw new Error("automated fee controller commands are not enabled");
            }
            const routed = await ctx.runAction(internal.automatedFeeEngine.executeVerifiedControllerChange, {
              requestId, programId: automatedFeeProgram._id, ownerXUserId: args.xUserId,
              walletRef: wallet.signerWalletRef, expectedAddress: wallet.address,
              operation: "holders", recipient: info.distributor,
            });
            await ctx.runMutation(internal.wallets.recordAutomatedFeeControllerOutcome, {
              tokenAddress: commandToken, transactionHash: routed.transactionHash,
              outcome: "holders", recipient: info.distributor,
            });
            const message = `✅ Success! Reassigned future creator fees for ${assetLabel(tokenSymbol || command.token)} to holders!\nYour TXN: ${transactionUrl(routed.transactionHash)}${warning}`;
            await ctx.runMutation(internal.wallets.updateWalletRequest, {
              requestId, status: "confirmed", workflowStage: "automated_holder_fee_sharing_enabled",
              transactionHash: routed.transactionHash, finalMessage: message,
            });
            return { ok: true, transactionHash: routed.transactionHash, message };
          }
          let routed: Awaited<ReturnType<typeof executeConfirmedStep>>;
          try {
            routed = await executeConfirmedStep(
              ctx,
              wallet,
              args.xUserId,
              args.sourcePostId,
              `${requestId}:holder-fee-route`,
              command,
              {
                type: "pons_v2_transfer_creator_fee_recipient",
                token: commandToken,
                newRecipient: info.distributor,
                factoryAddress,
              },
            );
          } catch (error) {
            if (createHash) {
              const message = `⚠️ The holder distributor was created, but future fees were not reassigned. Nothing else will run automatically. Distributor TXN: ${transactionUrl(createHash)} ${safeFailure(error, command.kind)}`;
              await ctx.runMutation(internal.wallets.updateWalletRequest, {
                requestId,
                status: "failed",
                workflowStage: "holder_fee_route",
                safeError: message,
                finalMessage: message,
              });
              return { ok: false, transactionHash: createHash, message };
            }
            throw error;
          }
          info = await signerRequest<{
            distributor: string | null;
            creatorFeeRecipient: string | null;
          }>("/v1/tokens/holder-distributor", {
            token: commandToken,
            distributorFactoryAddress,
            ponsFactoryAddress: factoryAddress,
          });
          if (
            !info.creatorFeeRecipient ||
            info.creatorFeeRecipient.toLowerCase() !==
              info.distributor?.toLowerCase()
          ) {
            throw new Error(
              "Pons did not confirm the holder distributor as creator fee recipient",
            );
          }
          await ctx.runMutation(
            internal.wallets.recordReassignedHolderFeeDistributor,
            {
              ownerXUserId: args.xUserId,
              controllerAddress: wallet.address,
              tokenAddress: commandToken,
              distributor: info.distributor,
              transactionHash: routed.transactionHash,
            },
          );
          const message = `✅ Success! Reassigned future creator fees for ${assetLabel(tokenSymbol || command.token)} to holders!\nYour TXN: ${transactionUrl(routed.transactionHash)}${warning}`;
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId,
            status: "confirmed",
            workflowStage: "holder_fee_sharing_enabled",
            transactionHash: routed.transactionHash,
            finalMessage: message,
          });
          return { ok: true, transactionHash: routed.transactionHash, message };
        }
        if (command.kind === "reassign_fees" && command.recipient !== "holders" && automatedFeeProgram) {
          if (
            automatedFeeProgram.status !== "enrolled" ||
            process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() !== "true" ||
            process.env.AUTOMATED_FEE_BOT_COMMANDS_ENABLED?.trim().toLowerCase() !== "true"
          ) {
            throw new Error("automated fee controller commands are not enabled");
          }
          const recipient = safeAddress(command.recipient) ? command.recipient : args.recipientAddress;
          if (!recipient || !safeAddress(recipient)) throw new Error("fee reassignment recipient is invalid");
          const routed = await ctx.runAction(internal.automatedFeeEngine.executeVerifiedControllerChange, {
            requestId, programId: automatedFeeProgram._id, ownerXUserId: args.xUserId,
            walletRef: wallet.signerWalletRef, expectedAddress: wallet.address,
            operation: "reassign", recipient,
          });
          await ctx.runMutation(internal.wallets.recordAutomatedFeeControllerOutcome, {
            tokenAddress: commandToken!, transactionHash: routed.transactionHash,
            outcome: "reassigned", recipient,
          });
          const message = `✅ Success! Reassigned future creator fees for ${assetLabel(tokenSymbol || command.token)}!\nYour TXN: ${transactionUrl(routed.transactionHash)}${warning}`;
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId, status: "confirmed", workflowStage: "automated_fee_control_reassigned",
            transactionHash: routed.transactionHash, finalMessage: message,
          });
          return { ok: true, transactionHash: routed.transactionHash, message };
        }
        if (command.kind === "swap_token_for_token") {
          const fromIsEth = /^eth$/i.test(command.fromToken);
          const toIsEth = /^eth$/i.test(command.toToken);
          const fromToken = fromIsEth
            ? undefined
            : await ctx.runQuery(internal.wallets.resolveKnownToken, {
                identifier: command.fromToken,
                walletId: wallet._id,
              });
          const toToken = toIsEth
            ? undefined
            : await ctx.runQuery(internal.wallets.resolveKnownToken, {
                identifier: command.toToken,
                walletId: wallet._id,
              });
          if (!fromIsEth && (!fromToken || !safeAddress(fromToken)))
            throw new Error(
              "source token lookup was not resolved by the registry",
            );
          if (!toIsEth && (!toToken || !safeAddress(toToken)))
            throw new Error(
              "destination token lookup was not resolved by the registry",
            );
          if (
            (fromIsEth && toIsEth) ||
            (fromToken &&
              toToken &&
              fromToken.toLowerCase() === toToken.toLowerCase())
          )
            throw new Error("a swap needs two different assets");

          const txns: string[] = [];
          let ethAmount: string;
          let targetSpendUnit: "eth" | "usd" = "eth";
          let sourceCompleted = false;
          try {
            const reserveEthForTarget = async (requestedEth?: string) => {
              const factoryAddress = registry.contracts.pons_v2_factory;
              if (!safeAddress(factoryAddress))
                throw new Error("Pons factory is not configured");
              const targetPair = await signerRequest<PonsPairInfo>(
                "/v1/tokens/pons-pair",
                { token: toToken!, factoryAddress },
              );
              const reservedGasUnits = targetPair.isPons && !targetPair.nativePair
                ? 1_200_000
                : 600_000;
              const spendable = await signerRequest<{
                raw: string; display: string; gasReserveRaw: string;
              }>("/v1/wallets/spendable-eth", {
                chainId: ROBINHOOD_CHAIN_ID,
                walletRef: wallet.signerWalletRef,
                expectedAddress: wallet.address,
                ownerReference: `x:${args.xUserId}`,
                reservedGasUnits,
                ...(requestedEth ? { requestedEth } : {}),
              });
              if (!/^\d+$/.test(spendable.raw) || BigInt(spendable.raw) <= 0n)
                throw new Error("ETH balance resolves to zero after reserving gas");
              return spendable.display;
            };
            if (fromToken && toToken) {
              const factoryAddress = registry.contracts.pons_v2_factory;
              const wethAddress = registry.contracts.weth;
              const quoterAddress = registry.contracts.swap_quoter;
              if (
                !safeAddress(factoryAddress) ||
                !safeAddress(wethAddress) ||
                !safeAddress(quoterAddress)
              )
                throw new Error("swap contracts are missing from the registry");
              const targetPair = await signerRequest<PonsPairInfo>(
                "/v1/tokens/pons-pair",
                { token: toToken, factoryAddress },
              );
              if (
                command.unit === "usd" &&
                targetPair.isPons &&
                !targetPair.nativePair &&
                targetPair.pairToken?.toLowerCase() === fromToken.toLowerCase()
              ) {
                const quoted = await signerRequest<{
                  raw: string;
                  display: string;
                }>("/v1/tokens/usd-amount", {
                  token: fromToken,
                  amount: command.amount,
                  wethAddress,
                  quoterAddress,
                });
                if (
                  !/^\d+$/.test(quoted.raw) ||
                  !/^[0-9]+(?:\.[0-9]+)?$/.test(quoted.display) ||
                  BigInt(quoted.raw) <= 0n
                )
                  throw new Error("direct pair amount was not verified");
                const before = await exactTokenBalance(
                  wallet,
                  args.xUserId,
                  toToken,
                );
                const directBuy: Extract<WalletCommand, { kind: "buy" }> = {
                  kind: "buy",
                  amount: quoted.display,
                  unit: "pair",
                  token: command.toToken,
                  pairAsset: fromToken,
                  slippageBps: command.slippageBps,
                };
                const direct = await executeConfirmedStep(
                  ctx,
                  wallet,
                  args.xUserId,
                  args.sourcePostId,
                  `${requestId}:direct-pair-buy`,
                  directBuy,
                  await operationFor(
                    directBuy,
                    undefined,
                    undefined,
                    undefined,
                    toToken,
                    registry,
                  ),
                );
                const after = await exactTokenBalance(
                  wallet,
                  args.xUserId,
                  toToken,
                );
                const received = BigInt(after.raw) - BigInt(before.raw);
                if (received <= 0n || after.decimals !== before.decimals)
                  throw new Error("destination token output was not verified");
                await Promise.all([
                  ctx.runMutation(internal.wallets.indexWalletToken, {
                    walletId: wallet._id,
                    tokenAddress: fromToken,
                    symbol: command.fromToken,
                    involvedByLaunch: false,
                    involvedByTransaction: true,
                  }),
                  ctx.runMutation(internal.wallets.indexWalletToken, {
                    walletId: wallet._id,
                    tokenAddress: toToken,
                    symbol: command.toToken,
                    involvedByLaunch: false,
                    involvedByTransaction: true,
                  }),
                ]);
                const message = `✅ Success! Swapped $${command.amount} of ${assetLabel(command.fromToken)} directly for ${significantAmount(formatUnits(received, after.decimals))} ${assetLabel(command.toToken)}!\nYour TXN: ${transactionUrl(direct.transactionHash)}${warning}`;
                await ctx.runMutation(internal.wallets.updateWalletRequest, {
                  requestId,
                  status: "confirmed",
                  transactionHash: direct.transactionHash,
                  finalMessage: message,
                });
                return {
                  ok: true,
                  transactionHash: direct.transactionHash,
                  message,
                };
              }
            }
            if (fromIsEth) {
              if (command.unit !== "percent" || command.amount !== "100")
                throw new Error("an ETH source swap must specify all of the ETH balance");
              // A linked-asset target can require the ETH funding swap, an
              // approval, and the final paired-asset buy. Reserve a live
              // max-fee envelope for that whole sequence before spending ETH.
              ethAmount = await reserveEthForTarget();
              targetSpendUnit = "eth";
            } else {
              const sourceSale: WalletCommand = {
                kind: "sell",
                amount: command.amount,
                unit: command.unit,
                token: command.fromToken,
                slippageBps: command.slippageBps,
              };
              const sold = await executeConfirmedStep(
                ctx,
                wallet,
                args.xUserId,
                args.sourcePostId,
                `${requestId}:source-sale`,
                sourceSale,
                await operationFor(
                  sourceSale,
                  undefined,
                  undefined,
                  undefined,
                  fromToken,
                  registry,
                ),
              );
              if (
                !(await ctx.runMutation(
                  internal.wallets.acquireWalletExecutionLock,
                  {
                    walletId: wallet._id,
                    requestId,
                    leaseToken: executionLeaseToken,
                  },
                ))
              ) {
                throw new Error(
                  "wallet execution lease was lost after the source sale",
                );
              }
              txns.push(sold.transactionHash);
              sourceCompleted = true;
              if (!sold.tradeOutputDisplay || !sold.tradeOutputTokenAddress)
                throw new Error("source sale output was not verified");
              const outputAmount = tradeDisplayAmount(sold.tradeOutputDisplay);
              if (/^0x0{40}$/i.test(sold.tradeOutputTokenAddress)) {
                ethAmount = outputAmount;
              } else {
                const bridgeSale: WalletCommand = {
                  kind: "sell",
                  amount: outputAmount,
                  unit: "token",
                  token: sold.tradeOutputTokenAddress,
                  slippageBps: command.slippageBps,
                };
                const bridged = await executeConfirmedStep(
                  ctx,
                  wallet,
                  args.xUserId,
                  args.sourcePostId,
                  `${requestId}:source-pair-to-eth`,
                  bridgeSale,
                  await operationFor(
                    bridgeSale,
                    undefined,
                    undefined,
                    undefined,
                    sold.tradeOutputTokenAddress,
                    registry,
                  ),
                );
                if (
                  !(await ctx.runMutation(
                    internal.wallets.acquireWalletExecutionLock,
                    {
                      walletId: wallet._id,
                      requestId,
                      leaseToken: executionLeaseToken,
                    },
                  ))
                ) {
                  throw new Error(
                    "wallet execution lease was lost after the bridge sale",
                  );
                }
                txns.push(bridged.transactionHash);
                if (
                  !bridged.tradeOutputDisplay ||
                  !bridged.tradeOutputTokenAddress ||
                  !/^0x0{40}$/i.test(bridged.tradeOutputTokenAddress)
                )
                  throw new Error("ETH bridge output was not verified");
                ethAmount = tradeDisplayAmount(bridged.tradeOutputDisplay);
              }
              // Do not blindly spend every wei produced by the source sale.
              // Keep the requested proceeds when the wallet already has gas,
              // otherwise cap them just enough to preserve the target steps.
              if (!toIsEth) ethAmount = await reserveEthForTarget(ethAmount);
            }

            if (toIsEth) {
              const message = `✅ Success! Swapped ${command.unit === "percent" ? "all" : `$${command.amount} of`} ${assetLabel(command.fromToken)} for ETH!\n${txns.map((hash, index) => `Swap ${index + 1} TXN: ${transactionUrl(hash)}`).join("\n")}${warning}`;
              await ctx.runMutation(internal.wallets.updateWalletRequest, {
                requestId,
                status: "confirmed",
                transactionHash: txns.at(-1)!,
                finalMessage: message,
              });
              return { ok: true, transactionHash: txns.at(-1), message };
            }

            const targetBefore = await exactTokenBalance(
              wallet,
              args.xUserId,
              toToken!,
            );
            const targetBuy: Extract<WalletCommand, { kind: "buy" }> = {
              kind: "buy",
              amount: ethAmount,
              unit: targetSpendUnit,
              token: command.toToken,
              slippageBps: command.slippageBps,
            };
            const funded = await fundedBuyCommand(
              ctx,
              wallet,
              args.xUserId,
              args.sourcePostId,
              `${requestId}:target`,
              targetBuy,
              toToken!,
              registry,
              executionLeaseToken,
              requestId,
            );
            if (funded.fundingTransactionHash)
              txns.push(funded.fundingTransactionHash);
            const bought = await executeConfirmedStep(
              ctx,
              wallet,
              args.xUserId,
              args.sourcePostId,
              `${requestId}:target-buy`,
              funded.command,
              await operationFor(
                funded.command,
                undefined,
                undefined,
                undefined,
                toToken,
                registry,
              ),
            );
            if (
              !(await ctx.runMutation(
                internal.wallets.acquireWalletExecutionLock,
                {
                  walletId: wallet._id,
                  requestId,
                  leaseToken: executionLeaseToken,
                },
              ))
            ) {
              throw new Error(
                "wallet execution lease was lost after the target purchase",
              );
            }
            txns.push(bought.transactionHash);
            const targetAfter = await exactTokenBalance(
              wallet,
              args.xUserId,
              toToken!,
            );
            const received = BigInt(targetAfter.raw) - BigInt(targetBefore.raw);
            if (
              received <= 0n ||
              targetAfter.decimals !== targetBefore.decimals
            )
              throw new Error("destination token output was not verified");
            const receivedDisplay = formatUnits(received, targetAfter.decimals);
            const indexing: Array<Promise<unknown>> = [
              ctx.runMutation(internal.wallets.indexWalletToken, {
                walletId: wallet._id,
                tokenAddress: toToken!,
                symbol: command.toToken,
                involvedByLaunch: false,
                involvedByTransaction: true,
              }),
            ];
            if (fromToken)
              indexing.push(
                ctx.runMutation(internal.wallets.indexWalletToken, {
                  walletId: wallet._id,
                  tokenAddress: fromToken,
                  symbol: command.fromToken,
                  involvedByLaunch: false,
                  involvedByTransaction: true,
                }),
              );
            await Promise.all(indexing);
            const message = `✅ Success! Swapped ${command.unit === "percent" ? "all" : `$${command.amount} of`} ${assetLabel(command.fromToken)} for ${significantAmount(receivedDisplay)} ${assetLabel(command.toToken)}!\n${txns.map((hash, index) => `Swap ${index + 1} TXN: ${transactionUrl(hash)}`).join("\n")}${warning}`;
            await ctx.runMutation(internal.wallets.updateWalletRequest, {
              requestId,
              status: "confirmed",
              transactionHash: bought.transactionHash,
              finalMessage: message,
            });
            return {
              ok: true,
              transactionHash: bought.transactionHash,
              message,
            };
          } catch (error) {
            if (sourceCompleted && txns.length)
              throw new Error(
                `The ${assetLabel(command.fromToken)} sale completed, but the purchase of ${assetLabel(command.toToken)} did not. The intermediate proceeds remain in your wallet. Completed TXN: ${transactionUrl(txns.at(-1)!)} ${safeFailure(error)}`,
              );
            throw error;
          }
        }
        if (command.kind === "buy_and_send") {
          if (!commandToken || !safeAddress(commandToken))
            throw new Error("token lookup was not resolved by the registry");
          const recipient = safeAddress(command.recipient)
            ? command.recipient
            : args.recipientAddress;
          if (
            !recipient ||
            !safeAddress(recipient) ||
            recipient.toLowerCase() === DEAD_ADDRESS.toLowerCase()
          )
            throw new Error("invalid transfer destination");
          const before = await exactTokenBalance(
            wallet,
            args.xUserId,
            commandToken,
          );
          const buyCommand: WalletCommand = {
            kind: "buy",
            amount: command.amount,
            unit: command.unit,
            token: command.token,
            ...(command.pairAsset ? { pairAsset: command.pairAsset } : {}),
            slippageBps: command.slippageBps,
          };
          const funded = await fundedBuyCommand(
            ctx,
            wallet,
            args.xUserId,
            args.sourcePostId,
            `${requestId}:buy`,
            buyCommand,
            commandToken,
            registry,
            executionLeaseToken,
            requestId,
          );
          const buyOperation = await operationFor(
            funded.command,
            undefined,
            undefined,
            undefined,
            commandToken,
            registry,
          );
          const buy = await executeConfirmedStep(
            ctx,
            wallet,
            args.xUserId,
            args.sourcePostId,
            `${requestId}:buy`,
            funded.command,
            buyOperation,
          );
          if (
            !(await ctx.runMutation(
              internal.wallets.acquireWalletExecutionLock,
              {
                walletId: wallet._id,
                requestId,
                leaseToken: executionLeaseToken,
              },
            ))
          ) {
            throw new Error(
              "wallet execution lease was lost before sending purchased tokens",
            );
          }
          try {
            const after = await exactTokenBalance(
              wallet,
              args.xUserId,
              commandToken,
            );
            if (after.decimals !== before.decimals)
              throw new Error(
                "token decimals changed while processing the purchase",
              );
            const purchased = BigInt(after.raw) - BigInt(before.raw);
            if (purchased <= 0n)
              throw new Error(
                "the confirmed buy did not increase the token balance",
              );
            const sendCommand: WalletCommand = {
              kind: "send",
              amount: formatUnits(purchased, after.decimals),
              unit: "token",
              token: command.token,
              recipient: command.recipient,
            };
            const sendOperation = await operationFor(
              sendCommand,
              undefined,
              undefined,
              recipient,
              commandToken,
              registry,
            );
            const sent = await executeConfirmedStep(
              ctx,
              wallet,
              args.xUserId,
              args.sourcePostId,
              `${requestId}:send`,
              sendCommand,
              sendOperation,
            );
            await ctx.runMutation(internal.wallets.indexWalletToken, {
              walletId: wallet._id,
              tokenAddress: commandToken,
              symbol: tokenSymbol || "TOKEN",
              involvedByLaunch: false,
              involvedByTransaction: true,
            });
            const message = `✅ Success! Bought ${significantAmount(formatUnits(purchased, after.decimals))} ${assetLabel(tokenSymbol)} and sent it to ${destinationLabel(command.recipient)}!\nBuy TXN: ${transactionUrl(buy.transactionHash)}\nSend TXN: ${transactionUrl(sent.transactionHash)}${warning}`;
            await ctx.runMutation(internal.wallets.updateWalletRequest, {
              requestId,
              status: "confirmed",
              transactionHash: sent.transactionHash,
              finalMessage: message,
            });
            return {
              ok: true,
              transactionHash: sent.transactionHash,
              message,
            };
          } catch (error) {
            throw new Error(
              `The buy completed, but the send did not. The purchased tokens remain in your wallet. Buy TXN: ${transactionUrl(buy.transactionHash)} ${safeFailure(error)}`,
            );
          }
        }
        if (command.kind === "buy_and_burn") {
          if (!commandToken || !safeAddress(commandToken))
            throw new Error("token lookup was not resolved by the registry");
          const before = await exactTokenBalance(
            wallet,
            args.xUserId,
            commandToken,
          );
          const buyCommand: WalletCommand = {
            kind: "buy",
            amount: command.amount,
            unit: command.unit,
            token: command.token,
            ...(command.pairAsset ? { pairAsset: command.pairAsset } : {}),
            slippageBps: command.slippageBps,
          };
          const funded = await fundedBuyCommand(
            ctx,
            wallet,
            args.xUserId,
            args.sourcePostId,
            `${requestId}:buy`,
            buyCommand,
            commandToken,
            registry,
            executionLeaseToken,
            requestId,
          );
          const buyOperation = await operationFor(
            funded.command,
            undefined,
            undefined,
            undefined,
            commandToken,
            registry,
          );
          const buy = await executeConfirmedStep(
            ctx,
            wallet,
            args.xUserId,
            args.sourcePostId,
            `${requestId}:buy`,
            funded.command,
            buyOperation,
          );
          if (
            !(await ctx.runMutation(
              internal.wallets.acquireWalletExecutionLock,
              {
                walletId: wallet._id,
                requestId,
                leaseToken: executionLeaseToken,
              },
            ))
          ) {
            throw new Error(
              "wallet execution lease was lost before burning purchased tokens",
            );
          }
          try {
            const after = await exactTokenBalance(
              wallet,
              args.xUserId,
              commandToken,
            );
            if (after.decimals !== before.decimals)
              throw new Error(
                "token decimals changed while processing the purchase",
              );
            const purchased = BigInt(after.raw) - BigInt(before.raw);
            if (purchased <= 0n)
              throw new Error(
                "the confirmed buy did not increase the token balance",
              );
            const displayPurchased = formatUnits(purchased, after.decimals);
            // Value the exact confirmed output against the Pons token price at
            // the buy receipt's block. This represents the received tokens at
            // purchase time rather than the requested spend or a later price.
            const purchaseValue = await tokenUsdValueAtBlock(
              commandToken,
              displayPurchased,
              buy.blockNumber,
            );
            const burnCommand: WalletCommand = {
              kind: "burn",
              amount: displayPurchased,
              unit: "token",
              token: command.token,
            };
            const burnOperation = await operationFor(
              burnCommand,
              undefined,
              undefined,
              undefined,
              commandToken,
              registry,
            );
            const burned = await executeConfirmedStep(
              ctx,
              wallet,
              args.xUserId,
              args.sourcePostId,
              `${requestId}:burn`,
              burnCommand,
              burnOperation,
            );
            await ctx.runMutation(internal.wallets.indexWalletToken, {
              walletId: wallet._id,
              tokenAddress: commandToken,
              symbol: tokenSymbol || "TOKEN",
              involvedByLaunch: false,
              involvedByTransaction: true,
            });
            const message = `✅ Success! Bought and burned ${significantAmount(displayPurchased)} ${assetLabel(tokenSymbol)}${purchaseValue ? ` (${purchaseValue})` : ""}!\nBuy TXN: ${transactionUrl(buy.transactionHash)}\nBurn TXN: ${transactionUrl(burned.transactionHash)}${warning}`;
            await ctx.runMutation(internal.wallets.updateWalletRequest, {
              requestId,
              status: "confirmed",
              transactionHash: burned.transactionHash,
              finalMessage: message,
            });
            return {
              ok: true,
              transactionHash: burned.transactionHash,
              message,
            };
          } catch (error) {
            throw new Error(
              `The buy completed, but the burn did not. The purchased tokens remain in your wallet. Buy TXN: ${transactionUrl(buy.transactionHash)} ${safeFailure(error)}`,
            );
          }
        }
        let executionCommand: Exclude<WalletCommand, { kind: "unknown" }> =
          command;
        if (command.kind === "buy" && commandToken) {
          const funded = await fundedBuyCommand(
            ctx,
            wallet,
            args.xUserId,
            args.sourcePostId,
            requestId,
            command,
            commandToken,
            registry,
            executionLeaseToken,
            requestId,
          );
          executionCommand = funded.command;
          if (funded.fundingTransactionHash) {
            const pair = registry.pairs.find(
              (item: RuntimeRegistry["pairs"][number]) =>
                item.address.toLowerCase() ===
                String(funded.command.pairAsset).toLowerCase(),
            );
            pairFunding = {
              transactionHash: funded.fundingTransactionHash,
              asset: pair?.symbol || "paired asset",
            };
            if (
              !(await ctx.runMutation(
                internal.wallets.acquireWalletExecutionLock,
                {
                  walletId: wallet._id,
                  requestId,
                  leaseToken: executionLeaseToken,
                },
              ))
            ) {
              throw new Error(
                "wallet execution lease was lost after paired-asset funding",
              );
            }
          }
        }
        if (
          command.kind === "launch" &&
          command.devBuy &&
          command.devBuy.unit !== "pair"
        ) {
          const pairToken = resolveLaunchPair(
            command.pairToken,
            registry.pairs,
          );
          if (!/^0x0{40}$/i.test(pairToken)) {
            const funded = await fundPairAsset(
              ctx,
              wallet,
              args.xUserId,
              args.sourcePostId,
              requestId,
              pairToken,
              command.devBuy.amount,
              command.devBuy.unit,
              250,
              registry,
              executionLeaseToken,
              requestId,
            );
            executionCommand = {
              ...command,
              devBuy: { amount: funded.amount, unit: "pair" },
            };
            const pair = registry.pairs.find(
              (item: RuntimeRegistry["pairs"][number]) =>
                item.address.toLowerCase() === pairToken.toLowerCase(),
            );
            pairFunding = {
              transactionHash: funded.transactionHash,
              asset: pair?.symbol || "paired asset",
            };
            if (
              !(await ctx.runMutation(
                internal.wallets.acquireWalletExecutionLock,
                {
                  walletId: wallet._id,
                  requestId,
                  leaseToken: executionLeaseToken,
                },
              ))
            ) {
              throw new Error(
                "wallet execution lease was lost after launch funding",
              );
            }
          }
        }
        workflowStage = "operation_build";
        await ctx.runMutation(internal.wallets.updateWalletRequest, {
          requestId,
          status: "simulating",
          workflowStage,
        });
        let operation = await operationFor(
          executionCommand,
          args.mediaUrl,
          undefined,
          args.recipientAddress,
          commandToken,
          registry,
          wallet.address,
        );
        if (command.kind === "launch") {
          let automatedVault: { vaultAddress: string; deploymentSalt: string; controllerAddress: string } | undefined;
          workflowStage = "launch_address_preparation";
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId,
            status: "simulating",
            workflowStage,
            clearErrorState: true,
          });
          const enrollmentPairToken = String(operation.pairToken || "0x0000000000000000000000000000000000000000");
          const automatedPairSupported = /^0x0{40}$/i.test(enrollmentPairToken)
            || AUTOMATED_FEE_PAIR_ROUTES.some((route) => route.pairAsset.toLowerCase() === enrollmentPairToken.toLowerCase());
          if (
            process.env.AUTOMATED_BUYBACK_BURN_ENABLED?.trim().toLowerCase() === "true" &&
            process.env.AUTOMATED_FEE_NEW_LAUNCH_ENROLLMENT_ENABLED?.trim().toLowerCase() === "true" &&
            !(executionCommand as Extract<WalletCommand, { kind: "launch" }>).holderFeeSharing &&
            automatedPairSupported
          ) {
            const controllerAddress = String(operation.creatorFeeRecipient || wallet.address);
            const ponsFactoryAddress = registry.contracts.pons_v2_factory;
            if (!safeAddress(controllerAddress) || !safeAddress(ponsFactoryAddress)) {
              throw new Error("automated fee launch enrollment inputs are invalid");
            }
            const prediction = await ctx.runAction(internal.automatedFeeEngine.predictNewLaunchVault, {
              requestId, ponsFactoryAddress,
            });
            automatedVault = { ...prediction, controllerAddress };
            operation = { ...operation, creatorFeeRecipient: prediction.vaultAddress };
          }
          operation = await prepareAndPersistLaunch(
            ctx,
            wallet,
            args.xUserId,
            requestId,
            operation,
          );
          if (automatedVault) {
            const predictedTokenAddress = String(operation.predictedTokenAddress || "");
            const pairTokenAddress = String(operation.pairToken || "0x0000000000000000000000000000000000000000");
            if (!safeAddress(predictedTokenAddress) || !safeAddress(pairTokenAddress)) {
              throw new Error("automated fee launch enrollment inputs are invalid");
            }
            await ctx.runMutation(internal.automatedFeeEngine.reservePrelaunchEnrollment, {
              requestId, predictedTokenAddress, predictedVaultAddress: automatedVault.vaultAddress,
              controllerAddress: automatedVault.controllerAddress, beneficiaryAddress: automatedVault.controllerAddress,
              pairTokenAddress, distributionMode: "wallet", deploymentSalt: automatedVault.deploymentSalt,
            });
          }
          await applyAutomaticFreeLaunchSponsorship(
            ctx,
            wallet,
            args.xUserId,
            requestId,
            executionLeaseToken,
            executionCommand as Extract<WalletCommand, { kind: "launch" }>,
            registry,
            operation,
          );
          if (
            !(await ctx.runMutation(
              internal.wallets.acquireWalletExecutionLock,
              {
                walletId: wallet._id,
                requestId,
                leaseToken: executionLeaseToken,
              },
            ))
          ) {
            throw new Error("wallet execution lease was lost after launch sponsorship");
          }
        }
        workflowStage = "signer_submission";
        await ctx.runMutation(internal.wallets.updateWalletRequest, {
          requestId,
          status: "simulating",
          workflowStage,
        });
        const result = await submitWithApproval(
          ctx,
          wallet,
          args.xUserId,
          requestId,
          operation,
        );
        if (!/^0x[a-fA-F0-9]{64}$/.test(result.transactionHash))
          throw new Error("signer returned an invalid transaction hash");
        if (result.status === "reverted")
          throw new Error("transaction reverted");
        if (
          commandToken &&
          safeAddress(commandToken) &&
          "token" in command &&
          typeof command.token === "string"
        ) {
          await ctx.runMutation(internal.wallets.indexWalletToken, {
            walletId: wallet._id,
            tokenAddress: commandToken,
            symbol: tokenSymbol || "TOKEN",
            involvedByLaunch: false,
            involvedByTransaction: true,
          });
        }
        const launchMetadata =
          command.kind === "launch"
            ? resolveLaunchMetadata(command)
            : undefined;
        const launchBase =
          command.kind === "launch"
            ? {
                sourcePostId: args.sourcePostId,
                ownerXUserId: args.xUserId,
                launcherUsername: userContext.user.username,
                launchMode: command.launchMode,
                name: command.name,
                symbol: command.symbol,
                imageUri: String(operation.imageUri || ""),
                description: launchMetadata!.description,
                website: launchMetadata!.website,
                twitter: launchMetadata!.twitter,
                telegram: launchMetadata!.telegram,
                pairToken: String(operation.pairToken || ""),
                devBuyWei: result.devBuyWei || "0",
                tokenAddress: result.tokenAddress,
                poolAddress: result.poolAddress,
                positionId: result.positionId,
                devBuySucceeded: result.devBuySucceeded,
                creatorFeeRecipient: String(
                  operation.creatorFeeRecipient || wallet.address,
                ),
                normalizedCreatorFeeRecipient: String(
                  operation.creatorFeeRecipient || wallet.address,
                ).toLowerCase(),
                holderFeeSharing: command.holderFeeSharing,
                holderFeeSharingStatus: command.holderFeeSharing
                  ? ("pending" as const)
                  : undefined,
                holderFeeSharingAttempts: command.holderFeeSharing
                  ? 0
                  : undefined,
              }
            : undefined;
        const to =
          result.toAddress && safeAddress(result.toAddress)
            ? result.toAddress
            : operationDestination(operation);
        const callKind = result.callKind || String(operation.type);
        const feeReassignment =
          command.kind === "reassign_fees"
            ? {
                feeReassignmentTokenAddress: String(operation.token),
                feeReassignmentRecipientAddress: String(operation.newRecipient),
                feeReassignmentUpdatesLaunch: true,
              }
            : {};
        if (result.status === "prepared") {
          if (
            !result.signedTransaction ||
            !/^0x[a-fA-F0-9]+$/.test(result.signedTransaction)
          )
            throw new Error("signer returned an invalid prepared transaction");
          await ctx.runMutation(internal.wallets.recordPreparedExecution, {
            requestId,
            walletId: wallet._id,
            to,
            valueWei: result.valueWei || "0",
            callKind,
            transactionHash: result.transactionHash,
            signedTransaction: result.signedTransaction,
            tradeOutputTokenAddress: result.tradeOutputTokenAddress,
            tradeOutputBalanceBefore: result.tradeOutputBalanceBefore,
            involvedPairTokenAddress: result.involvedPairTokenAddress,
            ...feeReassignment,
            claimIncludesOtherLaunches,
            launch: launchBase,
          });
          workflowStage = "confirmation_wait";
          const reconciled = await waitForConfirmedRequest(ctx, requestId);
          await indexInvolvedPair(
            ctx,
            wallet._id,
            reconciled.involvedPairTokenAddress,
            registry.pairs,
          );
          if (command.kind === "launch" && reconciled.tokenAddress) {
            try {
              await enableHolderFeeSharing(
                ctx,
                wallet,
                args.xUserId,
                args.sourcePostId,
                requestId,
                command,
                reconciled.tokenAddress,
                registry,
              );
            } catch (error) {
              const message = `${await transactionMessage(publicCommand, reconciled.transactionHash, reconciled.tokenAddress)}\n⚠️ The token launched, but holder fee sharing was not enabled. ${safeFailure(error)}`;
              await ctx.runMutation(internal.wallets.updateWalletRequest, {
                requestId,
                status: "confirmed",
                transactionHash: reconciled.transactionHash,
                finalMessage: message,
              });
              return {
                ok: false,
                transactionHash: reconciled.transactionHash,
                message,
              };
            }
          }
          const message = await combineVaultClaimMessage(ctx, requestId, command,
            `${await transactionMessage(publicCommand, reconciled.transactionHash, reconciled.tokenAddress, reconciled.claimedDisplay, reconciled.tradeOutputDisplay, claimIncludesOtherLaunches, reconciled.tradeOutputTokenAddress, reconciled.valueWei)}${warning}`);
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId,
            status: "confirmed",
            transactionHash: reconciled.transactionHash,
            finalMessage: message,
          });
          return {
            ok: true,
            transactionHash: reconciled.transactionHash,
            message,
          };
        }
        if (result.status === "broadcast" || result.status === "pending") {
          await ctx.runMutation(internal.wallets.recordBroadcastExecution, {
            requestId,
            walletId: wallet._id,
            to,
            valueWei: result.valueWei || "0",
            callKind,
            transactionHash: result.transactionHash,
            launch: launchBase,
            tradeOutputTokenAddress: result.tradeOutputTokenAddress,
            tradeOutputBalanceBefore: result.tradeOutputBalanceBefore,
            involvedPairTokenAddress: result.involvedPairTokenAddress,
            ...feeReassignment,
            claimIncludesOtherLaunches,
          });
          workflowStage = "confirmation_wait";
          const reconciled = await waitForConfirmedRequest(ctx, requestId);
          await indexInvolvedPair(
            ctx,
            wallet._id,
            reconciled.involvedPairTokenAddress,
            registry.pairs,
          );
          if (command.kind === "launch" && reconciled.tokenAddress) {
            try {
              await enableHolderFeeSharing(
                ctx,
                wallet,
                args.xUserId,
                args.sourcePostId,
                requestId,
                command,
                reconciled.tokenAddress,
                registry,
              );
            } catch (error) {
              const message = `${await transactionMessage(publicCommand, reconciled.transactionHash, reconciled.tokenAddress)}\n⚠️ The token launched, but holder fee sharing was not enabled. ${safeFailure(error)}`;
              await ctx.runMutation(internal.wallets.updateWalletRequest, {
                requestId,
                status: "confirmed",
                transactionHash: reconciled.transactionHash,
                finalMessage: message,
              });
              return {
                ok: false,
                transactionHash: reconciled.transactionHash,
                message,
              };
            }
          }
          const message = await combineVaultClaimMessage(ctx, requestId, command,
            `${await transactionMessage(publicCommand, reconciled.transactionHash, reconciled.tokenAddress, reconciled.claimedDisplay, reconciled.tradeOutputDisplay, claimIncludesOtherLaunches, reconciled.tradeOutputTokenAddress, reconciled.valueWei)}${warning}`);
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId,
            status: "confirmed",
            transactionHash: reconciled.transactionHash,
            finalMessage: message,
          });
          return {
            ok: true,
            transactionHash: reconciled.transactionHash,
            message,
          };
        }
        if (
          command.kind === "launch" &&
          (!result.tokenAddress || !safeAddress(result.tokenAddress))
        ) {
          throw new Error("launch receipt did not contain a token address");
        }
        if (
          command.kind === "launch" &&
          (!result.poolAddress || !safeAddress(result.poolAddress))
        ) {
          throw new Error("launch receipt did not contain its curve position");
        }
        await ctx.runMutation(internal.wallets.recordConfirmedExecution, {
          requestId,
          walletId: wallet._id,
          to,
          valueWei: result.valueWei || "0",
          callKind,
          transactionHash: result.transactionHash,
          blockNumber: result.blockNumber,
          claimedDisplay: result.claimedDisplay,
          tradeOutputDisplay: result.tradeOutputDisplay,
          tradeOutputTokenAddress: result.tradeOutputTokenAddress,
          tradeOutputBalanceBefore: result.tradeOutputBalanceBefore,
          involvedPairTokenAddress: result.involvedPairTokenAddress,
          launch: launchBase,
          ...feeReassignment,
          claimIncludesOtherLaunches,
        });
        await indexInvolvedPair(
          ctx,
          wallet._id,
          result.involvedPairTokenAddress,
          registry.pairs,
        );
        if (command.kind === "launch") {
          try {
            await enableHolderFeeSharing(
              ctx,
              wallet,
              args.xUserId,
              args.sourcePostId,
              requestId,
              command,
              result.tokenAddress!,
              registry,
            );
          } catch (error) {
            const message = `${await transactionMessage(publicCommand, result.transactionHash, result.tokenAddress)}\n⚠️ The token launched, but holder fee sharing was not enabled. ${safeFailure(error)}`;
            await ctx.runMutation(internal.wallets.updateWalletRequest, {
              requestId,
              status: "confirmed",
              transactionHash: result.transactionHash,
              finalMessage: message,
            });
            return {
              ok: false,
              transactionHash: result.transactionHash,
              message,
            };
          }
          const message = `${await transactionMessage(publicCommand, result.transactionHash, result.tokenAddress)}${warning}`;
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId,
            status: "confirmed",
            transactionHash: result.transactionHash,
            finalMessage: message,
          });
          return { ok: true, transactionHash: result.transactionHash, message };
        }
        const message = await combineVaultClaimMessage(ctx, requestId, command,
          `${await transactionMessage(publicCommand, result.transactionHash, undefined, result.claimedDisplay, result.tradeOutputDisplay, claimIncludesOtherLaunches, result.tradeOutputTokenAddress, result.valueWei)}${warning}`);
        await ctx.runMutation(internal.wallets.updateWalletRequest, {
          requestId,
          status: "confirmed",
          transactionHash: result.transactionHash,
          finalMessage: message,
        });
        return { ok: true, transactionHash: result.transactionHash, message };
      } catch (error) {
        const rawMessage =
          error instanceof Error ? error.message : "wallet request failed";
        if (command.kind === "claim_fees") {
          const pendingClaim = await ctx.runQuery(internal.wallets.getReconciliationContext, { requestId });
          if (pendingClaim?.request.status === "confirmed") {
            const message = pendingClaim.request.finalMessage || await reconstructConfirmedMessage(ctx, pendingClaim.request, wallet)
              || `✅ This request was already completed!\nYour TXN: ${transactionUrl(pendingClaim.request.transactionHash!)}`;
            return { ok: true, message, transactionHash: pendingClaim.request.transactionHash };
          }
          if (pendingClaim?.transaction && ["prepared", "broadcast"].includes(pendingClaim.transaction.status)) {
            await ctx.runMutation(internal.wallets.updateWalletRequest, {
              requestId, status: pendingClaim.transaction.status === "prepared" ? "prepared" : "broadcast",
              transactionHash: pendingClaim.transaction.transactionHash, workflowStage: "claim_confirmation_wait",
            });
            if (source === "terminal") await ctx.scheduler.runAfter(20_000, internal.legacyClaims.resumeTerminalClaim, { requestId });
            return { ok: true, message: "", pending: true, deferred: true };
          }
          if (/no claimable creator fees/i.test(rawMessage) && (!command.token || resolvedClaimToken)) {
            const vaultClaim = await ctx.runQuery(internal.automatedFeeClaimInfo.requestedClaimResult, {
              requestId, ...await claimPriceArgument(),
            });
            if (vaultClaim.hasVaults && !vaultClaim.pending) {
              const vaultMessage = vaultClaim.noFees
                ? withClaimLpFeeOffer(vaultClaim.message)
                : vaultClaim.message;
              await ctx.runMutation(internal.wallets.updateWalletRequest, {
                requestId, status: vaultClaim.unavailable && !vaultClaim.paid ? "failed" : "confirmed",
                finalMessage: vaultMessage, workflowStage: "vault_claim_completed",
                diagnosticCode: vaultClaim.paid ? "VAULT_CREATOR_FEES_DELIVERED" : "VAULT_CLAIM_NO_PAYOUT",
              });
              return { ok: !vaultClaim.unavailable, message: vaultMessage };
            }
            const guidance = await ctx.runQuery(internal.automatedFeeClaimInfo.emptyLegacyClaimMessage, {
              walletId: wallet._id, ...(resolvedClaimToken ? { tokenAddress: resolvedClaimToken } : {}),
            }).catch(() => null);
            if (guidance) {
              const automated = guidance.kind !== "legacy";
              const guidanceMessage = withClaimLpFeeOffer(guidance.message);
              await ctx.runMutation(internal.wallets.updateWalletRequest, {
                requestId, status: automated ? "skipped" : "failed",
                workflowStage: automated ? "automated_fee_claim_information" : "empty_legacy_fee_claim_information",
                finalMessage: guidanceMessage,
                ...(!automated ? { safeError: guidanceMessage } : {}),
                diagnosticCode: automated ? "AUTOMATED_CREATOR_FEES" : "NO_CLAIMABLE_CREATOR_FEES",
                diagnosticDetail: `Legacy escrow is empty; fee-claim account category: ${guidance.kind}.`,
              });
              if (limitCharged) await ctx.runMutation(internal.wallets.refundWalletLimitIfPreBroadcast, { requestId, xUserId: args.xUserId });
              return { ok: automated, message: guidanceMessage };
            }
          }
        }
        if (rawMessage === CLAIM_WORKFLOW_CONTINUATION || rawMessage === AUTOMATED_FEE_WORKFLOW_CONTINUATION) {
          // A continuation is an intentionally persisted multi-step workflow,
          // not a failed wallet action. Keep the parent visibly in progress and
          // do not refund its quota while child transactions or enrollment
          // verification may still be outstanding.
          await ctx.runMutation(internal.wallets.updateWalletRequest, {
            requestId,
            status: "simulating",
            workflowStage,
          });
          if (rawMessage === CLAIM_WORKFLOW_CONTINUATION && source === "terminal") {
            await ctx.scheduler.runAfter(5_000, internal.legacyClaims.resumeTerminalClaim, { requestId });
            return { ok: true, message: "", deferred: true, pending: true };
          }
          if (args.source === "terminal" && args.terminalSessionId) {
            const continuationDelay = rawMessage === AUTOMATED_FEE_WORKFLOW_CONTINUATION ? 15_000 : 1_000;
            await ctx.scheduler.runAfter(
              continuationDelay,
              internal.wallets.resumeTerminalCommand,
              {
                sessionId: args.terminalSessionId,
                ownerXUserId: args.xUserId,
                sourcePostId: args.sourcePostId,
                requestId,
                text: args.text,
                parsedCommandJson:
                  args.parsedCommandJson || JSON.stringify(command),
                channel:
                  args.channel === "terminal_form"
                    ? "terminal_form"
                    : "terminal_chat",
              },
            );
            return { ok: true, message: "", deferred: true };
          }
          // Do not throw across the Convex action boundary: wrappers previously
          // hid the continuation signal from X and produced a premature reply.
          return { ok: true, message: "", deferred: true, pending: true };
        }
        const baseMessage = safeFailure(error, command.kind, resolvedReplySymbol);
        const message = pairFunding
          ? `The ${pairFunding.asset} purchase completed, but the final ${command.kind === "launch" ? "launch" : "buy"} did not. The ${pairFunding.asset} remains in your wallet. Funding TXN: ${transactionUrl(pairFunding.transactionHash)} ${baseMessage}`
          : baseMessage;
        const userMessage = await combineVaultClaimMessage(ctx, requestId, command,
          fundingMessage(message, wallet.address, args.sourcePostId));
        await ctx.runMutation(internal.wallets.updateWalletRequest, {
          requestId,
          status: "failed",
          safeError: message,
          finalMessage: userMessage,
          workflowStage,
          diagnosticCode: privateDiagnosticCode(error),
          diagnosticDetail: sanitizedDiagnosticDetail(error),
        });
        const limitRefunded = limitCharged
          ? await ctx.runMutation(
              internal.wallets.refundWalletLimitIfPreBroadcast,
              { requestId, xUserId: args.xUserId },
            )
          : false;
        // Multi-step stages use deterministic child request IDs. If a child is
        // merely taking longer to confirm, let the X interaction retry instead
        // of publishing a terminal failure. The retry reuses the confirmed or
        // still-broadcast child record and resumes at the next persisted stage.
        const parent = await ctx.runQuery(
          internal.wallets.getReconciliationContext,
          { requestId },
        );
        if (
          /confirmation timed out/i.test(rawMessage) &&
          !parent?.request.transactionHash
        )
          throw error;
        return {
          ok: false,
          message: `${userMessage}${limitRefunded ? "" : warning}`,
        };
      } finally {
        if (executionLockHeld)
          await ctx.runMutation(internal.wallets.releaseWalletExecutionLock, {
            walletId: wallet._id,
            requestId,
            leaseToken: executionLeaseToken,
          });
      }
    }
    return {
      ok: false,
      message: GENERAL_GUIDED_HELP_MESSAGE,
    };
  },
});

export const recordTerminalMessage = internalMutation({
  args: {
    sessionId: v.string(),
    ownerXUserId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    messageType: v.union(
      v.literal("chat"),
      v.literal("action"),
      v.literal("result"),
    ),
    text: v.string(),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Keep bounded user input, but retain the complete assistant quote/help.
    // Cutting every message at 1,000 characters hid LP terms and instructions.
    const text = args.text.slice(0, args.role === "assistant" ? 24_000 : 1_000);
    if (args.requestId) {
      const existing = await ctx.db
        .query("terminalMessages")
        .withIndex("by_session_request_role", (q) =>
          q
            .eq("sessionId", args.sessionId)
            .eq("requestId", args.requestId)
            .eq("role", args.role),
        )
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          messageType: args.messageType,
          text,
        });
        return existing._id;
      }
    }
    return ctx.db.insert("terminalMessages", {
      ...args,
      text,
      createdAt: Date.now(),
    });
  },
});

async function webSessionHash(sessionId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sessionId),
  );
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function hasActiveTerminalSession(ctx: ActionCtx, ownerXUserId: string, sessionId: string | undefined): Promise<boolean> {
  if (!sessionId || !/^web_[a-zA-Z0-9_-]{16,80}$/.test(sessionId)) return false;
  const session: Doc<"webWalletSessions"> | null = await ctx.runQuery(
    internal.wallets.webSessionRecord,
    { sessionIdHash: await webSessionHash(sessionId) },
  );
  return Boolean(session && session.ownerXUserId === ownerXUserId && session.revokedAt === undefined
    && session.expiresAt > Math.floor(Date.now() / 1_000));
}

export const registerWebSessionRecord = internalMutation({
  args: {
    sessionIdHash: v.string(),
    ownerXUserId: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("webWalletSessions")
      .withIndex("by_session_hash", (q) =>
        q.eq("sessionIdHash", args.sessionIdHash),
      )
      .unique();
    const now = Date.now();
    if (existing)
      await ctx.db.patch(existing._id, {
        ownerXUserId: args.ownerXUserId,
        expiresAt: args.expiresAt,
        revokedAt: undefined,
        updatedAt: now,
      });
    else
      await ctx.db.insert("webWalletSessions", {
        ...args,
        createdAt: now,
        updatedAt: now,
      });
  },
});

export const webSessionRecord = internalQuery({
  args: { sessionIdHash: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("webWalletSessions")
      .withIndex("by_session_hash", (q) =>
        q.eq("sessionIdHash", args.sessionIdHash),
      )
      .unique(),
});

export const terminalGuidedHelpContext = internalQuery({
  args: { sessionId: v.string(), ownerXUserId: v.string() },
  handler: async (ctx, args) => {
    const recent = await ctx.db
      .query("terminalMessages")
      .withIndex("by_session_created_at", q => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(4);
    const latest = recent[0];
    if (!latest || latest.ownerXUserId !== args.ownerXUserId || latest.role !== "assistant"
      || latest.createdAt < Date.now() - GUIDED_HELP_TTL_MS) return null;
    const operation = guidedHelpOperationFromPrompt(latest.text);
    const sourceText = recent.slice(1).find(message => message.role === "user")?.text;
    return operation ? { operation, sourceText } : null;
  },
});

export const terminalGasResumeContext = internalQuery({
  args: { sessionId: v.string(), ownerXUserId: v.string() },
  handler: async (ctx, args) => {
    const recent = await ctx.db.query("terminalMessages")
      .withIndex("by_session_created_at", q => q.eq("sessionId", args.sessionId))
      .order("desc").take(8);
    const latest = recent[0];
    if (!latest || latest.ownerXUserId !== args.ownerXUserId || latest.role !== "assistant"
      || latest.createdAt < Date.now() - GUIDED_HELP_TTL_MS
      || latest.resumeConsumedByRequestId
      || !/fund your wallet with ETH for gas[\s\S]*reply\s+[“\"]resume[”\"]/i.test(latest.text)) return null;
    const sourceIndex = recent.slice(1).findIndex(message => message.role === "user" && !isResumeReply(message.text)) + 1;
    if (sourceIndex <= 0) return null;
    const source = recent[sourceIndex];
    const prompt = recent.slice(sourceIndex + 1).find(message => message.role === "assistant"
      && guidedHelpOperationFromPrompt(message.text));
    const operation = prompt ? guidedHelpOperationFromPrompt(prompt.text) : null;
    return source?.text ? {
      sourceText: operation ? guidedHelpCommandText(source.text, operation) : source.text,
      promptMessageId: latest._id,
    } : null;
  },
});

export const claimTerminalGasResume = internalMutation({
  args: { promptMessageId: v.id("terminalMessages"), sessionId: v.string(), ownerXUserId: v.string(), requestId: v.string() },
  handler: async (ctx, args) => {
    const prompt = await ctx.db.get(args.promptMessageId);
    if (!prompt || prompt.sessionId !== args.sessionId || prompt.ownerXUserId !== args.ownerXUserId
      || prompt.role !== "assistant" || prompt.createdAt < Date.now() - GUIDED_HELP_TTL_MS
      || !/fund your wallet with ETH for gas[\s\S]*reply\s+[“\"]resume[”\"]/i.test(prompt.text)) return false;
    if (prompt.resumeConsumedByRequestId) return prompt.resumeConsumedByRequestId === args.requestId;
    await ctx.db.patch(prompt._id, { resumeConsumedByRequestId: args.requestId });
    return true;
  },
});

export const revokeWebSessionRecord = internalMutation({
  args: { sessionIdHash: v.string(), ownerXUserId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("webWalletSessions")
      .withIndex("by_session_hash", (q) =>
        q.eq("sessionIdHash", args.sessionIdHash),
      )
      .unique();
    if (existing?.ownerXUserId === args.ownerXUserId && !existing.revokedAt)
      await ctx.db.patch(existing._id, {
        revokedAt: Date.now(),
        updatedAt: Date.now(),
      });
  },
});

export const consumeTerminalLimit = internalMutation({
  args: {
    ownerXUserId: v.string(),
    channel: v.union(v.literal("terminal_chat"), v.literal("terminal_form")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const limits =
      args.channel === "terminal_chat"
        ? { window: 40, daily: 500 }
        : { window: 100, daily: 2_000 };
    const key = `${args.channel}:${args.ownerXUserId}`;
    const record = await ctx.db
      .query("terminalRateLimits")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    const sameDay = record?.utcDay === day;
    const sameWindow = Boolean(
      record && now - record.windowStartedAt < 10 * 60_000,
    );
    const dailyCount = sameDay ? record!.dailyCount : 0;
    const windowCount = sameWindow ? record!.windowCount : 0;
    if (dailyCount >= limits.daily || windowCount >= limits.window)
      return false;
    const value = {
      utcDay: day,
      dailyCount: dailyCount + 1,
      windowStartedAt: sameWindow ? record!.windowStartedAt : now,
      windowCount: windowCount + 1,
      updatedAt: now,
    };
    if (record) await ctx.db.patch(record._id, value);
    else await ctx.db.insert("terminalRateLimits", { key, ...value });
    return true;
  },
});

/**
 * Pool discovery is substantially more expensive than an ordinary terminal
 * message. Limit user-visible searches per user per UTC day;
 * returned pool count and quote-time safety refreshes do not consume slots.
 */
export const consumeTerminalLiquiditySearch = internalMutation({
  args: { ownerXUserId: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    if (!/^web_[a-zA-Z0-9_-]{16,80}$/.test(args.sessionId)) return { allowed: false, remaining: 0, warn: false };
    // executeTerminalCommand validates the live authenticated session before
    // the internal liquidity action can reach this mutation.
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const key = `liquidity_search:${args.ownerXUserId}`;
    const record = await ctx.db.query("terminalRateLimits")
      .withIndex("by_key", q => q.eq("key", key)).unique();
    const sameDay = record?.utcDay === day;
    const used = sameDay ? record!.dailyCount : 0;
    if (used >= 15) return { allowed: false, remaining: 0, warn: false };
    const nextCount = used + 1;
    const value = {
      utcDay: day,
      dailyCount: nextCount,
      windowStartedAt: sameDay ? record!.windowStartedAt : now,
      windowCount: nextCount,
      updatedAt: now,
    };
    if (record) await ctx.db.patch(record._id, value);
    else await ctx.db.insert("terminalRateLimits", { key, ...value });
    return { allowed: true, remaining: 15 - nextCount, warn: nextCount === 10 };
  },
});

export const listTerminalHistory = internalQuery({
  args: {
    ownerXUserId: v.string(),
    sessionId: v.string(),
    includeCatalog: v.boolean(),
    includePublicCatalog: v.optional(v.boolean()),
    updatedAfter: v.optional(v.number()),
    feesUpdatedAfter: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const activeSince = Date.now() - 30 * 24 * 60 * 60_000;
    const sharedCatalog = args.includeCatalog && args.includePublicCatalog !== false;
    const readStartedAt = Date.now();
    const delta = args.updatedAfter !== undefined && !args.includeCatalog;
    const [
      messages,
      requests,
      houdiniReviews,
      xHoudiniQuotes,
      launches,
      launchCatalog,
      registryTokens,
      feeHistory,
    ] = await Promise.all([
      delta
        ? ctx.db
            .query("terminalMessages")
            .withIndex("by_session_created_at", (q) =>
              q.eq("sessionId", args.sessionId).gt("createdAt", args.updatedAfter!),
            )
            .order("desc")
            .take(40)
        : ctx.db
            .query("terminalMessages")
            .withIndex("by_session_created_at", (q) => q.eq("sessionId", args.sessionId))
            .order("desc")
            .take(40),
      // Multi-step operations create internal child requests for each onchain
      // step. Read enough raw rows to retain 40 user-level actions after those
      // implementation details are collapsed below.
      delta
        ? ctx.db
            .query("walletRequests")
            .withIndex("by_owner_updated_at", (q) =>
              q.eq("ownerXUserId", args.ownerXUserId).gt("updatedAt", args.updatedAfter!),
            )
            .order("desc")
            .take(80)
        : ctx.db
            .query("walletRequests")
            .withIndex("by_owner_created_at", (q) => q.eq("ownerXUserId", args.ownerXUserId))
            .order("desc")
            .take(160),
      // Houdini funding is executed through the ordinary wallet-send path for
      // safety and reconciliation. Keep that request in the audit trail, but
      // suppress its child row from Recent Actions because the corresponding
      // multi-chain/private swap is the user-level action shown there.
      delta
        ? ctx.db
            .query("houdiniQuoteReviews")
            .withIndex("by_owner_updated_at", (q) =>
              q.eq("ownerXUserId", args.ownerXUserId).gt("updatedAt", args.updatedAfter!),
            )
            .order("desc")
            .take(40)
        : ctx.db
            .query("houdiniQuoteReviews")
            .withIndex("by_owner_created_at", (q) => q.eq("ownerXUserId", args.ownerXUserId))
            .order("desc")
            .take(100),
      delta
        ? ctx.db
            .query("xHoudiniQuotes")
            .withIndex("by_owner_updated_at", (q) =>
              q.eq("ownerXUserId", args.ownerXUserId).gt("updatedAt", args.updatedAfter!),
            )
            .order("desc")
            .take(40)
        : ctx.db
            .query("xHoudiniQuotes")
            .withIndex("by_owner_created_at", (q) => q.eq("ownerXUserId", args.ownerXUserId))
            .order("desc")
            .take(100),
      args.includeCatalog
        ? ctx.db
            .query("tokenLaunches")
            .withIndex("by_owner_created_at", (q) =>
              q.eq("ownerXUserId", args.ownerXUserId),
            )
            .order("desc")
            .take(100)
        : Promise.resolve([]),
      sharedCatalog
        ? ctx.db
            .query("tokenLaunches")
            .withIndex("by_public_created_at", (q) =>
              q.eq("publicPublished", true),
            )
            .order("desc")
            .take(2_000)
        : Promise.resolve([]),
      sharedCatalog
        ? ctx.db
            .query("tokenRegistry")
            .filter((q) => q.eq(q.field("active"), true))
            .take(250)
        : Promise.resolve([]),
      terminalFeeReceipts(ctx, args.ownerXUserId, args.includeCatalog ? undefined : args.feesUpdatedAfter),
    ]);
    const activeLaunches = sharedCatalog && launchCatalog.length >= 2_000
      ? await ctx.db
          .query("tokenLaunches")
          .withIndex("by_public_last_buy", (q) =>
            q.eq("publicPublished", true).gte("publicLastBuyAt", activeSince),
          )
          .order("desc")
          .collect()
      : [];
    const catalog = new Map<
      string,
      { tokenAddress: string; symbol: string; name: string; pairToken?: string }
    >();
    const userRequestsBySource = new Map<string, (typeof requests)[number]>();
    const houdiniFundingRequestIds = new Set(
      [
        ...houdiniReviews.flatMap((review) =>
          review.fundingWalletRequestId ? [review.fundingWalletRequestId] : [],
        ),
        ...xHoudiniQuotes.flatMap((swap) =>
          swap.fundingRequestId ? [swap.fundingRequestId] : [],
        ),
      ],
    );
    for (const request of requests) {
      if (houdiniFundingRequestIds.has(request.requestId) || request.requestId.startsWith("houdini_")) continue;
      const current = userRequestsBySource.get(request.sourcePostId);
      // The parent request ID is a strict prefix of its child-step IDs, so it
      // is always the shortest record associated with one X post or terminal
      // event. This keeps the UI at one row per user request without deleting
      // the child records needed for reconciliation and transaction history.
      if (!current || request.requestId.length < current.requestId.length)
        userRequestsBySource.set(request.sourcePostId, request);
    }
    const userRequests = [...userRequestsBySource.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 40);
    const publishedOwnedLaunches = launches.filter(
      (item) => item.publicPublished === true && !isTokenIndexExcluded(item.tokenAddress),
    );
    for (const item of [
      ...launchCatalog,
      ...activeLaunches,
      ...publishedOwnedLaunches,
    ])
      if (item.tokenAddress && !isTokenIndexExcluded(item.tokenAddress))
        catalog.set(item.tokenAddress.toLowerCase(), {
          tokenAddress: item.tokenAddress,
          symbol: item.symbol,
          name: item.name,
          pairToken: item.pairToken,
        });
    for (const item of registryTokens)
      if (!isTokenIndexExcluded(item.address) && !catalog.has(item.normalizedAddress))
        catalog.set(item.normalizedAddress, {
          tokenAddress: item.address,
          symbol: item.symbol,
          name: item.name,
        });
    const lpExecutions = await ctx.db.query("liquidityExecutions")
      .withIndex("by_owner_updated", q => q.eq("ownerXUserId", args.ownerXUserId).gt("updatedAt", delta ? args.updatedAfter! : 0))
      .order("desc").take(40);
    const lpActions = await Promise.all(lpExecutions.map(async item => {
      const conversation = await ctx.db.get(item.conversationId);
      const draft = conversation ? JSON.parse(conversation.stateJson) as { fields?: { amount?: string; unit?: string; position?: string }; operation?: string; symbol?: string } : {};
      let plan: { claimPositions?: Array<{ positionId?: string }> } = {};
      try { plan = JSON.parse(item.planJson); } catch {}
      const steps = JSON.parse(item.stepsJson) as Array<{ transactionHash?: string; confirmed?: boolean }>;
      const responsePositionIds = item.response?.match(/\bLP-[A-F0-9]{8}\b/g) ?? [];
      const lpIdentifiers = [...new Set([
        ...(item.positionIds ?? []),
        ...(plan.claimPositions?.flatMap(position => position.positionId ? [position.positionId] : []) ?? []),
        ...(draft.fields?.position ? [draft.fields.position] : []),
        ...responsePositionIds,
      ].filter(position => /^LP-[A-F0-9]{8}$/.test(position)))];
      return { requestId: `liquidity:${item._id}`, kind: `liquidity_${draft.operation || "position"}`, amount: draft.fields?.amount, unit: draft.fields?.unit,
        token: draft.symbol, lpIdentifiers, status: item.status, source: conversation?.source || "terminal" as const,
        transactionHash: steps.at(-1)?.transactionHash, createdAt: item.createdAt, updatedAt: item.updatedAt,
      };
    }));
    return {
      feeReceipts: feeHistory.receipts,
      feesUpdatedThrough: feeHistory.updatedThrough,
      feesDelta: feeHistory.delta,
      messages: messages.reverse().map((item) => ({
        role: item.role,
        messageType: item.messageType,
        text: item.text,
        requestId: item.requestId,
        createdAt: item.createdAt,
      })),
      actions: [
        ...lpActions,
        ...userRequests.map((item) => {
        let command: Record<string, unknown> = {};
        try {
          command = JSON.parse(item.normalizedJson);
        } catch {}
        return {
          requestId: item.requestId,
          kind: item.kind,
          amount:
            typeof command.amount === "string" ? command.amount : undefined,
          unit: typeof command.unit === "string" ? command.unit : undefined,
          pairAsset:
            typeof command.pairAsset === "string"
              ? command.pairAsset
              : undefined,
          token:
            typeof command.token === "string"
              ? command.token
              : typeof command.fromToken === "string" &&
                  typeof command.toToken === "string"
                ? `${command.fromToken} → ${command.toToken}`
                : undefined,
          status: item.status,
          source: item.source || "x",
          transactionHash: item.transactionHash,
          safeError: item.safeError,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        };
        }),
        ...[
          ...new Map(
            xHoudiniQuotes
              .slice()
              .reverse()
              .filter((swap) => swap.confirmationRequired === false)
              .map((swap) => [swap.requestPostId, swap]),
          ).values(),
        ].map((swap) => ({
          requestId: `x-houdini:${swap._id}`,
          kind: swap.privateMode ? "private_swap" : "multi_chain_swap",
          amount: swap.sourceAmount,
          unit: swap.sourceUnit,
          token: `${swap.targetSymbol} on ${swap.targetChain}`,
          status:
            swap.status === "completed"
              ? "completed"
              : swap.status === "failed"
                ? "failed"
                : swap.status === "uncertain" ||
                    swap.status === "monitoring_timeout"
                  ? "checking"
                  : "processing",
          source: "x" as const,
          transactionHash: swap.fundingTransactionHash,
          orderId: swap.houdiniId,
          safeError: swap.safeError,
          createdAt: swap.createdAt,
          updatedAt: swap.updatedAt,
        })),
      ]
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 40),
      launches: publishedOwnedLaunches.flatMap((item) =>
        item.tokenAddress
          ? [
              {
                tokenAddress: item.tokenAddress,
                symbol: item.symbol,
                name: item.name,
                pairToken: item.pairToken,
              },
            ]
          : [],
      ),
      tokenCatalog: [...catalog.values()].sort((left, right) => {
        const priority = (symbol: string) =>
          symbol.toUpperCase() === "PONSBOT"
            ? 0
            : symbol.toUpperCase() === "PONS"
              ? 1
              : 2;
        return priority(left.symbol) - priority(right.symbol);
      }),
      catalogIncluded: args.includeCatalog,
      delta,
      updatedThrough: Math.max(
        args.updatedAfter || 0,
        // Empty sessions still need a cursor, otherwise every poll repeats the
        // full history query. Do not advance past a truncated result page.
        messages.length < 40 && requests.length < (delta ? 80 : 160) && houdiniReviews.length < (delta ? 40 : 100)
          && xHoudiniQuotes.length < (delta ? 40 : 100) && lpExecutions.length < 40 ? readStartedAt - 1 : 0,
        ...messages.map((item) => item.createdAt),
        ...requests.map((item) => item.updatedAt),
        ...houdiniReviews.map((item) => item.updatedAt || item.createdAt),
        ...xHoudiniQuotes.map((item) => item.updatedAt),
        ...lpExecutions.map((item) => item.updatedAt),
      ),
    };
  },
});

type TerminalHistoryResult = {
  feeReceipts: TerminalFeeReceipt[];
  feesUpdatedThrough: number;
  feesDelta: boolean;
  messages: Array<{
    role: "user" | "assistant";
    messageType: "chat" | "action" | "result";
    text: string;
    requestId?: string;
    createdAt: number;
  }>;
  actions: Array<{
    requestId: string;
    kind: string;
    amount?: string;
    unit?: string;
    pairAsset?: string;
    token?: string;
    lpIdentifiers?: string[];
    status: string;
    source: "x" | "terminal";
    transactionHash?: string;
    safeError?: string;
    createdAt: number;
    updatedAt: number;
  }>;
  launches: Array<{
    tokenAddress: string;
    symbol: string;
    name: string;
    pairToken?: string;
  }>;
  tokenCatalog: Array<{
    tokenAddress: string;
    symbol: string;
    name: string;
    pairToken?: string;
  }>;
  catalogIncluded: boolean;
  delta: boolean;
  updatedThrough: number;
};

export const terminalHistory = action({
  args: {
    secret: v.string(),
    ownerXUserId: v.string(),
    sessionId: v.string(),
    includeCatalog: v.optional(v.boolean()),
    includePublicCatalog: v.optional(v.boolean()),
    updatedAfter: v.optional(v.number()),
    feesUpdatedAfter: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TerminalHistoryResult> => {
    if (
      !process.env.WEB_AUTH_SECRET ||
      args.secret !== process.env.WEB_AUTH_SECRET
    )
      throw new Error("terminal authorization failed");
    if (!/^web_[a-zA-Z0-9_-]{16,80}$/.test(args.sessionId))
      throw new Error("invalid terminal session");
    return ctx.runQuery(internal.wallets.listTerminalHistory, {
      ownerXUserId: args.ownerXUserId,
      sessionId: args.sessionId,
      includeCatalog: args.includeCatalog !== false,
      includePublicCatalog: args.includePublicCatalog,
      updatedAfter: args.updatedAfter,
      feesUpdatedAfter: args.feesUpdatedAfter,
    });
  },
});

export const executeTerminalCommand = action({
  args: {
    secret: v.string(),
    ownerXUserId: v.string(),
    sessionId: v.string(),
    eventId: v.string(),
    channel: v.union(v.literal("terminal_chat"), v.literal("terminal_form")),
    text: v.optional(v.string()),
    commandJson: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CommandResult> => {
    if (
      !process.env.WEB_AUTH_SECRET ||
      args.secret !== process.env.WEB_AUTH_SECRET
    )
      throw new Error("terminal authorization failed");
    if (
      !/^web_[a-zA-Z0-9_-]{16,80}$/.test(args.sessionId) ||
      !/^[a-zA-Z0-9_-]{12,100}$/.test(args.eventId)
    )
      throw new Error("invalid terminal request identity");
    // Apply the same session check to chat and direct forms, before either
    // parsing or accepting a command. Fresh-login/CSRF checks also remain in
    // the authenticated website route.
    if (!await hasActiveTerminalSession(ctx, args.ownerXUserId, args.sessionId))
      throw new Error("Terminal session expired");
    const user = await ctx.runQuery(internal.wallets.getXUserAndWallet, {
      xUserId: args.ownerXUserId,
    });
    if (!user) throw new Error("authenticated wallet was not found");
    const allowed = await ctx.runMutation(
      internal.wallets.consumeTerminalLimit,
      { ownerXUserId: args.ownerXUserId, channel: args.channel },
    );
    if (!allowed) {
      const message =
        "⏳ You’ve reached the terminal request limit. Please wait a few minutes and try again.";
      const attempted = args.text?.trim();
      if (attempted)
        await ctx.runMutation(internal.wallets.recordTerminalMessage, {
          sessionId: args.sessionId,
          ownerXUserId: args.ownerXUserId,
          role: "user",
          messageType: args.channel === "terminal_chat" ? "chat" : "action",
          text: attempted,
          requestId: args.eventId,
        });
      await ctx.runMutation(internal.wallets.recordTerminalMessage, {
        sessionId: args.sessionId,
        ownerXUserId: args.ownerXUserId,
        role: "assistant",
        messageType: "result",
        text: message,
        requestId: args.eventId,
      });
      return { ok: false, message };
    }
    let command: WalletCommand | null = null;
    let displayText = args.text?.trim() || "";
    let executionText = displayText;
    if (args.channel === "terminal_chat") {
      if (!displayText || displayText.length > 500) {
        const message = "Enter a terminal request of 500 characters or fewer.";
        await ctx.runMutation(internal.wallets.recordTerminalMessage, {
          sessionId: args.sessionId,
          ownerXUserId: args.ownerXUserId,
          role: "assistant",
          messageType: "result",
          text: message,
          requestId: args.eventId,
        });
        return { ok: false, message };
      }
      const guidedContext = await ctx.runQuery(internal.wallets.terminalGuidedHelpContext, {
        sessionId: args.sessionId,
        ownerXUserId: args.ownerXUserId,
      });
      let gasResumeContext = isResumeReply(displayText)
        ? await ctx.runQuery(internal.wallets.terminalGasResumeContext, {
            sessionId: args.sessionId,
            ownerXUserId: args.ownerXUserId,
          })
        : null;
      if (gasResumeContext && !await ctx.runMutation(internal.wallets.claimTerminalGasResume, {
        promptMessageId: gasResumeContext.promptMessageId,
        sessionId: args.sessionId,
        ownerXUserId: args.ownerXUserId,
        requestId: args.eventId,
      })) gasResumeContext = null;
      await ctx.runMutation(internal.wallets.recordTerminalMessage, {
        sessionId: args.sessionId,
        ownerXUserId: args.ownerXUserId,
        role: "user",
        messageType: "chat",
        text: displayText,
        requestId: args.eventId,
      });
      const guidedClaimChoice = guidedContext?.operation === "claim"
        ? guidedHelpClaimSelection(displayText)
        : null;
      const guidedLpOfferChoice = guidedContext?.operation === "claim_lp_offer"
        ? guidedHelpClaimLpOfferSelection(displayText)
        : null;
      const liquidityText = guidedClaimChoice === "lp" || guidedLpOfferChoice === "lp"
        ? "claim LP fees"
        : displayText;
      const liquidity = await ctx.runAction(internal.liquidity.handle, {
        ownerXUserId: args.ownerXUserId, source: "terminal", scope: `terminal:${args.sessionId}`,
        requestKey: `terminal:${args.sessionId}:${args.eventId}`, text: liquidityText,
      });
      if (liquidity.handled) {
        const message = liquidity.message || (liquidity.deferred ? "⏳ Your liquidity request is processing. The result will appear here." : "");
        if (message) await ctx.runMutation(internal.wallets.recordTerminalMessage, { sessionId: args.sessionId, ownerXUserId: args.ownerXUserId, role: "assistant", messageType: "result", text: message, requestId: args.eventId });
        return { ok: !liquidity.silent, message, ...(liquidity.deferred ? { pending: true } : {}) };
      }
      if (guidedContext && guidedHelpCancelled(displayText)) {
        const message = "Guided help cancelled.";
        await ctx.runMutation(internal.wallets.recordTerminalMessage, {
          sessionId: args.sessionId, ownerXUserId: args.ownerXUserId, role: "assistant",
          messageType: "result", text: message, requestId: args.eventId,
        });
        return { ok: true, message };
      }
      if (guidedContext?.operation === "claim_lp_offer" && guidedLpOfferChoice === "cancel") {
        const message = "Okay.";
        await ctx.runMutation(internal.wallets.recordTerminalMessage, {
          sessionId: args.sessionId, ownerXUserId: args.ownerXUserId, role: "assistant",
          messageType: "result", text: message, requestId: args.eventId,
        });
        return { ok: true, message };
      }
      if (guidedContext?.operation === "claim_lp_offer" && !guidedLpOfferChoice) {
        const message = guidedHelpPrompt("claim_lp_offer");
        await ctx.runMutation(internal.wallets.recordTerminalMessage, {
          sessionId: args.sessionId, ownerXUserId: args.ownerXUserId, role: "assistant",
          messageType: "result", text: message, requestId: args.eventId,
        });
        return { ok: true, message };
      }
      if (guidedContext?.operation === "claim" && guidedClaimChoice === "creator") {
        const message = guidedHelpPrompt("claim_fees");
        await ctx.runMutation(internal.wallets.recordTerminalMessage, {
          sessionId: args.sessionId, ownerXUserId: args.ownerXUserId, role: "assistant",
          messageType: "result", text: message, requestId: args.eventId,
        });
        return { ok: true, message };
      }
      const guidedSelection = guidedContext ? guidedHelpSelection(displayText) : null;
      if (guidedSelection) {
        const message = guidedSelection === "cross_chain" || guidedSelection === "private_swap"
          ? "🌐 Open “Multi-Chain and Private Swaps” at the top of the terminal to prepare and review this swap."
          : guidedSelection === "reassign_fees"
            ? "💸 Creator-fee reassignment is available through X posts only."
            : guidedHelpPrompt(guidedSelection);
        await ctx.runMutation(internal.wallets.recordTerminalMessage, {
          sessionId: args.sessionId, ownerXUserId: args.ownerXUserId, role: "assistant",
          messageType: "result", text: message, requestId: args.eventId,
        });
        return { ok: true, message };
      }
      executionText = gasResumeContext?.sourceText || (guidedContext
        ? guidedHelpCommandText(displayText, guidedContext.operation)
        : displayText);
      const intent = await parseXWalletIntent(executionText, false);
      if (intent.kind === "help") {
        const activeQuestion = Boolean(
          guidedContext?.operation && guidedContext.operation !== "root" && guidedHelpQuestion(displayText),
        );
        const guidedOperation = guidedContext && !activeQuestion
          ? guidedHelpOperationFromHelp(displayText, intent.topic)
          : null;
        const message = activeQuestion && guidedContext?.operation && guidedContext.operation !== "root"
          ? guidedHelpQuestionResponse(guidedContext.operation, walletHelpMessage(intent.topic))
          : intent.topic === "capabilities"
          ? GENERAL_GUIDED_HELP_MESSAGE
          : guidedOperation
            ? guidedHelpPrompt(guidedOperation)
            : intent.topic === "fees"
            ? "💸 Pons Bot V2 payouts are automatic: 95% goes to the wallet or holders currently assigned the creator fees, while 5% buys and burns $PONSBOT. Say “claim my fees” to request a V2 cycle and claim legacy ETH fees. Reassignment and upgrades are available through X posts only."
            : walletHelpMessage(intent.topic);
        await ctx.runMutation(internal.wallets.recordTerminalMessage, {
          sessionId: args.sessionId,
          ownerXUserId: args.ownerXUserId,
          role: "assistant",
          messageType: "result",
          text: message,
          requestId: args.eventId,
        });
        return { ok: true, message };
      }
      if (intent.kind !== "command") {
        const message = guidedContext?.operation && guidedContext.operation !== "root"
          ? guidedHelpQuestion(displayText)
            ? guidedHelpQuestionResponse(guidedContext.operation)
            : guidedHelpPrompt(guidedContext.operation)
          : intent.kind === "irrelevant"
            ? conversationalWalletMessage()
            : unknownWalletMessage();
        await ctx.runMutation(internal.wallets.recordTerminalMessage, {
          sessionId: args.sessionId,
          ownerXUserId: args.ownerXUserId,
          role: "assistant",
          messageType: "result",
          text: message,
          requestId: args.eventId,
        });
        return { ok: false, message };
      }
      command = intent.command;
    } else {
      try {
        command = args.commandJson
          ? validateStructuredWalletCommand(
              JSON.parse(args.commandJson) as unknown,
            )
          : null;
      } catch {
        command = null;
      }
      displayText =
        displayText ||
        (command && command.kind !== "unknown"
          ? `${command.kind} request`
          : "Direct request");
      await ctx.runMutation(internal.wallets.recordTerminalMessage, {
        sessionId: args.sessionId,
        ownerXUserId: args.ownerXUserId,
        role: "user",
        messageType: "action",
        text: displayText,
        requestId: args.eventId,
      });
    }
    if (!command || command.kind === "unknown") {
      const message = "❌ That terminal request is invalid.";
      await ctx.runMutation(internal.wallets.recordTerminalMessage, {
        sessionId: args.sessionId,
        ownerXUserId: args.ownerXUserId,
        role: "assistant",
        messageType: "result",
        text: message,
        requestId: args.eventId,
      });
      return { ok: false, message };
    }
    if (!isTerminalCommand(command)) {
      const message =
        command.kind === "launch"
          ? "🚀 Launches are available through X posts only."
          : command.kind === "reassign_fees"
            ? "💸 Creator-fee reassignment is available through X posts only."
            : "❌ That action is not available in the terminal.";
      await ctx.runMutation(internal.wallets.recordTerminalMessage, {
        sessionId: args.sessionId,
        ownerXUserId: args.ownerXUserId,
        role: "assistant",
        messageType: "result",
        text: message,
        requestId: args.eventId,
      });
      return { ok: false, message };
    }
    const recipientAddress =
      command.kind === "send" ||
      command.kind === "buy_and_send" ||
      command.kind === "reassign_fees"
        ? await ctx.runAction(internal.xReplies.resolveTerminalRecipient, {
            recipient: command.recipient,
          })
        : undefined;
    const requestId = `terminal:${args.sessionId}:${args.eventId}:${command.kind}`;
    const result = await ctx.runAction(internal.wallets.executeCommand, {
      sourcePostId: args.eventId,
      requestId,
      xUserId: args.ownerXUserId,
      text: executionText,
      parsedCommandJson: JSON.stringify(command),
      source: "terminal",
      channel: args.channel,
      terminalSessionId: args.sessionId,
      ...(recipientAddress ? { recipientAddress } : {}),
    });
    if (result.deferred) return result;
    await ctx.runMutation(internal.wallets.recordTerminalMessage, {
      sessionId: args.sessionId,
      ownerXUserId: args.ownerXUserId,
      role: "assistant",
      messageType: "result",
      text: result.message,
      requestId: args.eventId,
    });
    return result;
  },
});

export const resumeTerminalCommand = internalAction({
  args: {
    sessionId: v.string(),
    ownerXUserId: v.string(),
    sourcePostId: v.string(),
    requestId: v.string(),
    text: v.string(),
    parsedCommandJson: v.string(),
    channel: v.union(v.literal("terminal_chat"), v.literal("terminal_form")),
  },
  handler: async (ctx, args): Promise<void> => {
    const session: Doc<"webWalletSessions"> | null = await ctx.runQuery(
      internal.wallets.webSessionRecord,
      { sessionIdHash: await webSessionHash(args.sessionId) },
    );
    if (
      !session ||
      session.ownerXUserId !== args.ownerXUserId ||
      session.revokedAt ||
      session.expiresAt <= Math.floor(Date.now() / 1_000)
    )
      return;
    try {
      const result: CommandResult = await ctx.runAction(
        internal.wallets.executeCommand,
        {
          sourcePostId: args.sourcePostId,
          requestId: args.requestId,
          xUserId: args.ownerXUserId,
          text: args.text,
          parsedCommandJson: args.parsedCommandJson,
          source: "terminal",
          channel: args.channel,
          terminalSessionId: args.sessionId,
        },
      );
      if (!result.deferred)
        await ctx.runMutation(internal.wallets.recordTerminalMessage, {
          sessionId: args.sessionId,
          ownerXUserId: args.ownerXUserId,
          role: "assistant",
          messageType: "result",
          text: result.message,
          requestId: args.sourcePostId,
        });
    } catch (error) {
      await ctx.runMutation(internal.wallets.recordTerminalMessage, {
        sessionId: args.sessionId,
        ownerXUserId: args.ownerXUserId,
        role: "assistant",
        messageType: "result",
        text: safeFailure(error),
        requestId: args.sourcePostId,
      });
    }
  },
});

export const registerWebSession = action({
  args: {
    secret: v.string(),
    sessionId: v.string(),
    ownerXUserId: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    if (
      !process.env.WEB_AUTH_SECRET ||
      args.secret !== process.env.WEB_AUTH_SECRET
    )
      throw new Error("web session authorization failed");
    if (
      !/^web_[a-zA-Z0-9_-]{16,80}$/.test(args.sessionId) ||
      !/^\d{1,30}$/.test(args.ownerXUserId) ||
      !Number.isSafeInteger(args.expiresAt)
    )
      throw new Error("invalid web session");
    await ctx.runMutation(internal.wallets.registerWebSessionRecord, {
      sessionIdHash: await webSessionHash(args.sessionId),
      ownerXUserId: args.ownerXUserId,
      expiresAt: args.expiresAt,
    });
    return true;
  },
});

export const verifyWebSession = action({
  args: { secret: v.string(), sessionId: v.string(), ownerXUserId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    if (
      !process.env.WEB_AUTH_SECRET ||
      args.secret !== process.env.WEB_AUTH_SECRET
    )
      return false;
    const record: Doc<"webWalletSessions"> | null = await ctx.runQuery(
      internal.wallets.webSessionRecord,
      { sessionIdHash: await webSessionHash(args.sessionId) },
    );
    return Boolean(
      record &&
      record.ownerXUserId === args.ownerXUserId &&
      !record.revokedAt &&
      record.expiresAt > Math.floor(Date.now() / 1_000),
    );
  },
});

export const revokeWebSession = action({
  args: { secret: v.string(), sessionId: v.string(), ownerXUserId: v.string() },
  handler: async (ctx, args) => {
    if (
      !process.env.WEB_AUTH_SECRET ||
      args.secret !== process.env.WEB_AUTH_SECRET
    )
      throw new Error("web session authorization failed");
    await ctx.runMutation(internal.wallets.revokeWebSessionRecord, {
      sessionIdHash: await webSessionHash(args.sessionId),
      ownerXUserId: args.ownerXUserId,
    });
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
    if (
      !process.env.WEB_AUTH_SECRET ||
      args.secret !== process.env.WEB_AUTH_SECRET
    ) {
      throw new Error("web wallet authorization failed");
    }
    if (
      !/^\d{1,30}$/.test(args.xUserId) ||
      !/^[A-Za-z0-9_]{1,15}$/.test(args.username)
    ) {
      throw new Error("invalid authenticated X identity");
    }
    await ctx.runMutation(internal.wallets.upsertXUser, {
      xUserId: args.xUserId,
      username: args.username,
      verified: args.verified,
      ...(args.verifiedType ? { verifiedType: args.verifiedType } : {}),
    });
    const wallet = await ctx.runAction(internal.wallets.ensureWallet, {
      xUserId: args.xUserId,
    });
    if (
      !wallet ||
      !safeAddress(wallet.address) ||
      wallet.ownerXUserId !== args.xUserId
    ) {
      throw new Error("authenticated X wallet provisioning failed");
    }
    return { address: wallet.address };
  },
});

async function exactTokenBalance(
  wallet: Doc<"cryptoWallets">,
  xUserId: string,
  token: string,
) {
  const balance = await signerRequest<{
    display: string;
    raw?: string;
    decimals?: number;
  }>("/v1/wallets/balance", {
    chainId: ROBINHOOD_CHAIN_ID,
    walletRef: wallet.signerWalletRef,
    expectedAddress: wallet.address,
    ownerReference: `x:${xUserId}`,
    token,
  });
  if (
    !balance.raw ||
    !/^\d+$/.test(balance.raw) ||
    !Number.isInteger(balance.decimals) ||
    balance.decimals! < 0 ||
    balance.decimals! > 255
  ) {
    throw new Error("signer did not return an exact token balance");
  }
  return { raw: balance.raw, decimals: balance.decimals! };
}

async function resolveSellToken(
  ctx: ActionCtx,
  wallet: Doc<"cryptoWallets">,
  xUserId: string,
  identifier: string,
) {
  if (safeAddress(identifier)) return normalizedRpcAddress(identifier);
  const matches: string[] = await ctx.runQuery(
    internal.wallets.listKnownTokenMatches,
    { identifier, walletId: wallet._id },
  );
  if (matches.length <= 1) return matches[0] || identifier;
  const balances = await Promise.all(
    matches.map(async (token) => {
      try {
        const balance = await exactTokenBalance(wallet, xUserId, token);
        return BigInt(balance.raw) > 0n ? token : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  const held = balances.filter((token): token is string => Boolean(token));
  if (held.length === 1) return held[0];
  throw new Error(
    "that ticker matches more than one token; use the contract address",
  );
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
  executionLeaseToken?: string,
  lockRequestId = parentRequestId,
) {
  const before = await exactTokenBalance(wallet, xUserId, pairToken);
  const fundingCommand: WalletCommand = {
    kind: "buy",
    amount,
    unit,
    token: pairToken,
    slippageBps,
  };
  const fundingOperation = await operationFor(
    fundingCommand,
    undefined,
    undefined,
    undefined,
    pairToken,
    registry,
  );
  const funding = await executeConfirmedStep(
    ctx,
    wallet,
    xUserId,
    sourcePostId,
    `${parentRequestId}:pair-funding`,
    fundingCommand,
    fundingOperation,
  );
  if (
    executionLeaseToken &&
    !(await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, {
      walletId: wallet._id,
      requestId: lockRequestId,
      leaseToken: executionLeaseToken,
    }))
  )
    throw new Error(
      "wallet execution lease was lost after paired-asset funding",
    );
  // Reconciliation returns the original output on retries. Prefer it so a
  // confirmed funding swap is not mistaken for a zero balance delta when this
  // parent action resumes after a timeout.
  if (funding.tradeOutputDisplay) {
    return {
      amount: tradeDisplayAmount(funding.tradeOutputDisplay),
      transactionHash: funding.transactionHash,
    };
  }
  const after = await exactTokenBalance(wallet, xUserId, pairToken);
  if (after.decimals !== before.decimals)
    throw new Error("paired asset decimals changed during funding");
  const received = BigInt(after.raw) - BigInt(before.raw);
  if (received <= 0n)
    throw new Error(
      "the confirmed funding swap did not increase the paired asset balance",
    );
  return {
    amount: formatUnits(received, after.decimals),
    transactionHash: funding.transactionHash,
  };
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
  executionLeaseToken?: string,
  lockRequestId = parentRequestId,
) {
  assertBuyTarget(tokenAddress);
  if (command.unit === "pair" || command.unit === "token") return { command };
  const factoryAddress = registry.contracts.pons_v2_factory;
  if (!safeAddress(factoryAddress))
    throw new Error("Pons factory is not configured");
  const pair = await signerRequest<PonsPairInfo>("/v1/tokens/pons-pair", {
    token: tokenAddress,
    factoryAddress,
  });
  if (!pair.isPons || pair.nativePair) return { command };
  if (!pair.pairToken || !safeAddress(pair.pairToken))
    throw new Error("Pons returned an invalid paired asset");
  const funded = await fundPairAsset(
    ctx,
    wallet,
    xUserId,
    sourcePostId,
    parentRequestId,
    pair.pairToken,
    command.amount,
    command.unit,
    command.slippageBps,
    registry,
    executionLeaseToken,
    lockRequestId,
  );
  return {
    command: {
      ...command,
      amount: funded.amount,
      unit: "pair" as const,
      pairAsset: pair.pairToken,
    },
    fundingTransactionHash: funded.transactionHash,
  };
}

async function assertUserFundsDeveloperBuy(
  command: Extract<WalletCommand, { kind: "launch" }>,
  registry: RuntimeRegistry,
  wallet: Doc<"cryptoWallets">,
  xUserId: string,
) {
  if (!command.devBuy) return;
  const pairToken = resolveLaunchPair(command.pairToken, registry.pairs);
  const result = await signerRequest<{
    sufficient: boolean;
    requiredWei: string;
    balanceWei: string;
  }>("/v1/sponsorships/free-launch/dev-buy-eligibility", {
    ownerReference: `x:${xUserId}`,
    walletRef: wallet.signerWalletRef,
    expectedAddress: wallet.address,
    amount: command.devBuy.amount,
    unit: command.devBuy.unit,
    pairToken,
  });
  if (!result.sufficient) {
    const pair = registry.pairs.find(
      (item) => item.address.toLowerCase() === pairToken.toLowerCase(),
    );
    if (/^0x0{40}$/i.test(pairToken)) {
      throw new Error("There isn't enough ETH in your wallet for that developer buy.");
    }
    throw new Error(`There isn't enough ${pair?.symbol || "paired asset"} in your wallet for that developer buy.`);
  }
}

async function applyAutomaticFreeLaunchSponsorship(
  ctx: ActionCtx,
  wallet: Doc<"cryptoWallets">,
  xUserId: string,
  requestId: string,
  walletLeaseToken: string,
  command: Extract<WalletCommand, { kind: "launch" }>,
  registry: RuntimeRegistry,
  operation: Record<string, unknown>,
) {
  const eligibility = await ctx.runMutation(internal.freeLaunches.eligibility, {
    ownerXUserId: xUserId,
  });
  if (!eligibility.eligible) return;

  await assertUserFundsDeveloperBuy(command, registry, wallet, xUserId);
  let estimate: {
    amountWei: string;
    launchFeeWei: string;
    estimatedGas: string;
    bufferedGasCostWei: string;
  };
  try {
    estimate = await signerRequest(
      "/v1/sponsorships/free-launch/estimate",
      {
        idempotencyKey: `${requestId}:sponsor-estimate`,
        chainId: ROBINHOOD_CHAIN_ID,
        ownerReference: `x:${xUserId}`,
        walletRef: wallet.signerWalletRef,
        expectedFrom: wallet.address,
        requireSimulation: true,
        operation,
      },
      60_000,
    );
  } catch (error) {
    // A promotion must never make the ordinary paid launch path unavailable.
    console.warn("automatic_free_launch_estimate_skipped", {
      requestId,
      message: error instanceof Error ? error.message.slice(0, 240) : "unknown",
    });
    return;
  }
  const reservation = await ctx.runMutation(internal.freeLaunches.reserve, {
    ownerXUserId: xUserId,
    walletId: wallet._id,
    recipientAddress: wallet.address,
    requestId,
    grantWei: estimate.amountWei,
    launchFeeWei: estimate.launchFeeWei,
    estimatedGas: estimate.estimatedGas,
    bufferedGasCostWei: estimate.bufferedGasCostWei,
  });
  if (!reservation.eligible || reservation.alreadyFunded) return;

  const fundingLeaseToken = crypto.randomUUID();
  let leaseHeld = false;
  let sponsorTransactionHash = reservation.sponsorTransactionHash;
  try {
    for (let attempt = 0; attempt < 120 && !leaseHeld; attempt += 1) {
      leaseHeld = await ctx.runMutation(internal.freeLaunches.acquireFundingLease, {
        requestId,
        leaseToken: fundingLeaseToken,
      });
      if (!leaseHeld) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!leaseHeld) throw new Error("free launch sponsor is busy");

    if (!sponsorTransactionHash) {
      const broadcast = await signerRequest<{ transactionHash: string; status: "broadcast" }>(
        "/v1/sponsorships/free-launch",
        {
          idempotencyKey: requestId,
          ownerReference: `x:${xUserId}`,
          walletRef: wallet.signerWalletRef,
          recipient: wallet.address,
          amountWei: reservation.grantWei,
        },
        60_000,
      );
      if (!/^0x[a-fA-F0-9]{64}$/.test(broadcast.transactionHash)) {
        throw new Error("free launch sponsor returned an invalid transaction hash");
      }
      sponsorTransactionHash = broadcast.transactionHash;
      await ctx.runMutation(internal.freeLaunches.recordFundingBroadcast, {
        requestId,
        transactionHash: sponsorTransactionHash,
      });
    }

    let sawNotFound = false;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const status = await signerRequest<{ status: "pending" | "confirmed" | "reverted" | "not_found" }>(
        "/v1/sponsorships/free-launch/status",
        {
          transactionHash: sponsorTransactionHash,
          recipient: wallet.address,
          amountWei: reservation.grantWei,
        },
      );
      if (status.status === "confirmed") {
        await ctx.runMutation(internal.freeLaunches.markFunded, {
          requestId,
          transactionHash: sponsorTransactionHash,
        });
        // Let RPC/CDP balance views settle after the receipt before asking the
        // user's wallet to sign the launch transaction.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        return;
      }
      if (status.status === "reverted") {
        await ctx.runMutation(internal.freeLaunches.markFundingReverted, {
          requestId,
          diagnosticCode: "FREE_LAUNCH_FUNDING_REVERTED",
        });
        throw new Error("free launch funding reverted");
      }
      if (status.status === "not_found") {
        sawNotFound = true;
        const check = await ctx.runMutation(internal.freeLaunches.recordFundingStatusCheck, {
          requestId,
          found: false,
        });
        if (check.manualReview) throw new Error("free launch funding requires manual review");
      } else if (sawNotFound) {
        await ctx.runMutation(internal.freeLaunches.recordFundingStatusCheck, {
          requestId,
          found: true,
        });
        sawNotFound = false;
      }
      if (attempt > 0 && attempt % 30 === 0) {
        leaseHeld = await ctx.runMutation(internal.freeLaunches.acquireFundingLease, {
          requestId,
          leaseToken: fundingLeaseToken,
        });
        if (!leaseHeld) throw new Error("free launch funding lease was lost");
        await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, {
          walletId: wallet._id,
          requestId,
          leaseToken: walletLeaseToken,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error("free launch funding confirmation timed out");
  } catch (error) {
    // Sponsorship is deliberately invisible and optional. If no funding hash
    // was recorded, release the slot and continue through the ordinary launch
    // path so the user receives the same normal success or funding response.
    if (!sponsorTransactionHash) {
      await ctx.runMutation(internal.freeLaunches.failBeforeFunding, {
        requestId,
        diagnosticCode: "FREE_LAUNCH_FUNDING_UNAVAILABLE",
      });
    }
    console.warn("automatic_free_launch_sponsorship_skipped", {
      requestId,
      message: error instanceof Error ? error.message.slice(0, 240) : "unknown",
    });
  } finally {
    if (leaseHeld) {
      await ctx.runMutation(internal.freeLaunches.releaseFundingLease, {
        leaseToken: fundingLeaseToken,
      });
    }
  }
}

export const reconcileFreeLaunchSponsorships = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    inspected: number;
    funded: number;
    reverted: number;
    released: number;
    pending: number;
  }> => {
    const recoverable: Array<{
      requestId: string;
      recipient: string;
      grantWei: string;
      transactionHash?: string;
    }> = await ctx.runQuery(internal.freeLaunches.listRecoverable, {});
    let funded = 0;
    let reverted = 0;
    let released = 0;
    let pending = 0;
    for (const item of recoverable) {
      if (!item.transactionHash) {
        await ctx.runMutation(internal.freeLaunches.failBeforeFunding, {
          requestId: item.requestId,
          diagnosticCode: "FREE_LAUNCH_FUNDING_INTERRUPTED_BEFORE_BROADCAST",
        });
        released += 1;
        continue;
      }
      try {
        const status = await signerRequest<{ status: "pending" | "confirmed" | "reverted" | "not_found" }>(
          "/v1/sponsorships/free-launch/status",
          {
            transactionHash: item.transactionHash,
            recipient: item.recipient,
            amountWei: item.grantWei,
          },
        );
        if (status.status === "confirmed") {
          await ctx.runMutation(internal.freeLaunches.markFunded, {
            requestId: item.requestId,
            transactionHash: item.transactionHash,
          });
          funded += 1;
        } else if (status.status === "reverted") {
          await ctx.runMutation(internal.freeLaunches.markFundingReverted, {
            requestId: item.requestId,
            diagnosticCode: "FREE_LAUNCH_FUNDING_REVERTED",
          });
          reverted += 1;
        } else if (status.status === "not_found") {
          await ctx.runMutation(internal.freeLaunches.recordFundingStatusCheck, {
            requestId: item.requestId,
            found: false,
          });
          pending += 1;
        } else {
          await ctx.runMutation(internal.freeLaunches.recordFundingStatusCheck, {
            requestId: item.requestId,
            found: true,
          });
          pending += 1;
        }
      } catch (error) {
        pending += 1;
        console.warn("free_launch_reconciliation_deferred", {
          requestId: item.requestId,
          message: error instanceof Error ? error.message.slice(0, 240) : "unknown",
        });
      }
    }
    return { inspected: recoverable.length, funded, reverted, released, pending };
  },
});

async function waitForConfirmedRequest(ctx: ActionCtx, requestId: string) {
  await ctx.runAction(internal.wallets.reconcileTransaction, { requestId });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await ctx.runQuery(
      internal.wallets.getReconciliationContext,
      { requestId },
    );
    if (
      current?.request.status === "confirmed" &&
      current.request.transactionHash
    ) {
      return {
        transactionHash: current.request.transactionHash,
        tokenAddress: current.launch?.tokenAddress,
        blockNumber: current.transaction?.blockNumber,
        valueWei: current.transaction?.valueWei,
        claimedDisplay: current.transaction?.claimedDisplay,
        tradeOutputDisplay: current.transaction?.tradeOutputDisplay,
        tradeOutputTokenAddress: current.transaction?.tradeOutputTokenAddress,
        involvedPairTokenAddress: current.transaction?.involvedPairTokenAddress,
      };
    }
    if (
      current?.request.status === "failed" ||
      current?.request.status === "rejected"
    ) {
      throw new Error(current.request.safeError || "transaction failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("transaction confirmation timed out");
}

async function enableHolderFeeSharing(
  ctx: ActionCtx,
  wallet: Doc<"cryptoWallets">,
  xUserId: string,
  sourcePostId: string,
  parentRequestId: string,
  command: Extract<WalletCommand, { kind: "launch" }>,
  tokenAddress: string,
  registry: RuntimeRegistry,
) {
  if (!command.holderFeeSharing) return undefined;
  const distributorFactoryAddress =
    registry.contracts.pons_holder_distributor_factory;
  const factoryAddress = registry.contracts.pons_v2_factory;
  if (
    !safeAddress(distributorFactoryAddress || "") ||
    !safeAddress(factoryAddress || "")
  )
    throw new Error("holder fee sharing contracts are not configured");
  let info = await signerRequest<{
    distributor: string | null;
    creatorFeeRecipient: string | null;
  }>("/v1/tokens/holder-distributor", {
    token: tokenAddress,
    distributorFactoryAddress,
    ponsFactoryAddress: factoryAddress,
  });
  let createHash: string | undefined;
  if (!info.distributor) {
    const created = await executeConfirmedStep(
      ctx,
      wallet,
      xUserId,
      sourcePostId,
      `${parentRequestId}:holder-distributor`,
      command,
      {
        type: "pons_v2_create_holder_distributor",
        token: tokenAddress,
        distributorFactoryAddress,
      },
    );
    createHash = created.transactionHash;
    info = await signerRequest<{
      distributor: string | null;
      creatorFeeRecipient: string | null;
    }>("/v1/tokens/holder-distributor", {
      token: tokenAddress,
      distributorFactoryAddress,
      ponsFactoryAddress: factoryAddress,
    });
  }
  if (!info.distributor || !safeAddress(info.distributor))
    throw new Error("holder fee distributor was not created");
  const routed = await executeConfirmedStep(
    ctx,
    wallet,
    xUserId,
    sourcePostId,
    `${parentRequestId}:holder-fee-route`,
    command,
    {
      type: "pons_v2_transfer_creator_fee_recipient",
      token: tokenAddress,
      newRecipient: info.distributor,
      factoryAddress,
    },
  );
  info = await signerRequest<{
    distributor: string | null;
    creatorFeeRecipient: string | null;
  }>("/v1/tokens/holder-distributor", {
    token: tokenAddress,
    distributorFactoryAddress,
    ponsFactoryAddress: factoryAddress,
  });
  if (
    !info.creatorFeeRecipient ||
    info.creatorFeeRecipient.toLowerCase() !== info.distributor?.toLowerCase()
  )
    throw new Error(
      "Pons did not confirm the holder distributor as creator fee recipient",
    );
  await ctx.runMutation(internal.wallets.recordHolderFeeDistributor, {
    requestId: parentRequestId,
    distributor: info.distributor,
  });
  return {
    distributor: info.distributor,
    createHash,
    routeHash: routed.transactionHash,
  };
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
  const reserved = await ctx.runMutation(
    internal.wallets.reserveWalletRequest,
    {
      requestId,
      sourcePostId,
      ownerXUserId: xUserId,
      walletId: wallet._id,
      kind: command.kind,
      normalizedJson: JSON.stringify(command),
    },
  );
  if (!reserved.inserted) {
    if (
      reserved.request?.status === "confirmed" &&
      reserved.request.transactionHash
    ) {
      const current = await ctx.runQuery(
        internal.wallets.getReconciliationContext,
        { requestId },
      );
      return {
        transactionHash: reserved.request.transactionHash,
        blockNumber: current?.transaction?.blockNumber,
        tradeOutputDisplay: current?.transaction?.tradeOutputDisplay,
        tradeOutputTokenAddress: current?.transaction?.tradeOutputTokenAddress,
        involvedPairTokenAddress:
          current?.transaction?.involvedPairTokenAddress,
      };
    }
    if (
      reserved.request?.status === "failed" ||
      reserved.request?.status === "rejected"
    ) {
      throw new Error(
        reserved.request.safeError || `${command.kind} step failed`,
      );
    }
  } else {
    await ctx.runMutation(internal.wallets.updateWalletRequest, {
      requestId,
      status: "simulating",
    });
    let result: Awaited<ReturnType<typeof submitWithApproval>>;
    try {
      await ctx.runMutation(internal.wallets.updateWalletRequest, {
        requestId,
        status: "simulating",
        workflowStage: "signer_submission",
      });
      result = await submitWithApproval(
        ctx,
        wallet,
        xUserId,
        requestId,
        operation,
      );
    } catch (error) {
      await ctx.runMutation(internal.wallets.updateWalletRequest, {
        requestId,
        status: "failed",
        safeError:
          error instanceof Error
            ? error.message
            : `${command.kind} step failed`,
        workflowStage: "signer_submission",
        diagnosticCode: privateDiagnosticCode(error),
      });
      throw error;
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(result.transactionHash))
      throw new Error("signer returned an invalid transaction hash");
    if (result.status === "reverted") throw new Error("transaction reverted");
    const to =
      result.toAddress && safeAddress(result.toAddress)
        ? result.toAddress
        : operationDestination(operation);
    const callKind = result.callKind || String(operation.type);
    const feeReassignment =
      operation.type === "pons_v2_transfer_creator_fee_recipient"
        ? {
            feeReassignmentTokenAddress: String(operation.token),
            feeReassignmentRecipientAddress: String(operation.newRecipient),
            feeReassignmentUpdatesLaunch: false,
          }
        : {};
    if (result.status === "confirmed") {
      await ctx.runMutation(internal.wallets.recordConfirmedExecution, {
        requestId,
        walletId: wallet._id,
        to,
        valueWei: result.valueWei || "0",
        callKind,
        transactionHash: result.transactionHash,
        blockNumber: result.blockNumber,
        claimedDisplay: result.claimedDisplay,
        tradeOutputDisplay: result.tradeOutputDisplay,
        tradeOutputTokenAddress: result.tradeOutputTokenAddress,
        tradeOutputBalanceBefore: result.tradeOutputBalanceBefore,
        involvedPairTokenAddress: result.involvedPairTokenAddress,
        ...feeReassignment,
      });
      return {
        transactionHash: result.transactionHash,
        blockNumber: result.blockNumber,
        tradeOutputDisplay: result.tradeOutputDisplay,
        tradeOutputTokenAddress: result.tradeOutputTokenAddress,
        involvedPairTokenAddress: result.involvedPairTokenAddress,
      };
    }
    if (result.status === "prepared") {
      if (
        !result.signedTransaction ||
        !/^0x[a-fA-F0-9]+$/.test(result.signedTransaction)
      )
        throw new Error("signer returned an invalid prepared transaction");
      await ctx.runMutation(internal.wallets.recordPreparedExecution, {
        requestId,
        walletId: wallet._id,
        to,
        valueWei: result.valueWei || "0",
        callKind,
        transactionHash: result.transactionHash,
        signedTransaction: result.signedTransaction,
        tradeOutputTokenAddress: result.tradeOutputTokenAddress,
        tradeOutputBalanceBefore: result.tradeOutputBalanceBefore,
        involvedPairTokenAddress: result.involvedPairTokenAddress,
        ...feeReassignment,
      });
    } else {
      await ctx.runMutation(internal.wallets.recordBroadcastExecution, {
        requestId,
        walletId: wallet._id,
        to,
        valueWei: result.valueWei || "0",
        callKind,
        transactionHash: result.transactionHash,
        tradeOutputTokenAddress: result.tradeOutputTokenAddress,
        tradeOutputBalanceBefore: result.tradeOutputBalanceBefore,
        involvedPairTokenAddress: result.involvedPairTokenAddress,
        ...feeReassignment,
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
  registry?: {
    contracts: Record<string, string>;
    pairs: Array<{
      address: string;
      symbol: string;
      pairApproved: boolean;
      active: boolean;
    }>;
  },
  launchOwnerAddress?: string,
): Promise<Record<string, unknown>> {
  const tokenValueContracts = () => {
    if ((command.kind !== "send" && command.kind !== "burn") || !["eth", "usd"].includes(command.unit)) return {};
    const ponsFactoryAddress = registry?.contracts.pons_v2_factory;
    const v4QuoterAddress = registry?.contracts.v4_quoter;
    if (!ponsFactoryAddress || !v4QuoterAddress || !safeAddress(ponsFactoryAddress) || !safeAddress(v4QuoterAddress)) {
      throw new Error("token valuation contracts are missing from the registry");
    }
    return { ponsFactoryAddress, v4QuoterAddress };
  };
  if (command.kind === "send") {
    const recipient = safeAddress(command.recipient)
      ? command.recipient
      : recipientAddress;
    if (
      !recipient ||
      !safeAddress(recipient) ||
      recipient.toLowerCase() === DEAD_ADDRESS.toLowerCase()
    )
      throw new Error("invalid transfer destination");
    const nativeEth = !command.token || /^eth$/i.test(command.token);
    if (nativeEth)
      return {
        type: "eth_transfer",
        recipient,
        amount: command.amount,
        unit: command.unit,
      };
    const quoterAddress = registry?.contracts.swap_quoter;
    const wethAddress = registry?.contracts.weth;
    if (
      !quoterAddress ||
      !wethAddress ||
      !safeAddress(quoterAddress) ||
      !safeAddress(wethAddress)
    )
      throw new Error("swap contracts are missing from the registry");
    return {
      type: "erc20_transfer",
      ...tokenValueContracts(),
      recipient,
      amount: command.amount,
      unit: command.unit,
      token: tokenOverride || command.token,
      quoterAddress,
      wethAddress,
      fee: 10_000,
    };
  }
  if (command.kind === "burn") {
    const quoterAddress = registry?.contracts.swap_quoter;
    const wethAddress = registry?.contracts.weth;
    if (
      !quoterAddress ||
      !wethAddress ||
      !safeAddress(quoterAddress) ||
      !safeAddress(wethAddress)
    )
      throw new Error("swap contracts are missing from the registry");
    return {
      type: "erc20_burn_to_dead",
      ...tokenValueContracts(),
      deadAddress: DEAD_ADDRESS,
      amount: command.amount,
      unit: command.unit,
      token: tokenOverride || command.token,
      quoterAddress,
      wethAddress,
      fee: 10_000,
    };
  }
  if (command.kind === "buy" || command.kind === "sell") {
    const routerAddress = registry?.contracts.swap_router;
    const quoterAddress = registry?.contracts.swap_quoter;
    const wethAddress = registry?.contracts.weth;
    const ponsFactoryAddress = registry?.contracts.pons_v2_factory;
    const v4QuoterAddress = registry?.contracts.v4_quoter;
    const universalRouterAddress = registry?.contracts.universal_router;
    const permit2Address = registry?.contracts.permit2;
    if (
      !routerAddress ||
      !quoterAddress ||
      !wethAddress ||
      !ponsFactoryAddress ||
      !v4QuoterAddress ||
      !universalRouterAddress ||
      !permit2Address ||
      !safeAddress(routerAddress) ||
      !safeAddress(quoterAddress) ||
      !safeAddress(wethAddress) ||
      !safeAddress(ponsFactoryAddress) ||
      !safeAddress(v4QuoterAddress) ||
      !safeAddress(universalRouterAddress) ||
      !safeAddress(permit2Address)
    ) {
      throw new Error("swap contracts are missing from the registry");
    }
    return {
      type: command.kind === "buy" ? "uniswap_v3_buy" : "uniswap_v3_sell",
      token: tokenOverride || command.token,
      amount: command.amount,
      unit: command.unit,
      slippageBps: command.slippageBps,
      ...(command.kind === "buy" && command.unit === "pair"
        ? {
            pairAsset: resolveTradingPair(
              command.pairAsset,
              registry?.pairs || [],
            ),
          }
        : {}),
      routerAddress,
      quoterAddress,
      wethAddress,
      ponsFactoryAddress,
      v4QuoterAddress,
      universalRouterAddress,
      permit2Address,
      fee: 10_000,
    };
  }
  if (command.kind === "claim_fees") {
    const factoryAddress = registry?.contracts.pons_v2_factory || "";
    if (!safeAddress(factoryAddress))
      throw new Error("Pons factory is not configured");
    const token = claimToken || tokenOverride;
    return {
      type: "pons_v2_claim_fees",
      ...(token ? { token } : {}),
      factoryAddress,
    };
  }
  if (command.kind === "reassign_fees") {
    const factoryAddress = registry?.contracts.pons_v2_factory || "";
    const token = tokenOverride;
    const newRecipient = safeAddress(command.recipient)
      ? command.recipient
      : recipientAddress;
    if (!safeAddress(factoryAddress) || !token || !safeAddress(token))
      throw new Error("Pons factory is not configured");
    if (
      !newRecipient ||
      !safeAddress(newRecipient) ||
      newRecipient.toLowerCase() === launchOwnerAddress?.toLowerCase() ||
      newRecipient.toLowerCase() === DEAD_ADDRESS.toLowerCase() ||
      newRecipient.toLowerCase() === token.toLowerCase() ||
      newRecipient.toLowerCase() === factoryAddress.toLowerCase()
    )
      throw new Error("fee reassignment recipient is invalid");
    return {
      type: "pons_v2_transfer_creator_fee_recipient",
      token,
      newRecipient,
      factoryAddress,
    };
  }
  if (command.kind === "launch") {
    const factoryAddress = registry?.contracts.pons_v2_factory || "";
    const launchAndBuyRouter = registry?.contracts.pons_v2_launch_router || "";
    const quoterAddress = registry?.contracts.swap_quoter || "";
    const wethAddress = registry?.contracts.weth || "";
    if (!safeAddress(factoryAddress))
      throw new Error("Pons factory is not configured");
    if (!safeAddress(launchAndBuyRouter))
      throw new Error("Pons launch-and-buy router is not configured");
    if (!safeAddress(quoterAddress) || !safeAddress(wethAddress))
      throw new Error("swap contracts are missing from the registry");
    const imageUri = await normalizeImage(mediaUrl);
    const metadata = resolveLaunchMetadata(command);
    const pairToken = resolveLaunchPair(
      command.pairToken,
      registry?.pairs || [],
    );
    const creatorFeeRecipient = command.feeRecipient
      ? safeAddress(command.feeRecipient)
        ? command.feeRecipient
        : recipientAddress
      : launchOwnerAddress;
    if (!creatorFeeRecipient || !safeAddress(creatorFeeRecipient))
      throw new Error("creator fee recipient could not be resolved");
    return {
      type: command.devBuy ? "pons_v2_launch_and_buy" : "pons_v2_launch",
      launchMode: command.launchMode,
      factoryAddress,
      launchAndBuyRouter,
      name: command.name,
      symbol: command.symbol,
      imageUri,
      description: metadata.description,
      devBuy: command.devBuy || null,
      socials: {
        website: metadata.website,
        twitter: metadata.twitter,
        telegram: metadata.telegram,
      },
      feeWalletSource: "reply_wallet",
      creatorFeeRecipient,
      launchConfigId: process.env.PONS_LAUNCH_CONFIG_ID || "0",
      pairToken,
      quoterAddress,
      wethAddress,
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
  if (
    !result.approvalTokenAddress ||
    !safeAddress(result.approvalTokenAddress) ||
    !result.signedTransaction ||
    !/^0x[a-fA-F0-9]+$/.test(result.signedTransaction) ||
    !/^0x[a-fA-F0-9]{64}$/.test(result.transactionHash)
  ) {
    throw new Error("signer returned invalid approval metadata");
  }
  const approvalRecord = await ctx.runMutation(
    internal.wallets.recordApprovalPrepared,
    {
      requestId,
      walletId: wallet._id,
      tokenAddress: result.approvalTokenAddress,
      transactionHash: result.transactionHash,
      signedTransaction: result.signedTransaction,
    },
  );
  const recordedApprovalNonce = approvalRecord?.signedTransaction
    ? parseTransaction(approvalRecord.signedTransaction as `0x${string}`).nonce
    : result.nonce;
  const minimumFollowUpNonce = recordedApprovalNonce === undefined
    ? undefined
    : recordedApprovalNonce + 1;
  const requestBody = {
    chainId: ROBINHOOD_CHAIN_ID,
    ownerReference: `x:${xUserId}`,
    walletRef: wallet.signerWalletRef,
    expectedFrom: wallet.address,
    expectedTo: result.approvalTokenAddress,
    transactionHash: approvalRecord?.transactionHash || result.transactionHash,
    operationType: "erc20_approval",
    expectedValueWei: "0",
  };
  if (approvalRecord?.status === "confirmed") {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    result = await submit(
      wallet,
      xUserId,
      requestId,
      operation,
      minimumFollowUpNonce,
    );
    if (result.approvalRequired)
      throw new Error(
        "confirmed token approval did not satisfy the requested operation",
      );
    return result;
  }
  if (
    approvalRecord?.status === "reverted" ||
    approvalRecord?.status === "invalid"
  )
    throw new Error("previous token approval failed");
  if (!approvalRecord || approvalRecord.status === "prepared") {
    const broadcast = await signerRequest<SubmittedTransaction>(
      "/v1/transactions/broadcast",
      {
        ...requestBody,
        signedTransaction:
          approvalRecord?.signedTransaction || result.signedTransaction,
      },
    );
    if (broadcast.status === "reverted") {
      await ctx.runMutation(internal.wallets.updateApprovalStatus, {
        requestId,
        status: "reverted",
      });
      throw new Error("token approval reverted");
    }
    await ctx.runMutation(internal.wallets.updateApprovalStatus, {
      requestId,
      status: "broadcast",
    });
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await signerRequest<SubmittedTransaction>(
      "/v1/transactions/status",
      requestBody,
    );
    if (status.status === "confirmed") {
      await ctx.runMutation(internal.wallets.updateApprovalStatus, {
        requestId,
        status: "confirmed",
        blockNumber: status.blockNumber,
      });
      // Give state reads a brief opportunity to converge, then explicitly
      // prevent reuse of the approval nonce even if one RPC remains behind.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      result = await submit(
        wallet,
        xUserId,
        requestId,
        operation,
        minimumFollowUpNonce,
      );
      if (result.approvalRequired)
        throw new Error(
          "token approval did not satisfy the requested operation",
        );
      return result;
    }
    if (status.status === "reverted") {
      await ctx.runMutation(internal.wallets.updateApprovalStatus, {
        requestId,
        status: "reverted",
        blockNumber: status.blockNumber,
      });
      throw new Error("token approval reverted");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    "token approval confirmation timed out; retrying later is safe",
  );
}

function resolveLaunchPair(
  identifier: string | undefined,
  assets: Array<{
    address: string;
    symbol: string;
    pairApproved: boolean;
    active: boolean;
  }>,
) {
  if (!identifier || /^eth$/i.test(identifier))
    return "0x0000000000000000000000000000000000000000";
  const normalized = identifier.replace(/^\$/, "").toLowerCase();
  const match = assets.find(
    (asset) =>
      asset.active &&
      asset.pairApproved &&
      (asset.symbol.toLowerCase() === normalized ||
        asset.address.toLowerCase() === normalized),
  );
  if (!match)
    throw new Error("requested Pons V2 pair is not currently approved");
  return match.address;
}

function resolveTradingPair(
  identifier: string | undefined,
  assets: Array<{ address: string; symbol: string; active: boolean }>,
) {
  if (!identifier) throw new Error("paired asset is required");
  const normalized = identifier.replace(/^\$/, "").toLowerCase();
  const match = assets.find(
    (asset) =>
      asset.active &&
      (asset.symbol.toLowerCase() === normalized ||
        asset.address.toLowerCase() === normalized),
  );
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
  const pair = pairs.find(
    (item) => item.address.toLowerCase() === address.toLowerCase(),
  );
  await ctx.runMutation(internal.wallets.indexWalletToken, {
    walletId,
    tokenAddress: address,
    symbol: pair?.symbol || address,
    involvedByLaunch: false,
    involvedByTransaction: true,
  });
}

function resolveLaunchMetadata(
  command: Extract<WalletCommand, { kind: "launch" }>,
) {
  return {
    description: command.description?.trim() || "",
    website: command.website ? normalizeWebsiteUrl(command.website) : "",
    twitter: command.twitter ? normalizeXUrl(command.twitter) : "",
    telegram: normalizeOptionalTelegramUrl(command.telegram) || "",
  };
}
