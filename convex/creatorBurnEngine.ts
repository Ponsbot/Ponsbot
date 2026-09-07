import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { signerRequest } from "./automatedFeeEngine";
import { creatorBurnRetryAt } from "../lib/creator-burn-cycle";
import { redactSignerDiagnostic } from "../lib/signer-diagnostics";
import { automatedFeeControllerTransactionMayExist } from "../lib/automated-fee-workflow";
import { isAutomatedFeeWorkflowContinuation } from "../lib/automated-fee-workflow";
import { creatorBurnPercentageBps } from "../lib/creator-burn-policy";

const MINUTE = 60_000;
const eventValidator = v.object({
  key: v.string(),
  owner: v.string(),
  kind: v.string(),
  received: v.string(),
  cashAllocated: v.string(),
  reserveAllocated: v.string(),
  cashDebited: v.string(),
  cashReceived: v.string(),
  reserveSpent: v.string(),
  tokensBurned: v.string(),
});
export type LayerEvent = {
  key: string;
  owner: string;
  kind: string;
  received: string;
  cashAllocated: string;
  reserveAllocated: string;
  cashDebited: string;
  cashReceived: string;
  reserveSpent: string;
  tokensBurned: string;
};
type Snapshot = {
  layer: string;
  owner: string;
  active: boolean;
  exited: boolean;
  primaryController: string;
  bps: number;
  cash: string;
  reserve: string;
  upstreamClaimable: string;
};
type Receipt = {
  status: "pending" | "confirmed" | "reverted" | "nonce_consumed";
  blockNumber?: string;
  events?: LayerEvent[];
};
function enabled() {
  return process.env.CREATOR_SELF_BUYBACK_ENABLED === "true";
}
async function journalEnvelope(
  ctx: MutationCtx,
  layerId: Id<"creatorBurnLayers">,
  transactionHash: string,
  signedTransaction: string,
) {
  const old = await ctx.db
    .query("creatorBurnTransactionJournal")
    .withIndex("by_hash", (q) => q.eq("transactionHash", transactionHash))
    .unique();
  if (old) {
    if (old.layerId !== layerId || old.signedTransaction !== signedTransaction)
      throw new Error("conflicting transaction journal");
    return;
  }
  await ctx.db.insert("creatorBurnTransactionJournal", {
    layerId,
    transactionHash,
    signedTransaction,
    createdAt: Date.now(),
  });
}
async function rememberOwner(
  ctx: MutationCtx,
  layerId: Id<"creatorBurnLayers">,
  address: string,
) {
  const ownerAddress = address.toLowerCase();
  if (!/^0x[\da-f]{40}$/.test(ownerAddress))
    throw new Error("invalid layer owner");
  if (
    !(await ctx.db
      .query("creatorBurnOwners")
      .withIndex("by_identity", (q) =>
        q.eq("layerId", layerId).eq("ownerAddress", ownerAddress),
      )
      .unique())
  )
    await ctx.db.insert("creatorBurnOwners", { layerId, ownerAddress });
}
// Input comes only from the authenticated signer inspection, never a public query.
export const recordVerifiedLayer = internalMutation({
  args: {
    programId: v.id("automatedFeePrograms"),
    layerAddress: v.string(),
    ownerAddress: v.string(),
    bps: v.number(),
    active: v.boolean(),
  },
  handler: async (ctx, a) => {
    const p = await ctx.db.get(a.programId);
    if (!p) throw new Error("missing fee program");
    if (
      !/^0x[\da-f]{40}$/i.test(a.layerAddress) ||
      !Number.isInteger(a.bps) ||
      a.bps < 0 ||
      a.bps > 10000
    )
      throw new Error("invalid layer snapshot");
    const old = await ctx.db
      .query("creatorBurnLayers")
      .withIndex("by_layer", (q) =>
        q.eq("layerAddress", a.layerAddress.toLowerCase()),
      )
      .unique();
    if (old && old.programId !== a.programId)
      throw new Error("layer program mismatch");
    const patch = {
      layerAddress: a.layerAddress.toLowerCase(),
      ownerAddress: a.ownerAddress.toLowerCase(),
      bps: a.bps,
      active: a.active,
      updatedAt: Date.now(),
    };
    const id = old
      ? old._id
      : await ctx.db.insert("creatorBurnLayers", {
          ...patch,
          programId: a.programId,
          nextCheckAt: Date.now() + MINUTE,
          failures: 0,
          burnRetryAt: 0,
          hasPending: false,
        });
    if (old) await ctx.db.patch(id, patch);
    await rememberOwner(ctx, id, p.beneficiaryAddress);
    await rememberOwner(ctx, id, a.ownerAddress);
    if (a.active) {
      if (
        !old &&
        (p.normalizedControllerAddress !== patch.ownerAddress ||
          p.normalizedBeneficiaryAddress !== patch.ownerAddress)
      )
        throw new Error("layer owner differs from verified program owner");
      await ctx.db.patch(p._id, {
        creatorBurnLayerAddress: patch.layerAddress,
        creatorBurnBps: a.bps,
        creatorBurnVerifiedAt: Date.now(),
        controllerAddress: patch.ownerAddress,
        normalizedControllerAddress: patch.ownerAddress,
        beneficiaryAddress: patch.ownerAddress,
        normalizedBeneficiaryAddress: patch.ownerAddress,
      });
    } else if (p.creatorBurnLayerAddress?.toLowerCase() === patch.layerAddress)
      await ctx.db.patch(p._id, {
        creatorBurnBps: 0,
        creatorBurnVerifiedAt: Date.now(),
      });
    return id;
  },
});
export const sync = internalAction({
  args: { programId: v.id("automatedFeePrograms") },
  handler: async (ctx, a): Promise<void> => {
    if (!process.env.CREATOR_SELF_BUYBACK_FACTORY_ADDRESS) return;
    const p = await ctx.runQuery(
      internal.automatedFeeEngine.enrollmentProgramStatus,
      a,
    );
    if (!p) return;
    const response = await signerRequest<{ layer: Snapshot | null }>(
      "/v1/creator-burn/discover",
      { vaultAddress: p.vaultAddress },
    );
    const s = response.layer;
    if (!s) return;
    await ctx.runMutation(internal.creatorBurnEngine.recordVerifiedLayer, {
      programId: p._id,
      layerAddress: s.layer,
      ownerAddress: s.owner,
      bps: s.bps,
      active: s.active,
    });
  },
});
export const ingest = internalMutation({
  args: {
    programId: v.id("automatedFeePrograms"),
    layerAddress: v.string(),
    transactionHash: v.string(),
    blockNumber: v.string(),
    events: v.array(eventValidator),
  },
  handler: async (ctx, a) => {
    const layer = await ctx.db
      .query("creatorBurnLayers")
      .withIndex("by_layer", (q) =>
        q.eq("layerAddress", a.layerAddress.toLowerCase()),
      )
      .unique();
    if (
      !layer ||
      layer.programId !== a.programId ||
      !/^0x[\da-f]{64}$/i.test(a.transactionHash) ||
      !/^\d+$/.test(a.blockNumber)
    )
      throw new Error("unregistered layer receipt");
    const program = await ctx.db.get(a.programId);
    if (!program) throw new Error("missing layer program");
    for (const row of a.events) {
      const prefix = `4663:${layer.layerAddress}:${a.transactionHash.toLowerCase()}:`;
      if (
        !row.key.startsWith(prefix) ||
        !/^\d+$/.test(row.key.slice(prefix.length)) ||
        ![
          row.received,
          row.cashAllocated,
          row.reserveAllocated,
          row.cashDebited,
          row.cashReceived,
          row.reserveSpent,
          row.tokensBurned,
        ].every((n) => /^\d+$/.test(n))
      )
        throw new Error("invalid layer receipt ledger");
      const prior = await ctx.db
        .query("creatorBurnEvents")
        .withIndex("by_key", (q) => q.eq("key", row.key))
        .unique();
      if (prior) {
        if (
          Object.entries(row).some(
            ([key, value]) =>
              String(prior[key as keyof typeof prior]).toLowerCase() !==
              value.toLowerCase(),
          )
        )
          throw new Error("conflicting layer receipt ledger");
        continue;
      }
      await rememberOwner(ctx, layer._id, row.owner);
      await ctx.db.insert("creatorBurnEvents", {
        ...row,
        owner: row.owner.toLowerCase(),
        layerId: layer._id,
        programId: a.programId,
        transactionHash: a.transactionHash.toLowerCase(),
        blockNumber: a.blockNumber,
        createdAt: Date.now(),
      });
      if (
        row.kind === "payout" &&
        !program.privateTest &&
        BigInt(row.cashReceived) > 0n
      ) {
        const asset = program.normalizedPairTokenAddress;
        const total = await ctx.db
          .query("automatedFeeAssetTotals")
          .withIndex("by_asset", (q) => q.eq("normalizedAssetAddress", asset))
          .unique();
        const patch = {
          lifetimeBeneficiaryDelivered: (
            BigInt(total?.lifetimeBeneficiaryDelivered ?? "0") +
            BigInt(row.cashReceived)
          ).toString(),
          updatedAt: Date.now(),
        };
        if (total) await ctx.db.patch(total._id, patch);
        else
          await ctx.db.insert("automatedFeeAssetTotals", {
            normalizedAssetAddress: asset,
            assetAddress: asset,
            lifetimeGrossClaimed: "0",
            lifetimeBuybackSpent: "0",
            ...patch,
          });
      }
    }
    await ctx.db.patch(layer._id, { nextCheckAt: Date.now() });
  },
});
export const wake = internalMutation({
  args: { programId: v.id("automatedFeePrograms") },
  handler: async (ctx, a) => {
    for (const l of await ctx.db
      .query("creatorBurnLayers")
      .withIndex("by_program", (q) => q.eq("programId", a.programId))
      .collect())
      await ctx.db.patch(l._id, { nextCheckAt: Date.now() });
  },
});
export const due = internalQuery({
  args: {},
  handler: async (ctx) =>
    ctx.db
      .query("creatorBurnLayers")
      .withIndex("by_due", (q) => q.lte("nextCheckAt", Date.now()))
      .filter((q) => q.neq(q.field("manualReview"), true))
      .take(10),
});
// Pending envelopes must remain visible even when disabled ordinary rows fill
// the due index. The shared keeper permits only one outstanding layer sender.
export const pendingLayers = internalQuery({
  args: {},
  handler: async (ctx) =>
    ctx.db
      .query("creatorBurnLayers")
      .withIndex("by_pending", (q) => q.eq("hasPending", true))
      .take(100),
});
export const begin = internalMutation({
  args: { layerId: v.id("creatorBurnLayers"), leaseId: v.string() },
  handler: async (ctx, a) => {
    const l = await ctx.db.get(a.layerId);
    if (
      !l ||
      (l.leaseUntil ?? 0) > Date.now() ||
      (l.manualReview && !l.pending)
    )
      return null;
    const p = await ctx.db.get(l.programId);
    if (!p) return null;
    if(l.active&&!l.pending&&await ctx.db.query("creatorBurnRequests").withIndex("by_program_status",q=>q.eq("programId",p._id).eq("status","pending")).first())return null;
    if (!l.pending) {
      const runs = await Promise.all(
        (
          [
            "reserved",
            "submitted",
            "uncertain",
            "deferred",
            "manual_review",
          ] as const
        ).map((status) =>
          ctx.db
            .query("automatedFeeRuns")
            .withIndex("by_program_status", (q) =>
              q.eq("programId", p._id).eq("status", status),
            )
            .first(),
        ),
      );
      const changes = await Promise.all(
        (
          [
            "reserved",
            "prepared",
            "broadcast",
            "manual_review",
            "failed",
          ] as const
        ).map((status) =>
          ctx.db
            .query("automatedFeeControllerChanges")
            .withIndex("by_program_status", (q) =>
              q.eq("programId", p._id).eq("status", status),
            )
            .first(),
        ),
      );
      const unfinishedRoots = await ctx.db
        .query("automatedFeeControllerChanges")
        .withIndex("by_program_status", (q) =>
          q.eq("programId", p._id).eq("status", "confirmed"),
        )
        .filter((q) =>
          q.and(
            q.eq(q.field("workflowRoot"), true),
            q.eq(q.field("workflowCompletedAt"), undefined),
          ),
        )
        .first();
      if (
        runs.some(Boolean) ||
        changes.some(
          (row) =>
            row &&
            (row.status !== "failed" ||
              automatedFeeControllerTransactionMayExist(row)),
        ) ||
        unfinishedRoots
      ) {
        await ctx.db.patch(l._id, { nextCheckAt: Date.now() + MINUTE });
        return null;
      }
    }
    await ctx.db.patch(l._id, {
      leaseId: a.leaseId,
      leaseUntil: Date.now() + 5 * MINUTE,
    });
    const owners = await ctx.db
      .query("creatorBurnOwners")
      .withIndex("by_layer", (q) => q.eq("layerId", l._id))
      .paginate({ cursor: l.ownerCursor ?? null, numItems: 10 });
    const currentOwner = await ctx.db
      .query("creatorBurnOwners")
      .withIndex("by_identity", (q) =>
        q.eq("layerId", l._id).eq("ownerAddress", l.ownerAddress),
      )
      .unique();
    return {
      layer: l,
      program: p,
      owners: owners.page.map((o) => o.ownerAddress),
      burnDeferredOwners: [
        ...owners.page,
        ...(currentOwner ? [currentOwner] : []),
      ]
        .filter((o) => (o.burnRetryAt ?? 0) > Date.now())
        .map((o) => o.ownerAddress),
      nextCursor: owners.isDone ? undefined : owners.continueCursor,
    };
  },
});
export const reserve = internalMutation({
  args: {
    layerId: v.id("creatorBurnLayers"),
    leaseId: v.string(),
    key: v.string(),
    stage: v.union(
      v.literal("collect"),
      v.literal("payout"),
      v.literal("burn"),
    ),
    beneficiary: v.string(),
  },
  handler: async (ctx, a) => {
    const l = await ctx.db.get(a.layerId);
    if (
      !l ||
      l.leaseId !== a.leaseId ||
      (l.leaseUntil ?? 0) <= Date.now() ||
      l.pending
    )
      throw new Error("layer reservation conflict");
    const pending = {
      key: a.key,
      stage: a.stage,
      beneficiary: a.beneficiary,
      createdAt: Date.now(),
    };
    await ctx.db.patch(l._id, { pending, hasPending: true });
    return pending;
  },
});
export const saveEnvelope = internalMutation({
  args: {
    layerId: v.id("creatorBurnLayers"),
    key: v.string(),
    transactionHash: v.string(),
    signedTransaction: v.string(),
  },
  handler: async (ctx, a) => {
    const l = await ctx.db.get(a.layerId);
    if (!l?.pending || l.pending.key !== a.key)
      throw new Error("layer envelope identity mismatch");
    if (
      l.pending.transactionHash &&
      (l.pending.transactionHash !== a.transactionHash ||
        l.pending.signedTransaction !== a.signedTransaction)
    )
      throw new Error("immutable layer envelope conflict");
    await journalEnvelope(ctx, l._id, a.transactionHash, a.signedTransaction);
    await ctx.db.patch(l._id, {
      pending: {
        ...l.pending,
        transactionHash: a.transactionHash,
        signedTransaction: a.signedTransaction,
      },
    });
  },
});
export const finish = internalMutation({
  args: {
    layerId: v.id("creatorBurnLayers"),
    leaseId: v.string(),
    clear: v.boolean(),
    delay: v.number(),
    diagnostic: v.optional(v.string()),
    nextCursor: v.optional(v.string()),
    burnBackoff: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const l = await ctx.db.get(a.layerId);
    if (!l || l.leaseId !== a.leaseId) return;
    const failures = a.diagnostic ? l.failures + 1 : 0;
    await ctx.db.patch(l._id, {
      leaseId: undefined,
      leaseUntil: undefined,
      ...(a.clear || (a.diagnostic && !l.pending?.transactionHash)
        ? { pending: undefined, hasPending: false }
        : {}),
      nextCheckAt: Date.now() + Math.max(0, a.delay),
      diagnostic: a.diagnostic,
      failures,
      ...(a.burnBackoff
        ? { burnRetryAt: creatorBurnRetryAt(Date.now(), failures) }
        : {}),
      ...(a.nextCursor !== undefined
        ? { ownerCursor: a.nextCursor || undefined }
        : {}),
    });
  },
});
export const run = internalAction({
  args: { layerId: v.id("creatorBurnLayers") },
  handler: async (ctx, a): Promise<void> => {
    const leaseId = crypto.randomUUID(),
      context = await ctx.runMutation(internal.creatorBurnEngine.begin, {
        ...a,
        leaseId,
      });
    if (!context) return;
    const { layer, program } = context;
    const identity = `creator-layer:${layer._id}`;
    let pending = layer.pending,
      clear = false,
      delay = MINUTE,
      diagnostic: string | undefined,
      burnBackoff = false;
    try {
      if (pending?.transactionHash) {
        let status: Receipt = { status: "pending" };
        let confirmedHash = pending.transactionHash;
        // The original may have mined while its replacement was being prepared.
        for (const hash of [
          ...(pending.previousHashes ?? []),
          pending.transactionHash,
        ]) {
          const candidate = await signerRequest<Receipt>(
            "/v1/creator-burn/status",
            {
              vaultAddress: program.vaultAddress,
              layerAddress: layer.layerAddress,
              transactionHash: hash,
              ...(hash === pending.transactionHash
                ? { signedTransaction: pending.signedTransaction }
                : {}),
            },
          );
          if (
            candidate.status === "confirmed" ||
            candidate.status === "reverted"
          ) {
            status = candidate;
            confirmedHash = hash;
            break;
          }
          if (candidate.status === "nonce_consumed") status = candidate;
        }
        if (status.status === "nonce_consumed") {
          await ctx.runMutation(internal.creatorBurnEngine.quarantine, {
            layerId: layer._id,
            reason:
              "Keeper nonce consumed by an unrecognized transaction; reconcile history before resuming this layer.",
          });
          clear = true;
          delay = 15 * MINUTE;
          return;
        }
        if (status.status !== "pending") {
          if (status.status === "confirmed")
            await ctx.runMutation(internal.creatorBurnEngine.ingest, {
              programId: program._id,
              layerAddress: layer.layerAddress,
              transactionHash: confirmedHash,
              blockNumber: status.blockNumber!,
              events: status.events ?? [],
            });
          else {
            diagnostic = "CREATOR_BURN_REVERTED";
            burnBackoff = pending.stage === "burn";
          }
          clear = true;
          delay = 0;
          return;
        }
        if (!enabled()) return;
        if (pending.signedTransaction) {
          if (
            !(await ctx.runMutation(
              internal.automatedFeeEngine.acquireKeeperLease,
              { controllerRequestId: identity, leaseId, now: Date.now() },
            ))
          )
            return;
          if (
            Date.now() - (pending.replacementAt ?? pending.createdAt) >
            5 * MINUTE
          ) {
            const replacement = await signerRequest<{
              transactionHash: string;
              signedTransaction: string;
            }>(
              "/v1/creator-burn/replace",
              {
                vaultAddress: program.vaultAddress,
                layerAddress: layer.layerAddress,
                transactionHash: pending.transactionHash,
                signedTransaction: pending.signedTransaction,
              },
              60000,
            );
            await ctx.runMutation(internal.creatorBurnEngine.saveReplacement, {
              layerId: layer._id,
              expectedHash: pending.transactionHash,
              ...replacement,
            });
            pending = { ...pending, ...replacement };
          }
          await signerRequest(
            "/v1/creator-burn/broadcast",
            {
              vaultAddress: program.vaultAddress,
              layerAddress: layer.layerAddress,
              transactionHash: pending.transactionHash,
              signedTransaction: pending.signedTransaction,
            },
            60_000,
          );
        }
        return;
      }
      if (!enabled()) {
        clear = Boolean(pending);
        delay = 15 * MINUTE;
        return;
      }
      if (
        !(await ctx.runMutation(
          internal.automatedFeeEngine.acquireKeeperLease,
          { controllerRequestId: identity, leaseId, now: Date.now() },
        ))
      )
        return;
      if (!pending) {
        let choice:
          | { stage: "collect" | "payout" | "burn"; beneficiary: string }
          | undefined;
        const current = await signerRequest<Snapshot>(
          "/v1/creator-burn/inspect",
          {
            vaultAddress: program.vaultAddress,
            layerAddress: layer.layerAddress,
          },
        );
        await ctx.runMutation(internal.creatorBurnEngine.recordVerifiedLayer, {
          programId: program._id,
          layerAddress: current.layer,
          ownerAddress: current.owner,
          bps: current.bps,
          active: current.active,
        });
        // No burn is attempted before cash. Prior owners remain separately payable.
        for (const owner of [
          ...new Set([...context.owners, current.owner.toLowerCase()]),
        ]) {
          const s = await signerRequest<Snapshot>("/v1/creator-burn/inspect", {
            vaultAddress: program.vaultAddress,
            layerAddress: layer.layerAddress,
            beneficiary: owner,
          });
          if (BigInt(s.cash) > 0n) {
            choice = { stage: "payout", beneficiary: owner };
            break;
          }
          if (
            !choice &&
            s.active &&
            BigInt(s.reserve) > 0n &&
            layer.burnRetryAt <= Date.now() &&
            !context.burnDeferredOwners.includes(owner)
          )
            choice = { stage: "burn", beneficiary: owner };
        }
        if (
          choice?.stage !== "payout" &&
          BigInt(current.upstreamClaimable) > 0n &&
          current.active
        )
          choice = { stage: "collect", beneficiary: current.owner };
        if (
          !current.active &&
          !current.exited &&
          current.owner.toLowerCase() !==
            current.primaryController.toLowerCase()
        )
          choice = { stage: "collect", beneficiary: current.owner };
        if (!choice) {
          delay = context.nextCursor ? MINUTE : 15 * MINUTE;
          return;
        }
        pending = await ctx.runMutation(internal.creatorBurnEngine.reserve, {
          layerId: layer._id,
          leaseId,
          key: crypto.randomUUID(),
          ...choice,
        });
      }
      const prepared = await signerRequest<
        | { deferred: true }
        | { transactionHash: string; signedTransaction: string }
      >(
        "/v1/creator-burn/prepare",
        {
          vaultAddress: program.vaultAddress,
          layerAddress: layer.layerAddress,
          beneficiary: pending.beneficiary,
          stage: pending.stage,
          idempotencyKey: `creator-layer:${pending.key}`,
        },
        120_000,
      );
      if ("deferred" in prepared) {
        clear = true;
        delay = MINUTE;
        await ctx.runMutation(internal.creatorBurnEngine.deferOwner, {
          layerId: layer._id,
          owner: pending.beneficiary,
        });
        return;
      }
      await ctx.runMutation(internal.creatorBurnEngine.saveEnvelope, {
        layerId: layer._id,
        key: pending.key,
        transactionHash: prepared.transactionHash,
        signedTransaction: prepared.signedTransaction,
      });
      // Persist first; if sending times out, the next run reconciles this exact hash.
      await signerRequest(
        "/v1/creator-burn/broadcast",
        {
          vaultAddress: program.vaultAddress,
          layerAddress: layer.layerAddress,
          transactionHash: prepared.transactionHash,
          signedTransaction: prepared.signedTransaction,
        },
        60_000,
      );
    } catch (e) {
      diagnostic = redactSignerDiagnostic(
        e instanceof Error ? e.message : String(e),
        400,
      );
      burnBackoff = pending?.stage === "burn";
      if (burnBackoff && pending)
        await ctx.runMutation(internal.creatorBurnEngine.deferOwner, {
          layerId: layer._id,
          owner: pending.beneficiary,
        });
      delay = creatorBurnRetryAt(Date.now(), layer.failures) - Date.now();
    } finally {
      await ctx.runMutation(internal.automatedFeeEngine.releaseKeeperLease, {
        controllerRequestId: identity,
        leaseId,
      });
      await ctx.runMutation(internal.creatorBurnEngine.finish, {
        layerId: layer._id,
        leaseId,
        clear,
        delay,
        diagnostic,
        burnBackoff,
        nextCursor: clear || !pending ? (context.nextCursor ?? "") : undefined,
      });
      if (clear && delay === 0 && !diagnostic && enabled())
        await ctx.scheduler.runAfter(0, internal.creatorBurnEngine.run, {
          layerId: layer._id,
        });
    }
  },
});
export const tick = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    for(const r of await ctx.runQuery(internal.creatorBurnEnrollment.due,{}))
      if(enabled() || (r.deploymentSigned && !r.deploymentSettled))
        await ctx.scheduler.runAfter(0,internal.creatorBurnEnrollment.run,{id:r._id});
    // No provider calls while disabled unless an existing signed hash needs reconciling.
    const rows = [
      ...new Map(
        [
          ...(await ctx.runQuery(internal.creatorBurnEngine.pendingLayers, {})),
          ...(enabled()
            ? await ctx.runQuery(internal.creatorBurnEngine.due, {})
            : []),
        ].map((row) => [row._id, row]),
      ).values(),
    ];
    for (const l of rows)
      if (enabled() || l.pending?.transactionHash) {
        await ctx.scheduler.runAfter(0, internal.creatorBurnEngine.run, {
          layerId: l._id,
        });
        await ctx.scheduler.runAfter(0, internal.creatorBurnEngine.scan, {
          layerId: l._id,
        });
      }
  },
});
export const layerById = internalQuery({
  args: { layerId: v.id("creatorBurnLayers") },
  handler: async (ctx, a) => ctx.db.get(a.layerId),
});
export const saveHistoryCursor = internalMutation({
  args: {
    layerId: v.id("creatorBurnLayers"),
    previous: v.optional(v.string()),
    next: v.string(),
  },
  handler: async (ctx, a) => {
    const l = await ctx.db.get(a.layerId);
    if (l && l.historyNextBlock === a.previous)
      await ctx.db.patch(l._id, { historyNextBlock: a.next });
  },
});
export const scan = internalAction({
  args: { layerId: v.id("creatorBurnLayers") },
  handler: async (ctx, a): Promise<void> => {
    const layer = await ctx.runQuery(internal.creatorBurnEngine.layerById, a);
    if (!layer) return;
    const program = await ctx.runQuery(
      internal.automatedFeeEngine.enrollmentProgramStatus,
      { programId: layer.programId },
    );
    if (!program) return;
    const result = await signerRequest<{
      receipts: Array<Receipt & { transactionHash: string }>;
      nextBlock: string;
      complete: boolean;
    }>(
      "/v1/creator-burn/history",
      {
        vaultAddress: program.vaultAddress,
        layerAddress: layer.layerAddress,
        fromBlock: layer.historyNextBlock,
      },
      120000,
    );
    for (const receipt of result.receipts)
      await ctx.runMutation(internal.creatorBurnEngine.ingest, {
        programId: program._id,
        layerAddress: layer.layerAddress,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber!,
        events: receipt.events ?? [],
      });
    await ctx.runMutation(internal.creatorBurnEngine.saveHistoryCursor, {
      layerId: layer._id,
      previous: layer.historyNextBlock,
      next: result.nextBlock,
    });
    if (!result.complete)
      await ctx.scheduler.runAfter(MINUTE, internal.creatorBurnEngine.scan, a);
  },
});
export const deferOwner = internalMutation({
  args: { layerId: v.id("creatorBurnLayers"), owner: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db
      .query("creatorBurnOwners")
      .withIndex("by_identity", (q) =>
        q.eq("layerId", a.layerId).eq("ownerAddress", a.owner.toLowerCase()),
      )
      .unique();
    if (row)
      await ctx.db.patch(row._id, { burnRetryAt: Date.now() + 15 * MINUTE });
  },
});
export const saveReplacement = internalMutation({
  args: {
    layerId: v.id("creatorBurnLayers"),
    expectedHash: v.string(),
    transactionHash: v.string(),
    signedTransaction: v.string(),
  },
  handler: async (ctx, a) => {
    const l = await ctx.db.get(a.layerId);
    if (!l?.pending || l.pending.transactionHash !== a.expectedHash)
      throw new Error("replacement identity changed");
    const previousHashes = [
      ...new Set([...(l.pending.previousHashes ?? []), a.expectedHash]),
    ];
    await journalEnvelope(ctx, l._id, a.transactionHash, a.signedTransaction);
    await ctx.db.patch(l._id, {
      pending: {
        ...l.pending,
        transactionHash: a.transactionHash,
        signedTransaction: a.signedTransaction,
        previousHashes,
        replacementAt: Date.now(),
      },
    });
  },
});
export const quarantine = internalMutation({
  args: { layerId: v.id("creatorBurnLayers"), reason: v.string() },
  handler: async (ctx, a) => {
    const l = await ctx.db.get(a.layerId);
    if (!l) return;
    await ctx.db.patch(l._id, { manualReview: true, diagnostic: a.reason });
    await ctx.db.patch(l.programId, {
      status: "manual_review",
      processingDiagnosticCode: "CREATOR_LAYER_NONCE_RECONCILIATION",
      processingDiagnosticDetail: a.reason,
    });
  },
});

