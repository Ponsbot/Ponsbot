import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { finalizeFeeWalletOutcome } from "./automatedFeeOutcomes";
import { attachRequestedClaims, liveRequestedClaims, requestedVaultClaimsEnabled } from "./automatedFeeClaimInfo";
import { existingFeeUpgradeState } from "../lib/fee-upgrade-command";
import { PONSBOT_BURN_TOKEN } from "../lib/burn-stats";
import { canUseGraduatedEscrow, feeRunHasTransaction, feeSweepPrerequisiteSatisfied, isGraduatedSweepPreflightFailure } from "../lib/automated-fee-sweep-policy";
import { FEE_ACCUMULATION_THRESHOLD_WEI, feeThresholdReached, nextFeeCheck, feeRetryDelay } from "../lib/automated-fee-scheduling";
import {
  AUTOMATED_FEE_BUYBACK_BPS,
  AUTOMATED_FEE_ENGINE_INTERVAL_MS,
  AUTOMATED_FEE_ENGINE_LEASE_MS,
  AUTOMATED_FEE_ENROLLMENT_RESERVATION_MS,
  AUTOMATED_FEE_MAX_PROGRAMS_PER_RUN,
  automatedFeeEngineConfiguration,
  automatedFeeRunIdempotencyKey,
  validateAutomatedFeeReceipt,
  automatedFeeEnrollmentAllowed,
  automatedFeeDistributionEligible,
  automatedFeeProcessingAllowed,
  automatedFeePrivateTestEnrollmentAllowed,
  automatedFeeProofMessage,
  automatedFeeBroadcastPayload,
  automatedFeePreparedFields,
  automatedFeeExecutionFields,
  automatedFeeDeploymentConfirmed,
} from "../lib/automated-fee-policy";
import {
  AUTOMATED_FEE_WORKFLOW_CONTINUATION,
  automatedFeeControllerTransactionMayExist,
  isAutomatedFeeControllerWorkflowRoot,
  isAutomatedFeeWorkflowContinuation,
  isTerminalAutomatedFeeControllerReview,
} from "../lib/automated-fee-workflow";

const ENGINE_KEY = "ponsbot-automated-buyback-burn-v1";
// The implementation lock is complete. Runtime activation still requires the
// master switch plus the specific enrollment/processing/command capability;
// all documented defaults remain false.
const PRODUCTION_EXECUTION_IMPLEMENTATION_READY = true;
const PRIVATE_MANUAL_TEST_IMPLEMENTATION_READY = true;
const ROBINHOOD_CHAIN_ID = 4663;
const RUN_ACTION_LEASE_MS = 5 * 60_000;
const KEEPER_ACTION_LEASE_MS = 10 * 60_000;
const MAX_PENDING_STAGE_MS = 20 * 60_000;
const MAX_PENDING_STATUS_CHECKS = 20;
const MAX_CONTROLLER_PENDING_MS = 30 * 60_000;
const MAX_CONTROLLER_PENDING_CHECKS = 120;

function signerConfiguration() {
  const explicitUrl = process.env.WALLET_SIGNER_URL?.trim();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const baseUrl = (explicitUrl || (siteUrl ? `${siteUrl.replace(/\/$/, "")}/api/wallet-signer` : "")).replace(/\/$/, "");
  const token = process.env.WALLET_SIGNER_TOKEN;
  if (!baseUrl || !token) throw new Error("automated fee signer is not configured");
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("automated fee signer must use HTTPS");
  }
  return { baseUrl, token };
}

async function signerRequest<T>(path: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  const { baseUrl, token } = signerConfiguration();
  const serialized = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const vault = typeof body === "object" && body !== null
    ? String("vaultAddress" in body ? (body as { vaultAddress?: unknown }).vaultAddress ?? ""
      : "token" in body ? (body as { token?: unknown }).token ?? ""
        : "tokenAddress" in body ? (body as { tokenAddress?: unknown }).tokenAddress ?? "" : "").toLowerCase() : "";
  const proofSecret = process.env.AUTOMATED_FEE_ENROLLMENT_SECRET?.trim();
  if (!proofSecret) throw new Error("automated fee enrollment proof is not configured");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(proofSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bodyDigestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  const bodyDigest = Array.from(new Uint8Array(bodyDigestBytes)).map((value) => value.toString(16).padStart(2, "0")).join("");
  const proofBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(automatedFeeProofMessage(timestamp, path, vault, bodyDigest)));
  const proof = Array.from(new Uint8Array(proofBytes)).map((value) => value.toString(16).padStart(2, "0")).join("");
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-automated-fee-timestamp": timestamp, "x-automated-fee-proof": proof },
    body: serialized,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  let payload: (T & { error?: string; diagnosticCode?: string; diagnosticDetail?: string }) | null = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
  if (!response.ok || !payload) {
    const detail = payload?.diagnosticCode || payload?.error || payload?.diagnosticDetail || `HTTP_${response.status}`;
    const error = new Error(`automated fee signer request failed [${path}]: ${String(detail).slice(0, 240)}${payload?.diagnosticDetail ? `: ${payload.diagnosticDetail.slice(0, 500)}` : ""}`);
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
    throw Object.assign(error, { retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0 });
  }
  return payload;
}

function configuration() {
  return automatedFeeEngineConfiguration({
    AUTOMATED_BUYBACK_BURN_ENABLED: process.env.AUTOMATED_BUYBACK_BURN_ENABLED,
    AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED: process.env.AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED,
    AUTOMATED_FEE_NEW_LAUNCH_ENROLLMENT_ENABLED: process.env.AUTOMATED_FEE_NEW_LAUNCH_ENROLLMENT_ENABLED,
    AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED: process.env.AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED,
    AUTOMATED_FEE_BOT_COMMANDS_ENABLED: process.env.AUTOMATED_FEE_BOT_COMMANDS_ENABLED,
    AUTOMATED_FEE_VAULT_FACTORY_ADDRESS: process.env.AUTOMATED_FEE_VAULT_FACTORY_ADDRESS,
    AUTOMATED_FEE_VAULT_IMPLEMENTATION_ADDRESS: process.env.AUTOMATED_FEE_VAULT_IMPLEMENTATION_ADDRESS,
    AUTOMATED_FEE_EXECUTION_ADAPTER_ADDRESS: process.env.AUTOMATED_FEE_EXECUTION_ADAPTER_ADDRESS,
    AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS: process.env.AUTOMATED_FEE_NATIVE_BUYBACK_EXECUTOR_ADDRESS,
    AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS: process.env.AUTOMATED_FEE_PAIRED_BUYBACK_EXECUTOR_ADDRESS,
    AUTOMATED_FEE_ADMIN_ADDRESS: process.env.AUTOMATED_FEE_ADMIN_ADDRESS,
    AUTOMATED_FEE_KEEPER_ADDRESS: process.env.AUTOMATED_FEE_KEEPER_ADDRESS,
    AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS: process.env.AUTOMATED_FEE_QUOTE_AUTHORIZER_ADDRESS,
    AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME: process.env.AUTOMATED_FEE_QUOTE_CDP_ACCOUNT_NAME,
    AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME: process.env.AUTOMATED_FEE_KEEPER_CDP_ACCOUNT_NAME,
    AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME: process.env.AUTOMATED_FEE_ADMIN_CDP_ACCOUNT_NAME,
    AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS: process.env.AUTOMATED_FEE_PAUSE_GUARDIAN_ADDRESS,
    AUTOMATED_FEE_CONTROL_ADDRESS: process.env.AUTOMATED_FEE_CONTROL_ADDRESS,
    AUTOMATED_FEE_V3_ROUTER_ADDRESS: process.env.AUTOMATED_FEE_V3_ROUTER_ADDRESS,
    AUTOMATED_FEE_V3_QUOTER_ADDRESS: process.env.AUTOMATED_FEE_V3_QUOTER_ADDRESS,
    AUTOMATED_FEE_WETH_ADDRESS: process.env.AUTOMATED_FEE_WETH_ADDRESS,
    AUTOMATED_FEE_MANUAL_TEST_ENABLED: process.env.AUTOMATED_FEE_MANUAL_TEST_ENABLED,
    AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES: process.env.AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES,
  });
}

function assertEnrollmentEnabled(tokenAddress: string, source: "new_launch" | "upgrade") {
  const config = configuration();
  if (automatedFeeEnrollmentAllowed(
    config,
    tokenAddress,
    source,
    PRODUCTION_EXECUTION_IMPLEMENTATION_READY,
    PRIVATE_MANUAL_TEST_IMPLEMENTATION_READY,
  )) return;
  throw new Error("automated fee enrollment is not enabled for this token");
}

function automatedFeeRecoveryInfrastructureReady() {
  const config = configuration();
  return PRODUCTION_EXECUTION_IMPLEMENTATION_READY
    && config.infrastructureReady
    && Boolean(process.env.AUTOMATED_FEE_ENROLLMENT_SECRET?.trim());
}

function assertEnrollmentRecoveryReady() {
  if (!automatedFeeRecoveryInfrastructureReady()) {
    throw new Error("automated fee enrollment recovery infrastructure is not ready");
  }
}

function validatedSalt(value: string) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error("vault deployment salt is invalid");
  return value.toLowerCase();
}

const NATIVE_PAIR = "0x0000000000000000000000000000000000000000";
function privateTestLauncherAddress() {
  const configured = process.env.AUTOMATED_FEE_PRIVATE_TEST_LAUNCHER_ADDRESS?.trim();
  if (!configured) throw new Error("private test launcher is not configured");
  return normalizedAddress(configured);
}
const privateTestArgs = {
  tokenAddress: v.string(), vaultAddress: v.string(), deploymentSalt: v.string(),
  launchTransactionHash: v.string(), vaultTransactionHash: v.string(),
};

// Internal operator entry point only. No tokenLaunches, registry, X identity,
// wallet request, announcement, or public catalog row is manufactured here.
export const preparePrivateTestProgram = internalMutation({
  args: privateTestArgs,
  handler: async (ctx, args) => {
    if (!automatedFeePrivateTestEnrollmentAllowed(configuration())) {
      throw new Error("private test requires processing on and all public enrollment/command switches off");
    }
    assertEnrollmentRecoveryReady();
    const token = normalizedAddress(args.tokenAddress);
    const vault = normalizedAddress(args.vaultAddress);
    const privateTestLauncher = privateTestLauncherAddress();
    const salt = validatedSalt(args.deploymentSalt);
    if (token === vault || token === NATIVE_PAIR || vault === NATIVE_PAIR) throw new Error("invalid private test addresses");
    validatedSalt(args.launchTransactionHash);
    validatedSalt(args.vaultTransactionHash);
    const [launch, registry, byToken, byVault] = await Promise.all([
      ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", token)).first(),
      ctx.db.query("tokenRegistry").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", token)).first(),
      ctx.db.query("automatedFeePrograms").withIndex("by_token", (q) => q.eq("normalizedTokenAddress", token)).unique(),
      ctx.db.query("automatedFeePrograms").withIndex("by_vault", (q) => q.eq("normalizedVaultAddress", vault)).unique(),
    ]);
    if (launch || registry) throw new Error("test token already appears in a public index");
    if (byToken || byVault) {
      if (!byToken || byToken._id !== byVault?._id || !byToken.privateTest || byToken.launchId
        || byToken.normalizedControllerAddress !== privateTestLauncher
        || byToken.deploymentSalt !== salt
        || byToken.deploymentTransactionHash !== args.vaultTransactionHash.toLowerCase()
        || byToken.enrollmentTransactionHash !== args.launchTransactionHash.toLowerCase()) {
        throw new Error("private test enrollment identity conflict");
      }
      return byToken._id;
    }
    const now = Date.now();
    return ctx.db.insert("automatedFeePrograms", {
      tokenAddress: token, normalizedTokenAddress: token, vaultAddress: vault, normalizedVaultAddress: vault,
      controllerAddress: privateTestLauncher, normalizedControllerAddress: privateTestLauncher,
      beneficiaryAddress: privateTestLauncher, normalizedBeneficiaryAddress: privateTestLauncher,
      pairTokenAddress: NATIVE_PAIR, normalizedPairTokenAddress: NATIVE_PAIR,
      privateTest: true, distributionMode: "wallet", enrollmentSource: "new_launch", programVersion: 1,
      buybackBps: AUTOMATED_FEE_BUYBACK_BPS, status: "prepared", deploymentSalt: salt,
      deploymentTransactionHash: args.vaultTransactionHash.toLowerCase(),
      enrollmentTransactionHash: args.launchTransactionHash.toLowerCase(),
      lifetimeGrossClaimed: "0", lifetimeBeneficiaryAllocated: "0", lifetimeBuybackSpent: "0", lifetimePonsbotBurned: "0",
      createdAt: now, updatedAt: now,
    });
  },
});

export const registerPrivateTestLaunch = internalAction({
  args: privateTestArgs,
  handler: async (ctx, args): Promise<{ programId: Id<"automatedFeePrograms">; status: string }> => {
    const programId = await ctx.runMutation(internal.automatedFeeEngine.preparePrivateTestProgram, args);
    const context = await ctx.runQuery(internal.automatedFeeEngine.processingContext, { programId });
    if (context.program?.status === "enrolled") return { programId, status: "already_enrolled" };
    // Standard signer verifies registered vault, confirmed receipts, recipient,
    // controller, beneficiary, pair, active state and deployed infrastructure.
    await ctx.runAction(internal.automatedFeeEngine.confirmEnrollment, {
      programId, deploymentTransactionHash: args.vaultTransactionHash.toLowerCase(),
      enrollmentTransactionHash: args.launchTransactionHash.toLowerCase(),
    });
    return { programId, status: "privately_enrolled_for_scheduled_processing" };
  },
});

export const privateTestStatus = internalQuery({
  args: { tokenAddress: v.string() },
  handler: async (ctx, args) => {
    const token = normalizedAddress(args.tokenAddress);
    const program = await ctx.db.query("automatedFeePrograms").withIndex("by_token", (q) => q.eq("normalizedTokenAddress", token)).unique();
    if (!program?.privateTest) throw new Error("private test program not found");
    const [launch, registry, holding, runs] = await Promise.all([
      ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", token)).first(),
      ctx.db.query("tokenRegistry").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", token)).first(),
      ctx.db.query("walletTokenIndex").withIndex("by_token", (q) => q.eq("normalizedTokenAddress", token)).first(),
      ctx.db.query("automatedFeeRuns").withIndex("by_program_status", (q) => q.eq("programId", program._id)).order("desc").take(10),
    ]);
    return {
      program, publicLaunchExists: !!launch, catalogEntryExists: !!registry, holdingIndexExists: !!holding,
      holdingIndex: holding ? { id: holding._id, walletId: holding.walletId, symbol: holding.symbol,
        involvedByLaunch: holding.involvedByLaunch, involvedByTransaction: holding.involvedByTransaction,
        createdAt: holding.createdAt, updatedAt: holding.updatedAt } : null,
      runs: runs.map((run) => ({ id: run._id, status: run.status, stage: run.workflowStage,
        diagnosticCode: run.diagnosticCode, diagnosticDetail: run.diagnosticDetail, updatedAt: run.updatedAt,
        sweepTransactionHash: run.sweepTransactionHash, sweepBroadcastAt: run.sweepBroadcastAt,
        processingTransactionHash: run.processingTransactionHash, deliveryTransactionHash: run.deliveryTransactionHash,
        grossClaimed: run.grossClaimed, beneficiaryAllocated: run.beneficiaryAllocated,
        beneficiaryDelivered: run.beneficiaryDelivered, buybackSpent: run.buybackSpent, ponsbotBurned: run.ponsbotBurned })),
    };
  },
});

// Atomically stop only an operator's private test before its on-chain exit.
// Competes with reserveProcessingRun so an already-started cycle must finish first.
export const pausePrivateTestForExit = internalMutation({
  args: { tokenAddress: v.string(), vaultAddress: v.string(), controllerAddress: v.string() },
  handler: async (ctx, args) => {
    const privateTestLauncher = privateTestLauncherAddress();
    const program = await ctx.db.query("automatedFeePrograms")
      .withIndex("by_token", (q) => q.eq("normalizedTokenAddress", normalizedAddress(args.tokenAddress))).unique();
    if (!program?.privateTest || program.launchId
      || program.normalizedVaultAddress !== normalizedAddress(args.vaultAddress)
      || program.normalizedControllerAddress !== privateTestLauncher
      || normalizedAddress(args.controllerAddress) !== privateTestLauncher
      || program.normalizedBeneficiaryAddress !== privateTestLauncher) {
      throw new Error("private test exit binding mismatch");
    }
    if (program.status === "exited") return { programId: program._id, status: "exited" };
    if (program.status !== "enrolled" && program.status !== "paused") throw new Error("private test requires review before exit");
    const blockers = await Promise.all([
      ...(["reserved", "submitted", "uncertain", "deferred", "manual_review"] as const).map((status) =>
        ctx.db.query("automatedFeeRuns").withIndex("by_program_status", (q) => q.eq("programId", program._id).eq("status", status)).first()),
      ...(["reserved", "prepared", "broadcast", "failed", "manual_review"] as const).map((status) =>
        ctx.db.query("automatedFeeControllerChanges").withIndex("by_program_status", (q) => q.eq("programId", program._id).eq("status", status)).first()),
    ]);
    if (blockers.some(Boolean)) throw new Error("private test has an unfinished fee cycle or controller change; nothing paused");
    await ctx.db.patch(program._id, { status: "paused", nextProcessAt: undefined, updatedAt: Date.now() });
    return { programId: program._id, status: "paused" };
  },
});

