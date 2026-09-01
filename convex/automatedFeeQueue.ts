import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { automatedFeeEngineConfiguration, automatedFeeProcessingAllowed, type AutomatedFeeEngineEnvironment } from "../lib/automated-fee-policy";
import { FEE_WORKERS, FEE_WORK_LEASE_MS, nextFeeCheck } from "../lib/automated-fee-scheduling";

const enabled = () => automatedFeeProcessingAllowed(automatedFeeEngineConfiguration(process.env as AutomatedFeeEngineEnvironment));
const activeStatuses = ["reserved", "submitted", "uncertain", "deferred"] as const;

export async function activeFeeRun(ctx: Pick<MutationCtx, "db">, programId: Id<"automatedFeePrograms">) {
  const rows = await Promise.all(activeStatuses.map(status => ctx.db.query("automatedFeeRuns")
    .withIndex("by_program_status", q => q.eq("programId", programId).eq("status", status)).first()));
  return rows.find(Boolean) ?? null;
}

// Only used to avoid repeatedly calling the signer while the keeper is busy.
// acquireKeeperLease remains the authoritative transaction/nonce safety gate.
async function keeperBusy(ctx: MutationCtx, runId: Id<"automatedFeeRuns"> | undefined, now: number) {
  const state = await ctx.db.query("automatedFeeEngineState").withIndex("by_key", q => q.eq("key", "ponsbot-automated-buyback-burn-v1")).unique();
  if ((state?.keeperLeaseUntil ?? 0) > now) return true;
  for (const status of [...activeStatuses, "manual_review"] as const) {
    const rows = await ctx.db.query("automatedFeeRuns").withIndex("by_status_next_retry", q => q.eq("status", status))
      .filter(q => q.or(
        q.and(q.neq(q.field("sweepTransactionHash"), undefined), q.eq(q.field("sweepBlockNumber"), undefined)),
        q.and(q.neq(q.field("processingTransactionHash"), undefined), q.eq(q.field("processingBlockNumber"), undefined)),
        q.and(q.neq(q.field("deliveryTransactionHash"), undefined), q.eq(q.field("deliveryBlockNumber"), undefined)),
      )).take(101);
    if (rows.length > 100 || rows.some(row => row._id !== runId && !/REVERTED$/.test(row.diagnosticCode ?? ""))) return true;
  }
  for (const status of ["prepared", "broadcast", "failed", "manual_review"] as const) {
    const row = await ctx.db.query("automatedFeeControllerChanges").withIndex("by_status_updated", q => q.eq("status", status))
      .filter(q => q.and(q.neq(q.field("transactionHash"), undefined), q.eq(q.field("transactionSettledAt"), undefined))).take(101);
    if (row.length > 100 || row.some(r => /:(?:controller-sweep|former-beneficiary-delivery)$/.test(r.requestId))) return true;
  }
  return false;
}

async function claim(ctx: MutationCtx, p: Doc<"automatedFeePrograms">, leaseId: string, now: number) {
  if (p.status !== "enrolled" || (p.workState === "running" && (p.workLeaseUntil ?? 0) > now)) return null;
  const run = await activeFeeRun(ctx, p._id);
  if (!run && p.workRunId) {
    // A crash after finalization but before finishWork must not start another
    // economic cycle outside this token's scheduled slot.
    await ctx.db.patch(p._id, { workState: "idle", workDueAt: undefined, workRunId: undefined,
      workLeaseId: undefined, workLeaseUntil: undefined, nextProcessAt: nextFeeCheck(p, now), updatedAt: now });
    return null;
  }
  if ((run?.leaseUntil ?? 0) > now || (run?.nextRetryAt ?? 0) > now) return null;
  if (run?.workflowStage === "waiting_keeper" && await keeperBusy(ctx, run._id, now)) return null;
  const firstCheck = !run && p.workState !== "waiting";
  await ctx.db.patch(p._id, {
    workState: "running", workLeaseId: leaseId, workLeaseUntil: now + FEE_WORK_LEASE_MS,
    workGeneration: (p.workGeneration ?? 0) + 1,
    workDueAt: undefined, workRunId: run?._id,
    scheduleAnchorAt: p.scheduleAnchorAt ?? p.enrolledAt ?? p.createdAt ?? now,
    ...(firstCheck ? { nextProcessAt: nextFeeCheck(p, now), lastCheckLatenessMs: Math.max(0, now - (p.nextProcessAt ?? now)) } : {}),
    updatedAt: now,
  });
  return { programId: p._id, runId: run?._id, workLeaseId: leaseId };
}