/** Called only by an authenticated command adapter. Identity is the immutable
 * X user ID of the linked wallet, never a username supplied in command text. */
export const changePercentage = internalAction({
  args: {
    requestId: v.string(),
    ownerXUserId: v.string(),
    tokenAddress: v.string(),
    percentage: v.string(),
  },
  handler: async (
    ctx,
    a,
  ): Promise<{
    status: "confirmed" | "pending";
    requestId: string;
    transactionHash?: string;
    bps: number;
  }> => {
    if (!enabled()) throw new Error("CREATOR_BURN_DISABLED");
    const bps = creatorBurnPercentageBps(a.percentage);
    const program = await ctx.runQuery(
      internal.automatedFeeEngine.programByToken,
      { tokenAddress: a.tokenAddress },
    );
    if (!program?.creatorBurnLayerAddress || program.status !== "enrolled")
      throw new Error("CREATOR_BURN_ACTIVE_LAYER_REQUIRED");
    const walletId = await ctx.runQuery(
      internal.automatedFeeEngine.controllerRecoveryWallet,
      {
        ownerXUserId: a.ownerXUserId,
        expectedAddress: program.controllerAddress,
      },
    );
    if (!walletId)
      throw new Error("Only the current fee owner can change this percentage.");
    const leaseToken = crypto.randomUUID();
    if (
      !(await ctx.runMutation(internal.wallets.acquireWalletExecutionLock, {
        walletId,
        requestId: a.requestId,
        leaseToken,
      }))
    )
      throw new Error("Wallet is processing another transaction.");
    try {
      const result = await ctx.runAction(
        internal.automatedFeeEngine.executeVerifiedControllerChange,
        {
          requestId: a.requestId,
          programId: program._id,
          ownerXUserId: a.ownerXUserId,
          walletRef: program.controllerAddress,
          expectedAddress: program.controllerAddress,
          operation: "reassign",
          recipient: program.controllerAddress,
          selfBurnBps: bps,
        },
      );
      return {
        status: "confirmed",
        requestId: a.requestId,
        transactionHash: result.transactionHash,
        bps,
      };
    } catch (error) {
      if (isAutomatedFeeWorkflowContinuation(error))
        return { status: "pending", requestId: a.requestId, bps };
      throw error;
    } finally {
      await ctx.runMutation(internal.wallets.releaseWalletExecutionLock, {
        walletId,
        requestId: a.requestId,
        leaseToken,
      });
    }
  },
});