export const resumePrivateTestSweep = internalMutation({
  args: { runId: v.id("automatedFeeRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    const program = run ? await ctx.db.get(run.programId) : null;
    if (!program?.privateTest || program.launchId || !run || !automatedFeeProcessingAllowed(configuration())
      || run.status !== "manual_review" || !run.sweepSignedTransaction || !run.sweepTransactionHash
      || run.sweepBroadcastAt || run.processingTransactionHash || run.deliveryTransactionHash
      || !run.diagnosticDetail?.includes("INVALID_SIGNER_REQUEST")) {
      throw new Error("only the private test's rejected pre-broadcast sweep can resume");
    }
    const now = Date.now();
    await ctx.db.patch(run._id, { status: "deferred", workflowStage: "sweep_transaction_prepared",
      leaseId: undefined, leaseUntil: undefined, nextRetryAt: now, updatedAt: now });
    await ctx.db.patch(program._id, { status: "enrolled", nextProcessAt: now, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.automatedFeeEngine.processProgram, { programId: program._id, runId: run._id });
    return { status: "same_signed_sweep_resumed", transactionHash: run.sweepTransactionHash };
  },
});

/// Reserves the predicted token/vault binding before a Pons launch exists.
/// This is deliberately separate from automatedFeePrograms: a failed launch
/// can expire without ever creating an enrolled fee program.
export const reservePrelaunchEnrollment = internalMutation({
  args: {
    requestId: v.string(),
    predictedTokenAddress: v.string(),
    predictedVaultAddress: v.string(),
    controllerAddress: v.string(),
    beneficiaryAddress: v.string(),
    pairTokenAddress: v.string(),
    distributionMode: v.union(v.literal("wallet"), v.literal("holders")),
    deploymentSalt: v.string(),
  },
  handler: async (ctx, args) => {
    if (!automatedFeeDistributionEligible(args.distributionMode)) {
      throw new Error("holder fee sharing is exempt from automated buyback and burn");
    }
    if (!configuration().capabilities.newLaunchEnrollment || !PRODUCTION_EXECUTION_IMPLEMENTATION_READY) {
      throw new Error("automated fee enrollment is not enabled");
    }
    const requestId = args.requestId.trim();
    if (!requestId || requestId.length > 200) throw new Error("automated fee request identity is invalid");
    const token = normalizedAddress(args.predictedTokenAddress);
    const vault = normalizedAddress(args.predictedVaultAddress);
    const existingRequest = await ctx.db.query("automatedFeeEnrollmentReservations")
      .withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique();
    if (existingRequest) {
      if (existingRequest.normalizedPredictedTokenAddress !== token
        || existingRequest.normalizedPredictedVaultAddress !== vault
        || existingRequest.normalizedControllerAddress !== normalizedAddress(args.controllerAddress)
        || existingRequest.normalizedBeneficiaryAddress !== normalizedAddress(args.beneficiaryAddress)
        || existingRequest.normalizedPairTokenAddress !== normalizedAddress(args.pairTokenAddress)
        || existingRequest.distributionMode !== args.distributionMode
        || existingRequest.deploymentSalt !== validatedSalt(args.deploymentSalt)) {
        throw new Error("automated fee reservation identity conflict");
      }
      if (existingRequest.status === "reserved" || existingRequest.status === "bound") return existingRequest._id;
      const existingProgram = await ctx.db.query("automatedFeePrograms").withIndex("by_token", (q) => q.eq("normalizedTokenAddress", token)).unique();
      if (existingProgram) throw new Error("automated fee program already exists");
      const now = Date.now();
      await ctx.db.patch(existingRequest._id, {
        status: "reserved", expiresAt: now + AUTOMATED_FEE_ENROLLMENT_RESERVATION_MS,
        boundProgramId: undefined, updatedAt: now,
      });
      return existingRequest._id;
    }
    const [tokenReservation, vaultReservation, tokenProgram, vaultProgram] = await Promise.all([
      ctx.db.query("automatedFeeEnrollmentReservations").withIndex("by_predicted_token", (q) => q.eq("normalizedPredictedTokenAddress", token)).unique(),
      ctx.db.query("automatedFeeEnrollmentReservations").withIndex("by_predicted_vault", (q) => q.eq("normalizedPredictedVaultAddress", vault)).unique(),
      ctx.db.query("automatedFeePrograms").withIndex("by_token", (q) => q.eq("normalizedTokenAddress", token)).unique(),
      ctx.db.query("automatedFeePrograms").withIndex("by_vault", (q) => q.eq("normalizedVaultAddress", vault)).unique(),
    ]);
    const conflictingReservation = [tokenReservation, vaultReservation].find((reservation) => reservation && (reservation.status === "reserved" || reservation.status === "bound"));
    if (conflictingReservation || tokenProgram || vaultProgram) throw new Error("automated fee reservation already exists");
    const now = Date.now();
    const reusableReservation = tokenReservation ?? vaultReservation;
    if (tokenReservation && vaultReservation && tokenReservation._id !== vaultReservation._id) {
      throw new Error("automated fee inactive reservation identity conflict");
    }
    if (reusableReservation) {
      await ctx.db.patch(reusableReservation._id, {
        requestId, predictedTokenAddress: args.predictedTokenAddress, normalizedPredictedTokenAddress: token,
        predictedVaultAddress: args.predictedVaultAddress, normalizedPredictedVaultAddress: vault,
        controllerAddress: args.controllerAddress, normalizedControllerAddress: normalizedAddress(args.controllerAddress),
        beneficiaryAddress: args.beneficiaryAddress, normalizedBeneficiaryAddress: normalizedAddress(args.beneficiaryAddress),
        pairTokenAddress: args.pairTokenAddress, normalizedPairTokenAddress: normalizedAddress(args.pairTokenAddress),
        distributionMode: args.distributionMode, deploymentSalt: validatedSalt(args.deploymentSalt),
        status: "reserved", boundProgramId: undefined, expiresAt: now + AUTOMATED_FEE_ENROLLMENT_RESERVATION_MS, updatedAt: now,
      });
      return reusableReservation._id;
    }
    return ctx.db.insert("automatedFeeEnrollmentReservations", {
      requestId,
      predictedTokenAddress: args.predictedTokenAddress,
      normalizedPredictedTokenAddress: token,
      predictedVaultAddress: args.predictedVaultAddress,
      normalizedPredictedVaultAddress: vault,
      controllerAddress: args.controllerAddress,
      normalizedControllerAddress: normalizedAddress(args.controllerAddress),
      beneficiaryAddress: args.beneficiaryAddress,
      normalizedBeneficiaryAddress: normalizedAddress(args.beneficiaryAddress),
      pairTokenAddress: args.pairTokenAddress,
      normalizedPairTokenAddress: normalizedAddress(args.pairTokenAddress),
      distributionMode: args.distributionMode,
      deploymentSalt: validatedSalt(args.deploymentSalt),
      status: "reserved",
      expiresAt: now + AUTOMATED_FEE_ENROLLMENT_RESERVATION_MS,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const bindPrelaunchEnrollment = internalMutation({
  args: {
    reservationId: v.id("automatedFeeEnrollmentReservations"),
    launchId: v.id("tokenLaunches"),
    actualTokenAddress: v.string(),
    actualVaultAddress: v.string(),
  },
  handler: async (ctx, args) => {
    // A reservation can only be created while enrollment is enabled. Once a
    // launch has assigned fee rights to its predicted vault, completion must
    // remain recoverable even if operators turn the initiation switch off.
    assertEnrollmentRecoveryReady();
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation || !["reserved", "expired", "bound"].includes(reservation.status)) {
      throw new Error("automated fee reservation is unavailable");
    }
    const token = normalizedAddress(args.actualTokenAddress);
    const vault = normalizedAddress(args.actualVaultAddress);
    const launch = await ctx.db.get(args.launchId);
    if (!launch?.transactionHash || launch.requestId !== reservation.requestId || launch.holderFeeSharing
      || launch.normalizedTokenAddress !== token
      || token !== reservation.normalizedPredictedTokenAddress
      || vault !== reservation.normalizedPredictedVaultAddress) {
      throw new Error("automated fee post-launch binding mismatch");
    }
    const [existingTokenProgram, existingVaultProgram] = await Promise.all([
      ctx.db.query("automatedFeePrograms").withIndex("by_token", (q) => q.eq("normalizedTokenAddress", token)).unique(),
      ctx.db.query("automatedFeePrograms").withIndex("by_vault", (q) => q.eq("normalizedVaultAddress", vault)).unique(),
    ]);
    if (existingTokenProgram || existingVaultProgram) {
      if (existingTokenProgram && existingTokenProgram._id === existingVaultProgram?._id
        && existingTokenProgram.launchId === launch._id && existingTokenProgram.enrollmentRequestId === reservation.requestId
        && existingTokenProgram.deploymentSalt === reservation.deploymentSalt) return existingTokenProgram._id;
      throw new Error("automated fee program already exists");
    }
    const now = Date.now();
    const programId = await ctx.db.insert("automatedFeePrograms", {
      tokenAddress: args.actualTokenAddress,
      normalizedTokenAddress: token,
      launchId: args.launchId,
      vaultAddress: args.actualVaultAddress,
      normalizedVaultAddress: vault,
      controllerAddress: reservation.controllerAddress,
      normalizedControllerAddress: reservation.normalizedControllerAddress,
      beneficiaryAddress: reservation.beneficiaryAddress,
      normalizedBeneficiaryAddress: reservation.normalizedBeneficiaryAddress,
      pairTokenAddress: reservation.pairTokenAddress,
      normalizedPairTokenAddress: reservation.normalizedPairTokenAddress,
      distributionMode: reservation.distributionMode,
      enrollmentSource: "new_launch",
      enrollmentRequestId: reservation.requestId,
      programVersion: 1,
      buybackBps: AUTOMATED_FEE_BUYBACK_BPS,
      status: "prepared",
      deploymentSalt: reservation.deploymentSalt,
      enrollmentAttempts: 0,
      nextEnrollmentAttemptAt: now,
      lifetimeGrossClaimed: "0",
      lifetimeBeneficiaryAllocated: "0",
      lifetimeBuybackSpent: "0",
      lifetimePonsbotBurned: "0",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(reservation._id, { status: "bound", boundProgramId: programId, updatedAt: now });
    return programId;
  },
});

export const cancelPrelaunchEnrollment = internalMutation({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => {
    const reservation = await ctx.db.query("automatedFeeEnrollmentReservations")
      .withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique();
    if (!reservation || reservation.status !== "reserved") return false;
    await ctx.db.patch(reservation._id, { status: "cancelled", updatedAt: Date.now() });
    return true;
  },
});

export const predictNewLaunchVault = internalAction({
  args: {
    requestId: v.string(), ponsFactoryAddress: v.string(),
  },
  handler: async (ctx, args): Promise<{ vaultAddress: string; deploymentSalt: string }> => {
    const config = configuration();
    if (!config.capabilities.newLaunchEnrollment || !PRODUCTION_EXECUTION_IMPLEMENTATION_READY) {
      throw new Error("automated fee new-launch enrollment is not enabled");
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      `ponsbot:automated-fee-vault:${args.requestId}`,
    ));
    const deploymentSalt = `0x${Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    const vaultFactoryAddress = process.env.AUTOMATED_FEE_VAULT_FACTORY_ADDRESS?.trim();
    if (!vaultFactoryAddress) throw new Error("automated fee vault factory is not configured");
    const prediction = await signerRequest<{ vaultAddress: string }>("/v1/automated-fees/predict-vault", {
      chainId: ROBINHOOD_CHAIN_ID, tokenAddress: "0x0000000000000000000000000000000000000000", vaultFactoryAddress,
      ponsFactoryAddress: args.ponsFactoryAddress, salt: deploymentSalt, enrollmentSource: "new_launch",
    });
    return { vaultAddress: prediction.vaultAddress, deploymentSalt };
  },
});

export const newLaunchEnrollmentContext = internalQuery({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => ({
    reservation: await ctx.db.query("automatedFeeEnrollmentReservations")
      .withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique(),
    launch: await ctx.db.query("tokenLaunches").withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique(),
  }),
});

export const bindAndDeployNewLaunch = internalAction({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }): Promise<void> => {
    const context = await ctx.runQuery(internal.automatedFeeEngine.newLaunchEnrollmentContext, { requestId });
    if (!context.reservation || !["reserved", "expired", "bound"].includes(context.reservation.status) || !context.launch?.tokenAddress) return;
    if (context.launch.holderFeeSharing) {
      await ctx.runMutation(internal.automatedFeeEngine.cancelPrelaunchEnrollment, { requestId });
      return;
    }
    const programId = await ctx.runMutation(internal.automatedFeeEngine.bindPrelaunchEnrollment, {
      reservationId: context.reservation._id, launchId: context.launch._id,
      actualTokenAddress: context.launch.tokenAddress, actualVaultAddress: context.reservation.predictedVaultAddress,
    });
    await ctx.runAction(internal.automatedFeeEngine.deployPreparedEnrollment, { programId });
  },
});

export const expirePrelaunchEnrollments = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db.query("automatedFeeEnrollmentReservations")
      .withIndex("by_status_expires", (q) => q.eq("status", "reserved").lte("expiresAt", now))
      .take(100);
    let count = 0;
    for (const reservation of expired) {
      const [launch, request, transaction] = await Promise.all([
        ctx.db.query("tokenLaunches").withIndex("by_request_id", q => q.eq("requestId", reservation.requestId)).unique(),
        ctx.db.query("walletRequests").withIndex("by_request_id", q => q.eq("requestId", reservation.requestId)).unique(),
        ctx.db.query("walletTransactions").withIndex("by_request_id", q => q.eq("requestId", reservation.requestId)).unique(),
      ]);
      // Expiration must never discard an obligation to an already launched token
      // or a launch whose signed envelope may still reach the chain.
      const mayLaunch = launch || transaction || request?.transactionHash
        || (request && !["failed", "rejected", "skipped"].includes(request.status));
      await ctx.db.patch(reservation._id, mayLaunch
        ? { expiresAt: now + AUTOMATED_FEE_ENROLLMENT_RESERVATION_MS }
        : { status: "expired", updatedAt: now });
      if (!mayLaunch) count++;
    }
    return count;
  },
});

export const pendingLaunchBindings = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("automatedFeeEnrollmentReservations")
      .withIndex("by_status_updated", q => q.eq("status", "reserved")).take(25);
    const requests: string[] = [];
    for (const row of rows) {
      // Rotate inspected rows so one failed/still-pending launch cannot starve others.
      await ctx.db.patch(row._id, { updatedAt: Date.now() });
      const launch = await ctx.db.query("tokenLaunches").withIndex("by_request_id", q => q.eq("requestId", row.requestId)).unique();
      if (launch?.transactionHash) requests.push(row.requestId);
    }
    return requests;
  },
});

function normalizedAddress(value: string) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error("automated fee address is invalid");
  return value.toLowerCase();
}

export const prepareEnrollment = internalMutation({
  args: {
    launchId: v.id("tokenLaunches"),
    tokenAddress: v.string(),
    vaultAddress: v.string(),
    controllerAddress: v.string(),
    beneficiaryAddress: v.string(),
    pairTokenAddress: v.string(),
    distributionMode: v.union(v.literal("wallet"), v.literal("holders")),
    enrollmentSource: v.union(v.literal("new_launch"), v.literal("upgrade")),
    enrollmentRequestId: v.optional(v.string()),
    deploymentSalt: v.string(),
  },
  handler: async (ctx, args) => {
    if (!automatedFeeDistributionEligible(args.distributionMode)) {
      throw new Error("holder fee sharing is exempt from automated buyback and burn");
    }
    const token = normalizedAddress(args.tokenAddress);
    assertEnrollmentEnabled(token, args.enrollmentSource);
    const vault = normalizedAddress(args.vaultAddress);
    const controller = normalizedAddress(args.controllerAddress);
    const beneficiary = normalizedAddress(args.beneficiaryAddress);
    const pair = normalizedAddress(args.pairTokenAddress);
    if (!/^0x[a-fA-F0-9]{64}$/.test(args.deploymentSalt)) throw new Error("vault deployment salt is invalid");
    const launch = await ctx.db.get(args.launchId);
    if (!launch || launch.normalizedTokenAddress !== token) throw new Error("automated fee launch binding is invalid");
    const [byToken, byVault] = await Promise.all([
      ctx.db.query("automatedFeePrograms").withIndex("by_token", (q) => q.eq("normalizedTokenAddress", token)).unique(),
      ctx.db.query("automatedFeePrograms").withIndex("by_vault", (q) => q.eq("normalizedVaultAddress", vault)).unique(),
    ]);
    if (byToken || byVault) throw new Error("automated fee program already exists");
    const now = Date.now();
    return ctx.db.insert("automatedFeePrograms", {
      tokenAddress: args.tokenAddress,
      normalizedTokenAddress: token,
      launchId: args.launchId,
      vaultAddress: args.vaultAddress,
      normalizedVaultAddress: vault,
      controllerAddress: args.controllerAddress,
      normalizedControllerAddress: controller,
      beneficiaryAddress: args.beneficiaryAddress,
      normalizedBeneficiaryAddress: beneficiary,
      pairTokenAddress: args.pairTokenAddress,
      normalizedPairTokenAddress: pair,
      distributionMode: args.distributionMode,
      enrollmentSource: args.enrollmentSource,
      enrollmentRequestId: args.enrollmentRequestId,
      programVersion: 1,
      buybackBps: AUTOMATED_FEE_BUYBACK_BPS,
      status: "prepared",
      deploymentSalt: args.deploymentSalt,
      enrollmentAttempts: 0,
      nextEnrollmentAttemptAt: now,
      lifetimeGrossClaimed: "0",
      lifetimeBeneficiaryAllocated: "0",
      lifetimeBuybackSpent: "0",
      lifetimePonsbotBurned: "0",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const finalizeVerifiedEnrollment = internalMutation({
  args: {
    programId: v.id("automatedFeePrograms"),
    deploymentTransactionHash: v.string(),
    enrollmentTransactionHash: v.string(),
    confirmedControllerAddress: v.string(),
    confirmedBeneficiaryAddress: v.string(),
  },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program || program.status !== "prepared") throw new Error("automated fee enrollment is not prepared");
    assertEnrollmentRecoveryReady();
    if (normalizedAddress(args.confirmedControllerAddress) !== program.normalizedControllerAddress
      || normalizedAddress(args.confirmedBeneficiaryAddress) !== program.normalizedBeneficiaryAddress) {
      throw new Error("automated fee enrollment post-state mismatch");
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(args.deploymentTransactionHash)
      || !/^0x[a-fA-F0-9]{64}$/.test(args.enrollmentTransactionHash)) {
      throw new Error("automated fee enrollment transaction hash is invalid");
    }
    const now = Date.now();
    await ctx.db.patch(program._id, {
      status: "enrolled",
      deploymentTransactionHash: args.deploymentTransactionHash,
      enrollmentTransactionHash: args.enrollmentTransactionHash,
      enrolledAt: now,
      nextEnrollmentAttemptAt: undefined,
      enrollmentDiagnosticCode: undefined,
      enrollmentDiagnosticDetail: undefined,
      enrollmentVerificationAttempts: undefined,
      nextProcessAt: now + 15 * 60_000,
      deploymentConfirmedAt: now, deploymentSettledAt: now,
      updatedAt: now,
    });
    if (program.enrollmentSource === "upgrade") {
      await finalizeFeeWalletOutcome(ctx, { ...program, status: "enrolled", enrollmentTransactionHash: args.enrollmentTransactionHash },
        program.enrollmentRequestId ?? "", "upgrade", args.enrollmentTransactionHash);
    }
  },
});

export const markUpgradeVaultDeployed = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), deploymentTransactionHash: v.string() },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program || program.status !== "prepared" || program.enrollmentSource !== "upgrade"
      || program.deploymentTransactionHash?.toLowerCase() !== args.deploymentTransactionHash.toLowerCase()) {
      throw new Error("automated fee upgrade deployment state mismatch");
    }
    await ctx.db.patch(program._id, {
      nextEnrollmentAttemptAt: Date.now() + 60_000, enrollmentDiagnosticCode: "UPGRADE_WAITING_FOR_ASSIGNMENT",
      deploymentConfirmedAt: Date.now(), deploymentSettledAt: Date.now(),
      enrollmentDiagnosticDetail: undefined, updatedAt: Date.now(),
    });
  },
});

export const markUpgradeAssignmentSubmitted = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), assignmentTransactionHash: v.string() },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program || program.status !== "prepared" || program.enrollmentSource !== "upgrade"
      || !program.deploymentTransactionHash || !/^0x[a-fA-F0-9]{64}$/.test(args.assignmentTransactionHash)) {
      throw new Error("automated fee upgrade assignment state mismatch");
    }
    if (program.enrollmentTransactionHash
      && program.enrollmentTransactionHash.toLowerCase() !== args.assignmentTransactionHash.toLowerCase()) {
      throw new Error("automated fee upgrade assignment persistence conflict");
    }
    const now = Date.now();
    await ctx.db.patch(program._id, {
      enrollmentTransactionHash: args.assignmentTransactionHash.toLowerCase(),
      enrollmentDiagnosticCode: "UPGRADE_ASSIGNMENT_SUBMITTED",
      enrollmentDiagnosticDetail: undefined,
      enrollmentVerificationAttempts: 0,
      nextEnrollmentAttemptAt: now,
      updatedAt: now,
    });
  },
});

export const deferUpgradeVerification = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), diagnosticDetail: v.string() },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program || program.status !== "prepared" || program.enrollmentSource !== "upgrade") return;
    const attempts = (program.enrollmentVerificationAttempts ?? 0) + 1;
    const manualReview = attempts >= 20;
    await ctx.db.patch(program._id, {
      status: manualReview ? "manual_review" : "prepared",
      enrollmentVerificationAttempts: attempts,
      enrollmentDiagnosticCode: manualReview ? "UPGRADE_ASSIGNMENT_MANUAL_REVIEW" : "UPGRADE_ASSIGNMENT_VERIFICATION_PENDING",
      enrollmentDiagnosticDetail: args.diagnosticDetail.slice(0, 500),
      nextEnrollmentAttemptAt: manualReview ? undefined : Date.now() + 60_000,
      updatedAt: Date.now(),
    });
  },
});

// A cancelled request stays cancelled. Only a different, admitted request from
// the same wallet can adopt an unassigned, confirmed deployment. Live Pons
// authority is checked by prepareExistingLaunchUpgrade immediately beforehand.
export const restartCancelledUpgrade = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), requestId: v.string(), previousRequestId: v.string(), controllerAddress: v.string() },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program || program.enrollmentRequestId !== args.previousRequestId
      || existingFeeUpgradeState(program, args.requestId) !== "restart"
      || program.normalizedControllerAddress !== normalizedAddress(args.controllerAddress)) throw new Error("cancelled upgrade cannot be restarted");
    const oldRequest = await ctx.db.query("walletRequests").withIndex("by_request_id", q => q.eq("requestId", args.previousRequestId)).unique();
    const request = await ctx.db.query("walletRequests").withIndex("by_request_id", q => q.eq("requestId", args.requestId)).unique();
    const wallet = request ? await ctx.db.get(request.walletId) : null;
    const childId = `${args.previousRequestId}:upgrade-assignment`;
    const oldChild = await ctx.db.query("walletRequests").withIndex("by_request_id", q => q.eq("requestId", childId)).unique();
    const oldTransaction = await ctx.db.query("walletTransactions").withIndex("by_request_id", q => q.eq("requestId", childId)).unique();
    if (!oldRequest || oldRequest.status !== "rejected" || oldRequest.diagnosticCode !== "UPGRADE_CANCELLED_BY_OPERATOR"
      || !request || !["accepted", "simulating"].includes(request.status) || request.kind !== "upgrade_fees"
      || request.diagnosticCode === "UPGRADE_CANCELLED_BY_OPERATOR"
      || request.ownerXUserId !== oldRequest.ownerXUserId || request.walletId !== oldRequest.walletId
      || !wallet || wallet.address.toLowerCase() !== program.normalizedControllerAddress
      || oldChild || oldTransaction) throw new Error("cancelled upgrade assignment requires review");
    await ctx.db.patch(program._id, {
      status: "prepared", enrollmentRequestId: args.requestId,
      enrollmentDiagnosticCode: "UPGRADE_WAITING_FOR_ASSIGNMENT", enrollmentDiagnosticDetail: undefined,
      enrollmentVerificationAttempts: 0, nextEnrollmentAttemptAt: Date.now() + 60_000, updatedAt: Date.now(),
    });
  },
});

export const prepareExistingLaunchUpgrade = internalAction({
  args: {
    launchId: v.id("tokenLaunches"), requestId: v.string(), controllerAddress: v.string(),
    beneficiaryAddress: v.string(), pairTokenAddress: v.string(), ponsFactoryAddress: v.string(),
  },
  handler: async (ctx, args): Promise<{ programId: Id<"automatedFeePrograms">; vaultAddress: string; alreadyEnrolled: boolean }> => {
    const launch = (await ctx.runQuery(internal.automatedFeeEngine.upgradeLaunchContext, { launchId: args.launchId })).launch;
    if (!launch?.tokenAddress || !launch.poolAddress || launch.holderFeeSharing) throw new Error("launch is not eligible for automated fee upgrade");
    assertEnrollmentEnabled(launch.tokenAddress, "upgrade");
    // Reassignment can occur directly on Pons, outside our stored launch row.
    // Read current authority instead of authorizing (or rejecting) stale data.
    const registry = await ctx.runQuery(internal.registry.runtimeConfig, {});
    const live = await signerRequest<{ exists: boolean; creatorFeeRecipient: string | null; pairToken: string | null; distributor: string | null }>("/v1/tokens/holder-distributor", {
      token: launch.tokenAddress, distributorFactoryAddress: registry.contracts.pons_holder_distributor_factory,
      ponsFactoryAddress: args.ponsFactoryAddress,
    });
    if (live.distributor && live.creatorFeeRecipient?.toLowerCase() === live.distributor.toLowerCase()) throw new Error("holder fee sharing is already enabled for this launch");
    if (!live.exists || live.creatorFeeRecipient?.toLowerCase() !== normalizedAddress(args.controllerAddress)
      || normalizedAddress(args.beneficiaryAddress) !== normalizedAddress(args.controllerAddress)) {
      throw new Error("wallet no longer controls this launch's creator fees");
    }
    if (live.pairToken?.toLowerCase() !== normalizedAddress(args.pairTokenAddress)) throw new Error("launch pair could not be verified");
    let existing = await ctx.runQuery(internal.automatedFeeEngine.programByToken, {
      tokenAddress: launch.tokenAddress,
    });
    if (existing) {
      if (existingFeeUpgradeState(existing, args.requestId) === "restart") {
        await ctx.runMutation(internal.automatedFeeEngine.restartCancelledUpgrade, {
          programId: existing._id, requestId: args.requestId,
          previousRequestId: existing.enrollmentRequestId!, controllerAddress: args.controllerAddress,
        });
        existing = (await ctx.runQuery(internal.automatedFeeEngine.enrollmentProgramStatus, { programId: existing._id }))!;
      }
      if (existing.launchId !== args.launchId || existing.enrollmentSource !== "upgrade"
        || existing.enrollmentRequestId !== args.requestId
        || existing.normalizedControllerAddress !== normalizedAddress(args.controllerAddress)
        || existing.normalizedBeneficiaryAddress !== normalizedAddress(args.beneficiaryAddress)
        || existing.normalizedPairTokenAddress !== normalizedAddress(args.pairTokenAddress)
        || existing.status === "exited" || existing.status === "manual_review") {
        throw new Error("automated fee program already exists");
      }
      if (existing.status === "prepared" && !automatedFeeDeploymentConfirmed(existing) && existing.nextEnrollmentAttemptAt !== undefined) {
        await ctx.scheduler.runAfter(0, internal.automatedFeeEngine.deployPreparedEnrollment, { programId: existing._id });
      }
      return { programId: existing._id, vaultAddress: existing.vaultAddress, alreadyEnrolled: existing.status === "enrolled" };
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      `ponsbot:automated-fee-upgrade:${args.requestId}:${launch.tokenAddress.toLowerCase()}`,
    ));
    const deploymentSalt = `0x${Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    const vaultFactoryAddress = process.env.AUTOMATED_FEE_VAULT_FACTORY_ADDRESS?.trim();
    if (!vaultFactoryAddress) throw new Error("automated fee vault factory is not configured");
    const prediction = await signerRequest<{ vaultAddress: string }>("/v1/automated-fees/predict-vault", {
      chainId: ROBINHOOD_CHAIN_ID, tokenAddress: launch.tokenAddress, vaultFactoryAddress,
      ponsFactoryAddress: args.ponsFactoryAddress, salt: deploymentSalt, enrollmentSource: "upgrade",
    });
    const programId = await ctx.runMutation(internal.automatedFeeEngine.prepareEnrollment, {
      launchId: args.launchId, tokenAddress: launch.tokenAddress, vaultAddress: prediction.vaultAddress,
      controllerAddress: args.controllerAddress, beneficiaryAddress: args.beneficiaryAddress,
      pairTokenAddress: args.pairTokenAddress, distributionMode: "wallet", enrollmentSource: "upgrade",
      enrollmentRequestId: args.requestId, deploymentSalt,
    });
    await ctx.scheduler.runAfter(0, internal.automatedFeeEngine.deployPreparedEnrollment, { programId });
    return { programId, vaultAddress: prediction.vaultAddress, alreadyEnrolled: false };
  },
});

export const enrollmentProgramStatus = internalQuery({
  args: { programId: v.id("automatedFeePrograms") },
  handler: async (ctx, { programId }) => ctx.db.get(programId),
});

export const upgradeLaunchContext = internalQuery({
  args: { launchId: v.id("tokenLaunches") },
  handler: async (ctx, { launchId }) => ({ launch: await ctx.db.get(launchId) }),
});

// Deployment-admin-only staging tools. These are deliberately not exposed to
// the X/terminal command dispatcher and never enable public upgrade switches.
export const operatorUpgradeContext = internalQuery({
  args: { tokenAddress: v.string(), controllerAddress: v.string() },
  handler: async (ctx, args) => {
    const token = normalizedAddress(args.tokenAddress);
    const controller = normalizedAddress(args.controllerAddress);
    const [launch, wallet, program] = await Promise.all([
      ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", token)).unique(),
      ctx.db.query("cryptoWallets").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", controller)).unique(),
      ctx.db.query("automatedFeePrograms").withIndex("by_token", (q) => q.eq("normalizedTokenAddress", token)).unique(),
    ]);
    return { launch, wallet, program: program ? {
      _id: program._id, status: program.status, vaultAddress: program.vaultAddress,
      controllerAddress: program.controllerAddress, beneficiaryAddress: program.beneficiaryAddress,
      deploymentSalt: program.deploymentSalt, deploymentTransactionHash: program.deploymentTransactionHash,
      enrollmentTransactionHash: program.enrollmentTransactionHash, nextProcessAt: program.nextProcessAt,
    } : null };
  },
});

export const prepareOperatorUpgradeProgram = internalMutation({
  args: {
    tokenAddress: v.string(), controllerAddress: v.string(), vaultAddress: v.string(),
    deploymentSalt: v.string(), leaseToken: v.string(), requestId: v.string(),
  },
  handler: async (ctx, args) => {
    if (!automatedFeePrivateTestEnrollmentAllowed(configuration())) {
      throw new Error("operator staging requires processing on and public enrollment/commands off");
    }
    assertEnrollmentRecoveryReady();
    const token = normalizedAddress(args.tokenAddress), controller = normalizedAddress(args.controllerAddress);
    const vault = normalizedAddress(args.vaultAddress), salt = validatedSalt(args.deploymentSalt);
    if (token === NATIVE_PAIR || controller === NATIVE_PAIR || vault === NATIVE_PAIR || vault === controller || vault === token) {
      throw new Error("invalid operator upgrade addresses");
    }
    const [launch, wallet, byToken, byVault] = await Promise.all([
      ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", (q) => q.eq("normalizedTokenAddress", token)).unique(),
      ctx.db.query("cryptoWallets").withIndex("by_normalized_address", (q) => q.eq("normalizedAddress", controller)).unique(),
      ctx.db.query("automatedFeePrograms").withIndex("by_token", (q) => q.eq("normalizedTokenAddress", token)).unique(),
      ctx.db.query("automatedFeePrograms").withIndex("by_vault", (q) => q.eq("normalizedVaultAddress", vault)).unique(),
    ]);
    if (!launch?.publicPublished || !launch.poolAddress || launch.holderFeeSharing
      || launch.normalizedCreatorFeeRecipient !== controller || !wallet || wallet.status !== "active"
      || wallet.chainId !== ROBINHOOD_CHAIN_ID || wallet.signerWalletRef.toLowerCase() !== controller) {
      throw new Error("legacy launch or controlling wallet is not eligible");
    }
    const lock = await ctx.db.query("walletExecutionLocks").withIndex("by_wallet_id", (q) => q.eq("walletId", wallet._id)).unique();
    if (!lock || lock.requestId !== args.requestId || lock.leaseToken !== args.leaseToken || lock.leaseUntil <= Date.now()) {
      throw new Error("operator upgrade wallet lease is unavailable");
    }
    if (byToken || byVault) {
      if (!byToken || byToken._id !== byVault?._id || byToken.launchId !== launch._id
        || byToken.normalizedControllerAddress !== controller || byToken.normalizedBeneficiaryAddress !== controller
        || byToken.enrollmentSource !== "upgrade" || byToken.privateTest || byToken.deploymentSalt !== salt
        || !["prepared", "enrolled"].includes(byToken.status)) throw new Error("operator upgrade binding conflicts with an existing program");
      return byToken._id;
    }
    const now = Date.now(), pair = normalizedAddress(launch.pairToken || NATIVE_PAIR);
    // No nextEnrollmentAttemptAt: the operator's persisted script performs the
    // two transactions. Normal processing starts ONLY after signer verification.
    return ctx.db.insert("automatedFeePrograms", {
      tokenAddress: token, normalizedTokenAddress: token, launchId: launch._id,
      vaultAddress: vault, normalizedVaultAddress: vault,
      controllerAddress: controller, normalizedControllerAddress: controller,
      beneficiaryAddress: controller, normalizedBeneficiaryAddress: controller,
      pairTokenAddress: pair, normalizedPairTokenAddress: pair,
      distributionMode: "wallet", enrollmentSource: "upgrade", deploymentSalt: salt,
      programVersion: 1, buybackBps: AUTOMATED_FEE_BUYBACK_BPS, status: "prepared",
      lifetimeGrossClaimed: "0", lifetimeBeneficiaryAllocated: "0", lifetimeBuybackSpent: "0", lifetimePonsbotBurned: "0",
      createdAt: now, updatedAt: now,
    });
  },
});

export const completeExistingLaunchUpgrade = internalAction({
  args: { programId: v.id("automatedFeePrograms"), assignmentTransactionHash: v.string() },
  handler: async (ctx, args) => {
    const program = (await ctx.runQuery(internal.automatedFeeEngine.processingContext, { programId: args.programId })).program;
    if (!program || program.status !== "prepared" || program.enrollmentSource !== "upgrade" || !program.deploymentTransactionHash) {
      throw new Error("automated fee upgrade is not ready for assignment verification");
    }
    await ctx.runAction(internal.automatedFeeEngine.confirmEnrollment, {
      programId: program._id, deploymentTransactionHash: program.deploymentTransactionHash,
      enrollmentTransactionHash: args.assignmentTransactionHash,
    });
  },
});

export const confirmEnrollment = internalAction({
  args: {
    programId: v.id("automatedFeePrograms"), deploymentTransactionHash: v.string(),
    enrollmentTransactionHash: v.string(),
  },
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.automatedFeeEngine.processingContext, { programId: args.programId });
    const program = context.program;
    if (!program || program.status !== "prepared") throw new Error("automated fee enrollment is not prepared");
    const verification = await signerRequest<{
      verified: boolean; controller: string; beneficiary: string; token: string; pairAsset: string;
      creatorFeeRecipient: string; active: boolean; paused: boolean;
    }>("/v1/automated-fees/verify-enrollment", {
      chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress, tokenAddress: program.tokenAddress,
      controllerAddress: program.controllerAddress, beneficiaryAddress: program.beneficiaryAddress,
      pairTokenAddress: program.pairTokenAddress, deploymentTransactionHash: args.deploymentTransactionHash,
      enrollmentTransactionHash: args.enrollmentTransactionHash, enrollmentSource: program.enrollmentSource,
    });
    if (!verification.verified) throw new Error("automated fee enrollment was not verified");
    await ctx.runMutation(internal.automatedFeeEngine.finalizeVerifiedEnrollment, {
      programId: args.programId, deploymentTransactionHash: args.deploymentTransactionHash,
      enrollmentTransactionHash: args.enrollmentTransactionHash,
      confirmedControllerAddress: verification.controller, confirmedBeneficiaryAddress: verification.beneficiary,
    });
  },
});

export const enrollmentContext = internalQuery({
  args: { programId: v.id("automatedFeePrograms") },
  handler: async (ctx, { programId }) => {
    const program = await ctx.db.get(programId);
    return { program, launch: program?.launchId ? await ctx.db.get(program.launchId) : null };
  },
});

export const persistPreparedVaultDeployment = internalMutation({
  args: {
    programId: v.id("automatedFeePrograms"), transactionHash: v.string(),
    signedTransaction: v.string(), transactionNonce: v.number(), preparedAt: v.number(),
    enrollmentTransactionHash: v.string(),
  },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program || program.status !== "prepared") throw new Error("automated fee enrollment is not prepared");
    if (program.deploymentSignedTransaction) {
      if (program.deploymentTransactionHash !== args.transactionHash
        || program.deploymentSignedTransaction !== args.signedTransaction
        || (program.enrollmentSource === "new_launch" && program.enrollmentTransactionHash !== args.enrollmentTransactionHash)) {
        throw new Error("automated fee deployment persistence conflict");
      }
      return;
    }
    await ctx.db.patch(program._id, {
      deploymentTransactionHash: args.transactionHash,
      deploymentSignedTransaction: args.signedTransaction,
      deploymentTransactionNonce: args.transactionNonce,
      deploymentPreparedAt: args.preparedAt,
      enrollmentTransactionHash: program.enrollmentSource === "new_launch" ? args.enrollmentTransactionHash : undefined,
      enrollmentAttempts: (program.enrollmentAttempts ?? 0) + 1,
      nextEnrollmentAttemptAt: args.preparedAt,
      enrollmentDiagnosticCode: undefined,
      enrollmentDiagnosticDetail: undefined,
      updatedAt: args.preparedAt,
    });
  },
});

export const recordVaultDeploymentBroadcast = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), broadcastAt: v.number() },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program || program.status !== "prepared" || !program.deploymentSignedTransaction) {
      throw new Error("automated fee deployment is not prepared for broadcast");
    }
    await ctx.db.patch(program._id, {
      deploymentBroadcastAt: program.deploymentBroadcastAt ?? args.broadcastAt,
      nextEnrollmentAttemptAt: args.broadcastAt + 30_000,
      updatedAt: args.broadcastAt,
    });
  },
});