export const beginWork = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), workLeaseId: v.string(), dispatched: v.boolean() },
  handler: async (ctx, args) => {
    if (!enabled()) return null;
    const p = await ctx.db.get(args.programId), now = Date.now();
    if (!p || p.status !== "enrolled") return null;
    if (args.dispatched) return p.workState === "running" && p.workLeaseId === args.workLeaseId && (p.workLeaseUntil ?? 0) > now
      ? { programId: p._id, runId: p.workRunId, workLeaseId: args.workLeaseId } : null;
    const workers = await ctx.db.query("automatedFeePrograms").withIndex("by_work_lease", q => q.eq("workState", "running").gt("workLeaseUntil", now)).take(FEE_WORKERS);
    if (workers.length >= FEE_WORKERS || (p.workDueAt ?? 0) > now) return null;
    if (p.workState === "idle" && (p.nextProcessAt ?? 0) > now) return null;
    return claim(ctx, p, args.workLeaseId, now);
  },
});

/** Claim before scheduling. Four workers drain all batches, not 20 per tick. */
export const dispatch = internalMutation({
  args: {},
  handler: async ctx => {
    if (!enabled()) return { dispatched: 0 };
    const now = Date.now();
    const engine = await ctx.db.query("automatedFeeEngineState").withIndex("by_key", q => q.eq("key", "ponsbot-automated-buyback-burn-v1")).unique();
    const heartbeat = { lastStartedAt: now, lastCompletedAt: now, lastStatus: "completed" as const, updatedAt: now };
    if (engine) await ctx.db.patch(engine._id, heartbeat);
    else await ctx.db.insert("automatedFeeEngineState", { key: "ponsbot-automated-buyback-burn-v1", ...heartbeat });
    // Backward-compatible recovery for pre-queue runs and lost continuations.
    // Never create a replacement run or sign a replacement transaction here.
    for (const status of activeStatuses) {
      const runs = await ctx.db.query("automatedFeeRuns").withIndex("by_status_recovery", q => q.eq("status", status)).take(20);
      for (const run of runs) {
        await ctx.db.patch(run._id, { recoveryCheckedAt: now });
        if ((run.leaseUntil ?? 0) > now || (run.nextRetryAt ?? 0) > now) continue;
        const p = await ctx.db.get(run.programId);
        if (!p || p.status !== "enrolled" || p.workState === "running" || p.workState === "waiting") continue;
        await ctx.db.patch(p._id, { workState: "waiting", workRunId: run._id,
          workDueAt: run.nextRetryAt ?? Math.max(now, run.updatedAt + 60_000), processingDiagnosticCode: "CONTINUATION_RECOVERED" });
      }
    }
    const expired = await ctx.db.query("automatedFeePrograms").withIndex("by_work_lease", q => q.eq("workState", "running").lte("workLeaseUntil", now)).take(20);
    for (const p of expired) await ctx.db.patch(p._id, { workState: "waiting", workDueAt: now,
      workLeaseId: undefined, workLeaseUntil: undefined, processingDiagnosticCode: "WORKER_LEASE_RECOVERED" });
    const workers = await ctx.db.query("automatedFeePrograms").withIndex("by_work_lease", q => q.eq("workState", "running").gt("workLeaseUntil", now)).take(FEE_WORKERS);
    let capacity = FEE_WORKERS - workers.length;
    if (capacity <= 0) return { dispatched: 0 };
    const waiting = await ctx.db.query("automatedFeePrograms").withIndex("by_work_due", q => q.eq("workState", "waiting").lte("workDueAt", now)).take(20);
    const due = await ctx.db.query("automatedFeePrograms").withIndex("by_status_next_process", q => q.eq("status", "enrolled").lte("nextProcessAt", now))
      .filter(q => q.or(q.eq(q.field("workState"), "idle"), q.eq(q.field("workState"), undefined))).take(20);
    let dispatched = 0;
    for (const p of [...waiting, ...due]) {
      if (!capacity) break;
      const previousWorkRunId = p.workRunId;
      // Mutation-safe fencing: a persisted generation, not nondeterministic Web Crypto.
      const claimed = await claim(ctx, p, `fee-work:${p._id}:${(p.workGeneration ?? 0) + 1}`, now);
      if (!claimed) {
        // Rotate blocked entries so >20 waiting tokens cannot starve their receipt owner.
        const current = await ctx.db.get(p._id);
        if (current?.workState === "idle" && previousWorkRunId && !current.workRunId) continue;
        if (p.status === "enrolled") await ctx.db.patch(p._id, { workState: "waiting", workDueAt: now + 60_000 });
        else await ctx.db.patch(p._id, { workState: "idle", workDueAt: undefined });
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.automatedFeeEngine.processProgram, claimed);
      dispatched++; capacity--;
    }
    if (!dispatched && (waiting.length === 20 || due.length === 20)) await ctx.scheduler.runAfter(0, internal.automatedFeeQueue.dispatch, {});
    return { dispatched };
  },
});

