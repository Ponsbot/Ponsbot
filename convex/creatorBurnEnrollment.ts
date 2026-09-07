import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { signerRequest } from "./automatedFeeEngine";
import { redactSignerDiagnostic } from "../lib/signer-diagnostics";
import { keccak256, stringToHex } from "viem";

export async function queueCreatorBurnRequest(
  ctx: MutationCtx,
  a: {
    requestId: string;
    tokenAddress: string;
    ownerXUserId: string;
    bps: number;
  },
) {
  if (process.env.CREATOR_SELF_BUYBACK_ENABLED !== "true")
    throw new Error("Creator self-buyback is not enabled yet.");
  if (!Number.isInteger(a.bps) || a.bps < 0 || a.bps > 10000)
    throw new Error("Choose a percentage from 0 to 100.");
  const p = await ctx.db
    .query("automatedFeePrograms")
    .withIndex("by_token", (q) =>
      q.eq("normalizedTokenAddress", a.tokenAddress.toLowerCase()),
    )
    .unique();
  if (!p || p.status !== "enrolled" || p.distributionMode !== "wallet")
    throw new Error("This token needs an active Pons Bot vault first.");
  const wallet = await ctx.db
    .query("cryptoWallets")
    .withIndex("by_owner_x_user_id", (q) =>
      q.eq("ownerXUserId", a.ownerXUserId),
    )
    .unique();
  if (
    !wallet ||
    wallet.status !== "active" ||
    wallet.chainId !== 4663 ||
    wallet.address.toLowerCase() !== p.normalizedControllerAddress
  )
    throw new Error("Only the current fee owner can change this percentage.");
  const old = await ctx.db
    .query("creatorBurnRequests")
    .withIndex("by_request", (q) => q.eq("requestId", a.requestId))
    .unique();
  if (old) {
    if (
      old.programId !== p._id ||
      old.ownerXUserId !== a.ownerXUserId ||
      old.bps !== a.bps
    )
      throw new Error("Creator burn request conflict");
    if (old.status === "manual_review")
      throw new Error(
        "Creator-fee configuration needs review. Please contact @Ponsbotfamily before trying again.",
      );
    return old._id;
  }
  if (
    await ctx.db
      .query("creatorBurnRequests")
      .withIndex("by_program_status", (q) =>
        q.eq("programId", p._id).eq("status", "pending"),
      )
      .first()
  )
    throw new Error(
      "A creator-fee change is already processing for this token.",
    );
  const id = await ctx.db.insert("creatorBurnRequests", {
    requestId: a.requestId,
    programId: p._id,
    ownerXUserId: a.ownerXUserId,
    ownerAddress: wallet.address,
    bps: a.bps,
    status: "pending",
    nextAttemptAt: Date.now(),
    attempts: 0,
    createdAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.creatorBurnEnrollment.run, { id });
  return id;
}
export const request = internalMutation({
  args: {
    requestId: v.string(),
    tokenAddress: v.string(),
    ownerXUserId: v.string(),
    bps: v.number(),
  },
  handler: queueCreatorBurnRequest,
});
export const plan = internalQuery({
  args: { tokenAddress: v.string() },
  handler: async (ctx, a) => {
    const p = await ctx.db
      .query("automatedFeePrograms")
      .withIndex("by_token", (q) =>
        q.eq("normalizedTokenAddress", a.tokenAddress.toLowerCase()),
      )
      .unique();
    if (!p) return null;
    const wallet =
      (await ctx.db
        .query("cryptoWallets")
        .withIndex("by_normalized_address", (q) =>
          q.eq("normalizedAddress", p.normalizedControllerAddress),
        )
        .unique()) ??
      (await ctx.db
        .query("cryptoWallets")
        .withIndex("by_address", (q) => q.eq("address", p.controllerAddress))
        .unique());
    return {
      enabled: process.env.CREATOR_SELF_BUYBACK_ENABLED === "true",
      programId: p._id,
      status: p.status,
      tokenAddress: p.tokenAddress,
      vaultAddress: p.vaultAddress,
      ownerAddress: p.controllerAddress,
      ownerXUserId: wallet?.ownerXUserId,
      walletActive: wallet?.status === "active" && wallet.chainId === 4663,
      layerAddress: p.creatorBurnLayerAddress,
      bps: p.creatorBurnBps,
    };
  },
});
export const due = internalQuery({
  args: {},
  handler: (ctx) =>
    ctx.db
      .query("creatorBurnRequests")
      .withIndex("by_due", (q) =>
        q.eq("status", "pending").lte("nextAttemptAt", Date.now()),
      )
      .take(10),
});
export const status = internalQuery({
  args: { requestId: v.string() },
  handler: async (ctx, a) => {
    const r = await ctx.db
      .query("creatorBurnRequests")
      .withIndex("by_request", (q) => q.eq("requestId", a.requestId))
      .unique();
    return r
      ? {
          id: r._id,
          status: r.status,
          bps: r.bps,
          attempts: r.attempts,
          layerAddress: r.layerAddress,
          transactionHash: r.transactionHash,
          deploymentHash: r.deploymentHash,
          deploymentSettled: r.deploymentSettled,
          diagnostic: r.diagnostic,
          nextAttemptAt: r.nextAttemptAt,
        }
      : null;
  },
});
export const begin = internalMutation({
  args: { id: v.id("creatorBurnRequests"), leaseId: v.string() },
  handler: async (ctx, a) => {
    const r = await ctx.db.get(a.id);
    if (!r || r.status !== "pending" || (r.leaseUntil ?? 0) > Date.now())
      return null;
    await ctx.db.patch(r._id, {
      leaseId: a.leaseId,
      leaseUntil: Date.now() + 240000,
      attempts: r.attempts + 1,
    });
    return r;
  },
});
export const save = internalMutation({
  args: {
    id: v.id("creatorBurnRequests"),
    leaseId: v.string(),
    deploymentHash: v.optional(v.string()),
    deploymentSigned: v.optional(v.string()),
    deploymentIdentity: v.optional(v.string()),
    deploymentSettled: v.optional(v.boolean()),
    layerAddress: v.optional(v.string()),
    transactionHash: v.optional(v.string()),
    done: v.optional(v.boolean()),
    manualReview: v.optional(v.boolean()),
    diagnostic: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const r = await ctx.db.get(a.id);
    if (!r || r.leaseId !== a.leaseId) throw new Error("Enrollment lease lost");
    if (
      r.deploymentSigned &&
      a.deploymentSigned &&
      r.deploymentSigned !== a.deploymentSigned
    )
      throw new Error("Immutable deployment conflict");
    const { id, leaseId, done, manualReview, diagnostic, ...patch } = a;
    await ctx.db.patch(id, {
      ...patch,
      ...(done ? { status: "confirmed" as const } : {}),
      ...(manualReview
        ? { status: "manual_review" as const, leaseUntil: 0 }
        : {}),
      ...(diagnostic
        ? { diagnostic, nextAttemptAt: Date.now() + 60000, leaseUntil: 0 }
        : {}),
    });
    if (done || manualReview) {
      const wr = await ctx.db
        .query("walletRequests")
        .withIndex("by_request_id", (q) => q.eq("requestId", r.requestId))
        .unique();
      const p = await ctx.db.get(r.programId),
        launch = p?.launchId ? await ctx.db.get(p.launchId) : null;
      if (wr && manualReview) {
        const message =
          "⚠️ The creator-fee configuration did not finish and needs review. Please contact @Ponsbotfamily before trying again.";
        await ctx.db.patch(wr._id, {
          status: "failed",
          workflowStage: "creator_self_burn_review",
          safeError: message,
          finalMessage: message,
          updatedAt: Date.now(),
        });
      } else if (wr)
        await ctx.db.patch(wr._id, {
          status: "confirmed",
          transactionHash: a.transactionHash,
          workflowStage: "creator_self_burn_configured",
          finalMessage: `✅ ${r.bps / 100}% of your creator-fee share from $${launch?.symbol ?? "TOKEN"} now buys back and burns $${launch?.symbol ?? "TOKEN"}.\nThis applies after Pons Bot’s 5% allocation.\nhttps://www.ponsbot.family/launch/${p?.tokenAddress}`,
          updatedAt: Date.now(),
        });
    }
  },
});
export const run = internalAction({
  args: { id: v.id("creatorBurnRequests") },
  handler: async (ctx, a): Promise<void> => {
    const enabled = process.env.CREATOR_SELF_BUYBACK_ENABLED === "true";
    const leaseId = crypto.randomUUID(),
      r = await ctx.runMutation(internal.creatorBurnEnrollment.begin, {
        ...a,
        leaseId,
      });
    if (!r) return;
    let walletId = null,
      locked = false,
      adminLease = false,
      unsettledDeployment = Boolean(r.deploymentSigned && !r.deploymentSettled),
      deploymentIdentity = r.deploymentIdentity;
    const save = (x: Record<string, unknown>) =>
      ctx.runMutation(internal.creatorBurnEnrollment.save, {
        ...a,
        leaseId,
        ...x,
      });
    try {
      const p = await ctx.runQuery(
        internal.automatedFeeEngine.enrollmentProgramStatus,
        { programId: r.programId },
      );
      if (!p || p.status !== "enrolled")
        throw new Error("Active primary vault required");
      if (!enabled) {
        // Read receipts only. Disabling must never start another owner operation.
        if (r.deploymentSigned && !r.deploymentSettled) {
          const s = await signerRequest<{ status: string }>(
            "/v1/creator-burn/deploy-layer",
            {
              vaultAddress: p.vaultAddress,
              expectedOwner: r.ownerAddress,
              idempotencyKey: `creator-layer:${r.requestId}`,
              signedTransaction: r.deploymentSigned,
            },
          );
          if (s.status === "confirmed" || s.status === "reverted") {
            deploymentIdentity = r.deploymentIdentity;
            if (deploymentIdentity) {
              adminLease = await ctx.runMutation(
                internal.automatedFeeEngine.acquireDeploymentLease,
                {
                  programId: p._id,
                  leaseId,
                  externalDeploymentId: deploymentIdentity,
                },
              );
              if (!adminLease) throw new Error("Admin busy");
              await ctx.runMutation(
                internal.automatedFeeEngine.completeExternalDeployment,
                {
                  programId: p._id,
                  leaseId,
                  externalDeploymentId: deploymentIdentity,
                },
              );
            }
            unsettledDeployment = false;
            await save({
              deploymentSettled: true,
              manualReview: s.status === "reverted",
            });
          }
        }
        await save({
          diagnostic: "Creator burn enrollment paused by configuration",
        });
        return;
      }
      walletId = await ctx.runQuery(
        internal.automatedFeeEngine.controllerRecoveryWallet,
        { ownerXUserId: r.ownerXUserId, expectedAddress: r.ownerAddress },
      );
      if (!walletId) throw new Error("Owner wallet unavailable");
      locked = await ctx.runMutation(
        internal.wallets.acquireWalletExecutionLock,
        { walletId, requestId: r.requestId, leaseToken: leaseId },
      );
      if (!locked) throw new Error("Wallet busy");
      let found = await signerRequest<{
        layer: {
          layer: string;
          owner: string;
          active: boolean;
          exited: boolean;
        } | null;
      }>("/v1/creator-burn/discover", { vaultAddress: p.vaultAddress });
      if (!found.layer || (r.deploymentSigned && !r.deploymentSettled)) {
        const identity =
          r.deploymentIdentity ??
          keccak256(
            stringToHex(`creator-layer:${r.requestId}:${p.vaultAddress}`),
          );
        deploymentIdentity = identity;
        adminLease = await ctx.runMutation(
          internal.automatedFeeEngine.acquireDeploymentLease,
          { programId: p._id, leaseId, externalDeploymentId: identity },
        );
        if (!adminLease) throw new Error("Admin busy");
        const req = {
          vaultAddress: p.vaultAddress,
          expectedOwner: r.ownerAddress,
          idempotencyKey: `creator-layer:${r.requestId}`,
        };
        let signed = r.deploymentSigned;
        if (!signed) {
          const tx = await signerRequest<{
            signedTransaction?: string;
            transactionHash?: string;
            status: string;
          }>("/v1/creator-burn/deploy-layer", req, 60000);
          if (tx.signedTransaction) {
            await save({
              deploymentSigned: tx.signedTransaction,
              deploymentHash: tx.transactionHash,
              deploymentIdentity: identity,
            });
            signed = tx.signedTransaction;
            unsettledDeployment = true;
          }
        }
        if (signed) {
          const s = await signerRequest<{ status: string }>(
            "/v1/creator-burn/deploy-layer",
            { ...req, signedTransaction: signed },
            60000,
          );
          if (s.status === "reverted") {
            await ctx.runMutation(
              internal.automatedFeeEngine.completeExternalDeployment,
              {
                programId: p._id,
                leaseId,
                externalDeploymentId: identity,
              },
            );
            unsettledDeployment = false;
            await save({
              deploymentSettled: true,
              manualReview: true,
              diagnostic:
                "Layer deployment reverted; no fee rights were transferred",
            });
            return;
          }
          if (s.status !== "confirmed")
            throw new Error(`Layer deployment ${s.status}`);
        }
        await ctx.runMutation(
          internal.automatedFeeEngine.completeExternalDeployment,
          { programId: p._id, leaseId, externalDeploymentId: identity },
        );
        unsettledDeployment = false;
        await save({ deploymentSettled: true });
        found = await signerRequest<typeof found>("/v1/creator-burn/discover", {
          vaultAddress: p.vaultAddress,
        });
      }
      if (!found.layer || found.layer.exited)
        throw new Error("Creator layer owner changed");
      if (
        !found.layer.active &&
        found.layer.owner.toLowerCase() !== r.ownerAddress.toLowerCase()
      ) {
        // A dormant layer may predate a legitimate primary-vault reassignment.
        // The registered layer worker can synchronize it, but cannot burn until active.
        await ctx.runAction(internal.creatorBurnEngine.sync, {
          programId: p._id,
        });
        await ctx.runMutation(internal.creatorBurnEngine.wake, {
          programId: p._id,
        });
        throw new Error("Waiting for dormant layer owner synchronization");
      }
      if (found.layer.owner.toLowerCase() !== r.ownerAddress.toLowerCase())
        throw new Error("Creator layer owner changed");
      if (!found.layer.active)
        await ctx.runAction(
          internal.automatedFeeEngine.executeVerifiedControllerChange,
          {
            requestId: `${r.requestId}:enroll`,
            programId: p._id,
            ownerXUserId: r.ownerXUserId,
            walletRef: r.ownerAddress,
            expectedAddress: r.ownerAddress,
            operation: "reassign",
            recipient: found.layer.layer,
            enrollmentLayer: found.layer.layer,
          },
        );
      // Always resume the saved enrollment, including former-owner fee delivery.
      const enrollment = await ctx.runQuery(
        internal.automatedFeeEngine.controllerChangeByRequestId,
        { requestId: `${r.requestId}:enroll` },
      );
      if (enrollment && !enrollment.workflowCompletedAt)
        await ctx.runAction(
          internal.automatedFeeEngine.executeVerifiedControllerChange,
          {
            requestId: `${r.requestId}:enroll`,
            programId: p._id,
            ownerXUserId: r.ownerXUserId,
            walletRef: r.ownerAddress,
            expectedAddress: r.ownerAddress,
            operation: "reassign",
            recipient: found.layer.layer,
            enrollmentLayer: found.layer.layer,
          },
        );
      await ctx.runAction(internal.creatorBurnEngine.sync, {
        programId: p._id,
      });
      const result = await ctx.runAction(
        internal.automatedFeeEngine.executeVerifiedControllerChange,
        {
          requestId: `${r.requestId}:percentage`,
          programId: p._id,
          ownerXUserId: r.ownerXUserId,
          walletRef: r.ownerAddress,
          expectedAddress: r.ownerAddress,
          operation: "reassign",
          recipient: r.ownerAddress,
          selfBurnBps: r.bps,
        },
      );
      await save({
        done: true,
        transactionHash: result.transactionHash,
        layerAddress: found.layer.layer,
      });
    } catch (e) {
      await save({
        diagnostic: redactSignerDiagnostic(
          e instanceof Error ? e.message : String(e),
        ),
      });
    } finally {
      try {
        if (adminLease) {
          if (!unsettledDeployment && deploymentIdentity)
            await ctx
              .runMutation(
                internal.automatedFeeEngine.completeExternalDeployment,
                {
                  programId: r.programId,
                  leaseId,
                  externalDeploymentId: deploymentIdentity,
                },
              )
              .catch(() => undefined);
          await ctx.runMutation(
            internal.automatedFeeEngine.releaseDeploymentLease,
            { programId: r.programId, leaseId },
          );
        }
      } finally {
        if (walletId && locked)
          await ctx.runMutation(internal.wallets.releaseWalletExecutionLock, {
            walletId,
            requestId: r.requestId,
            leaseToken: leaseId,
          });
      }
    }
  },
});