export const deferVaultEnrollment = internalMutation({
  args: {
    programId: v.id("automatedFeePrograms"), nextAttemptAt: v.number(),
    diagnosticCode: v.string(), diagnosticDetail: v.optional(v.string()),
    clearDeployment: v.optional(v.boolean()), manualReview: v.optional(v.boolean()),
    transactionSettled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program || (program.status !== "prepared" && program.status !== "manual_review")) return;
    await ctx.db.patch(program._id, {
      status: args.manualReview ? "manual_review" : "prepared",
      nextEnrollmentAttemptAt: args.manualReview ? undefined : args.nextAttemptAt,
      enrollmentDiagnosticCode: args.diagnosticCode.slice(0, 100),
      enrollmentDiagnosticDetail: args.diagnosticDetail?.slice(0, 500),
      ...(args.transactionSettled ? { deploymentSettledAt: Date.now() } : {}),
      ...(args.clearDeployment ? {
        deploymentTransactionHash: undefined, deploymentSignedTransaction: undefined,
        deploymentTransactionNonce: undefined, deploymentPreparedAt: undefined, deploymentBroadcastAt: undefined,
        deploymentConfirmedAt: undefined, deploymentSettledAt: undefined,
      } : {}),
      updatedAt: Date.now(),
    });
  },
});

export const acquireDeploymentLease = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), leaseId: v.string() },
  handler: async (ctx, args) => {
    const state = await ctx.db.query("automatedFeeEngineState").withIndex("by_key", q => q.eq("key", ENGINE_KEY)).unique();
    if ((state?.adminLeaseUntil ?? 0) > Date.now() && state?.adminLeaseId !== args.leaseId) return false;
    for (const status of ["prepared", "manual_review"] as const) {
      const programs = await ctx.db.query("automatedFeePrograms").withIndex("by_status_next_enrollment", q => q.eq("status", status))
        .filter(q => q.and(q.neq(q.field("deploymentTransactionHash"), undefined),
          q.eq(q.field("deploymentSettledAt"), undefined), q.eq(q.field("deploymentConfirmedAt"), undefined))).take(101);
      if (programs.length > 100) return false;
      if (programs.some(p => p._id !== args.programId && p.deploymentTransactionHash
        && !p.deploymentSettledAt && !automatedFeeDeploymentConfirmed(p))) return false;
    }
    const patch = { adminLeaseId: args.leaseId, adminProgramId: args.programId, adminLeaseUntil: Date.now() + 5 * 60_000, updatedAt: Date.now() };
    if (state) await ctx.db.patch(state._id, patch);
    else await ctx.db.insert("automatedFeeEngineState", { key: ENGINE_KEY, ...patch });
    return true;
  },
});

export const releaseDeploymentLease = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), leaseId: v.string() },
  handler: async (ctx, args) => {
    const state = await ctx.db.query("automatedFeeEngineState").withIndex("by_key", q => q.eq("key", ENGINE_KEY)).unique();
    if (state?.adminLeaseId === args.leaseId && state.adminProgramId === args.programId) {
      await ctx.db.patch(state._id, { adminLeaseId: undefined, adminProgramId: undefined, adminLeaseUntil: undefined });
    }
  },
});

// Contention is not an execution failure and must not consume signing attempts.
export const deferBlockedEnrollment = internalMutation({
  args: { programId: v.id("automatedFeePrograms") },
  handler: async (ctx, { programId }) => {
    const program = await ctx.db.get(programId);
    if (!program || program.status !== "prepared") return;
    await ctx.db.patch(programId, {
      nextEnrollmentAttemptAt: Math.max(program.nextEnrollmentAttemptAt ?? 0, Date.now() + 60_000),
      updatedAt: Date.now(),
    });
  },
});

// Only called after the signer verifies a successful receipt and factory registration.
// Deployment settlement is independent of subsequent enrollment verification.
export const markVaultDeploymentConfirmed = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), transactionHash: v.string() },
  handler: async (ctx, { programId, transactionHash }) => {
    const program = await ctx.db.get(programId);
    if (!program || program.status !== "prepared"
      || program.deploymentTransactionHash?.toLowerCase() !== transactionHash.toLowerCase()) {
      throw new Error("vault deployment confirmation mismatch");
    }
    await ctx.db.patch(programId, {
      deploymentConfirmedAt: program.deploymentConfirmedAt ?? Date.now(),
      deploymentSettledAt: program.deploymentSettledAt ?? Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const deployPreparedEnrollment = internalAction({
  args: { programId: v.id("automatedFeePrograms") },
  handler: async (ctx, { programId }) => {
    const deploymentLeaseId = crypto.randomUUID();
    if (!(await ctx.runMutation(internal.automatedFeeEngine.acquireDeploymentLease, { programId, leaseId: deploymentLeaseId }))) {
      await ctx.runMutation(internal.automatedFeeEngine.deferBlockedEnrollment, { programId });
      return;
    }
    try {
    const context = await ctx.runQuery(internal.automatedFeeEngine.enrollmentContext, { programId });
    const program = context.program;
    const launch = context.launch;
    if (!program || program.status !== "prepared" || !launch?.poolAddress || !launch.transactionHash) return;
    assertEnrollmentRecoveryReady();
    const attempts = program.enrollmentAttempts ?? 0;
    if (attempts >= 8 && !program.deploymentTransactionHash) {
      await ctx.runMutation(internal.automatedFeeEngine.deferVaultEnrollment, {
        programId, nextAttemptAt: Date.now(), diagnosticCode: "ENROLLMENT_RETRY_LIMIT",
        diagnosticDetail: "Vault deployment requires manual review after repeated failures.", manualReview: true,
      });
      return;
    }
    try {
      let transactionHash = program.deploymentTransactionHash;
      let signedTransaction = program.deploymentSignedTransaction;
      let transactionNonce = program.deploymentTransactionNonce;
      const ponsFactoryAddress = process.env.PONS_V2_FACTORY_ADDRESS?.trim();
      const vaultFactoryAddress = process.env.AUTOMATED_FEE_VAULT_FACTORY_ADDRESS?.trim();
      if (!ponsFactoryAddress || !vaultFactoryAddress) throw new Error("automated fee deployment addresses are not configured");
      if (!signedTransaction || !transactionHash || transactionNonce === undefined) {
        const prediction = await signerRequest<{ vaultAddress: string; feeEscrow: string }>("/v1/automated-fees/predict-vault", {
          chainId: ROBINHOOD_CHAIN_ID, tokenAddress: program.tokenAddress, vaultFactoryAddress,
          ponsFactoryAddress, salt: program.deploymentSalt, enrollmentSource: program.enrollmentSource,
        });
        if (normalizedAddress(prediction.vaultAddress) !== program.normalizedVaultAddress) throw new Error("automated fee predicted vault mismatch");
        const prepared = await signerRequest<{ transactionHash: string; signedTransaction: string; nonce: number; predictedVault: string }>("/v1/automated-fees/prepare-vault", {
          idempotencyKey: `automated-fee-enroll:${program._id}:${attempts + 1}`, chainId: ROBINHOOD_CHAIN_ID,
          vaultFactoryAddress, salt: program.deploymentSalt, token: program.tokenAddress,
          curve: launch.poolAddress, pairAsset: program.pairTokenAddress, ponsFactory: ponsFactoryAddress,
          feeEscrow: prediction.feeEscrow, ponsbot: process.env.PONSBOT_TOKEN_ADDRESS?.trim() || PONSBOT_BURN_TOKEN,
          controller: program.controllerAddress, beneficiary: program.beneficiaryAddress,
          feeControl: process.env.AUTOMATED_FEE_CONTROL_ADDRESS, distributionMode: "wallet",
          enrollmentSource: program.enrollmentSource,
        }, 60_000);
        if (normalizedAddress(prepared.predictedVault) !== program.normalizedVaultAddress) throw new Error("automated fee prepared vault mismatch");
        transactionHash = prepared.transactionHash; signedTransaction = prepared.signedTransaction; transactionNonce = prepared.nonce;
        await ctx.runMutation(internal.automatedFeeEngine.persistPreparedVaultDeployment, {
          programId, transactionHash, signedTransaction, transactionNonce,
          preparedAt: Date.now(), enrollmentTransactionHash: launch.transactionHash,
        });
      }
      let broadcastAt = program.deploymentBroadcastAt;
      if (!broadcastAt) {
        await signerRequest("/v1/automated-fees/broadcast-vault", {
          transactionHash, signedTransaction, vaultAddress: vaultFactoryAddress,
          tokenAddress: program.tokenAddress, enrollmentSource: program.enrollmentSource,
        }, 60_000);
        broadcastAt = Date.now();
        await ctx.runMutation(internal.automatedFeeEngine.recordVaultDeploymentBroadcast, { programId, broadcastAt });
      }
      const status = await signerRequest<{ status: "pending" | "confirmed" | "reverted" | "dropped" }>("/v1/automated-fees/vault-deployment-status", {
        chainId: ROBINHOOD_CHAIN_ID, tokenAddress: program.tokenAddress, vaultFactoryAddress,
        vaultAddress: program.vaultAddress, transactionHash, transactionNonce, broadcastAt,
        enrollmentSource: program.enrollmentSource,
      });
      if (status.status === "confirmed") {
        await ctx.runMutation(internal.automatedFeeEngine.markVaultDeploymentConfirmed, { programId, transactionHash });
        if (program.enrollmentSource === "upgrade") {
          await ctx.runMutation(internal.automatedFeeEngine.markUpgradeVaultDeployed, {
            programId, deploymentTransactionHash: transactionHash,
          });
        } else {
          await ctx.runAction(internal.automatedFeeEngine.confirmEnrollment, {
            programId, deploymentTransactionHash: transactionHash, enrollmentTransactionHash: launch.transactionHash,
          });
        }
      } else if (status.status === "pending") {
        await ctx.runMutation(internal.automatedFeeEngine.deferVaultEnrollment, {
          programId, nextAttemptAt: Date.now() + 30_000, diagnosticCode: "ENROLLMENT_PENDING",
        });
      } else {
        await ctx.runMutation(internal.automatedFeeEngine.deferVaultEnrollment, {
          programId, nextAttemptAt: Date.now() + 60_000, diagnosticCode: `ENROLLMENT_${status.status.toUpperCase()}`,
          clearDeployment: status.status === "dropped", manualReview: status.status === "reverted",
          transactionSettled: true,
        });
      }
    } catch (error) {
      const persisted = await ctx.runQuery(internal.automatedFeeEngine.enrollmentProgramStatus, { programId });
      await ctx.runMutation(internal.automatedFeeEngine.deferVaultEnrollment, {
        programId, nextAttemptAt: Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempts, 5)),
        diagnosticCode: "ENROLLMENT_EXECUTION_FAILED",
        diagnosticDetail: error instanceof Error ? error.message : String(error),
        manualReview: !persisted?.deploymentTransactionHash && attempts + 1 >= 8,
      });
    }
    } finally {
      await ctx.runMutation(internal.automatedFeeEngine.releaseDeploymentLease, { programId, leaseId: deploymentLeaseId });
    }
  },
});

export const recoverPreparedEnrollments = internalAction({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    if (!automatedFeeRecoveryInfrastructureReady()) return { scheduled: 0 };
    const bindings = await ctx.runMutation(internal.automatedFeeEngine.pendingLaunchBindings, {});
    for (const requestId of bindings) await ctx.scheduler.runAfter(0, internal.automatedFeeEngine.bindAndDeployNewLaunch, { requestId });
    const programs: Doc<"automatedFeePrograms">[] = await ctx.runQuery(internal.automatedFeeEngine.duePreparedEnrollments, { now: Date.now() });
    for (const program of programs) {
      if (program.enrollmentSource === "upgrade" && program.deploymentTransactionHash && automatedFeeDeploymentConfirmed(program)) {
        await ctx.scheduler.runAfter(0,
          program.enrollmentTransactionHash
            ? internal.automatedFeeEngine.recoverExistingLaunchUpgrade
            : internal.automatedFeeEngine.recoverUpgradeAssignment,
          { programId: program._id },
        );
      } else {
        await ctx.scheduler.runAfter(0, internal.automatedFeeEngine.deployPreparedEnrollment, { programId: program._id });
      }
    }
    return { scheduled: programs.length + bindings.length };
  },
});