export const queueRun = internalMutation({
  args: { runId: v.id("automatedFeeRuns"), leaseId: v.string(), delayMs: v.number(), waitingKeeper: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.leaseId !== args.leaseId || !activeStatuses.includes(run.status as typeof activeStatuses[number])) return false;
    const now = Date.now(), due = now + Math.max(0, args.delayMs);
    await ctx.db.patch(run._id, { leaseId: undefined, leaseUntil: undefined, nextRetryAt: due,
      ...(args.waitingKeeper ? { workflowStage: "waiting_keeper", keeperQueuedAt: run.keeperQueuedAt ?? now } : {}), updatedAt: now });
    const p = await ctx.db.get(run.programId);
    if (!p) return false;
    const receiptPending = ["sweep", "processing", "delivery"].some(stage => {
      const key = stage as "sweep" | "processing" | "delivery";
      return run[`${key}BroadcastAt`] && !run[`${key}BlockNumber`];
    });
    await ctx.db.patch(p._id, { workRunId: run._id, workDueAt: due,
      processingDiagnosticCode: args.waitingKeeper ? "WAITING_KEEPER" : receiptPending ? "WAITING_RECEIPT" : "CONTINUATION_READY", updatedAt: now });
    // Receipt delays stay 30/60 seconds. Scheduler loss is recovered by the minute cron.
    if (!args.waitingKeeper) await ctx.scheduler.runAfter(Math.max(0, args.delayMs), internal.automatedFeeQueue.dispatch, {});
    return true;
  },
});

export const finishWork = internalMutation({
  args: { programId: v.id("automatedFeePrograms"), workLeaseId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.programId);
    if (!p || p.workLeaseId !== args.workLeaseId) return;
    const run = await activeFeeRun(ctx, p._id), now = Date.now();
    const pending = p.status === "enrolled" && (run !== null || p.workDueAt !== undefined);
    await ctx.db.patch(p._id, { workState: pending ? "waiting" : "idle", workLeaseId: undefined, workLeaseUntil: undefined,
      workDueAt: pending ? p.workDueAt ?? run?.nextRetryAt ?? now + 60_000 : undefined,
      workRunId: run?._id, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.automatedFeeQueue.dispatch, {});
  },
});

export const status = internalQuery({
  args: {},
  handler: async ctx => {
    const now = Date.now();
    const programs = await ctx.db.query("automatedFeePrograms").withIndex("by_status_next_process", q => q.eq("status", "enrolled")).take(501);
    return { capped: programs.length > 500, workerLimit: FEE_WORKERS, programs: programs.slice(0, 500).map(p => ({
      token: p.tokenAddress, state: p.workState ?? "not_checked", nextCheckAt: p.nextProcessAt,
      nextAttemptAt: p.workDueAt, lastCheckedAt: p.lastCheckedAt, lastPaidAt: p.lastPaidAt,
      lastCheckLatenessMs: p.lastCheckLatenessMs, availableCreatorFeesEthWei: p.availableCreatorFeesEthWei,
      thresholdWei: p.accumulationThresholdWei, reason: p.processingDiagnosticCode,
      overdueMs: Math.max(0, now - (p.workDueAt ?? p.nextProcessAt ?? now)),
    })) };
  },
});

export const pausedReceiptCandidates = internalMutation({
  args: {},
  handler: async ctx => {
    if (enabled()) return [];
    const result: Array<{ runId: Id<"automatedFeeRuns">; vaultAddress: string; transactionHash: string;
      stage: "sweep" | "processing" | "delivery"; transactionNonce?: number; broadcastAt?: number }> = [];
    for (const status of activeStatuses) {
      const runs = await ctx.db.query("automatedFeeRuns").withIndex("by_status_recovery", q => q.eq("status", status)).take(5);
      for (const r of runs) {
        await ctx.db.patch(r._id, { recoveryCheckedAt: Date.now() });
        const stage = r.sweepTransactionHash && !r.sweepBlockNumber ? "sweep"
          : r.processingTransactionHash && !r.processingBlockNumber ? "processing"
            : r.deliveryTransactionHash && !r.deliveryBlockNumber ? "delivery" : null;
        if (stage) result.push({ runId: r._id, vaultAddress: r.vaultAddress, stage,
          transactionHash: r[`${stage}TransactionHash`]!, transactionNonce: r[`${stage}TransactionNonce`], broadcastAt: r[`${stage}BroadcastAt`] });
      }
    }
    return result;
  },
});

export const recordPausedReceipt = internalMutation({
  args: { runId: v.id("automatedFeeRuns"), observation: v.string() },
  handler: async (ctx, args) => {
    const r = await ctx.db.get(args.runId);
    if (!r) return;
    // Observation only: re-enabled execution revalidates the receipt before
    // advancing stages or updating financial totals. No transaction is queued.
    await ctx.db.patch(r._id, { pausedReceiptObservation: args.observation.slice(0, 120), pausedReceiptObservedAt: Date.now() });
  },
});