export const recoverUpgradeAssignment = internalAction({
  args: { programId: v.id("automatedFeePrograms") },
  handler: async (ctx, { programId }) => {
    const program = await ctx.runQuery(internal.automatedFeeEngine.enrollmentProgramStatus, { programId });
    if (!program || program.status !== "prepared" || program.enrollmentSource !== "upgrade"
      || !program.deploymentTransactionHash || program.enrollmentTransactionHash || !program.enrollmentRequestId) return;
    if (!automatedFeeDeploymentConfirmed(program)) {
      await ctx.scheduler.runAfter(0, internal.automatedFeeEngine.deployPreparedEnrollment, { programId });
      return;
    }
    const assignmentRequestId = `${program.enrollmentRequestId}:upgrade-assignment`;
    try {
      await ctx.runAction(internal.wallets.reconcileTransaction, { requestId: assignmentRequestId });
    } catch {
      // The persisted wallet request below remains authoritative. A transient
      // RPC error should defer recovery, not erase a possibly broadcast hash.
    }
    const assignment = await ctx.runQuery(internal.wallets.getWalletRequest, { requestId: assignmentRequestId });
    if (assignment?.status === "confirmed" && assignment.transactionHash) {
      await ctx.runMutation(internal.automatedFeeEngine.markUpgradeAssignmentSubmitted, {
        programId, assignmentTransactionHash: assignment.transactionHash,
      });
      await ctx.scheduler.runAfter(0, internal.automatedFeeEngine.recoverExistingLaunchUpgrade, { programId });
      return;
    }
    // Deployment recovery must wake the parent that creates the assignment,
    // not just keep looking for a child transaction that does not exist yet.
    const parent = await ctx.runQuery(internal.wallets.getWalletRequest, { requestId: program.enrollmentRequestId });
    if (parent && ["accepted", "simulating"].includes(parent.status)
      && parent.diagnosticCode !== "UPGRADE_CANCELLED_BY_OPERATOR" && (parent.source ?? "x") === "x") {
      const reply = await ctx.runQuery(internal.xReplies.getRetryContext, { postId: parent.sourcePostId });
      if (reply && !reply.interaction.responsePostId && reply.interaction.commandKind !== "operator_cancelled"
        && !["rejected", "completed", "publishing"].includes(reply.interaction.status)
        && (!reply.interaction.nextRetryAt || reply.interaction.nextRetryAt <= Date.now())) {
        await ctx.runMutation(internal.xReplies.scheduleInteractionRetry, {
          postId: parent.sourcePostId, safeError: AUTOMATED_FEE_WORKFLOW_CONTINUATION,
        });
      }
    }
    await ctx.runMutation(internal.automatedFeeEngine.deferUpgradeVerification, {
      programId,
      diagnosticDetail: assignment
        ? `Upgrade assignment is ${assignment.status}; waiting for a confirmed transaction.`
        : "Upgrade assignment transaction has not been persisted yet.",
    });
  },
});

export const recoverExistingLaunchUpgrade = internalAction({
  args: { programId: v.id("automatedFeePrograms") },
  handler: async (ctx, { programId }) => {
    const program = await ctx.runQuery(internal.automatedFeeEngine.enrollmentProgramStatus, { programId });
    if (!program || !["prepared", "enrolled"].includes(program.status) || program.enrollmentSource !== "upgrade"
      || !program.deploymentTransactionHash || !program.enrollmentTransactionHash) return;
    try {
      if (program.status === "prepared") await ctx.runAction(internal.automatedFeeEngine.confirmEnrollment, {
        programId, deploymentTransactionHash: program.deploymentTransactionHash,
        enrollmentTransactionHash: program.enrollmentTransactionHash,
      });
      await ctx.runMutation(internal.automatedFeeEngine.finalizeRecoveredWalletRequest, {
        requestId: program.enrollmentRequestId ?? "",
        programId, operation: "upgrade", transactionHash: program.enrollmentTransactionHash,
      });
    } catch (error) {
      await ctx.runMutation(internal.automatedFeeEngine.deferUpgradeVerification, {
        programId,
        diagnosticDetail: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

export const finalizeRecoveredWalletRequest = internalMutation({
  args: {
    requestId: v.string(), programId: v.id("automatedFeePrograms"),
    operation: v.union(v.literal("upgrade"), v.literal("reassign"), v.literal("holders")),
    transactionHash: v.string(),
  },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program) throw new Error("automated fee program is missing");
    await finalizeFeeWalletOutcome(ctx, program, args.requestId, args.operation, args.transactionHash);
  },
});

export const duePreparedEnrollments = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    // Search for persisted deployments independently of the unsigned backlog.
    // Otherwise the very receipt that unlocks signing can sit behind ten blocked jobs.
    const submitted = await ctx.db.query("automatedFeePrograms")
      .withIndex("by_status_next_enrollment", q => q.eq("status", "prepared").gt("nextEnrollmentAttemptAt", 0).lte("nextEnrollmentAttemptAt", now))
      .filter(q => q.and(q.neq(q.field("privateTest"), true), q.neq(q.field("deploymentTransactionHash"), undefined)))
      .take(10);
    const unsigned = await ctx.db.query("automatedFeePrograms")
      .withIndex("by_status_next_enrollment", q => q.eq("status", "prepared").gt("nextEnrollmentAttemptAt", 0).lte("nextEnrollmentAttemptAt", now))
      .filter(q => q.and(q.neq(q.field("privateTest"), true), q.eq(q.field("deploymentTransactionHash"), undefined)))
      .take(10 - submitted.length);
    return [...submitted, ...unsigned];
  },
});

export const duePrograms = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }) => ctx.db
    .query("automatedFeePrograms")
    .withIndex("by_status_next_process", (q) => q.eq("status", "enrolled").lte("nextProcessAt", now))
    .take(AUTOMATED_FEE_MAX_PROGRAMS_PER_RUN),
});

export const operationalStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const programStatuses = ["prepared", "enrolled", "paused", "exited", "manual_review"] as const;
    const runStatuses = ["reserved", "submitted", "uncertain", "deferred", "manual_review"] as const;
    const controllerStatuses = ["reserved", "prepared", "broadcast", "failed", "manual_review"] as const;
    const [programs, runs, controllerChanges, incompleteConfirmedControllers, engine] = await Promise.all([
      Promise.all(programStatuses.map(async (status) => ({
        status, count: (await ctx.db.query("automatedFeePrograms").filter((q) => q.eq(q.field("status"), status)).take(101)).length,
      }))),
      Promise.all(runStatuses.map(async (status) => ({
        status, count: (await ctx.db.query("automatedFeeRuns").filter((q) => q.eq(q.field("status"), status)).take(101)).length,
      }))),
      Promise.all(controllerStatuses.map(async (status) => {
        const rows = await ctx.db.query("automatedFeeControllerChanges")
          .withIndex("by_status_updated", (q) => q.eq("status", status)).take(101);
        return {
          status,
          count: status === "failed"
            ? rows.filter((row) => row.transactionHash || row.signedTransaction).length
            : rows.length,
        };
      })),
      ctx.db.query("automatedFeeControllerChanges")
        .withIndex("by_status_workflow_root_updated", (q) => q.eq("status", "confirmed").eq("workflowRoot", true))
        .filter((q) => q.eq(q.field("workflowCompletedAt"), undefined))
        .take(101),
      ctx.db.query("automatedFeeEngineState").withIndex("by_key", (q) => q.eq("key", ENGINE_KEY)).unique(),
    ]);
    return {
      configuration: {
        masterEnabled: configuration().enabled,
        capabilities: configuration().capabilities,
        infrastructureReady: configuration().infrastructureReady,
      },
      programs, runs,
      controllerChanges: [...controllerChanges, { status: "confirmed_incomplete", count: incompleteConfirmedControllers.length }],
      engine: engine ? {
        lastStartedAt: engine.lastStartedAt, lastCompletedAt: engine.lastCompletedAt,
        lastStatus: engine.lastStatus, lastDiagnosticCode: engine.lastDiagnosticCode,
        lifetimePonsbotBurned: engine.lifetimePonsbotBurned ?? "0",
      } : null,
      countsCappedAt: 101,
    };
  },
});

export const monitorOperationalHealth = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    status: "disabled" | "healthy" | "attention_required";
    programManualReview?: number;
    runManualReview?: number;
    controllerManualReview?: number;
    controllerFailed?: number;
    controllerIncomplete?: number;
  }> => {
    if (!automatedFeeRecoveryInfrastructureReady()) return { status: "disabled" as const };
    const health: {
      programs: Array<{ status: string; count: number }>;
      runs: Array<{ status: string; count: number }>;
      controllerChanges: Array<{ status: string; count: number }>;
      engine: unknown;
    } = await ctx.runQuery(internal.automatedFeeEngine.operationalStatus, {});
    const programManualReview = health.programs.find((entry: { status: string }) => entry.status === "manual_review")?.count ?? 0;
    const runManualReview = health.runs.find((entry: { status: string }) => entry.status === "manual_review")?.count ?? 0;
    const controllerManualReview = health.controllerChanges.find((entry: { status: string }) => entry.status === "manual_review")?.count ?? 0;
    const controllerFailed = health.controllerChanges.find((entry: { status: string }) => entry.status === "failed")?.count ?? 0;
    const controllerIncomplete = health.controllerChanges.find((entry: { status: string }) => entry.status === "confirmed_incomplete")?.count ?? 0;
    if (programManualReview || runManualReview || controllerManualReview || controllerFailed || controllerIncomplete) {
      console.error("automated_fee_operational_attention_required", {
        programManualReview, runManualReview, controllerManualReview, controllerFailed, controllerIncomplete,
        engine: health.engine,
      });
      return { status: "attention_required" as const, programManualReview, runManualReview, controllerManualReview, controllerFailed, controllerIncomplete };
    }
    return { status: "healthy" as const };
  },
});

export const processingContext = internalQuery({
  args: { programId: v.id("automatedFeePrograms"), runId: v.optional(v.id("automatedFeeRuns")) },
  handler: async (ctx, args) => ({
    program: await ctx.db.get(args.programId),
    run: args.runId ? await ctx.db.get(args.runId) : null,
  }),
});

export const reserveProcessingRun = internalMutation({
  args: {
    programId: v.id("automatedFeePrograms"),
    processThroughBlock: v.string(),
    executionNonce: v.string(),
    phaseAtReservation: v.number(),
    requiresClaim: v.optional(v.boolean()),
    leaseId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program || program.status !== "enrolled") throw new Error("automated fee program is not executable");
    if (!PRODUCTION_EXECUTION_IMPLEMENTATION_READY || !automatedFeeProcessingAllowed(configuration())) {
      throw new Error("automated fee processing is not enabled");
    }
    const controllerChanges = await Promise.all(
      (["reserved", "prepared", "broadcast", "failed", "manual_review"] as const).map((status) =>
        ctx.db.query("automatedFeeControllerChanges")
          .withIndex("by_program_status", (q) => q.eq("programId", program._id).eq("status", status))
          .first(),
      ),
    );
    if (controllerChanges.some((change) => change
      && (change.status !== "failed" || automatedFeeControllerTransactionMayExist(change)))) {
      throw new Error("automated fee controller change is in progress");
    }
    const activeRuns = await Promise.all(
      (["reserved", "submitted", "uncertain", "deferred"] as const).map((status) => ctx.db
        .query("automatedFeeRuns")
        .withIndex("by_program_status", (q) => q.eq("programId", program._id).eq("status", status))
        .first()),
    );
    const activeRun = activeRuns.find((run) => run !== null);
    if (activeRun) {
      if (activeRun.beneficiaryAddress.toLowerCase() === program.normalizedBeneficiaryAddress)
        await attachRequestedClaims(ctx, program, activeRun._id);
      if (activeRun.status === "reserved" && (activeRun.leaseUntil ?? 0) < args.now) {
        await ctx.db.patch(activeRun._id, {
          status: "deferred",
          workflowStage: "reservation_lease_expired",
          leaseId: undefined,
          leaseUntil: undefined,
          retryCount: activeRun.retryCount + 1,
          nextRetryAt: args.now,
          diagnosticCode: "AUTOMATED_FEE_RESERVATION_LEASE_EXPIRED",
          updatedAt: args.now,
        });
        return { runId: activeRun._id, created: false, status: "deferred" as const };
      }
      return { runId: activeRun._id, created: false, status: activeRun.status };
    }
    const key = automatedFeeRunIdempotencyKey(program.tokenAddress, args.processThroughBlock);
    const existing = await ctx.db.query("automatedFeeRuns").withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", key)).unique();
    if (existing) return { runId: existing._id, created: false, status: existing.status };
    const requestedClaim = requestedVaultClaimsEnabled() && (await liveRequestedClaims(ctx, program)).length > 0;
    if (args.requiresClaim && !requestedClaim) throw new Error("AUTOMATED_FEE_REQUEST_CANCELLED");
    const runId = await ctx.db.insert("automatedFeeRuns", {
      programId: program._id,
      requestedClaim,
      tokenAddress: program.tokenAddress,
      vaultAddress: program.vaultAddress,
      idempotencyKey: key,
      status: "reserved",
      workflowStage: "reserved_before_quote",
      pairTokenAddress: program.pairTokenAddress,
      controllerAddress: program.controllerAddress,
      beneficiaryAddress: program.beneficiaryAddress,
      executionNonce: args.executionNonce,
      phaseAtReservation: args.phaseAtReservation,
      leaseId: args.leaseId,
      leaseUntil: args.now + RUN_ACTION_LEASE_MS,
      retryCount: 0,
      createdAt: args.now,
      updatedAt: args.now,
    });
    await attachRequestedClaims(ctx, program, runId);
    return { runId, created: true, status: "reserved" as const };
  },
});

export const acquireProcessingRunLease = internalMutation({
  args: { runId: v.id("automatedFeeRuns"), leaseId: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status === "confirmed" || run.status === "manual_review" || run.status === "reverted") return false;
    if (run.leaseUntil && run.leaseUntil > args.now && run.leaseId !== args.leaseId) return false;
    await ctx.db.patch(run._id, { leaseId: args.leaseId, leaseUntil: args.now + RUN_ACTION_LEASE_MS, updatedAt: args.now });
    return true;
  },
});

export const releaseProcessingRunLease = internalMutation({
  args: { runId: v.id("automatedFeeRuns"), leaseId: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.leaseId !== args.leaseId) return false;
    await ctx.db.patch(run._id, { leaseId: undefined, leaseUntil: undefined, updatedAt: Date.now() });
    return true;
  },
});

export const acquireKeeperLease = internalMutation({
  args: { runId: v.optional(v.id("automatedFeeRuns")), controllerRequestId: v.optional(v.string()), leaseId: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    if (Boolean(args.runId) === Boolean(args.controllerRequestId)) throw new Error("keeper lease requires exactly one workflow identity");
    const state = await ctx.db.query("automatedFeeEngineState").withIndex("by_key", (q) => q.eq("key", ENGINE_KEY)).unique();
    if (state?.keeperLeaseUntil && state.keeperLeaseUntil > args.now && state.keeperLeaseId !== args.leaseId) return false;
    // A released/expired action lease is not permission to reuse the nonce of a
    // persisted but unconfirmed transaction. Only its own workflow may resume it.
    for (const status of ["reserved", "submitted", "uncertain", "deferred", "manual_review"] as const) {
      const runs = await ctx.db.query("automatedFeeRuns").withIndex("by_status_next_retry", q => q.eq("status", status))
        .filter(q => q.or(
          q.and(q.neq(q.field("sweepTransactionHash"), undefined), q.eq(q.field("sweepBlockNumber"), undefined)),
          q.and(q.neq(q.field("processingTransactionHash"), undefined), q.eq(q.field("processingBlockNumber"), undefined)),
          q.and(q.neq(q.field("deliveryTransactionHash"), undefined), q.eq(q.field("deliveryBlockNumber"), undefined)),
        )).take(101);
      if (runs.length > 100) return false;
      if (runs.some(run => run._id !== args.runId && !/REVERTED$/.test(run.diagnosticCode ?? "") && (
        (run.sweepTransactionHash && !run.sweepBlockNumber)
        || (run.processingTransactionHash && !run.processingBlockNumber)
        || (run.deliveryTransactionHash && !run.deliveryBlockNumber)))) return false;
    }
    for (const status of ["prepared", "broadcast", "failed", "manual_review"] as const) {
      const rows = await ctx.db.query("automatedFeeControllerChanges").withIndex("by_status_updated", q => q.eq("status", status))
        .filter(q => q.and(q.neq(q.field("transactionHash"), undefined), q.eq(q.field("transactionSettledAt"), undefined))).take(101);
      if (rows.length > 100) return false;
      if (rows.some(row => (row.parentRequestId ?? row.requestId.replace(/:(?:controller-sweep|former-beneficiary-delivery)$/, "")) !== args.controllerRequestId
        && row.transactionHash && !row.transactionSettledAt
        && /:(?:controller-sweep|former-beneficiary-delivery)$/.test(row.requestId))) return false;
    }
    const patch = { keeperLeaseId: args.leaseId, keeperLeaseUntil: args.now + KEEPER_ACTION_LEASE_MS,
      keeperRunId: args.runId, keeperControllerRequestId: args.controllerRequestId, updatedAt: args.now };
    if (state) await ctx.db.patch(state._id, patch);
    else await ctx.db.insert("automatedFeeEngineState", { key: ENGINE_KEY, ...patch });
    return true;
  },
});

export const releaseKeeperLease = internalMutation({
  args: { runId: v.optional(v.id("automatedFeeRuns")), controllerRequestId: v.optional(v.string()), leaseId: v.string() },
  handler: async (ctx, args) => {
    const state = await ctx.db.query("automatedFeeEngineState").withIndex("by_key", (q) => q.eq("key", ENGINE_KEY)).unique();
    if (!state || state.keeperLeaseId !== args.leaseId || state.keeperRunId !== args.runId
      || state.keeperControllerRequestId !== args.controllerRequestId) return false;
    await ctx.db.patch(state._id, { keeperLeaseId: undefined, keeperLeaseUntil: undefined, keeperRunId: undefined, keeperControllerRequestId: undefined, updatedAt: Date.now() });
    return true;
  },
});

export const recordSubmittedRun = internalMutation({
  args: {
    runId: v.id("automatedFeeRuns"),
    leaseId: v.string(),
    transactionHash: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    // Once a transaction may have been broadcast, preserving its hash is safer
    // than rejecting the record because the lease expired milliseconds earlier.
    // A matching lease identity is still required and overlapping runs are blocked.
    if (!run || run.status !== "reserved" || run.leaseId !== args.leaseId) {
      throw new Error("automated fee run lease is unavailable");
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(args.transactionHash)) throw new Error("automated fee transaction hash is invalid");
    await ctx.db.patch(run._id, {
      status: "submitted",
      workflowStage: "transaction_submitted",
      transactionHash: args.transactionHash.toLowerCase(),
      leaseUntil: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const recordRunStageTransaction = internalMutation({
  args: {
    runId: v.id("automatedFeeRuns"),
    leaseId: v.optional(v.string()),
    stage: v.union(v.literal("sweep"), v.literal("processing"), v.literal("delivery")),
    transactionHash: v.string(),
    signedTransaction: v.string(),
    transactionNonce: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || !["reserved", "submitted", "uncertain", "deferred"].includes(run.status)) {
      throw new Error("automated fee run is unavailable");
    }
    if (!args.leaseId || run.leaseId !== args.leaseId || (run.leaseUntil ?? 0) < Date.now()) {
      throw new Error("automated fee run lease is unavailable");
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(args.transactionHash)) throw new Error("automated fee transaction hash is invalid");
    if (!/^0x[a-fA-F0-9]+$/.test(args.signedTransaction) || args.signedTransaction.length > 50_000) throw new Error("automated fee signed transaction is invalid");
    if (!Number.isSafeInteger(args.transactionNonce) || args.transactionNonce < 0) throw new Error("automated fee transaction nonce is invalid");
    const hash = args.transactionHash.toLowerCase();
    const existing = args.stage === "sweep" ? run.sweepTransactionHash
      : args.stage === "processing" ? run.processingTransactionHash
        : run.deliveryTransactionHash;
    if (existing && existing !== hash) throw new Error("automated fee stage transaction identity conflict");
    if (args.stage === "sweep" && (run.graduatedEscrowReadyBlock || run.processingTransactionHash || run.deliveryTransactionHash)) {
      throw new Error("automated fee sweep stage is out of order");
    }
    if (args.stage === "processing" && (!feeSweepPrerequisiteSatisfied(run) || run.deliveryTransactionHash)) {
      throw new Error("automated fee processing stage is out of order");
    }
    if (args.stage === "delivery" && (!run.processingBlockNumber || !run.beneficiaryAllocated)) {
      throw new Error("automated fee delivery stage is out of order");
    }
    const preparedAt = Date.now();
    const stagePatch = args.stage === "sweep" ? { sweepTransactionHash: hash, sweepSignedTransaction: args.signedTransaction, sweepTransactionNonce: args.transactionNonce, sweepPreparedAt: preparedAt }
      : args.stage === "processing" ? { processingTransactionHash: hash, processingSignedTransaction: args.signedTransaction, processingTransactionNonce: args.transactionNonce, processingPreparedAt: preparedAt, transactionHash: hash }
        : { deliveryTransactionHash: hash, deliverySignedTransaction: args.signedTransaction, deliveryTransactionNonce: args.transactionNonce, deliveryPreparedAt: preparedAt };
    await ctx.db.patch(run._id, {
      ...stagePatch,
      status: "reserved",
      workflowStage: `${args.stage}_transaction_prepared`,
      updatedAt: Date.now(),
    });
  },
});

export const recordRunStageBroadcast = internalMutation({
  args: { runId: v.id("automatedFeeRuns"), leaseId: v.string(), stage: v.union(v.literal("sweep"), v.literal("processing"), v.literal("delivery")), transactionHash: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.leaseId !== args.leaseId || (run.leaseUntil ?? 0) < Date.now()) throw new Error("automated fee run lease is unavailable");
    const expected = args.stage === "sweep" ? run.sweepTransactionHash : args.stage === "processing" ? run.processingTransactionHash : run.deliveryTransactionHash;
    if (!expected || expected !== args.transactionHash.toLowerCase()) throw new Error("automated fee broadcast identity mismatch");
    const now = Date.now();
    const stagePatch = args.stage === "sweep" ? { sweepBroadcastAt: now }
      : args.stage === "processing" ? { processingBroadcastAt: now }
        : { deliveryBroadcastAt: now };
    await ctx.db.patch(run._id, { ...stagePatch, status: "submitted", workflowStage: `${args.stage}_transaction_submitted`, pendingStatusChecks: 0, updatedAt: now });
  },
});

export const recordPendingStageCheck = internalMutation({
  args: { runId: v.id("automatedFeeRuns"), stage: v.union(v.literal("sweep"), v.literal("processing"), v.literal("delivery")) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status === "confirmed" || run.status === "manual_review") return { manualReview: false, checks: 0 };
    const checks = (run.pendingStatusChecks ?? 0) + 1;
    const broadcastAt = args.stage === "sweep" ? run.sweepBroadcastAt : args.stage === "processing" ? run.processingBroadcastAt : run.deliveryBroadcastAt;
    const manualReview = checks >= MAX_PENDING_STATUS_CHECKS || Boolean(broadcastAt && Date.now() - broadcastAt >= MAX_PENDING_STAGE_MS);
    await ctx.db.patch(run._id, { pendingStatusChecks: checks, status: manualReview ? "manual_review" : run.status, workflowStage: manualReview ? `${args.stage}_pending_manual_review` : run.workflowStage, diagnosticCode: manualReview ? "AUTOMATED_FEE_TRANSACTION_PENDING_TOO_LONG" : run.diagnosticCode, updatedAt: Date.now() });
    if (manualReview) await ctx.db.patch(run.programId, { status: "manual_review", nextProcessAt: undefined, updatedAt: Date.now() });
    return { manualReview, checks };
  },
});

export const confirmRunStage = internalMutation({
  args: {
    runId: v.id("automatedFeeRuns"),
    stage: v.union(v.literal("sweep"), v.literal("processing"), v.literal("delivery")),
    blockNumber: v.string(),
    beneficiaryDelivered: v.optional(v.string()),
    externalDelivery: v.optional(v.boolean()),
    gasCostWei: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || !["submitted", "uncertain", "deferred"].includes(run.status)) throw new Error("automated fee run cannot confirm this stage");
    if (!/^\d+$/.test(args.blockNumber) || (args.beneficiaryDelivered !== undefined && !/^\d+$/.test(args.beneficiaryDelivered))) {
      throw new Error("automated fee stage receipt values are invalid");
    }
    if (args.gasCostWei !== undefined && !/^\d+$/.test(args.gasCostWei)) throw new Error("invalid fee gas cost");
    const expectedHash = args.stage === "sweep" ? run.sweepTransactionHash
      : args.stage === "processing" ? run.processingTransactionHash
        : run.deliveryTransactionHash;
    if (!expectedHash && !(args.stage === "delivery" && args.externalDelivery === true)) throw new Error("automated fee stage transaction was not recorded");
    if (args.stage === "processing" && !feeSweepPrerequisiteSatisfied(run)) throw new Error("automated fee processing confirmation is out of order");
    if (args.stage === "delivery" && (!run.processingBlockNumber || !run.beneficiaryAllocated)) {
      throw new Error("automated fee delivery confirmation is out of order");
    }
    const stagePatch = args.stage === "sweep" ? { sweepBlockNumber: args.blockNumber }
      : args.stage === "processing" ? { processingBlockNumber: args.blockNumber }
        : { deliveryBlockNumber: args.blockNumber, beneficiaryDelivered: args.beneficiaryDelivered };
    await ctx.db.patch(run._id, {
      ...stagePatch,
      ...(args.gasCostWei !== undefined ? { [`${args.stage}GasCostWei`]: args.gasCostWei } : {}),
      workflowStage: `${args.stage}_confirmed`,
      updatedAt: Date.now(),
    });
  },
});

export const recordRunGas = internalMutation({
  args: { runId: v.id("automatedFeeRuns"), stage: v.union(v.literal("sweep"), v.literal("processing"), v.literal("delivery")),
    transactionHash: v.string(), gasCostWei: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run[`${args.stage}TransactionHash`]?.toLowerCase() !== args.transactionHash.toLowerCase()
      || !/^\d+$/.test(args.gasCostWei)) throw new Error("AUTOMATED_FEE_GAS_RECEIPT_MISMATCH");
    const receipts = run.gasReceipts ?? [], hash = args.transactionHash.toLowerCase();
    if (receipts.some(r => r.transactionHash === hash)) return;
    await ctx.db.patch(run._id, { gasReceipts: [...receipts, { transactionHash: hash, stage: args.stage, costWei: args.gasCostWei }],
      [`${args.stage}GasCostWei`]: args.gasCostWei });
  },
});

export const deferProcessingRun = internalMutation({
  args: {
    programId: v.id("automatedFeePrograms"), runId: v.id("automatedFeeRuns"),
    diagnosticCode: v.string(), diagnosticDetail: v.optional(v.string()), manualReview: v.boolean(), retryAfterMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const [program, run] = await Promise.all([ctx.db.get(args.programId), ctx.db.get(args.runId)]);
    if (!program || !run || run.programId !== program._id || run.status === "confirmed") return false;
    const now = Date.now();
    const retryAt = now + feeRetryDelay(run.retryCount, args.retryAfterMs);
    await ctx.db.patch(run._id, {
      status: args.manualReview ? "manual_review" : "deferred",
      workflowStage: args.manualReview ? "manual_review" : "retry_deferred",
      leaseId: undefined, leaseUntil: undefined,
      retryCount: run.retryCount + 1,
      nextRetryAt: args.manualReview ? undefined : retryAt,
      diagnosticCode: args.diagnosticCode.slice(0, 120),
      diagnosticDetail: args.diagnosticDetail?.slice(0, 500), updatedAt: now,
    });
    await ctx.db.patch(program._id, {
      status: args.manualReview ? "manual_review" : program.status,
      nextProcessAt: args.manualReview ? undefined : program.nextProcessAt ?? nextFeeCheck(program, now),
      workDueAt: args.manualReview ? undefined : retryAt,
      processingDiagnosticCode: args.manualReview ? "MANUAL_REVIEW" : "RPC_RETRY",
      updatedAt: now,
    });
    if (!args.manualReview) await ctx.scheduler.runAfter(retryAt - now, internal.automatedFeeQueue.dispatch, {});
    return true;
  },
});

export const markProgramManualReview = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), diagnosticCode: v.string(), diagnosticDetail: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program || program.status === "exited") return false;
    const now = Date.now();
    await ctx.db.patch(program._id, { status: "manual_review", nextProcessAt: undefined, updatedAt: now });
    const state = await ctx.db.query("automatedFeeEngineState").withIndex("by_key", (q) => q.eq("key", ENGINE_KEY)).unique();
    const patch = { lastStatus: "failed" as const, lastDiagnosticCode: args.diagnosticCode.slice(0, 120), updatedAt: now };
    if (state) await ctx.db.patch(state._id, patch);
    else await ctx.db.insert("automatedFeeEngineState", { key: ENGINE_KEY, ...patch });
    console.error("automated_fee_program_manual_review", {
      programId: String(program._id), diagnosticCode: args.diagnosticCode.slice(0, 120),
      diagnosticDetail: args.diagnosticDetail?.slice(0, 500),
    });
    return true;
  },
});

export const deferProgramWithoutRun = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), diagnosticCode: v.string(), delayMs: v.number() },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program || program.status !== "enrolled") return false;
    const now = Date.now();
    const delay = Math.max(args.delayMs, feeRetryDelay(program.workAttempts ?? 0));
    await ctx.db.patch(program._id, { workDueAt: now + delay, workAttempts: (program.workAttempts ?? 0) + 1,
      processingDiagnosticCode: args.diagnosticCode.slice(0, 120), updatedAt: now });
    await ctx.scheduler.runAfter(delay, internal.automatedFeeQueue.dispatch, {});
    const state = await ctx.db.query("automatedFeeEngineState").withIndex("by_key", (q) => q.eq("key", ENGINE_KEY)).unique();
    if (state) await ctx.db.patch(state._id, { lastDiagnosticCode: args.diagnosticCode.slice(0, 120), updatedAt: now });
    return true;
  },
});

export const resetSweepAfterGraduation = internalMutation({
  args: { runId: v.id("automatedFeeRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.processingTransactionHash || run.deliveryTransactionHash || run.phaseAtReservation !== 0) return false;
    await ctx.db.patch(run._id, {
      phaseAtReservation: 2,
      sweepTransactionHash: undefined, sweepSignedTransaction: undefined, sweepTransactionNonce: undefined,
      sweepPreparedAt: undefined, sweepBroadcastAt: undefined, sweepBlockNumber: undefined,
      pendingStatusChecks: 0, status: "deferred", workflowStage: "graduation_detected_retry_graduated_sweep",
      leaseId: undefined, leaseUntil: undefined, nextRetryAt: Date.now(), updatedAt: Date.now(),
    });
    return true;
  },
});

export const finalizeNoFeeRun = internalMutation({
  args: { runId: v.id("automatedFeeRuns"), blockNumber: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || !feeSweepPrerequisiteSatisfied(run) || run.processingTransactionHash) throw new Error("automated fee no-fee run is not finalizable");
    const now = Date.now();
    await ctx.db.patch(run._id, { status: "confirmed", workflowStage: "cycle_no_fees", blockNumber: args.blockNumber, leaseId: undefined, leaseUntil: undefined, updatedAt: now });
    const program = await ctx.db.get(run.programId);
    await ctx.db.patch(run.programId, { lastProcessAt: now, lastProcessedBlock: args.blockNumber,
      nextProcessAt: nextFeeCheck(program ?? {}, now), workDueAt: undefined, processingDiagnosticCode: "NO_FEES", updatedAt: now });
    return true;
  },
});

export const finalizeUnsweptNoFeeRun = internalMutation({
  args: { runId: v.id("automatedFeeRuns"), blockNumber: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.sweepTransactionHash || run.processingTransactionHash || !/^\d+$/.test(args.blockNumber)) {
      throw new Error("automated fee unswept no-fee run is not finalizable");
    }
    const now = Date.now();
    await ctx.db.patch(run._id, { status: "confirmed", workflowStage: "cycle_no_fees_or_dust", blockNumber: args.blockNumber, leaseId: undefined, leaseUntil: undefined, updatedAt: now });
    const program = await ctx.db.get(run.programId);
    await ctx.db.patch(run.programId, { lastProcessAt: now, lastProcessedBlock: args.blockNumber,
      nextProcessAt: nextFeeCheck(program ?? {}, now), workDueAt: undefined, processingDiagnosticCode: "NO_FEES", updatedAt: now });
  },
});

type Inspection = {
  blockNumber: string; token: string; pairAsset: string; controller: string; beneficiary: string;
  executionNonce: string; active: boolean; paused: boolean; phase: number; creatorFeeRecipient: string; escrowBalance: string;
  lastCurveSweepBlock: string;
  availableCreatorFeesEthWei?: string; availableCreatorFees?: string; escrowCreatorFeesEthWei?: string;
  operatorRequired?: boolean;
};
type PreparedTx = { transactionHash: string; signedTransaction: string; nonce: number };
type SweepPrepared = PreparedTx | { noFees: true; blockNumber: string };
type DeliveryPrepared = PreparedTx | { alreadyDelivered: true; deliveredAmount: string; blockNumber: string };
type Status = { status: "pending" | "dropped" | "reverted" | "confirmed"; blockNumber?: string; gasCostWei?: string; grossClaimed?: string; beneficiaryAllocated?: string; buybackSpent?: string; ponsbotBurned?: string; amount?: string };

export const recordGraduatedEscrowReady = internalMutation({
  args: { runId: v.id("automatedFeeRuns"), leaseId: v.string(), phase: v.literal(2), blockNumber: v.string(), escrowBalance: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || !["reserved", "deferred"].includes(run.status)
      || run.leaseId !== args.leaseId || (run.leaseUntil ?? 0) <= Date.now()
      || !/^\d+$/.test(args.blockNumber) || !canUseGraduatedEscrow(args.phase, args.escrowBalance, run)) {
      throw new Error("graduated escrow observation is unavailable");
    }
    await ctx.db.patch(run._id, { graduatedEscrowReadyBlock: args.blockNumber,
      workflowStage: "graduated_escrow_ready_without_sweep", updatedAt: Date.now() });
  },
});

export const deferGraduatedSweepPreflight = internalMutation({
  args: { runId: v.id("automatedFeeRuns"), leaseId: v.string(), phase: v.literal(2), diagnosticDetail: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    const program = run ? await ctx.db.get(run.programId) : null;
    if (!run || !program || program.status !== "enrolled" || run.leaseId !== args.leaseId
      || (run.leaseUntil ?? 0) <= Date.now()
      || !isGraduatedSweepPreflightFailure(args.phase, args.diagnosticDetail, run)) {
      throw new Error("graduated sweep retry is unavailable");
    }
    const now = Date.now();
    const nextRetryAt = now + 5 * 60_000;
    await ctx.db.patch(run._id, { status: "deferred", workflowStage: "graduated_sweep_preflight_wait",
      leaseId: undefined, leaseUntil: undefined, nextRetryAt, retryCount: run.retryCount + 1,
      diagnosticCode: "AUTOMATED_FEE_GRADUATED_SWEEP_DEFERRED", diagnosticDetail: args.diagnosticDetail.slice(0, 500), updatedAt: now });
    await ctx.db.patch(program._id, { workDueAt: nextRetryAt, processingDiagnosticCode: "WAITING_PONS_OPERATOR", updatedAt: now });
    await ctx.scheduler.runAfter(5 * 60_000, internal.automatedFeeQueue.dispatch, {});
  },
});

// Operator-only incident recovery. Never reopens a run with any transaction,
// and the normal worker revalidates the live vault before signing anything.
export const resumeGraduatedSweepPreflight = internalMutation({
  args: { runId: v.id("automatedFeeRuns"), expectedTokenAddress: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    const program = run ? await ctx.db.get(run.programId) : null;
    if (!run || !program || !automatedFeeProcessingAllowed(configuration())
      || run.status !== "manual_review" || program.status !== "manual_review"
      || program.normalizedTokenAddress !== normalizedAddress(args.expectedTokenAddress)
      || !isGraduatedSweepPreflightFailure(run.phaseAtReservation, run.diagnosticDetail ?? "", run)) {
      throw new Error("only an unsigned graduated sweep preflight failure can resume");
    }
    const blockers = await Promise.all([
      ...(["reserved", "submitted", "deferred", "uncertain"] as const).map(status => ctx.db.query("automatedFeeRuns")
        .withIndex("by_program_status", q => q.eq("programId", program._id).eq("status", status)).first()),
      ...(["reserved", "prepared", "broadcast", "failed", "manual_review"] as const).map(status => ctx.db.query("automatedFeeControllerChanges")
        .withIndex("by_program_status", q => q.eq("programId", program._id).eq("status", status)).first()),
    ]);
    if (blockers.some(Boolean)) throw new Error("another fee workflow must finish before recovery");
    const now = Date.now();
    await ctx.db.patch(run._id, { status: "deferred", workflowStage: "graduated_sweep_preflight_recovered",
      leaseId: undefined, leaseUntil: undefined, nextRetryAt: now, updatedAt: now });
    await ctx.db.patch(program._id, { status: "enrolled", nextProcessAt: now, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.automatedFeeEngine.processProgram, { programId: program._id, runId: run._id });
    return { status: "unsigned_graduated_cycle_resumed", runId: run._id };
  },
});

export const recordFeeAssessment = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), workLeaseId: v.string(), runId: v.optional(v.id("automatedFeeRuns")),
    valueWei: v.string(), assetAmount: v.string(), operatorWait: v.boolean(), phase: v.optional(v.number()),
    escrowAmount: v.optional(v.string()), escrowValueWei: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program || program.workLeaseId !== args.workLeaseId || program.status !== "enrolled") throw new Error("fee assessment lease lost");
    if (!/^\d+$/.test(args.valueWei) || !/^\d+$/.test(args.assetAmount)) throw new Error("AUTOMATED_FEE_ASSESSMENT_INVALID");
    const claims = await liveRequestedClaims(ctx, program, args.runId);
    const requested = requestedVaultClaimsEnabled() && claims.length > 0;
    const escrowReady = args.phase === 2 && /^\d+$/.test(args.escrowAmount ?? "") && BigInt(args.escrowAmount!) >= 10_000n
      && (requested || feeThresholdReached(args.escrowValueWei));
    const operatorWait = args.operatorWait && !escrowReady;
    // Only the off-chain accumulation policy is bypassed. The deployed vault's
    // 10,000-base-unit floor, quote minimums, pause gates and payout checks stay.
    const now = Date.now(), eligible = (requested ? BigInt(args.assetAmount) >= 10_000n : feeThresholdReached(args.valueWei)) && !operatorWait;
    const run = args.runId ? await ctx.db.get(args.runId) : null;
    if (run && (run.programId !== program._id || feeRunHasTransaction(run))) throw new Error("fee assessment cannot discard an existing transaction");
    await ctx.db.patch(program._id, { lastCheckedAt: now, workAttempts: 0,
      availableCreatorFeesEthWei: args.valueWei, availableCreatorFees: args.assetAmount,
      accumulationThresholdWei: FEE_ACCUMULATION_THRESHOLD_WEI.toString(),
      processingDiagnosticCode: eligible ? "FEES_READY" : operatorWait ? "WAITING_PONS_OPERATOR" : "ACCUMULATING",
      nextProcessAt: nextFeeCheck(program, now), updatedAt: now });
    if (!eligible && run) await ctx.db.patch(run._id, { status: "confirmed", workflowStage: "accumulating_no_transaction",
      nextRetryAt: undefined, leaseId: undefined, leaseUntil: undefined, updatedAt: now });
    if (requested && run && eligible) await ctx.db.patch(run._id, { requestedClaim: true });
    if (!eligible) for (const claim of claims) await ctx.db.patch(claim._id, {
      status: "no_fees", reason: operatorWait ? "waiting_pons_operator" : "no_fees_or_dust", updatedAt: now,
    });
    return eligible;
  },
});

export const processProgram = internalAction({
  args: { programId: v.id("automatedFeePrograms"), runId: v.optional(v.id("automatedFeeRuns")), workLeaseId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ status: string; runId?: string }> => {
    if (!PRODUCTION_EXECUTION_IMPLEMENTATION_READY || !automatedFeeProcessingAllowed(configuration())) {
      return { status: "processing_disabled" };
    }
    const initial = await ctx.runQuery(internal.automatedFeeEngine.processingContext, { programId: args.programId, runId: args.runId });
    const program = initial.program;
    if (!program || program.status !== "enrolled") return { status: "program_unavailable" };
    let run = initial.run;
    // A scheduled retry can outlive another worker completing this run.
    // Do not turn that stale callback into an endless lease-retry loop.
    if (run?.status === "confirmed") return { status: "already_complete", runId: run._id };
    if (run?.status === "manual_review" || run?.status === "reverted") return { status: "manual_review", runId: run._id };
    if (run && run.programId !== program._id) throw new Error("AUTOMATED_FEE_RUN_PROGRAM_MISMATCH");
    const workLeaseId = args.workLeaseId ?? crypto.randomUUID();
    const work = await ctx.runMutation(internal.automatedFeeQueue.beginWork, { programId: program._id, workLeaseId, dispatched: Boolean(args.workLeaseId) });
    if (!work) return { status: "worker_queued" };
    if (work.runId) run = (await ctx.runQuery(internal.automatedFeeEngine.processingContext, { programId: program._id, runId: work.runId })).run;
    let observedPhase: number | undefined;
    const actionLeaseId = crypto.randomUUID();
    try {
      // Lock before inspection. Busy callbacks must not multiply RPC reads.
      if (run && !(await ctx.runMutation(internal.automatedFeeEngine.acquireProcessingRunLease, { runId: run._id, leaseId: actionLeaseId, now: Date.now() }))) {
        return { status: "run_leased", runId: run._id };
      }
      const assess = !run || !feeRunHasTransaction(run);
      const inspection = await signerRequest<Inspection>("/v1/automated-fees/inspect", {
        chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress,
        ...(assess ? { includeAccumulation: true } : {}),
      });
      observedPhase = inspection.phase;
      const matches = inspection.token.toLowerCase() === program.normalizedTokenAddress
        && inspection.pairAsset.toLowerCase() === program.normalizedPairTokenAddress
        && inspection.controller.toLowerCase() === program.normalizedControllerAddress
        && inspection.beneficiary.toLowerCase() === program.normalizedBeneficiaryAddress
        && inspection.creatorFeeRecipient.toLowerCase() === program.normalizedVaultAddress;
      if (inspection.phase === 1) {
        await ctx.runMutation(internal.automatedFeeEngine.deferProgramWithoutRun, { programId: program._id, diagnosticCode: "AUTOMATED_FEE_GRADUATION_SETTLING", delayMs: 60_000 });
        return { status: "graduation_settling" };
      }
      if (!matches || !inspection.active || inspection.paused || (inspection.phase !== 0 && inspection.phase !== 2)) {
        throw new Error("AUTOMATED_FEE_ENROLLMENT_STATE_MISMATCH");
      }
      if (assess) {
        // Missing/new signer fields fail closed: never spend gas before valuation.
        if (inspection.availableCreatorFeesEthWei === undefined || inspection.availableCreatorFees === undefined) {
          throw new Error("AUTOMATED_FEE_ACCUMULATION_INSPECTION_UNAVAILABLE");
        }
        const eligible = await ctx.runMutation(internal.automatedFeeEngine.recordFeeAssessment, {
          programId: program._id, workLeaseId, runId: run?._id,
          valueWei: inspection.availableCreatorFeesEthWei, assetAmount: inspection.availableCreatorFees,
          operatorWait: inspection.operatorRequired === true,
          phase: inspection.phase, escrowAmount: inspection.escrowBalance, escrowValueWei: inspection.escrowCreatorFeesEthWei,
        });
        if (!eligible) return { status: "accumulating", runId: run?._id };
        if (run) run = (await ctx.runQuery(internal.automatedFeeEngine.processingContext, { programId: program._id, runId: run._id })).run;
      }
      if (!run) {
        const reserved = await ctx.runMutation(internal.automatedFeeEngine.reserveProcessingRun, {
          programId: program._id, processThroughBlock: inspection.blockNumber,
          executionNonce: inspection.executionNonce, phaseAtReservation: inspection.phase,
          requiresClaim: !feeThresholdReached(inspection.availableCreatorFeesEthWei),
          leaseId: actionLeaseId, now: Date.now(),
        });
        const context = await ctx.runQuery(internal.automatedFeeEngine.processingContext, { programId: program._id, runId: reserved.runId });
        run = context.run;
        if (!reserved.created && run) {
        const acquired = await ctx.runMutation(internal.automatedFeeEngine.acquireProcessingRunLease, {
          runId: run._id, leaseId: actionLeaseId, now: Date.now(),
        });
        if (!acquired) {
          return { status: "run_leased", runId: run._id };
        }
        }
      }
      if (!run) throw new Error("AUTOMATED_FEE_RUN_MISSING");
      const schedule = async (delay = 30_000) => {
        return ctx.runMutation(internal.automatedFeeQueue.queueRun, { runId: run!._id, leaseId: actionLeaseId, delayMs: delay });
      };
      const acquireKeeper = async () => {
        const acquired = await ctx.runMutation(internal.automatedFeeEngine.acquireKeeperLease, { runId: run!._id, leaseId: actionLeaseId, now: Date.now() });
        if (!acquired) await ctx.runMutation(internal.automatedFeeQueue.queueRun, { runId: run!._id, leaseId: actionLeaseId, delayMs: 0, waitingKeeper: true });
        return acquired;
      };
      const releaseKeeper = async () => ctx.runMutation(internal.automatedFeeEngine.releaseKeeperLease, { runId: run!._id, leaseId: actionLeaseId });
      if (!run.graduatedEscrowReadyBlock && canUseGraduatedEscrow(inspection.phase, inspection.escrowBalance, run)
        && (!assess || run.requestedClaim || feeThresholdReached(inspection.escrowCreatorFeesEthWei))) {
        await ctx.runMutation(internal.automatedFeeEngine.recordGraduatedEscrowReady, {
          runId: run._id, leaseId: actionLeaseId, phase: 2, blockNumber: inspection.blockNumber, escrowBalance: inspection.escrowBalance,
        });
        run = { ...run, graduatedEscrowReadyBlock: inspection.blockNumber };
      }
      if (!run.graduatedEscrowReadyBlock && !run.sweepTransactionHash) {
        if (!(await acquireKeeper())) return { status: "keeper_leased", runId: run._id };
        try {
          const prepared = await signerRequest<SweepPrepared>("/v1/automated-fees/prepare-sweep", {
            idempotencyKey: `${run.idempotencyKey}:sweep`, chainId: ROBINHOOD_CHAIN_ID,
            vaultAddress: program.vaultAddress, sweepKind: inspection.phase === 0 ? "curve" : "graduated",
            minConversionQuoteOut: inspection.phase === 0 ? "0" : "1", minBuybackTokensOut: "1",
          }, 60_000);
          if ("noFees" in prepared && prepared.noFees) {
            await ctx.runMutation(internal.automatedFeeEngine.finalizeUnsweptNoFeeRun, { runId: run._id, blockNumber: prepared.blockNumber });
            return { status: "cycle_no_fees_or_dust", runId: run._id };
          }
          if (!("transactionHash" in prepared)) throw new Error("AUTOMATED_FEE_SWEEP_PREPARATION_INVALID");
          await ctx.runMutation(internal.automatedFeeEngine.recordRunStageTransaction, {
            runId: run._id, leaseId: actionLeaseId, stage: "sweep", transactionHash: prepared.transactionHash,
            signedTransaction: prepared.signedTransaction, transactionNonce: prepared.nonce,
          });
          await signerRequest("/v1/automated-fees/broadcast-sweep", automatedFeeBroadcastPayload(prepared, program.vaultAddress), 60_000);
          await ctx.runMutation(internal.automatedFeeEngine.recordRunStageBroadcast, { runId: run._id, leaseId: actionLeaseId, stage: "sweep", transactionHash: prepared.transactionHash });
        } finally { await releaseKeeper(); }
        await schedule(30_000); return { status: "sweep_submitted", runId: run._id };
      }
      if (!run.graduatedEscrowReadyBlock && !run.sweepBroadcastAt) {
        if (!run.sweepTransactionHash || !run.sweepSignedTransaction || run.sweepTransactionNonce === undefined) throw new Error("AUTOMATED_FEE_SWEEP_PREPARED_STATE_INCOMPLETE");
        if (!(await acquireKeeper())) return { status: "keeper_leased", runId: run._id };
        try {
          await signerRequest("/v1/automated-fees/broadcast-sweep", { transactionHash: run.sweepTransactionHash, signedTransaction: run.sweepSignedTransaction, vaultAddress: program.vaultAddress }, 60_000);
          await ctx.runMutation(internal.automatedFeeEngine.recordRunStageBroadcast, { runId: run._id, leaseId: actionLeaseId, stage: "sweep", transactionHash: run.sweepTransactionHash });
        } finally { await releaseKeeper(); }
        await schedule(30_000); return { status: "sweep_submitted", runId: run._id };
      }
      if (!run.graduatedEscrowReadyBlock && !run.sweepBlockNumber) {
        const status = await signerRequest<Status>("/v1/automated-fees/status", { chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress, transactionHash: run.sweepTransactionHash, stage: "sweep", transactionNonce: run.sweepTransactionNonce, broadcastAt: run.sweepBroadcastAt });
        if (status.gasCostWei) await ctx.runMutation(internal.automatedFeeEngine.recordRunGas, { runId: run._id, stage: "sweep", transactionHash: run.sweepTransactionHash!, gasCostWei: status.gasCostWei });
        if (status.status === "pending") {
          const pending = await ctx.runMutation(internal.automatedFeeEngine.recordPendingStageCheck, { runId: run._id, stage: "sweep" });
          if (!pending.manualReview) await schedule(60_000);
          return { status: pending.manualReview ? "manual_review" : "sweep_pending", runId: run._id };
        }
        if (status.status === "dropped") throw new Error("AUTOMATED_FEE_SWEEP_DROPPED");
        if (status.status === "reverted") {
          if (run.phaseAtReservation === 0 && inspection.phase === 2) {
            await ctx.runMutation(internal.automatedFeeEngine.resetSweepAfterGraduation, { runId: run._id });
            await schedule(0); return { status: "graduated_sweep_retry", runId: run._id };
          }
          throw new Error("AUTOMATED_FEE_SWEEP_REVERTED");
        }
        await ctx.runMutation(internal.automatedFeeEngine.confirmRunStage, { runId: run._id, stage: "sweep", blockNumber: status.blockNumber!, gasCostWei: status.gasCostWei });
        await schedule(0); return { status: "sweep_confirmed", runId: run._id };
      }
      // Processing empties escrow. After submitting that transaction, continue
      // receipt reconciliation/delivery instead of treating zero escrow as no fees.
      if (!run.processingTransactionHash && BigInt(inspection.escrowBalance) < 10_000n) {
        await ctx.runMutation(internal.automatedFeeEngine.finalizeNoFeeRun, { runId: run._id, blockNumber: inspection.blockNumber });
        return { status: "cycle_no_fees", runId: run._id };
      }
      if (!run.processingTransactionHash) {
        if (!(await acquireKeeper())) return { status: "keeper_leased", runId: run._id };
        try {
          const deadline = Math.floor(Date.now() / 1000) + 300;
          const quote = await signerRequest<any>("/v1/automated-fees/authorize", { chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress, deadline, nonce: inspection.executionNonce }, 60_000);
          const prepared = await signerRequest<PreparedTx>("/v1/automated-fees/prepare", {
            idempotencyKey: `${run.idempotencyKey}:processing`, chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress,
            maxBuybackAmount: quote.maxBuybackAmount, minPonsbotOut: quote.minPonsbotOut,
            minSweepBuybackTokensOut: quote.minSweepBuybackTokensOut, deadline: quote.deadline,
            routeTarget: quote.routeTarget, routeData: quote.routeData, quoteSignature: quote.signature,
          }, 60_000);
          await ctx.runMutation(internal.automatedFeeEngine.recordRunStageTransaction, {
            runId: run._id, leaseId: actionLeaseId, stage: "processing", transactionHash: prepared.transactionHash,
            signedTransaction: prepared.signedTransaction, transactionNonce: prepared.nonce,
          });
          await signerRequest("/v1/automated-fees/broadcast", automatedFeeBroadcastPayload(prepared, program.vaultAddress), 60_000);
          await ctx.runMutation(internal.automatedFeeEngine.recordRunStageBroadcast, { runId: run._id, leaseId: actionLeaseId, stage: "processing", transactionHash: prepared.transactionHash });
        } finally { await releaseKeeper(); }
        await schedule(30_000); return { status: "processing_submitted", runId: run._id };
      }
      if (!run.processingBroadcastAt) {
        if (!run.processingSignedTransaction || run.processingTransactionNonce === undefined) throw new Error("AUTOMATED_FEE_PROCESSING_PREPARED_STATE_INCOMPLETE");
        if (!(await acquireKeeper())) return { status: "keeper_leased", runId: run._id };
        try {
          await signerRequest("/v1/automated-fees/broadcast", { transactionHash: run.processingTransactionHash, signedTransaction: run.processingSignedTransaction, vaultAddress: program.vaultAddress }, 60_000);
          await ctx.runMutation(internal.automatedFeeEngine.recordRunStageBroadcast, { runId: run._id, leaseId: actionLeaseId, stage: "processing", transactionHash: run.processingTransactionHash });
        } finally { await releaseKeeper(); }
        await schedule(30_000); return { status: "processing_submitted", runId: run._id };
      }
      if (!run.processingBlockNumber || run.grossClaimed === undefined || run.beneficiaryAllocated === undefined
        || run.buybackSpent === undefined || run.ponsbotBurned === undefined) {
        const status = await signerRequest<Status>("/v1/automated-fees/status", { chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress, transactionHash: run.processingTransactionHash, stage: "processing", transactionNonce: run.processingTransactionNonce, broadcastAt: run.processingBroadcastAt });
        if (status.gasCostWei) await ctx.runMutation(internal.automatedFeeEngine.recordRunGas, { runId: run._id, stage: "processing", transactionHash: run.processingTransactionHash, gasCostWei: status.gasCostWei });
        if (status.status === "pending") {
          const pending = await ctx.runMutation(internal.automatedFeeEngine.recordPendingStageCheck, { runId: run._id, stage: "processing" });
          if (!pending.manualReview) await schedule(60_000);
          return { status: pending.manualReview ? "manual_review" : "processing_pending", runId: run._id };
        }
        if (status.status === "dropped") throw new Error("AUTOMATED_FEE_PROCESSING_DROPPED");
        if (status.status === "reverted") throw new Error("AUTOMATED_FEE_PROCESSING_REVERTED");
        await ctx.runMutation(internal.automatedFeeEngine.reconcileProcessingRun, { runId: run._id, outcome: "confirmed", workflowStage: "processing_confirmed", blockNumber: status.blockNumber, grossClaimed: status.grossClaimed, beneficiaryAllocated: status.beneficiaryAllocated, buybackSpent: status.buybackSpent, ponsbotBurned: status.ponsbotBurned });
        await schedule(0); return { status: "processing_confirmed", runId: run._id };
      }
      if (!run.deliveryTransactionHash) {
        if (!run.beneficiaryAllocated || BigInt(run.beneficiaryAllocated) <= 0n) throw new Error("AUTOMATED_FEE_DELIVERY_AMOUNT_INVALID");
        if (!(await acquireKeeper())) return { status: "keeper_leased", runId: run._id };
        try {
          const prepared = await signerRequest<DeliveryPrepared>("/v1/automated-fees/prepare-delivery", {
            idempotencyKey: `${run.idempotencyKey}:delivery`, chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress,
            beneficiary: run.beneficiaryAddress, asset: run.pairTokenAddress, amount: run.beneficiaryAllocated,
            processingBlockNumber: run.processingBlockNumber!,
          }, 60_000);
          if ("alreadyDelivered" in prepared && prepared.alreadyDelivered) {
            await ctx.runMutation(internal.automatedFeeEngine.confirmRunStage, { runId: run._id, stage: "delivery", blockNumber: prepared.blockNumber, beneficiaryDelivered: prepared.deliveredAmount, externalDelivery: true });
            await ctx.runMutation(internal.automatedFeeEngine.finalizeDeliveredRun, { runId: run._id, deliveryBlockNumber: prepared.blockNumber, beneficiaryDelivered: prepared.deliveredAmount });
            return { status: "cycle_confirmed_external_delivery", runId: run._id };
          }
          if (!("transactionHash" in prepared)) throw new Error("AUTOMATED_FEE_DELIVERY_PREPARATION_INVALID");
          await ctx.runMutation(internal.automatedFeeEngine.recordRunStageTransaction, {
            runId: run._id, leaseId: actionLeaseId, stage: "delivery", transactionHash: prepared.transactionHash,
            signedTransaction: prepared.signedTransaction, transactionNonce: prepared.nonce,
          });
          await signerRequest("/v1/automated-fees/broadcast-delivery", automatedFeeBroadcastPayload(prepared, program.vaultAddress), 60_000);
          await ctx.runMutation(internal.automatedFeeEngine.recordRunStageBroadcast, { runId: run._id, leaseId: actionLeaseId, stage: "delivery", transactionHash: prepared.transactionHash });
        } finally { await releaseKeeper(); }
        await schedule(30_000); return { status: "delivery_submitted", runId: run._id };
      }
      if (!run.deliveryBroadcastAt) {
        if (!run.deliverySignedTransaction || run.deliveryTransactionNonce === undefined) throw new Error("AUTOMATED_FEE_DELIVERY_PREPARED_STATE_INCOMPLETE");
        if (!(await acquireKeeper())) return { status: "keeper_leased", runId: run._id };
        try {
          await signerRequest("/v1/automated-fees/broadcast-delivery", { transactionHash: run.deliveryTransactionHash, signedTransaction: run.deliverySignedTransaction, vaultAddress: program.vaultAddress }, 60_000);
          await ctx.runMutation(internal.automatedFeeEngine.recordRunStageBroadcast, { runId: run._id, leaseId: actionLeaseId, stage: "delivery", transactionHash: run.deliveryTransactionHash });
        } finally { await releaseKeeper(); }
        await schedule(30_000); return { status: "delivery_submitted", runId: run._id };
      }
      if (!run.deliveryBlockNumber) {
        const status = await signerRequest<Status>("/v1/automated-fees/status", { chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress, transactionHash: run.deliveryTransactionHash, stage: "delivery", transactionNonce: run.deliveryTransactionNonce, broadcastAt: run.deliveryBroadcastAt });
        if (status.gasCostWei) await ctx.runMutation(internal.automatedFeeEngine.recordRunGas, { runId: run._id, stage: "delivery", transactionHash: run.deliveryTransactionHash, gasCostWei: status.gasCostWei });
        if (status.status === "pending") {
          const pending = await ctx.runMutation(internal.automatedFeeEngine.recordPendingStageCheck, { runId: run._id, stage: "delivery" });
          if (!pending.manualReview) await schedule(60_000);
          return { status: pending.manualReview ? "manual_review" : "delivery_pending", runId: run._id };
        }
        if (status.status === "dropped") throw new Error("AUTOMATED_FEE_DELIVERY_DROPPED");
        if (status.status === "reverted") throw new Error("AUTOMATED_FEE_DELIVERY_REVERTED");
        if (status.amount !== run.beneficiaryAllocated) throw new Error("AUTOMATED_FEE_DELIVERY_RECEIPT_MISMATCH");
        await ctx.runMutation(internal.automatedFeeEngine.confirmRunStage, { runId: run._id, stage: "delivery", blockNumber: status.blockNumber!, beneficiaryDelivered: status.amount, gasCostWei: status.gasCostWei });
        await ctx.runMutation(internal.automatedFeeEngine.finalizeDeliveredRun, { runId: run._id, deliveryBlockNumber: status.blockNumber!, beneficiaryDelivered: status.amount! });
        return { status: "cycle_confirmed", runId: run._id };
      }
      // Recover a crash after delivery receipt persistence but before aggregate accounting.
      if (run.deliveryBlockNumber && run.beneficiaryDelivered) {
        await ctx.runMutation(internal.automatedFeeEngine.finalizeDeliveredRun, { runId: run._id,
          deliveryBlockNumber: run.deliveryBlockNumber, beneficiaryDelivered: run.beneficiaryDelivered });
        return { status: "cycle_confirmed", runId: run._id };
      }
      throw new Error("AUTOMATED_FEE_DELIVERY_STATE_INVALID");
    } catch (error) {
      if (run) {
        const detail = error instanceof Error ? error.message : String(error);
        // Explicit requests may reach economically tiny quotes that scheduled
        // cycles never see. A zero-output authorization is not retryable until
        // more fees accumulate. No processing envelope exists at this point.
        if (run.requestedClaim && !run.processingTransactionHash && !run.processingSignedTransaction
          && feeSweepPrerequisiteSatisfied(run)
          && detail.includes("[/v1/automated-fees/authorize]") && /below minimum output/i.test(detail)) {
          await ctx.runMutation(internal.automatedFeeEngine.finalizeNoFeeRun, {
            runId: run._id, blockNumber: run.sweepBlockNumber || run.graduatedEscrowReadyBlock!,
          });
          return { status: "cycle_no_fees_or_dust", runId: run._id };
        }
        if (observedPhase === 2 && isGraduatedSweepPreflightFailure(observedPhase, detail, run)) {
          await ctx.runMutation(internal.automatedFeeEngine.deferGraduatedSweepPreflight, {
            runId: run._id, leaseId: actionLeaseId, phase: 2, diagnosticDetail: detail,
          });
          return { status: "graduated_sweep_deferred", runId: run._id };
        }
        const manualReview = /MISMATCH|REVERTED|DROPPED|INVALID|out of order/i.test(detail);
        await ctx.runMutation(internal.automatedFeeEngine.deferProcessingRun, {
          programId: program._id, runId: run._id, manualReview,
          diagnosticCode: detail.match(/AUTOMATED_FEE_[A-Z_]+/)?.[0] ?? "AUTOMATED_FEE_PROCESSING_FAILED",
          diagnosticDetail: detail,
          retryAfterMs: typeof (error as { retryAfterMs?: unknown })?.retryAfterMs === "number" ? (error as { retryAfterMs: number }).retryAfterMs : undefined,
        });
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        const immutableMismatch = /ENROLLMENT_STATE_MISMATCH|INVALID_CONFIGURATION|not registered/i.test(detail);
        if (immutableMismatch) {
          await ctx.runMutation(internal.automatedFeeEngine.markProgramManualReview, {
            programId: program._id,
            diagnosticCode: detail.match(/AUTOMATED_FEE_[A-Z_]+/)?.[0] ?? "AUTOMATED_FEE_PRE_RUN_VALIDATION_FAILED",
            diagnosticDetail: detail,
          });
        } else {
          await ctx.runMutation(internal.automatedFeeEngine.deferProgramWithoutRun, {
            programId: program._id,
            diagnosticCode: detail.match(/AUTOMATED_FEE_[A-Z_]+/)?.[0] ?? "AUTOMATED_FEE_TRANSIENT_PRE_RUN_FAILURE",
            delayMs: Math.max(60_000, Math.min(60 * 60_000, Number((error as { retryAfterMs?: number })?.retryAfterMs) || 0)),
          });
        }
      }
      return { status: "failed", runId: run?._id };
    } finally {
      if (run) await ctx.runMutation(internal.automatedFeeEngine.releaseProcessingRunLease, { runId: run._id, leaseId: actionLeaseId });
      await ctx.runMutation(internal.automatedFeeQueue.finishWork, { programId: program._id, workLeaseId });
    }
  },
});

export const reconcileProcessingRun = internalMutation({
  args: {
    runId: v.id("automatedFeeRuns"),
    outcome: v.union(v.literal("confirmed"), v.literal("reverted"), v.literal("uncertain"), v.literal("deferred"), v.literal("manual_review")),
    workflowStage: v.string(),
    blockNumber: v.optional(v.string()),
    grossClaimed: v.optional(v.string()),
    beneficiaryAllocated: v.optional(v.string()),
    buybackSpent: v.optional(v.string()),
    ponsbotBurned: v.optional(v.string()),
    diagnosticCode: v.optional(v.string()),
    diagnosticDetail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || !["submitted", "uncertain", "deferred"].includes(run.status)) throw new Error("automated fee run cannot be reconciled");
    const numeric = [args.grossClaimed, args.beneficiaryAllocated, args.buybackSpent, args.ponsbotBurned, args.blockNumber]
      .filter((value): value is string => value !== undefined);
    if (numeric.some((value) => !/^\d+$/.test(value))) throw new Error("automated fee receipt values are invalid");
    if (args.outcome === "confirmed") {
      if (!feeSweepPrerequisiteSatisfied(run)) throw new Error("automated fee processing receipt is out of order");
      if (!run.transactionHash || args.blockNumber === undefined || args.grossClaimed === undefined
        || args.beneficiaryAllocated === undefined || args.buybackSpent === undefined || args.ponsbotBurned === undefined) {
        throw new Error("confirmed automated fee receipt is incomplete");
      }
      validateAutomatedFeeReceipt({
        grossClaimed: args.grossClaimed,
        beneficiaryAllocated: args.beneficiaryAllocated,
        buybackSpent: args.buybackSpent,
        ponsbotBurned: args.ponsbotBurned,
      });
    }
    const now = Date.now();
    await ctx.db.patch(run._id, {
      status: args.outcome === "confirmed" ? "submitted" : args.outcome,
      workflowStage: args.workflowStage.slice(0, 120),
      blockNumber: args.blockNumber,
      ...(args.outcome === "confirmed" ? { processingBlockNumber: args.blockNumber } : {}),
      grossClaimed: args.grossClaimed,
      beneficiaryAllocated: args.beneficiaryAllocated,
      buybackSpent: args.buybackSpent,
      ponsbotBurned: args.ponsbotBurned,
      diagnosticCode: args.diagnosticCode?.slice(0, 120),
      diagnosticDetail: args.diagnosticDetail?.slice(0, 500),
      retryCount: args.outcome === "deferred" || args.outcome === "uncertain" ? run.retryCount + 1 : run.retryCount,
      nextRetryAt: args.outcome === "deferred" || args.outcome === "uncertain" ? now + feeRetryDelay(run.retryCount) : undefined,
      updatedAt: now,
    });
    const program = await ctx.db.get(run.programId);
    if (!program) return;
    if (args.outcome === "manual_review") {
      await ctx.db.patch(program._id, { status: "manual_review", updatedAt: now });
    } else if (args.outcome !== "confirmed") {
      await ctx.db.patch(program._id, { workDueAt: now + feeRetryDelay(run.retryCount), updatedAt: now });
    }
  },
});

export const finalizeDeliveredRun = internalMutation({
  args: {
    runId: v.id("automatedFeeRuns"),
    deliveryBlockNumber: v.string(),
    beneficiaryDelivered: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || !["submitted", "deferred", "uncertain"].includes(run.status) || !run.deliveryBlockNumber
      || run.deliveryBlockNumber !== args.deliveryBlockNumber || run.beneficiaryDelivered !== args.beneficiaryDelivered) {
      throw new Error("automated fee delivery is not ready to finalize");
    }
    if (!/^\d+$/.test(args.deliveryBlockNumber) || !/^\d+$/.test(args.beneficiaryDelivered)) {
      throw new Error("automated fee delivery receipt is invalid");
    }
    if (!run.grossClaimed || !run.beneficiaryAllocated || !run.buybackSpent || !run.ponsbotBurned
      || args.beneficiaryDelivered !== run.beneficiaryAllocated) {
      throw new Error("automated fee delivery accounting invariant failed");
    }
    const program = await ctx.db.get(run.programId);
    if (!program) throw new Error("automated fee program is missing");
    const now = Date.now();
    const add = (left: string | undefined, right: string) => (BigInt(left ?? "0") + BigInt(right)).toString();
    await ctx.db.patch(run._id, {
      status: "confirmed",
      workflowStage: "cycle_confirmed",
      deliveryBlockNumber: args.deliveryBlockNumber,
      beneficiaryDelivered: args.beneficiaryDelivered,
      updatedAt: now,
    });
    await ctx.db.patch(program._id, {
      lastProcessAt: now,
      lastProcessedBlock: run.processingBlockNumber ?? run.blockNumber,
      nextProcessAt: nextFeeCheck(program, now),
      workDueAt: undefined, lastPaidAt: now, processingDiagnosticCode: "CYCLE_CONFIRMED",
      lifetimeGrossClaimed: add(program.lifetimeGrossClaimed, run.grossClaimed),
      lifetimeBeneficiaryAllocated: add(program.lifetimeBeneficiaryAllocated, run.beneficiaryAllocated),
      lifetimeBuybackSpent: add(program.lifetimeBuybackSpent, run.buybackSpent),
      lifetimePonsbotBurned: add(program.lifetimePonsbotBurned, run.ponsbotBurned),
      updatedAt: now,
    });
    // Private tests retain full accounting but do not inflate public platform totals.
    if (program.privateTest) return;
    await ctx.scheduler.runAfter(1_000, internal.creatorFeeHistory.recordVaultClaim, { runId: run._id });
    const engine = await ctx.db.query("automatedFeeEngineState").withIndex("by_key", (q) => q.eq("key", ENGINE_KEY)).unique();
    // Gross, beneficiary, and buyback values are denominated in each launch's
    // pair asset and cannot be meaningfully added across assets. Keep those
    // totals only in automatedFeeAssetTotals. PONSBOT burned has one common
    // denomination, so it is the only platform-wide monetary accumulator.
    const totals = {
      lifetimePonsbotBurned: add(engine?.lifetimePonsbotBurned, run.ponsbotBurned),
      updatedAt: now,
    };
    if (engine) await ctx.db.patch(engine._id, totals);
    else await ctx.db.insert("automatedFeeEngineState", { key: ENGINE_KEY, ...totals });
    const normalizedAssetAddress = program.normalizedPairTokenAddress;
    const assetTotal = await ctx.db.query("automatedFeeAssetTotals")
      .withIndex("by_asset", (q) => q.eq("normalizedAssetAddress", normalizedAssetAddress)).unique();
    const assetTotals = {
      lifetimeGrossClaimed: add(assetTotal?.lifetimeGrossClaimed, run.grossClaimed),
      lifetimeBeneficiaryDelivered: add(assetTotal?.lifetimeBeneficiaryDelivered, args.beneficiaryDelivered),
      lifetimeBuybackSpent: add(assetTotal?.lifetimeBuybackSpent, run.buybackSpent), updatedAt: now,
    };
    if (assetTotal) await ctx.db.patch(assetTotal._id, assetTotals);
    else await ctx.db.insert("automatedFeeAssetTotals", {
      normalizedAssetAddress, assetAddress: program.pairTokenAddress, ...assetTotals,
    });
  },
});

export const privateAutomatedFeeTotals = internalQuery({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query("automatedFeeEngineState").withIndex("by_key", (q) => q.eq("key", ENGINE_KEY)).unique();
    const perAsset = await ctx.db.query("automatedFeeAssetTotals").take(5_000);
    return {
      ponsbotBurned: state?.lifetimePonsbotBurned ?? "0",
      updatedAt: state?.updatedAt ?? null,
      perAsset: perAsset.map((asset) => ({
        assetAddress: asset.assetAddress,
        grossClaimed: asset.lifetimeGrossClaimed,
        beneficiaryDelivered: asset.lifetimeBeneficiaryDelivered,
        buybackSpent: asset.lifetimeBuybackSpent,
        updatedAt: asset.updatedAt,
      })),
    };
  },
});

export const privateAutomatedFeeHealth = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const [state, programs, activeRuns] = await Promise.all([
      ctx.db.query("automatedFeeEngineState").withIndex("by_key", (q) => q.eq("key", ENGINE_KEY)).unique(),
      ctx.db.query("automatedFeePrograms").take(5_001),
      ctx.db.query("automatedFeeRuns").take(5_001),
    ]);
    const counts = { prepared: 0, enrolled: 0, paused: 0, exited: 0, manual_review: 0 };
    for (const program of programs.slice(0, 5_000)) counts[program.status] += 1;
    const unfinished = activeRuns.slice(0, 5_000).filter((run) => run.status !== "confirmed" && run.status !== "reverted");
    return {
      engine: state ? {
        lastStartedAt: state.lastStartedAt ?? null,
        lastCompletedAt: state.lastCompletedAt ?? null,
        lastStatus: state.lastStatus ?? null,
        lastDiagnosticCode: state.lastDiagnosticCode ?? null,
        leaseActive: (state.leaseUntil ?? 0) > now,
      } : null,
      programs: counts,
      runs: {
        unfinished: unfinished.length,
        manualReview: unfinished.filter((run) => run.status === "manual_review").length,
        overdueRetry: unfinished.filter((run) => run.nextRetryAt !== undefined && run.nextRetryAt <= now).length,
        expiredLease: unfinished.filter((run) => run.leaseUntil !== undefined && run.leaseUntil <= now).length,
      },
      checkedAt: now,
      truncated: programs.length > 5_000 || activeRuns.length > 5_000,
    };
  },
});

export const recordControllerChange = internalMutation({
  args: {
    programId: v.id("automatedFeePrograms"), transactionHash: v.string(),
    previousControllerAddress: v.string(), newControllerAddress: v.optional(v.string()),
    newBeneficiaryAddress: v.optional(v.string()),
    outcome: v.union(v.literal("reassigned"), v.literal("paused"), v.literal("resumed"), v.literal("exited"), v.literal("holders")),
  },
  handler: async (ctx, args) => {
    const program = await ctx.db.get(args.programId);
    if (!program) throw new Error("automated fee program is missing");
    if (program.normalizedControllerAddress !== normalizedAddress(args.previousControllerAddress)) {
      throw new Error("automated fee controller changed before confirmation");
    }
    const unfinishedRuns = await Promise.all(
      (["reserved", "submitted", "uncertain", "deferred", "manual_review"] as const).map((status) =>
        ctx.db.query("automatedFeeRuns")
          .withIndex("by_program_status", (q) => q.eq("programId", program._id).eq("status", status))
          .first(),
      ),
    );
    if (unfinishedRuns.some(Boolean)) {
      throw new Error("automated fee controller change is blocked while a fee cycle is unfinished");
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(args.transactionHash)) throw new Error("automated fee controller transaction hash is invalid");
    const now = Date.now();
    if (args.outcome === "reassigned") {
      if (!args.newControllerAddress || !args.newBeneficiaryAddress) throw new Error("automated fee reassignment state is incomplete");
      await ctx.db.patch(program._id, {
        controllerAddress: args.newControllerAddress, normalizedControllerAddress: normalizedAddress(args.newControllerAddress),
        beneficiaryAddress: args.newBeneficiaryAddress, normalizedBeneficiaryAddress: normalizedAddress(args.newBeneficiaryAddress),
        lastControllerChangeTransactionHash: args.transactionHash.toLowerCase(), updatedAt: now,
      });
      return;
    }
    if (args.outcome === "resumed") {
      if (program.status !== "paused") throw new Error("only a paused automated fee program can be resumed");
      await ctx.db.patch(program._id, {
        status: "enrolled", nextProcessAt: nextFeeCheck(program, now),
        lastControllerChangeTransactionHash: args.transactionHash.toLowerCase(), updatedAt: now,
      });
      return;
    }
    await ctx.db.patch(program._id, {
      status: args.outcome === "paused" ? "paused" : "exited",
      distributionMode: args.outcome === "holders" ? "holders" : program.distributionMode,
      flywheelExemptionReason: args.outcome === "holders" ? "holder_fee_sharing" : program.flywheelExemptionReason,
      exemptedAt: args.outcome === "holders" ? now : program.exemptedAt,
      nextProcessAt: undefined, lastControllerChangeTransactionHash: args.transactionHash.toLowerCase(), updatedAt: now,
    });
  },
});

export const programByToken = internalQuery({
  args: { tokenAddress: v.string() },
  handler: async (ctx, { tokenAddress }) => ctx.db.query("automatedFeePrograms")
    .withIndex("by_token", (q) => q.eq("normalizedTokenAddress", normalizedAddress(tokenAddress))).unique(),
});

export const reserveControllerChange = internalMutation({
  args: {
    requestId: v.string(), programId: v.id("automatedFeePrograms"),
    parentRequestId: v.optional(v.string()),
    operation: v.union(v.literal("reassign"), v.literal("holders")),
    previousControllerAddress: v.string(), newControllerAddress: v.optional(v.string()),
    newBeneficiaryAddress: v.optional(v.string()), exitRecipientAddress: v.optional(v.string()),
    ownerXUserId: v.optional(v.string()), walletRef: v.optional(v.string()),
    vaultAddress: v.optional(v.string()), pairTokenAddress: v.optional(v.string()),
    previousBeneficiaryAddress: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.parentRequestId) {
      const parent = await ctx.db.query("automatedFeeControllerChanges")
        .withIndex("by_request_id", q => q.eq("requestId", args.parentRequestId!)).unique();
      const step = args.requestId.slice(args.parentRequestId.length + 1);
      if (!parent || !parent.workflowRoot || parent.parentRequestId || parent.workflowCompletedAt
        || args.requestId !== `${args.parentRequestId}:${step}`
        || !["controller-sweep", "pause", "exit", "former-beneficiary-delivery"].includes(step)
        || parent.programId !== args.programId || parent.operation !== args.operation
        || parent.previousControllerAddress.toLowerCase() !== args.previousControllerAddress.toLowerCase()
        || (parent.newControllerAddress ?? "").toLowerCase() !== (args.newControllerAddress ?? "").toLowerCase()
        || (parent.newBeneficiaryAddress ?? "").toLowerCase() !== (args.newBeneficiaryAddress ?? "").toLowerCase()
        || (parent.exitRecipientAddress ?? "").toLowerCase() !== (args.exitRecipientAddress ?? "").toLowerCase()
        || args.ownerXUserId || args.walletRef || args.vaultAddress) {
        throw new Error("automated fee controller child identity conflict");
      }
    }
    const existing = await ctx.db.query("automatedFeeControllerChanges")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (existing) {
      const sameIdentity = existing.programId === args.programId
        && (existing.parentRequestId ?? "") === (args.parentRequestId ?? "")
        && existing.operation === args.operation
        && existing.previousControllerAddress.toLowerCase() === args.previousControllerAddress.toLowerCase()
        && (existing.newControllerAddress ?? "").toLowerCase() === (args.newControllerAddress ?? "").toLowerCase()
        && (existing.newBeneficiaryAddress ?? "").toLowerCase() === (args.newBeneficiaryAddress ?? "").toLowerCase()
        && (existing.exitRecipientAddress ?? "").toLowerCase() === (args.exitRecipientAddress ?? "").toLowerCase()
        && (existing.ownerXUserId ?? "") === (args.ownerXUserId ?? "")
        && (existing.walletRef ?? "").toLowerCase() === (args.walletRef ?? "").toLowerCase()
        && (existing.vaultAddress ?? "").toLowerCase() === (args.vaultAddress ?? "").toLowerCase()
        && (existing.pairTokenAddress ?? "").toLowerCase() === (args.pairTokenAddress ?? "").toLowerCase()
        && (existing.previousBeneficiaryAddress ?? "").toLowerCase() === (args.previousBeneficiaryAddress ?? "").toLowerCase();
      if (!sameIdentity) throw new Error("automated fee controller request identity conflict");
      return existing;
    }
    const program = await ctx.db.get(args.programId);
    if (!program || (program.status !== "enrolled" && !(args.operation === "holders" && program.status === "paused"))
      || program.normalizedControllerAddress !== normalizedAddress(args.previousControllerAddress)) {
      throw new Error("automated fee controller rights are unavailable");
    }
    const controllerBlockers = (await Promise.all([
      ...(["reserved", "prepared", "broadcast", "failed", "manual_review"] as const).map((status) =>
        ctx.db.query("automatedFeeControllerChanges")
          .withIndex("by_program_status", (q) => q.eq("programId", program._id).eq("status", status))
          .take(20),
      ),
      ctx.db.query("automatedFeeControllerChanges")
        .withIndex("by_program_status", (q) => q.eq("programId", program._id).eq("status", "confirmed"))
        .filter((q) => q.eq(q.field("workflowCompletedAt"), undefined))
        .take(20),
    ])).flat().filter((row) => {
      if (row.requestId === args.requestId || row.requestId === args.parentRequestId
        || row.parentRequestId === (args.parentRequestId ?? args.requestId)
        || !row.ownerXUserId || !row.walletRef || !row.vaultAddress) return false;
      if (row.status === "failed") return automatedFeeControllerTransactionMayExist(row);
      return row.status !== "confirmed" || !row.workflowCompletedAt;
    });
    if (controllerBlockers.length > 0) {
      throw new Error("another automated fee controller change is still being finalized");
    }
    const unfinished = await Promise.all(
      (["reserved", "submitted", "uncertain", "deferred", "manual_review"] as const).map((status) =>
        ctx.db.query("automatedFeeRuns").withIndex("by_program_status", (q) => q.eq("programId", program._id).eq("status", status)).first(),
      ),
    );
    if (unfinished.some(Boolean)) throw new Error("automated fee cycle is still being finalized");
    const now = Date.now();
    const id = await ctx.db.insert("automatedFeeControllerChanges", {
      ...args,
      workflowRoot: !args.parentRequestId && Boolean(args.ownerXUserId && args.walletRef && args.vaultAddress),
      status: "reserved", createdAt: now, updatedAt: now,
    });
    return (await ctx.db.get(id))!;
  },
});

export const persistControllerTransaction = internalMutation({
  args: {
    requestId: v.string(), transactionHash: v.string(), signedTransaction: v.string(), transactionNonce: v.number(),
    operationJson: v.optional(v.string()),
    deliveryAmount: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const change = await ctx.db.query("automatedFeeControllerChanges")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!change) throw new Error("automated fee controller change is missing");
    if (change.signedTransaction && (change.transactionHash !== args.transactionHash || change.signedTransaction !== args.signedTransaction
      || change.transactionNonce !== args.transactionNonce || change.operationJson !== args.operationJson
      || change.deliveryAmount !== args.deliveryAmount)) {
      throw new Error("automated fee controller transaction persistence conflict");
    }
    await ctx.db.patch(change._id, {
      transactionHash: args.transactionHash, signedTransaction: args.signedTransaction,
      transactionNonce: args.transactionNonce, status: "prepared", updatedAt: Date.now(),
      operationJson: args.operationJson,
      deliveryAmount: args.deliveryAmount,
    });
  },
});

export const acquireControllerExecutionLease = internalMutation({
  args: { requestId: v.string(), leaseId: v.string() },
  handler: async (ctx, args) => {
    const root = await ctx.db.query("automatedFeeControllerChanges").withIndex("by_request_id", q => q.eq("requestId", args.requestId)).unique();
    if (!root?.workflowRoot || root.workflowCompletedAt) return false;
    if ((root.executionLeaseUntil ?? 0) > Date.now() && root.executionLeaseId !== args.leaseId) return false;
    await ctx.db.patch(root._id, { executionLeaseId: args.leaseId, executionLeaseUntil: Date.now() + 10 * 60_000 });
    return true;
  },
});

export const releaseControllerExecutionLease = internalMutation({
  args: { requestId: v.string(), leaseId: v.string() },
  handler: async (ctx, args) => {
    const root = await ctx.db.query("automatedFeeControllerChanges").withIndex("by_request_id", q => q.eq("requestId", args.requestId)).unique();
    if (root?.executionLeaseId === args.leaseId) await ctx.db.patch(root._id, { executionLeaseId: undefined, executionLeaseUntil: undefined });
  },
});

export const controllerChangeByRequestId = internalQuery({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => ctx.db.query("automatedFeeControllerChanges")
    .withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique(),
});

export const markControllerChangeStatus = internalMutation({
  args: {
    requestId: v.string(), status: v.union(v.literal("broadcast"), v.literal("confirmed"), v.literal("failed"), v.literal("manual_review")),
    diagnosticCode: v.optional(v.string()), diagnosticDetail: v.optional(v.string()),
    workflowComplete: v.optional(v.boolean()),
    transactionSettled: v.optional(v.boolean()),
    transactionHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const change = await ctx.db.query("automatedFeeControllerChanges")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId)).unique();
    if (!change) throw new Error("automated fee controller change is missing");
    if (args.transactionHash && !/^0x[a-fA-F0-9]{64}$/.test(args.transactionHash)) {
      throw new Error("automated fee controller transaction hash is invalid");
    }
    if (args.transactionHash && change.transactionHash
      && change.transactionHash.toLowerCase() !== args.transactionHash.toLowerCase()) {
      throw new Error("automated fee controller transaction identity conflict");
    }
    await ctx.db.patch(change._id, {
      status: args.status, diagnosticCode: args.diagnosticCode?.slice(0, 100),
      diagnosticDetail: args.diagnosticDetail?.slice(0, 500),
      ...(args.transactionHash ? { transactionHash: args.transactionHash.toLowerCase() } : {}),
      ...(args.status === "broadcast" ? { transactionBroadcastAt: change.transactionBroadcastAt ?? Date.now() } : {}),
      ...(args.workflowComplete ? { workflowCompletedAt: Date.now() } : {}),
      ...(args.status === "confirmed" || args.transactionSettled ? { transactionSettledAt: Date.now() } : {}),
      updatedAt: Date.now(),
    });
    if (args.workflowComplete && change.workflowRoot) {
      const program = await ctx.db.get(change.programId);
      const hash = args.transactionHash ?? change.transactionHash;
      if (!program || !hash) throw new Error("automated fee completed controller outcome is missing");
      await finalizeFeeWalletOutcome(ctx, program, change.requestId, change.operation === "holders" ? "holders" : "reassign", hash);
    }
  },
});

export const recordControllerPendingCheck = internalMutation({
  args: { requestId: v.string() },
  handler: async (ctx, { requestId }) => {
    const change = await ctx.db.query("automatedFeeControllerChanges")
      .withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique();
    if (!change || !["prepared", "broadcast"].includes(change.status)) {
      return { manualReview: change?.status === "manual_review", checks: change?.pendingStatusChecks ?? 0 };
    }
    const checks = (change.pendingStatusChecks ?? 0) + 1;
    const pendingSince = change.transactionBroadcastAt ?? change.updatedAt;
    const manualReview = checks >= MAX_CONTROLLER_PENDING_CHECKS
      || Date.now() - pendingSince >= MAX_CONTROLLER_PENDING_MS;
    await ctx.db.patch(change._id, {
      pendingStatusChecks: checks,
      ...(manualReview ? {
        status: "manual_review" as const,
        diagnosticCode: "CONTROLLER_TRANSACTION_PENDING_TOO_LONG",
        diagnosticDetail: "Controller transaction remained pending beyond the automatic reconciliation window.",
      } : {}),
      updatedAt: Date.now(),
    });
    return { manualReview, checks };
  },
});

type ControllerExecution = {
  maxBuybackAmount: string; minPonsbotOut: string; minSweepBuybackTokensOut: string;
  deadline: number; routeTarget: string; routeData: string; quoteSignature: string;
};

export const executeVerifiedControllerChange = internalAction({
  args: {
    requestId: v.string(), programId: v.id("automatedFeePrograms"), ownerXUserId: v.string(),
    walletRef: v.string(), expectedAddress: v.string(),
    operation: v.union(v.literal("reassign"), v.literal("holders")),
    recipient: v.string(),
  },
  handler: async (ctx, args): Promise<{ transactionHash: string; outcome: "reassigned" | "holders" }> => {
    const program = (await ctx.runQuery(internal.automatedFeeEngine.processingContext, { programId: args.programId })).program;
    if (!program || (program.status !== "enrolled" && !(args.operation === "holders" && program.status === "paused"))) {
      throw new Error("automated fee program is unavailable");
    }
    const change = await ctx.runMutation(internal.automatedFeeEngine.reserveControllerChange, {
      requestId: args.requestId, programId: args.programId, operation: args.operation,
      previousControllerAddress: args.expectedAddress,
      ownerXUserId: args.ownerXUserId, walletRef: args.walletRef,
      vaultAddress: program.vaultAddress, pairTokenAddress: program.pairTokenAddress,
      previousBeneficiaryAddress: program.beneficiaryAddress,
      ...(args.operation === "reassign" ? { newControllerAddress: args.recipient, newBeneficiaryAddress: args.recipient } : { exitRecipientAddress: args.recipient }),
    });
    if (change.workflowCompletedAt && change.transactionHash) {
      return { transactionHash: change.transactionHash, outcome: args.operation === "reassign" ? "reassigned" : "holders" };
    }
    const executionLeaseId = crypto.randomUUID();
    if (!(await ctx.runMutation(internal.automatedFeeEngine.acquireControllerExecutionLease, { requestId: args.requestId, leaseId: executionLeaseId }))) {
      throw new Error(AUTOMATED_FEE_WORKFLOW_CONTINUATION);
    }
    const recordSettledFailure = async (requestId: string, status: "reverted" | "dropped") => {
      await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, {
        requestId, status: "manual_review", transactionSettled: true,
        diagnosticCode: status === "reverted" ? "CONTROLLER_TRANSACTION_REVERTED" : "CONTROLLER_TRANSACTION_DROPPED",
      });
    };
    const deliverFormerBeneficiary = async (processingBlockNumber: string) => {
      const deliveryRequestId = `${args.requestId}:former-beneficiary-delivery`;
      const amount = await signerRequest<{ amount: string }>("/v1/automated-fees/claimable", {
        chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress,
        beneficiary: program.beneficiaryAddress, asset: program.pairTokenAddress,
      });
      if (!/^\d+$/.test(amount.amount)) throw new Error("automated fee former-beneficiary balance is invalid");
      const existing = await ctx.runQuery(internal.automatedFeeEngine.controllerChangeByRequestId, { requestId: deliveryRequestId });
      if (existing?.status === "confirmed") return;
      if (BigInt(amount.amount) === 0n) {
        if (!existing?.transactionHash) return;
        const status = await signerRequest<Status>("/v1/automated-fees/status", {
          chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress,
          transactionHash: existing.transactionHash, stage: "delivery",
          transactionNonce: existing.transactionNonce,
          broadcastAt: existing.transactionBroadcastAt,
        });
        if (status.status === "confirmed") {
          if (existing.deliveryAmount && status.amount !== existing.deliveryAmount) {
            throw new Error("automated fee former-beneficiary delivery amount mismatch");
          }
          await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, {
            requestId: deliveryRequestId, status: "confirmed",
          });
          return;
        }
        if (status.status === "reverted" || status.status === "dropped") {
          await recordSettledFailure(deliveryRequestId, status.status);
          throw new Error(`automated fee former-beneficiary delivery ${status.status}`);
        }
        const pending = await ctx.runMutation(internal.automatedFeeEngine.recordControllerPendingCheck, { requestId: deliveryRequestId });
        if (pending.manualReview) throw new Error("automated fee former-beneficiary delivery requires manual review");
        throw new Error(AUTOMATED_FEE_WORKFLOW_CONTINUATION);
      }
      let delivery = await ctx.runMutation(internal.automatedFeeEngine.reserveControllerChange, {
        requestId: deliveryRequestId, parentRequestId: args.requestId, programId: args.programId, operation: args.operation,
        previousControllerAddress: args.expectedAddress,
        ...(args.operation === "reassign"
          ? { newControllerAddress: args.recipient, newBeneficiaryAddress: args.recipient }
          : { exitRecipientAddress: args.recipient }),
      });
      if (!delivery.signedTransaction || !delivery.transactionHash) {
        const prepared = await signerRequest<DeliveryPrepared>("/v1/automated-fees/prepare-delivery", {
          idempotencyKey: `automated-fee-controller-delivery:${args.requestId}`,
          chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress,
          beneficiary: program.beneficiaryAddress, asset: program.pairTokenAddress,
          amount: amount.amount, processingBlockNumber,
        }, 60_000);
        if (!("transactionHash" in prepared)) {
          await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, {
            requestId: deliveryRequestId, status: "confirmed",
          });
          return;
        }
        const preparedTransaction: PreparedTx = prepared;
        await ctx.runMutation(internal.automatedFeeEngine.persistControllerTransaction, {
          requestId: deliveryRequestId, ...automatedFeePreparedFields(preparedTransaction),
          deliveryAmount: amount.amount,
        });
        delivery = { ...delivery, ...preparedTransaction, transactionNonce: preparedTransaction.nonce, deliveryAmount: amount.amount, status: "prepared" };
      }
      if (delivery.status === "prepared") {
        await signerRequest("/v1/automated-fees/broadcast-delivery", {
          transactionHash: delivery.transactionHash, signedTransaction: delivery.signedTransaction,
          vaultAddress: program.vaultAddress,
        }, 60_000);
        await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, {
          requestId: deliveryRequestId, status: "broadcast",
        });
      }
      const status = await signerRequest<Status>("/v1/automated-fees/status", {
        chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress,
        transactionHash: delivery.transactionHash, stage: "delivery",
        transactionNonce: delivery.transactionNonce,
        broadcastAt: delivery.transactionBroadcastAt,
      });
      if (status.status === "confirmed") {
        if (status.amount !== (delivery.deliveryAmount ?? amount.amount)) throw new Error("automated fee former-beneficiary delivery amount mismatch");
        await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, {
          requestId: deliveryRequestId, status: "confirmed",
        });
        return;
      }
      if (status.status === "reverted" || status.status === "dropped") {
        await recordSettledFailure(deliveryRequestId, status.status);
        throw new Error(`automated fee former-beneficiary delivery ${status.status}`);
      }
      const pending = await ctx.runMutation(internal.automatedFeeEngine.recordControllerPendingCheck, { requestId: deliveryRequestId });
      if (pending.manualReview) throw new Error("automated fee former-beneficiary delivery requires manual review");
      throw new Error(AUTOMATED_FEE_WORKFLOW_CONTINUATION);
    };
    const executeOne = async (
      requestId: string,
      operation: { type: "pause" } | { type: "exit"; recipient: string } | { type: "reassign"; newController: string; newBeneficiary: string; execution: ControllerExecution },
      expectedStatus: { type: "pause" } | { type: "exit"; recipient: string } | { type: "reassign"; newController: string; newBeneficiary: string },
    ) => {
      let stored = requestId === args.requestId ? change : await ctx.runMutation(internal.automatedFeeEngine.reserveControllerChange, {
        requestId, parentRequestId: args.requestId, programId: args.programId, operation: args.operation,
        previousControllerAddress: args.expectedAddress,
        ...(args.operation === "reassign" ? { newControllerAddress: args.recipient, newBeneficiaryAddress: args.recipient } : { exitRecipientAddress: args.recipient }),
      });
      // Reuse the exact authorization encoded in a persisted transaction. A new
      // deadline/quote on retry must not change calldata for that signed hash.
      if (stored.signedTransaction) {
        if (!stored.operationJson) throw new Error("automated fee controller transaction operation is missing; manual review required");
        operation = JSON.parse(stored.operationJson);
      }
      if (!stored.signedTransaction || !stored.transactionHash) {
        const prepared = await signerRequest<{ transactionHash: string; signedTransaction: string; nonce: number }>("/v1/automated-fees/prepare-controller", {
          idempotencyKey: `automated-fee-controller:${requestId}`, chainId: ROBINHOOD_CHAIN_ID,
          ownerReference: `x:${args.ownerXUserId}`, walletRef: args.walletRef, expectedAddress: args.expectedAddress,
          vaultAddress: program.vaultAddress, operation,
        }, 60_000);
        await ctx.runMutation(internal.automatedFeeEngine.persistControllerTransaction, {
          requestId, ...automatedFeePreparedFields(prepared), operationJson: JSON.stringify(operation),
        });
        stored = { ...stored, ...prepared, transactionNonce: prepared.nonce, status: "prepared" };
      }
      if (!stored.transactionBroadcastAt && !stored.transactionSettledAt) {
        await signerRequest("/v1/automated-fees/broadcast-controller", {
          transactionHash: stored.transactionHash, signedTransaction: stored.signedTransaction,
          ownerReference: `x:${args.ownerXUserId}`, walletRef: args.walletRef,
          expectedAddress: args.expectedAddress, vaultAddress: program.vaultAddress, operation,
        }, 60_000);
        await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, { requestId, status: "broadcast" });
      }
      const status = await signerRequest<{ status: "pending" | "confirmed" | "reverted" | "dropped"; blockNumber?: string }>("/v1/automated-fees/controller-status", {
        chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress,
        transactionHash: stored.transactionHash, operation: expectedStatus,
        expectedAddress: args.expectedAddress,
        transactionNonce: stored.transactionNonce,
        broadcastAt: stored.transactionBroadcastAt,
      });
      if (status.status === "confirmed") {
        await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, { requestId, status: "confirmed" });
        return { transactionHash: stored.transactionHash!, blockNumber: status.blockNumber ?? "0" };
      }
      if (status.status === "reverted" || status.status === "dropped") {
        await recordSettledFailure(requestId, status.status);
        throw new Error(`automated fee controller transaction ${status.status}`);
      }
      const pending = await ctx.runMutation(internal.automatedFeeEngine.recordControllerPendingCheck, { requestId });
      if (pending.manualReview) throw new Error("automated fee controller transaction requires manual review");
      throw new Error(AUTOMATED_FEE_WORKFLOW_CONTINUATION);
    };
    try {
      let hash: string;
      if (!(await ctx.runMutation(internal.automatedFeeEngine.acquireKeeperLease, {
        controllerRequestId: args.requestId, leaseId: executionLeaseId, now: Date.now(),
      }))) throw new Error(AUTOMATED_FEE_WORKFLOW_CONTINUATION);
      if (args.operation === "holders") {
        const inspection = await signerRequest<Inspection>("/v1/automated-fees/inspect", {
          chainId: ROBINHOOD_CHAIN_ID,
          vaultAddress: program.vaultAddress,
        });
        if (inspection.active && !inspection.paused) {
          const pause = await executeOne(`${args.requestId}:pause`, { type: "pause" }, { type: "pause" });
          await ctx.runMutation(internal.automatedFeeEngine.recordControllerChange, {
            programId: args.programId,
            transactionHash: pause.transactionHash,
            previousControllerAddress: args.expectedAddress,
            outcome: "paused",
          });
        }
        const exited = await executeOne(`${args.requestId}:exit`, { type: "exit", recipient: args.recipient }, { type: "exit", recipient: args.recipient });
        hash = exited.transactionHash;
        await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, {
          requestId: args.requestId, status: "confirmed",
        });
        await deliverFormerBeneficiary(exited.blockNumber);
      } else {
        let inspection = await signerRequest<Inspection>("/v1/automated-fees/inspect", { chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress });
        const alreadyReassigned = inspection.controller.toLowerCase() === args.recipient.toLowerCase()
          && inspection.beneficiary.toLowerCase() === args.recipient.toLowerCase();
        if (!alreadyReassigned && inspection.phase === 0 && inspection.lastCurveSweepBlock === "0") {
          const sweepRequestId = `${args.requestId}:controller-sweep`;
          let sweep = await ctx.runMutation(internal.automatedFeeEngine.reserveControllerChange, {
            requestId: sweepRequestId, parentRequestId: args.requestId, programId: args.programId, operation: "reassign",
            previousControllerAddress: args.expectedAddress, newControllerAddress: args.recipient,
            newBeneficiaryAddress: args.recipient,
          });
          if (!sweep.signedTransaction || !sweep.transactionHash) {
            const prepared = await signerRequest<{ transactionHash: string; signedTransaction: string; nonce: number }>("/v1/automated-fees/prepare-controller-sweep", {
              idempotencyKey: `automated-fee-controller-sweep:${args.requestId}`,
              chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress,
            }, 60_000);
            await ctx.runMutation(internal.automatedFeeEngine.persistControllerTransaction, {
              requestId: sweepRequestId, ...automatedFeePreparedFields(prepared),
            });
            sweep = { ...sweep, ...prepared, transactionNonce: prepared.nonce, status: "prepared" };
          }
          if (sweep.status === "prepared") {
            await signerRequest("/v1/automated-fees/broadcast-controller-sweep", {
              transactionHash: sweep.transactionHash, signedTransaction: sweep.signedTransaction,
              vaultAddress: program.vaultAddress,
            }, 60_000);
            await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, { requestId: sweepRequestId, status: "broadcast" });
          }
          const status = await signerRequest<{ status: "pending" | "confirmed" | "reverted" | "dropped" }>("/v1/automated-fees/controller-sweep-status", {
            chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress, transactionHash: sweep.transactionHash,
            transactionNonce: sweep.transactionNonce,
            broadcastAt: sweep.transactionBroadcastAt,
          });
          if (status.status === "confirmed") {
            await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, { requestId: sweepRequestId, status: "confirmed" });
          } else if (status.status === "reverted" || status.status === "dropped") {
            await recordSettledFailure(sweepRequestId, status.status);
            throw new Error(`automated fee controller sweep ${status.status}`);
          } else {
            const pending = await ctx.runMutation(internal.automatedFeeEngine.recordControllerPendingCheck, { requestId: sweepRequestId });
            if (pending.manualReview) throw new Error("automated fee controller sweep requires manual review");
            throw new Error(AUTOMATED_FEE_WORKFLOW_CONTINUATION);
          }
          inspection = await signerRequest<Inspection>("/v1/automated-fees/inspect", { chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress });
          if (inspection.lastCurveSweepBlock === "0") throw new Error("automated fee controller sweep was not finalized");
        }
        let reassignmentBlockNumber = "0";
        if (alreadyReassigned) {
          if (!change.transactionHash) throw new Error("automated fee reassignment transaction is missing");
          hash = change.transactionHash;
          const status = await signerRequest<{ status: "pending" | "confirmed" | "reverted" | "dropped"; blockNumber?: string }>("/v1/automated-fees/controller-status", {
            chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress,
            transactionHash: change.transactionHash,
            expectedAddress: args.expectedAddress,
            transactionNonce: change.transactionNonce,
            broadcastAt: change.transactionBroadcastAt,
            operation: { type: "reassign", newController: args.recipient, newBeneficiary: args.recipient },
          });
          if (status.status === "pending") {
            const pending = await ctx.runMutation(internal.automatedFeeEngine.recordControllerPendingCheck, { requestId: args.requestId });
            if (pending.manualReview) throw new Error("automated fee controller transaction requires manual review");
            throw new Error(AUTOMATED_FEE_WORKFLOW_CONTINUATION);
          }
          if (status.status !== "confirmed") throw new Error(`automated fee controller transaction ${status.status}`);
          reassignmentBlockNumber = status.blockNumber ?? "0";
        } else {
          const deadline = Math.floor(Date.now() / 1000) + 300;
          let execution: ControllerExecution;
          if (change.signedTransaction && change.operationJson) {
            execution = JSON.parse(change.operationJson).execution;
          } else {
          try {
            const quote = await signerRequest<Omit<ControllerExecution, "quoteSignature"> & { signature: string }>("/v1/automated-fees/authorize", {
              chainId: ROBINHOOD_CHAIN_ID, vaultAddress: program.vaultAddress, deadline, nonce: inspection.executionNonce,
            }, 60_000);
            execution = automatedFeeExecutionFields(quote);
          } catch (error) {
            if (!/no processable automated creator fees/i.test(error instanceof Error ? error.message : String(error))) throw error;
            execution = {
              maxBuybackAmount: "0", minPonsbotOut: "0", minSweepBuybackTokensOut: "0", deadline,
              routeTarget: "0x0000000000000000000000000000000000000000", routeData: "0x", quoteSignature: "0x",
            };
          }
          }
          const reassigned = await executeOne(args.requestId, {
            type: "reassign", newController: args.recipient, newBeneficiary: args.recipient,
            execution,
          }, { type: "reassign", newController: args.recipient, newBeneficiary: args.recipient });
          hash = reassigned.transactionHash;
          reassignmentBlockNumber = reassigned.blockNumber;
        }
        await deliverFormerBeneficiary(reassignmentBlockNumber);
      }
      await ctx.runMutation(internal.automatedFeeEngine.recordControllerChange, {
        programId: args.programId, transactionHash: hash, previousControllerAddress: args.expectedAddress,
        ...(args.operation === "reassign" ? { newControllerAddress: args.recipient, newBeneficiaryAddress: args.recipient, outcome: "reassigned" as const }
          : { outcome: "holders" as const }),
      });
      await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, {
        requestId: args.requestId, status: "confirmed", workflowComplete: true, transactionHash: hash,
      });
      return { transactionHash: hash, outcome: args.operation === "reassign" ? "reassigned" : "holders" };
    } catch (error) {
      if (isAutomatedFeeWorkflowContinuation(error)) throw error;
      const current = await ctx.runQuery(internal.automatedFeeEngine.controllerChangeByRequestId, {
        requestId: args.requestId,
      });
      const detail = error instanceof Error ? error.message : String(error);
      const transactionMayExist = Boolean(current?.transactionHash || current?.signedTransaction)
        || current?.status === "prepared" || current?.status === "broadcast" || current?.status === "confirmed" || current?.status === "manual_review"
        || /controller (?:transaction|sweep)|former-beneficiary delivery/i.test(detail);
      await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, {
        requestId: args.requestId, status: transactionMayExist ? "manual_review" : "failed",
        diagnosticCode: current && isTerminalAutomatedFeeControllerReview(current) ? current.diagnosticCode
          : current?.status === "confirmed" ? "FORMER_BENEFICIARY_DELIVERY_FAILED"
          : /dropped/i.test(detail) ? "CONTROLLER_TRANSACTION_DROPPED"
            : /reverted/i.test(detail) ? "CONTROLLER_TRANSACTION_REVERTED"
              : transactionMayExist ? "CONTROLLER_CHANGE_RECONCILIATION_REQUIRED" : "CONTROLLER_CHANGE_FAILED",
        diagnosticDetail: detail,
      });
      throw error;
    } finally {
      await ctx.runMutation(internal.automatedFeeEngine.releaseKeeperLease, { controllerRequestId: args.requestId, leaseId: executionLeaseId });
      await ctx.runMutation(internal.automatedFeeEngine.releaseControllerExecutionLease, { requestId: args.requestId, leaseId: executionLeaseId });
    }
  },
});

export const controllerChangesForRecovery = internalQuery({
  args: {},
  handler: async (ctx) => {
    const statuses = ["reserved", "prepared", "broadcast", "failed", "manual_review"] as const;
    const rows = (await Promise.all([
      ...statuses.map((status) => ctx.db.query("automatedFeeControllerChanges")
        .withIndex("by_status_updated", (q) => q.eq("status", status)).take(20)),
      ctx.db.query("automatedFeeControllerChanges")
        .withIndex("by_status_workflow_root_updated", (q) => q.eq("status", "confirmed").eq("workflowRoot", true))
        .filter((q) => q.eq(q.field("workflowCompletedAt"), undefined))
        .take(20),
    ])).flat();
    const candidates = [];
    for (const row of rows) {
      // Workflow roots carry the original wallet identity. Child pause, exit,
      // sweep, and delivery records intentionally do not. Request IDs cannot be
      // used to distinguish them because X and terminal root IDs contain colons.
      if (!isAutomatedFeeControllerWorkflowRoot(row)) continue;
      if (row.workflowCompletedAt) continue;
      if (isTerminalAutomatedFeeControllerReview(row)) continue;
      if (row.status === "failed" && !automatedFeeControllerTransactionMayExist(row)) continue;
      const childIds = [
        `${row.requestId}:pause`, `${row.requestId}:exit`, `${row.requestId}:controller-sweep`,
        `${row.requestId}:former-beneficiary-delivery`,
      ];
      const children = await Promise.all(childIds.map((requestId) => ctx.db.query("automatedFeeControllerChanges")
        .withIndex("by_request_id", (q) => q.eq("requestId", requestId)).unique()));
      if (children.some((child) => child && isTerminalAutomatedFeeControllerReview(child))) continue;
      const program = await ctx.db.get(row.programId);
      if (!program) continue;
      const stateComplete = row.operation === "reassign"
        ? Boolean(row.newControllerAddress && program.normalizedControllerAddress === normalizedAddress(row.newControllerAddress))
        : program.status === "exited" && program.distributionMode === "holders";
      candidates.push({ row, program, stateComplete });
    }
    return candidates.slice(0, 10);
  },
});

export const controllerRecoveryWallet = internalQuery({
  args: { ownerXUserId: v.string(), expectedAddress: v.string() },
  handler: async (ctx, args) => {
    const wallet = await ctx.db.query("cryptoWallets").withIndex("by_owner_x_user_id", q => q.eq("ownerXUserId", args.ownerXUserId)).unique();
    if (!wallet || wallet.status !== "active" || wallet.chainId !== ROBINHOOD_CHAIN_ID
      || wallet.address.toLowerCase() !== args.expectedAddress.toLowerCase()) return null;
    return wallet._id;
  },
});

export const recoverControllerChanges = internalAction({
  args: {},
  handler: async (ctx): Promise<{ attempted: number; continued: number }> => {
    const config = configuration();
    // New public controller commands remain gated in wallets.ts. Persisted
    // controller workflows may already have broadcast a pause, exit, sweep,
    // reassignment, or delivery and must remain reconcilable after a switch is
    // turned off.
    if (!automatedFeeRecoveryInfrastructureReady()) return { attempted: 0, continued: 0 };
    const candidates = await ctx.runQuery(internal.automatedFeeEngine.controllerChangesForRecovery, {});
    let continued = 0;
    for (const { row, program, stateComplete } of candidates) {
      const recipient = row.operation === "reassign" ? row.newControllerAddress : row.exitRecipientAddress;
      if (!recipient || !row.ownerXUserId || !row.walletRef) continue;
      let walletId: Id<"cryptoWallets"> | null = null;
      const walletLease = crypto.randomUUID();
      let ownsWalletLease = false;
      try {
        const completedHash = row.transactionHash || program.lastControllerChangeTransactionHash;
        if (stateComplete && completedHash) {
          await ctx.runMutation(internal.automatedFeeEngine.markControllerChangeStatus, {
            requestId: row.requestId, status: "confirmed", workflowComplete: true,
            transactionHash: completedHash,
          });
          await ctx.runMutation(internal.automatedFeeEngine.finalizeRecoveredWalletRequest, {
            requestId: row.requestId, programId: row.programId,
            operation: row.operation === "holders" ? "holders" : "reassign",
            transactionHash: completedHash,
          });
          continue;
        }
        // Foreground requests already hold this lock. Background recovery must
        // acquire it too before signing with a user's wallet alongside trades.
        walletId = await ctx.runQuery(internal.automatedFeeEngine.controllerRecoveryWallet, {
          ownerXUserId: row.ownerXUserId, expectedAddress: row.previousControllerAddress,
        });
        if (!walletId) continue;
        ownsWalletLease = await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, {
          walletId, requestId: row.requestId, leaseToken: walletLease,
        });
        if (!ownsWalletLease) continue;
        const result = await ctx.runAction(internal.automatedFeeEngine.executeVerifiedControllerChange, {
          requestId: row.requestId, programId: row.programId, ownerXUserId: row.ownerXUserId,
          walletRef: row.walletRef, expectedAddress: row.previousControllerAddress,
          operation: row.operation, recipient,
        });
        await ctx.runMutation(internal.automatedFeeEngine.finalizeRecoveredWalletRequest, {
          requestId: row.requestId, programId: row.programId,
          operation: row.operation === "holders" ? "holders" : "reassign",
          transactionHash: result.transactionHash,
        });
      } catch (error) {
        if (isAutomatedFeeWorkflowContinuation(error)) continued += 1;
      } finally {
        if (walletId && ownsWalletLease) await ctx.runMutation(internal.wallets.releaseWalletExecutionLock, {
          walletId, requestId: row.requestId, leaseToken: walletLease,
        });
      }
    }
    return { attempted: candidates.length, continued };
  },
});

export const acquireEngineLease = internalMutation({
  args: { leaseId: v.string(), now: v.number() },
  handler: async (ctx, { leaseId, now }) => {
    const current = await ctx.db.query("automatedFeeEngineState").withIndex("by_key", (q) => q.eq("key", ENGINE_KEY)).unique();
    if (current?.leaseUntil && current.leaseUntil > now) return false;
    const patch = { leaseId, leaseUntil: now + AUTOMATED_FEE_ENGINE_LEASE_MS, lastStartedAt: now, updatedAt: now };
    if (current) await ctx.db.patch(current._id, patch);
    else await ctx.db.insert("automatedFeeEngineState", { key: ENGINE_KEY, ...patch });
    return true;
  },
});

export const finishEngineRun = internalMutation({
  args: {
    leaseId: v.string(),
    status: v.union(v.literal("idle"), v.literal("completed"), v.literal("failed")),
    diagnosticCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const current = await ctx.db.query("automatedFeeEngineState").withIndex("by_key", (q) => q.eq("key", ENGINE_KEY)).unique();
    if (!current || current.leaseId !== args.leaseId) return false;
    const now = Date.now();
    await ctx.db.patch(current._id, {
      leaseId: undefined,
      leaseUntil: undefined,
      lastCompletedAt: now,
      lastStatus: args.status,
      lastDiagnosticCode: args.diagnosticCode,
      updatedAt: now,
    });
    return true;
  },
});

export const runScheduledProcessing = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    status: "disabled" | "not_ready" | "leased" | "idle" | "completed";
    missing?: string[];
    executionImplementationReady?: boolean;
    considered?: number;
  }> => {
    const config = configuration();
    if (!config.enabled || !config.requestedCapabilities.sweepBuybackBurn) {
      if (automatedFeeRecoveryInfrastructureReady()) {
        const pending = await ctx.runMutation(internal.automatedFeeQueue.pausedReceiptCandidates, {});
        // Bounded read-only batches. No inspections, quotes, signatures or broadcasts.
        for (let i = 0; i < pending.length; i += 4) await Promise.all(pending.slice(i, i + 4).map(async row => {
          let observation: string;
          try {
            const { runId: _runId, ...request } = row;
            const result = await signerRequest<Status>("/v1/automated-fees/status", { chainId: ROBINHOOD_CHAIN_ID, ...request });
            observation = `${row.stage}:${result.status}`;
          } catch { observation = `${row.stage}:rpc_unavailable`; }
          await ctx.runMutation(internal.automatedFeeQueue.recordPausedReceipt, { runId: row.runId, observation });
        }));
      }
      return { status: "disabled" as const };
    }
    if (!config.capabilities.sweepBuybackBurn || !PRODUCTION_EXECUTION_IMPLEMENTATION_READY) {
      return {
        status: "not_ready" as const,
        missing: config.invalid,
        executionImplementationReady: PRODUCTION_EXECUTION_IMPLEMENTATION_READY,
      };
    }
    // Dispatch is one atomic mutation; a long-lived action lease would only
    // delay recovery if this tiny cron action died after acquiring it.
    const result = await ctx.runMutation(internal.automatedFeeQueue.dispatch, {});
    return { status: result.dispatched ? "completed" as const : "idle" as const, considered: result.dispatched };
  },
});
