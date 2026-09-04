import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { FEE_CHECK_INTERVAL_MS } from "../lib/automated-fee-scheduling";
import * as engine from "../convex/automatedFeeEngine";
import * as feeQueue from "../convex/automatedFeeQueue";
import * as wallets from "../convex/wallets";
import * as xReplies from "../convex/xReplies";
import * as xFloodProtection from "../convex/xFloodProtection";
import * as liquidity from "../convex/liquidity";
import { existingFeeUpgradeState } from "../lib/fee-upgrade-command";
import { automatedFeeControllerBroadcastRequestSchema, automatedFeeControllerTransactionRequestSchema } from "../lib/wallet-signer/policy";
import { automatedFeeExecutionFields, automatedFeePreparedFields } from "../lib/automated-fee-policy";
import { automatedFeeOutcomeMessage } from "../convex/automatedFeeOutcomes";
import { canUseGraduatedEscrow, feeSweepPrerequisiteSatisfied, isGraduatedSweepPreflightFailure } from "../lib/automated-fee-sweep-policy";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const handler = (f: any) => f._handler;
function database() {
  const rows: Record<string, any[]> = {};
  const db = {
    query(table: string) {
      const tests: Array<(r: any) => boolean> = [];
      const b: any = {};
      for (const [op, predicate] of Object.entries({ eq: (a: any,b: any) => a === b, gt: (a: any,b: any) => a > b, gte: (a: any,b: any) => a >= b, lte: (a: any,b: any) => a === undefined || a <= b }))
        b[op] = (key: string, value: any) => { tests.push(r => predicate(r[key], value)); return b; };
      let index: string[] = [];
      const result = () => (rows[table] ?? []).filter(r => tests.every(p => p(r))).sort((x, y) => {
        for (const key of index) { if (x[key] !== y[key]) return (x[key] ?? 0) < (y[key] ?? 0) ? -1 : 1; }
        return 0;
      });
      const q: any = {
        withIndex(name: string, cb: any) { cb(b); index = ({ by_status_updated: ["updatedAt"], by_work_due: ["workDueAt"], by_status_next_process: ["nextProcessAt"], by_status_next_retry: ["nextRetryAt"] } as any)[name] ?? []; return q; },
        filter(cb: any) {
          const expr = { field: (k: string) => (r: any) => r[k], eq: (f: any,v: any) => (r: any) => f(r) === v, neq: (f: any,v: any) => (r: any) => f(r) !== v,
            and: (...ps: any[]) => (r: any) => ps.every(p => p(r)), or: (...ps: any[]) => (r: any) => ps.some(p => p(r)) };
          tests.push(cb(expr)); return q;
        },
        unique: async () => { const r = result(); if (r.length > 1) throw new Error("not unique"); return r[0] ?? null; },
        first: async () => result()[0] ?? null, take: async (n: number) => result().slice(0,n), collect: async () => result(),
      };
      return q;
    },
    get: async (id: string) => Object.values(rows).flat().find(r => r._id === id) ?? null,
    insert: async (table: string, data: any) => { const _id = `${table}-${rows[table]?.length ?? 0}`; (rows[table] ??= []).push({ _id, ...data }); return _id; },
    patch: async (id: string, data: any) => { const r = Object.values(rows).flat().find(r => r._id === id); if (!r) throw new Error("missing row"); Object.assign(r,data); },
    delete: async (id: string) => { for (const table of Object.keys(rows)) rows[table] = rows[table].filter(r => r._id !== id); },
  };
  const scheduled: { name: string; args: any }[] = [];
  const invoke = async (ref: any, args: any) => {
    const [module, name] = getFunctionName(ref).split(":");
    return handler((module === "wallets" ? wallets : module === "liquidity" ? liquidity : module === "xFloodProtection" ? xFloodProtection : module === "xReplies" ? xReplies : module === "automatedFeeQueue" ? feeQueue : engine as any)[name])(ctx, args);
  };
  const ctx: any = { db, rows, scheduled, runQuery: invoke, runMutation: invoke, runAction: invoke,
    scheduler: { runAfter: vi.fn(async (_delay: number, ref: any, args: any) => { scheduled.push({ name: getFunctionName(ref), args }); }) } };
  return ctx;
}
beforeEach(() => {
  ["VAULT_FACTORY", "VAULT_IMPLEMENTATION", "EXECUTION_ADAPTER", "NATIVE_BUYBACK_EXECUTOR", "PAIRED_BUYBACK_EXECUTOR", "ADMIN", "KEEPER", "QUOTE_AUTHORIZER", "PAUSE_GUARDIAN", "CONTROL", "V3_ROUTER", "V3_QUOTER", "WETH"]
    .forEach((key, i) => vi.stubEnv(`AUTOMATED_FEE_${key}_ADDRESS`, a(i + 1)));
  for (const role of ["QUOTE", "KEEPER", "ADMIN"]) vi.stubEnv(`AUTOMATED_FEE_${role}_CDP_ACCOUNT_NAME`, `test-${role}`);
  vi.stubEnv("AUTOMATED_FEE_ENROLLMENT_SECRET", "unit-test-only");
  vi.stubEnv("WALLET_SIGNER_URL", "https://signer.test"); vi.stubEnv("WALLET_SIGNER_TOKEN", "unit-test-only");
  vi.stubEnv("AUTOMATED_BUYBACK_BURN_ENABLED", "true"); vi.stubEnv("AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.ponsbot.family");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network request"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function fixture() {
  const ctx = database();
  ctx.rows.automatedFeePrograms = [{ _id: "p", status: "enrolled", launchId: "l", tokenAddress: a(20), normalizedTokenAddress: a(20),
    vaultAddress: a(21), normalizedVaultAddress: a(21), controllerAddress: a(1), normalizedControllerAddress: a(1),
    beneficiaryAddress: a(1), normalizedBeneficiaryAddress: a(1), pairTokenAddress: a(0), normalizedPairTokenAddress: a(0), distributionMode: "wallet" }];
  ctx.rows.tokenLaunches = [{ _id: "l", requestId: "launch", tokenAddress: a(20), normalizedTokenAddress: a(20), symbol: "TEST", transactionHash: h(90) }];
  ctx.rows.walletRequests = [{ _id: "w", requestId: "root", status: "accepted" }];
  return ctx;
}

describe("economic fee queue", () => {
  it("retroactively accelerates a recent launch and reserves only one worker", async () => {
    const ctx = fixture(), p = ctx.rows.automatedFeePrograms[0], now = Date.now();
    const createdAt = now - 35 * 60_000;
    Object.assign(ctx.rows.tokenLaunches[0], { publicPublished: true, createdAt });
    Object.assign(p, { enrolledAt: createdAt, workState: "idle", lastCheckedAt: now - 20 * 60_000, nextProcessAt: now + 25 * 60_000 });
    expect(await handler(feeQueue.dispatch)(ctx, {})).toMatchObject({ dispatched: 1 });
    expect(p.launchCreatedAt).toBe(createdAt);
    expect(p.nextProcessAt).toBe(createdAt + 40 * 60_000);
    expect(await handler(feeQueue.dispatch)(ctx, {})).toMatchObject({ dispatched: 0 });
    expect(ctx.scheduled.filter((s: any) => s.name === "automatedFeeEngine:processProgram")).toHaveLength(1);
  });
  it.each(["paused", "manual_review", "exited"])("does not restart a recent %s program", async status => {
    const ctx = fixture(), p = ctx.rows.automatedFeePrograms[0], now = Date.now();
    Object.assign(ctx.rows.tokenLaunches[0], { publicPublished: true, createdAt: now - 30 * 60_000 });
    Object.assign(p, { status, nextProcessAt: now + 60 * 60_000 });
    expect(await handler(feeQueue.dispatch)(ctx, {})).toMatchObject({ dispatched: 0 });
    expect(p.nextProcessAt).toBe(now + 60 * 60_000);
  });
  const threshold = "7000000000000000";
  function inspect(value = threshold) {
    return { blockNumber: "100", token: a(20), pairAsset: a(0), controller: a(1), beneficiary: a(1),
      creatorFeeRecipient: a(21), active: true, paused: false, phase: 2, executionNonce: "0", escrowBalance: value,
      lastCurveSweepBlock: "0", availableCreatorFeesEthWei: value, availableCreatorFees: value, escrowCreatorFeesEthWei: value };
  }
  it("does not sweep, sign, quote or create a run below threshold", async () => {
    const ctx = fixture(), p = ctx.rows.automatedFeePrograms[0];
    Object.assign(p, { enrolledAt: Date.now() - 16 * 60_000, nextProcessAt: Date.now() - 60_000 });
    vi.stubGlobal("fetch", vi.fn(async url => {
      expect(String(url)).toContain("/inspect");
      return new Response(JSON.stringify(inspect("6999999999999999")));
    }));
    expect(await handler(engine.processProgram)(ctx, { programId: "p" })).toMatchObject({ status: "accumulating" });
    expect(p).toMatchObject({ workState: "idle", processingDiagnosticCode: "ACCUMULATING", accumulationThresholdWei: threshold });
    expect(p.nextProcessAt).toBe(p.enrolledAt + FEE_CHECK_INTERVAL_MS);
    expect(ctx.rows.automatedFeeRuns ?? []).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("fails closed if an older signer has no accumulation fields", async () => {
    const ctx = fixture();
    const data: any = inspect(); delete data.availableCreatorFeesEthWei;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(data))));
    await handler(engine.processProgram)(ctx, { programId: "p" });
    expect(ctx.rows.automatedFeePrograms[0]).toMatchObject({ workState: "waiting", processingDiagnosticCode: "AUTOMATED_FEE_ACCUMULATION_INSPECTION_UNAVAILABLE" });
    expect(ctx.rows.automatedFeeRuns ?? []).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("claims at most four concurrent workers and drains 48 tokens without another cron tick", async () => {
    const ctx = fixture(), template = ctx.rows.automatedFeePrograms[0], now = Date.now();
    ctx.rows.automatedFeePrograms = Array.from({ length: 48 }, (_, i) => ({ ...template, _id: `p${i}`,
      enrolledAt: now - 16 * 60_000 + i, nextProcessAt: now - 60_000 + i }));
    const seen = new Set<string>();
    for (let batch = 0; batch < 12; batch++) {
      expect(await handler(feeQueue.dispatch)(ctx, {})).toEqual({ dispatched: 4 });
      expect(await handler(feeQueue.dispatch)(ctx, {})).toEqual({ dispatched: 0 });
      const workers = ctx.rows.automatedFeePrograms.filter((p: any) => p.workState === "running");
      expect(workers).toHaveLength(4);
      for (const p of workers) {
        expect(seen.has(p._id)).toBe(false); seen.add(p._id);
        await handler(feeQueue.finishWork)(ctx, { programId: p._id, workLeaseId: p.workLeaseId });
      }
    }
    expect(seen.size).toBe(48);
    expect(await handler(feeQueue.dispatch)(ctx, {})).toEqual({ dispatched: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reclaims an abandoned worker with a different fence and refuses the stale worker", async () => {
    const ctx = fixture(), p = ctx.rows.automatedFeePrograms[0];
    Object.assign(p, { workState: "running", workLeaseId: "old", workLeaseUntil: Date.now() - 1 });
    expect(await handler(feeQueue.dispatch)(ctx, {})).toEqual({ dispatched: 1 });
    const currentLease = p.workLeaseId;
    expect(currentLease).not.toBe("old");
    expect(await handler(feeQueue.beginWork)(ctx, { programId: "p", workLeaseId: "old", dispatched: true })).toBeNull();
    await handler(feeQueue.finishWork)(ctx, { programId: "p", workLeaseId: "old" });
    expect(p.workLeaseId).toBe(currentLease);
  });
  it("recovers a saved transaction without creating another run", async () => {
    const ctx = fixture();
    ctx.rows.automatedFeeRuns = [{ _id: "r", programId: "p", status: "submitted", sweepTransactionHash: h(1),
      sweepSignedTransaction: "0x1234", workflowStage: "sweep_submitted", nextRetryAt: Date.now() - 1 }];
    expect(await handler(feeQueue.dispatch)(ctx, {})).toEqual({ dispatched: 1 });
    expect(ctx.rows.automatedFeePrograms[0].workRunId).toBe("r");
    expect(ctx.rows.automatedFeeRuns).toHaveLength(1);
    expect(ctx.scheduled.find((s: any) => s.name.endsWith(":processProgram"))?.args.runId).toBe("r");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("honors retry eligibility independently of fixed token check time", async () => {
    const ctx = fixture(), now = Date.now(), p = ctx.rows.automatedFeePrograms[0];
    Object.assign(p, { workState: "waiting", workDueAt: now + 180_000, nextProcessAt: now - 1 });
    expect(await handler(feeQueue.dispatch)(ctx, {})).toEqual({ dispatched: 0 });
    expect(await handler(feeQueue.beginWork)(ctx, { programId: "p", workLeaseId: "new", dispatched: false })).toBeNull();
  });
  it("does not reinspect queued tokens while another keeper transaction is pending", async () => {
    const ctx = fixture(), p = ctx.rows.automatedFeePrograms[0], now = Date.now();
    Object.assign(p, { workState: "waiting", workDueAt: now - 1 });
    ctx.rows.automatedFeeRuns = [
      { _id: "wait", programId: "p", status: "reserved", workflowStage: "waiting_keeper", nextRetryAt: now - 1 },
      { _id: "owner", programId: "other", status: "submitted", processingTransactionHash: h(1), nextRetryAt: now - 1 },
    ];
    expect(await handler(feeQueue.dispatch)(ctx, {})).toEqual({ dispatched: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.scheduled.filter((s: any) => s.name.endsWith(":processProgram"))).toHaveLength(0);
  });
  it("does not unlock the keeper for an ambiguously dropped transaction", async () => {
    const ctx = fixture();
    ctx.rows.automatedFeeRuns = [{ _id: "unknown", programId: "other", status: "manual_review",
      processingTransactionHash: h(1), diagnosticCode: "AUTOMATED_FEE_PROCESSING_DROPPED" }];
    expect(await handler(engine.acquireKeeperLease)(ctx, { runId: "new", leaseId: "lease", now: Date.now() })).toBe(false);
  });
  it("does not let stale confirmed callbacks start another cycle", async () => {
    const ctx = fixture(); ctx.rows.automatedFeeRuns = [{ _id: "done", programId: "p", status: "confirmed" }];
    expect(await handler(engine.processProgram)(ctx, { programId: "p", runId: "done" })).toMatchObject({ status: "already_complete" });
    expect(fetch).not.toHaveBeenCalled(); expect(ctx.scheduled).toHaveLength(0);
  });
  it("does not discard a transaction-bearing run as accumulating", async () => {
    const ctx = fixture(); ctx.rows.automatedFeePrograms[0].workLeaseId = "lease";
    ctx.rows.automatedFeeRuns = [{ _id: "r", programId: "p", status: "submitted", processingTransactionHash: h(1) }];
    await expect(handler(engine.recordFeeAssessment)(ctx, { programId: "p", workLeaseId: "lease", runId: "r", valueWei: "0", assetAmount: "0", operatorWait: false })).rejects.toThrow();
    expect(ctx.rows.automatedFeeRuns[0].status).toBe("submitted");
  });
  it("keeps RPC retries off the cadence clock and honors Retry-After", async () => {
    const ctx = fixture(), now = Date.now();
    ctx.rows.automatedFeePrograms[0].nextProcessAt = now + 800_000;
    ctx.rows.automatedFeeRuns = [{ _id: "r", programId: "p", status: "reserved", retryCount: 0 }];
    vi.spyOn(Date, "now").mockReturnValue(now);
    await handler(engine.deferProcessingRun)(ctx, { programId: "p", runId: "r", diagnosticCode: "RPC_429", manualReview: false, retryAfterMs: 200_000 });
    expect(ctx.rows.automatedFeeRuns[0].nextRetryAt).toBe(now + 200_000);
    expect(ctx.rows.automatedFeePrograms[0].nextProcessAt).toBe(now + 800_000);
  });
  it("keeps a disabled queue from starting new work", async () => {
    const ctx = fixture(); vi.stubEnv("AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED", "false");
    expect(await handler(feeQueue.dispatch)(ctx, {})).toEqual({ dispatched: 0 });
    expect(ctx.scheduled).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
  });
  it("checks only existing transaction receipts while disabled", async () => {
    const ctx = fixture(); vi.stubEnv("AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED", "false");
    ctx.rows.automatedFeeRuns = [{ _id: "r", programId: "p", vaultAddress: a(21), status: "submitted",
      processingTransactionHash: h(1), processingSignedTransaction: "0x1234", processingTransactionNonce: 3 }];
    vi.stubGlobal("fetch", vi.fn(async (url: string, request: RequestInit) => {
      expect(url).toContain("/status");
      expect(JSON.parse(String(request.body))).toMatchObject({ transactionHash: h(1), stage: "processing" });
      return new Response(JSON.stringify({ status: "confirmed", blockNumber: "123" }));
    }));
    expect(await handler(engine.runScheduledProcessing)(ctx, {})).toMatchObject({ status: "disabled" });
    expect(ctx.rows.automatedFeeRuns[0]).toMatchObject({ status: "submitted", pausedReceiptObservation: "processing:confirmed" });
    expect(ctx.rows.automatedFeeRuns[0].processingBlockNumber).toBeUndefined();
    expect(ctx.scheduled).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not start a new cycle after a crash between finalization and worker release", async () => {
    const ctx = fixture(), p = ctx.rows.automatedFeePrograms[0];
    Object.assign(p, { workState: "waiting", workRunId: "done", workDueAt: Date.now() - 1, enrolledAt: Date.now() - 16 * 60_000 });
    ctx.rows.automatedFeeRuns = [{ _id: "done", programId: "p", status: "confirmed" }];
    expect(await handler(feeQueue.dispatch)(ctx, {})).toEqual({ dispatched: 0 });
    expect(p.workState).toBe("idle"); expect(p.nextProcessAt).toBeGreaterThan(Date.now());
  });
  it("recovers receipt ownership behind more than twenty keeper waiters", async () => {
    const ctx = fixture(), template = ctx.rows.automatedFeePrograms[0], now = Date.now();
    ctx.rows.automatedFeePrograms = Array.from({ length: 26 }, (_, i) => ({ ...template, _id: `p${i}`, workState: "waiting", workDueAt: now - 1 }));
    ctx.rows.automatedFeeRuns = Array.from({ length: 26 }, (_, i) => ({ _id: `r${i}`, programId: `p${i}`,
      status: i === 25 ? "submitted" : "reserved", workflowStage: i === 25 ? "sweep_submitted" : "waiting_keeper", nextRetryAt: now - 1,
      ...(i === 25 ? { sweepTransactionHash: h(1), sweepBroadcastAt: now - 60_000 } : {}) }));
    await handler(feeQueue.dispatch)(ctx, {});
    await handler(feeQueue.dispatch)(ctx, {});
    expect(ctx.scheduled.filter((s: any) => s.name.endsWith(":processProgram")).map((s: any) => s.args.runId)).toContain("r25");
  });
  it("stores processing receipt and fee accounting together", async () => {
    const ctx = fixture();
    ctx.rows.automatedFeeRuns = [{ _id: "r", programId: "p", status: "submitted", transactionHash: h(1), graduatedEscrowReadyBlock: "100" }];
    await handler(engine.reconcileProcessingRun)(ctx, { runId: "r", outcome: "confirmed", workflowStage: "processing_confirmed",
      blockNumber: "101", grossClaimed: "100", beneficiaryAllocated: "95", buybackSpent: "5", ponsbotBurned: "8" });
    expect(ctx.rows.automatedFeeRuns[0]).toMatchObject({ processingBlockNumber: "101", grossClaimed: "100", beneficiaryAllocated: "95" });
  });
  it("finishes delivery accounting after interruption without sending again", async () => {
    const ctx = fixture();
    ctx.rows.automatedFeeRuns = [{ _id: "r", programId: "p", status: "deferred", workflowStage: "retry_deferred",
      graduatedEscrowReadyBlock: "100", processingTransactionHash: h(1), processingBroadcastAt: 1, processingBlockNumber: "101",
      deliveryTransactionHash: h(2), deliveryBroadcastAt: 2, deliveryBlockNumber: "102", beneficiaryDelivered: "95",
      grossClaimed: "100", beneficiaryAllocated: "95", buybackSpent: "5", ponsbotBurned: "8" }];
    vi.stubGlobal("fetch", vi.fn(async url => {
      expect(String(url)).toContain("/inspect"); return new Response(JSON.stringify(inspect("0")));
    }));
    expect(await handler(engine.processProgram)(ctx, { programId: "p", runId: "r" })).toMatchObject({ status: "cycle_confirmed" });
    expect(ctx.rows.automatedFeePrograms[0].lifetimePonsbotBurned).toBe("8");
    expect(ctx.rows.automatedFeeRuns[0].status).toBe("confirmed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains and reuses the exact signed transaction after a lost broadcast response", async () => {
    const ctx = fixture(); let prepares = 0, broadcasts = 0, clock = Date.now();
    const payloads: any[] = []; vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); let result: any;
      if (url.endsWith("/inspect")) result = inspect();
      else if (url.endsWith("/authorize")) result = { maxBuybackAmount: "1", minPonsbotOut: "1", minSweepBuybackTokensOut: "0", deadline: body.deadline, routeTarget: a(5), routeData: "0x", signature: "0x1234" };
      else if (url.endsWith("/prepare")) { prepares++; result = { transactionHash: h(1), signedTransaction: "0xabcd", nonce: 3 }; }
      else if (url.endsWith("/broadcast")) {
        broadcasts++; payloads.push(body);
        if (broadcasts === 1) return new Response(JSON.stringify({ error: "temporarily unavailable" }), { status: 503 });
        result = { status: "broadcast" };
      } else throw new Error("unexpected signer endpoint");
      return new Response(JSON.stringify(result));
    }));
    expect(await handler(engine.processProgram)(ctx, { programId: "p" })).toMatchObject({ status: "failed" });
    const run = ctx.rows.automatedFeeRuns[0];
    expect(run.processingSignedTransaction).toBe("0xabcd"); clock += 31_000;
    expect(await handler(engine.processProgram)(ctx, { programId: "p", runId: run._id })).toMatchObject({ status: "processing_submitted" });
    expect(prepares).toBe(1); expect(broadcasts).toBe(2); expect(payloads[1]).toEqual(payloads[0]);
  });
  it("records gas once per receipt and rejects mismatched transaction hashes", async () => {
    const ctx = fixture(); ctx.rows.automatedFeeRuns = [{ _id: "r", programId: "p", status: "submitted", sweepTransactionHash: h(1) }];
    const args = { runId: "r", stage: "sweep", transactionHash: h(1), gasCostWei: "123" };
    await handler(engine.recordRunGas)(ctx, args); await handler(engine.recordRunGas)(ctx, args);
    expect(ctx.rows.automatedFeeRuns[0].gasReceipts).toHaveLength(1);
    await expect(handler(engine.recordRunGas)(ctx, { ...args, transactionHash: h(2) })).rejects.toThrow();
  });
});

describe("graduated escrow processing and sweep incident recovery", () => {
  const detail = "automated fee signer request failed [/v1/automated-fees/prepare-sweep]: SIMULATION_OR_REVERT: Execution reverted for an unknown reason.";
  function cycleFixture() {
    const ctx = fixture();
    ctx.rows.automatedFeeRuns = [{ _id: "run", programId: "p", status: "reserved", phaseAtReservation: 2,
      tokenAddress: a(20), vaultAddress: a(21), pairTokenAddress: a(0), beneficiaryAddress: a(1),
      idempotencyKey: "cycle", executionNonce: "0", retryCount: 0, leaseId: "lease", leaseUntil: Date.now() + 60_000 }];
    return ctx;
  }
  it("resumes only the exact unsigned processing incident once", async () => {
    const ctx = cycleFixture(), run = ctx.rows.automatedFeeRuns[0];
    Object.assign(run, { status: "manual_review", diagnosticDetail: detail.replace("prepare-sweep", "prepare") });
    ctx.rows.automatedFeePrograms[0].status = "manual_review";
    await expect(handler(engine.resumeUnsignedProcessingPreflight)(ctx, { runId: "run", expectedTokenAddress: a(99) })).rejects.toThrow();
    await handler(engine.resumeUnsignedProcessingPreflight)(ctx, { runId: "run", expectedTokenAddress: a(20) });
    expect(run.status).toBe("deferred");
    expect(ctx.rows.automatedFeePrograms[0].status).toBe("enrolled");
    expect(ctx.scheduled).toHaveLength(1);
    await expect(handler(engine.resumeUnsignedProcessingPreflight)(ctx, { runId: "run", expectedTokenAddress: a(20) })).rejects.toThrow();
  });
  it.each(["sweepTransactionHash", "processingSignedTransaction", "processingTransactionHash", "deliveryTransactionHash"])("processing recovery rejects %s", async field => {
    const ctx = cycleFixture(), run = ctx.rows.automatedFeeRuns[0];
    Object.assign(run, { status: "manual_review", diagnosticDetail: detail.replace("prepare-sweep", "prepare"), [field]: h(1) });
    ctx.rows.automatedFeePrograms[0].status = "manual_review";
    await expect(handler(engine.resumeUnsignedProcessingPreflight)(ctx, { runId: "run", expectedTokenAddress: a(20) })).rejects.toThrow();
    expect(ctx.scheduled).toHaveLength(0);
  });
  it("allows already-escrowed graduated fees, but never skips a curve sweep", () => {
    expect(canUseGraduatedEscrow(2, "10000", {})).toBe(true);
    for (const phase of [0, 1]) expect(canUseGraduatedEscrow(phase, "100000", {})).toBe(false);
    for (const amount of ["0", "9999", "invalid", "-1"]) expect(canUseGraduatedEscrow(2, amount, {})).toBe(false);
    expect(canUseGraduatedEscrow(2, "100000", { sweepSignedTransaction: "0x1234" })).toBe(false);
    expect(canUseGraduatedEscrow(2, "100000", { processingTransactionHash: h(1) })).toBe(false);
    expect(feeSweepPrerequisiteSatisfied({ graduatedEscrowReadyBlock: "10" })).toBe(true);
    expect(feeSweepPrerequisiteSatisfied({ graduatedEscrowReadyBlock: "10", sweepTransactionHash: h(1) })).toBe(false);
  });
  it("records an observation instead of inventing a sweep transaction or receipt", async () => {
    const ctx = cycleFixture(), run = ctx.rows.automatedFeeRuns[0];
    await handler(engine.recordGraduatedEscrowReady)(ctx, { runId: "run", leaseId: "lease", phase: 2, blockNumber: "100", escrowBalance: "100000" });
    expect(run.graduatedEscrowReadyBlock).toBe("100");
    expect(run.sweepBlockNumber).toBeUndefined();
    expect(run.sweepTransactionHash).toBeUndefined();
    await handler(engine.recordRunStageTransaction)(ctx, { runId: "run", leaseId: "lease", stage: "processing", transactionHash: h(1), signedTransaction: "0x1234", transactionNonce: 1 });
    await expect(handler(engine.recordRunStageTransaction)(ctx, { runId: "run", leaseId: "lease", stage: "sweep", transactionHash: h(2), signedTransaction: "0x1234", transactionNonce: 2 })).rejects.toThrow("out of order");
  });
  it("still rejects curve processing without a real sweep receipt", async () => {
    const ctx = cycleFixture(); ctx.rows.automatedFeeRuns[0].phaseAtReservation = 0;
    await expect(handler(engine.recordRunStageTransaction)(ctx, { runId: "run", leaseId: "lease", stage: "processing", transactionHash: h(1), signedTransaction: "0x1234", transactionNonce: 1 })).rejects.toThrow("out of order");
    await expect(handler(engine.recordGraduatedEscrowReady)(ctx, { runId: "run", leaseId: "lease", phase: 0, blockNumber: "100", escrowBalance: "100000" })).rejects.toThrow();
  });
  it.each(["sweepTransactionHash", "sweepSignedTransaction", "processingTransactionHash", "processingSignedTransaction", "deliveryTransactionHash", "deliverySignedTransaction", "transactionHash"])("never recovers or downgrades a run with %s", async field => {
    const ctx = cycleFixture(), run = ctx.rows.automatedFeeRuns[0];
    Object.assign(run, { status: "manual_review", diagnosticDetail: detail, [field]: h(1) });
    ctx.rows.automatedFeePrograms[0].status = "manual_review";
    expect(isGraduatedSweepPreflightFailure(2, detail, run)).toBe(false);
    await expect(handler(engine.resumeGraduatedSweepPreflight)(ctx, { runId: "run", expectedTokenAddress: a(20) })).rejects.toThrow();
    expect(ctx.scheduled).toHaveLength(0);
  });
  it("recovers only the requested unsigned preflight incident once", async () => {
    const ctx = cycleFixture(), run = ctx.rows.automatedFeeRuns[0];
    Object.assign(run, { status: "manual_review", diagnosticDetail: detail });
    ctx.rows.automatedFeePrograms[0].status = "manual_review";
    await expect(handler(engine.resumeGraduatedSweepPreflight)(ctx, { runId: "run", expectedTokenAddress: a(99) })).rejects.toThrow();
    await handler(engine.resumeGraduatedSweepPreflight)(ctx, { runId: "run", expectedTokenAddress: a(20) });
    expect(run.status).toBe("deferred");
    expect(ctx.rows.automatedFeePrograms[0].status).toBe("enrolled");
    expect(ctx.scheduled).toHaveLength(1);
    await expect(handler(engine.resumeGraduatedSweepPreflight)(ctx, { runId: "run", expectedTokenAddress: a(20) })).rejects.toThrow();
  });
  it("does not recover across an outstanding controller change", async () => {
    const ctx = cycleFixture(); Object.assign(ctx.rows.automatedFeeRuns[0], { status: "manual_review", diagnosticDetail: detail });
    ctx.rows.automatedFeePrograms[0].status = "manual_review";
    ctx.rows.automatedFeeControllerChanges = [{ _id: "c", programId: "p", status: "prepared" }];
    await expect(handler(engine.resumeGraduatedSweepPreflight)(ctx, { runId: "run", expectedTokenAddress: a(20) })).rejects.toThrow("another fee workflow");
  });
  it.each(["INVALID_SIGNER_REQUEST", "AUTHORIZATION_FAILED", "AUTOMATED_FEE_ENROLLMENT_STATE_MISMATCH"])("keeps unrelated %s failures out of preflight recovery", code => {
    expect(isGraduatedSweepPreflightFailure(2, `[/v1/automated-fees/prepare-sweep]: ${code}`, {})).toBe(false);
  });
  it("defers a graduated simulation failure without permanently stopping the program", async () => {
    const ctx = cycleFixture();
    await handler(engine.deferGraduatedSweepPreflight)(ctx, { runId: "run", leaseId: "lease", phase: 2, diagnosticDetail: detail });
    expect(ctx.rows.automatedFeePrograms[0].status).toBe("enrolled");
    expect(ctx.rows.automatedFeeRuns[0]).toMatchObject({ status: "deferred", workflowStage: "graduated_sweep_preflight_wait" });
    expect(ctx.scheduler.runAfter.mock.calls[0][0]).toBe(300_000);
  });
  it("processes, confirms and delivers escrow without sweeping, including zero escrow after processing", async () => {
    const ctx = cycleFixture(), run = ctx.rows.automatedFeeRuns[0];
    run.leaseUntil = 0;
    const paths: string[] = []; let processed = false, nonce = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname, body = JSON.parse(String(init.body)); paths.push(path);
      let result: any;
      if (path.endsWith("/inspect")) result = { blockNumber: "100", token: a(20), pairAsset: a(0), controller: a(1), beneficiary: a(1),
        creatorFeeRecipient: a(21), active: true, paused: false, phase: 2, executionNonce: "0", escrowBalance: processed ? "0" : "100000", lastCurveSweepBlock: "0",
        availableCreatorFeesEthWei: "10000000000000000", availableCreatorFees: "100000", escrowCreatorFeesEthWei: "10000000000000000" };
      else if (path.endsWith("/authorize")) result = { maxBuybackAmount: "5000", minPonsbotOut: "1", minSweepBuybackTokensOut: "0", deadline: body.deadline, routeTarget: a(5), routeData: "0x", signature: "0x1234" };
      else if (path.endsWith("/prepare") || path.endsWith("/prepare-delivery")) result = { transactionHash: h(++nonce), signedTransaction: "0x1234", nonce };
      else if (path.endsWith("/broadcast") || path.endsWith("/broadcast-delivery")) result = { status: "broadcast" };
      else if (path.endsWith("/status")) {
        if (body.stage === "processing") { processed = true; result = { status: "confirmed", blockNumber: "101", grossClaimed: "100000", beneficiaryAllocated: "95000", buybackSpent: "5000", ponsbotBurned: "300" }; }
        else result = { status: "confirmed", blockNumber: "102", amount: "95000" };
      } else throw new Error("unexpected endpoint: " + path);
      return new Response(JSON.stringify(result));
    }));
    let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
    for (let i = 0; i < 4; i++) { await handler(engine.processProgram)(ctx, { programId: "p", runId: "run" }); clock += 31_000; }
    expect(run).toMatchObject({ status: "confirmed", workflowStage: "cycle_confirmed", grossClaimed: "100000", beneficiaryDelivered: "95000", ponsbotBurned: "300" });
    expect(paths.some(path => path.includes("sweep"))).toBe(false);
    expect(nonce).toBe(2);
    expect(ctx.rows.automatedFeePrograms[0].lifetimePonsbotBurned).toBe("300");
    const requests = paths.length, scheduled = ctx.scheduled.length;
    expect(await handler(engine.processProgram)(ctx, { programId: "p", runId: "run" })).toMatchObject({ status: "already_complete" });
    expect(paths).toHaveLength(requests);
    expect(ctx.scheduled).toHaveLength(scheduled);
  });
  it("routes an empty-escrow operator preflight failure into a scheduled retry", async () => {
    const ctx = cycleFixture();
    ctx.rows.automatedFeeRuns[0].leaseUntil = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/inspect")) return new Response(JSON.stringify({ blockNumber: "100", token: a(20), pairAsset: a(0), controller: a(1), beneficiary: a(1),
        creatorFeeRecipient: a(21), active: true, paused: false, phase: 2, executionNonce: "0", escrowBalance: "0", lastCurveSweepBlock: "0",
        availableCreatorFeesEthWei: "10000000000000000", availableCreatorFees: "10000000000000000", escrowCreatorFeesEthWei: "0" }));
      if (url.endsWith("/prepare-sweep")) return new Response(JSON.stringify({ diagnosticCode: "SIMULATION_OR_REVERT", diagnosticDetail: "Execution reverted" }), { status: 400 });
      throw new Error("unexpected request");
    }));
    expect(await handler(engine.processProgram)(ctx, { programId: "p", runId: "run" })).toMatchObject({ status: "graduated_sweep_deferred" });
    expect(ctx.rows.automatedFeePrograms[0].status).toBe("enrolled");
    expect(ctx.rows.automatedFeeRuns[0].sweepTransactionHash).toBeUndefined();
  });
});
const root = { requestId: "root", programId: "p", operation: "reassign", previousControllerAddress: a(1), newControllerAddress: a(2),
  newBeneficiaryAddress: a(2), ownerXUserId: "123", walletRef: a(1), vaultAddress: a(21), pairTokenAddress: a(0), previousBeneficiaryAddress: a(1) };

describe("upgrade incident: continuation, cancellation and fresh-post recovery", () => {
  const request = { requestId: "new", sourcePostId: "post", ownerXUserId: "123", walletId: "wallet",
    kind: "upgrade_fees", normalizedJson: JSON.stringify({ kind: "upgrade_fees", token: "TEST" }), source: "x", channel: "x_reply" };
  function cancelledFixture() {
    const ctx = fixture();
    Object.assign(ctx.rows.automatedFeePrograms[0], { status: "manual_review", enrollmentSource: "upgrade", enrollmentRequestId: "old",
      enrollmentDiagnosticCode: "UPGRADE_CANCELLED_BY_OPERATOR", deploymentTransactionHash: h(1), deploymentConfirmedAt: 1 });
    ctx.rows.cryptoWallets = [{ _id: "wallet", address: a(1), ownerXUserId: "123" }];
    ctx.rows.walletRequests = [{ ...request, _id: "old-request", requestId: "old", status: "rejected", diagnosticCode: "UPGRADE_CANCELLED_BY_OPERATOR" },
      { ...request, _id: "new-request", status: "simulating" }];
    return ctx;
  }
  it("resumes identical pending upgrades without creating a request or charging quota again", async () => {
    const ctx = database();
    expect((await handler(wallets.reserveWalletRequest)(ctx, request)).retried).toBe(false);
    ctx.rows.walletRequests[0].status = "simulating";
    expect(await handler(wallets.reserveWalletRequest)(ctx, request)).toMatchObject({ inserted: true, retried: true });
    expect(ctx.rows.walletRequests).toHaveLength(1);
    await expect(handler(wallets.reserveWalletRequest)(ctx, { ...request, ownerXUserId: "other" })).rejects.toThrow("identity mismatch");
    ctx.rows.walletRequests[0].status = "rejected";
    ctx.rows.walletRequests[0].diagnosticCode = "UPGRADE_CANCELLED_BY_OPERATOR";
    expect((await handler(wallets.reserveWalletRequest)(ctx, request)).inserted).toBe(false);
    await handler(wallets.updateWalletRequest)(ctx, { requestId: "new", status: "simulating" });
    expect(ctx.rows.walletRequests[0].status).toBe("rejected");
  });
  it("reuses the confirmed unassigned vault only for a different admitted request", async () => {
    const ctx = cancelledFixture(); const p = ctx.rows.automatedFeePrograms[0];
    expect(existingFeeUpgradeState(p, "old")).toBe("review");
    expect(existingFeeUpgradeState(p, "new")).toBe("restart");
    await handler(engine.restartCancelledUpgrade)(ctx, { programId: "p", requestId: "new", previousRequestId: "old", controllerAddress: a(1) });
    expect(p).toMatchObject({ status: "prepared", enrollmentRequestId: "new", deploymentTransactionHash: h(1), vaultAddress: a(21) });
    expect(ctx.rows.walletRequests[0].status).toBe("rejected");
    expect(ctx.scheduled).toHaveLength(0);
  });
  it.each(["wrong_wallet", "existing_assignment", "cancelled_new_request", "unconfirmed_deployment"])("does not reuse a cancelled vault: %s", async reason => {
    const ctx = cancelledFixture();
    if (reason === "wrong_wallet") ctx.rows.cryptoWallets[0].address = a(2);
    if (reason === "existing_assignment") ctx.rows.walletTransactions = [{ _id: "tx", requestId: "old:upgrade-assignment", status: "prepared" }];
    if (reason === "cancelled_new_request") ctx.rows.walletRequests[1].status = "rejected";
    if (reason === "unconfirmed_deployment") ctx.rows.automatedFeePrograms[0].deploymentConfirmedAt = undefined;
    await expect(handler(engine.restartCancelledUpgrade)(ctx, { programId: "p", requestId: "new", previousRequestId: "old", controllerAddress: a(1) })).rejects.toThrow();
    expect(ctx.rows.automatedFeePrograms[0].status).toBe("manual_review");
  });
  it("never reopens, schedules or publishes either cancelled X post", async () => {
    const ctx = database();
    ctx.rows.xReplyInteractions = ["first", "second"].map(postId => ({ _id: postId, postId, status: "rejected", commandKind: "operator_cancelled" }));
    for (const postId of ["first", "second"]) {
      await handler(xReplies.scheduleInteractionRetry)(ctx, { postId, safeError: "automated fee workflow continuation required" });
      await handler(xReplies.updateInteraction)(ctx, { postId, status: "processing" });
      expect(await handler(xReplies.beginReplyPublication)(ctx, { postId, publicationKey: `${postId}:outcome` })).toMatchObject({ reserved: false });
    }
    expect(ctx.rows.xReplyInteractions.every((r: any) => r.status === "rejected")).toBe(true);
    expect(ctx.scheduled).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("schedules continuation without consuming the ordinary failure retry budget", async () => {
    const ctx = database(); ctx.rows.xReplyInteractions = [{ _id: "i", postId: "post", status: "processing", retryCount: 0 }];
    await handler(xReplies.scheduleInteractionRetry)(ctx, { postId: "post", safeError: "automated fee workflow continuation required" });
    expect(ctx.rows.xReplyInteractions[0]).toMatchObject({ status: "failed", retryCount: 0 });
    expect(ctx.scheduled).toEqual([{ name: "xReplies:retryInteraction", args: { postId: "post" } }]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("runs the actual wallet dispatcher across deployment, assignment and confirmed retry", async () => {
    const ctx = fixture();
    for (const key of ["AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED", "AUTOMATED_FEE_BOT_COMMANDS_ENABLED", "X_CRYPTO_EXECUTION_ENABLED"])
      vi.stubEnv(key, "true");
    const user = { xUserId: "123", verified: true };
    const wallet = { _id: "wallet", address: a(1), signerWalletRef: a(1), ownerXUserId: "123", status: "active", chainId: 4663 };
    ctx.rows.walletRequests = [];
    Object.assign(ctx.rows.automatedFeePrograms[0], { status: "prepared", enrollmentSource: "upgrade", enrollmentRequestId: "x:post:upgrade_fees" });
    let feeOwner = a(1), submits = 0, quota = 0;
    const invoke = ctx.runMutation;
    const routed = async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === "wallets:getXUserAndWallet") return { user, wallet };
      if (name === "wallets:consumeWalletLimit") { quota++; return { allowed: true, remaining: 90 }; }
      if (name === "wallets:acquireWalletExecutionLock") return true;
      if (name === "wallets:releaseWalletExecutionLock" || name === "registry:ensureInitialized") return;
      if (name === "registry:runtimeConfig") return { contracts: { pons_v2_factory: a(30), pons_holder_distributor_factory: a(31) }, pairs: [] };
      if (name === "wallets:resolveLaunchForFeeUpgrade") return { status: "ok", launchId: "l", tokenAddress: a(20), pairTokenAddress: a(0) };
      if (name === "automatedFeeEngine:prepareExistingLaunchUpgrade") return { programId: "p", vaultAddress: a(21), alreadyEnrolled: false };
      if (name === "automatedFeeEngine:completeExistingLaunchUpgrade") { ctx.rows.automatedFeePrograms[0].status = "enrolled"; return; }
      if (name === "wallets:recordConfirmedExecution") {
        await handler(wallets.updateWalletRequest)(ctx, { requestId: args.requestId, status: "confirmed", transactionHash: args.transactionHash }); return;
      }
      return invoke(ref, args);
    };
    ctx.runQuery = routed; ctx.runMutation = routed; ctx.runAction = routed;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      // The zero-ETH guard is a read-only RPC check before entering the signer.
      const rpc = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (rpc?.method === "eth_getBalance") return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: "0xde0b6b3a7640000" }));
      if (path.endsWith("/balance")) return new Response(JSON.stringify({ symbol: "TEST" }));
      if (path.endsWith("/holder-distributor")) return new Response(JSON.stringify({ exists: true, creatorFeeRecipient: feeOwner, pairToken: a(0), distributor: null }));
      if (path.endsWith("/execute")) {
        const body = JSON.parse(String(init.body));
        expect(body.operation).toMatchObject({ type: "pons_v2_transfer_creator_fee_recipient", token: a(20), newRecipient: a(21) });
        submits++; feeOwner = a(21);
        return new Response(JSON.stringify({ status: "confirmed", transactionHash: h(2), toAddress: a(30), valueWei: "0" }));
      }
      throw new Error("Unexpected test-only endpoint " + path);
    }));
    const args = { sourcePostId: "post", xUserId: "123", text: "@ponsbotfamily upgrade $TEST", parsedCommandJson: JSON.stringify({ kind: "upgrade_fees", token: "TEST" }) };
    expect(await handler(wallets.executeCommand)(ctx, args)).toMatchObject({ deferred: true, pending: true, message: "" });
    expect(submits).toBe(0);
    Object.assign(ctx.rows.automatedFeePrograms[0], { deploymentTransactionHash: h(1), deploymentConfirmedAt: 1 });
    const result = await handler(wallets.executeCommand)(ctx, args);
    expect(result).toMatchObject({ ok: true, transactionHash: h(2) });
    expect(result.message).toContain("$TEST has been upgraded to Pons Bot V2");
    expect((await handler(wallets.executeCommand)(ctx, args)).ok).toBe(true);
    expect(submits).toBe(1); expect(quota).toBe(1);
  });
  it("X schedules a pending wallet result without attempting publication", async () => {
    const ctx = database();
    for (const key of ["X_REPLIES_ENABLED", "AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED", "AUTOMATED_FEE_BOT_COMMANDS_ENABLED"]) vi.stubEnv(key, "true");
    vi.stubEnv("X_STANDALONE_MENTIONS_ENABLED", "false");
    ctx.rows.xReplyInteractions = [{ _id: "i", postId: "post", status: "received", text: "@ponsbotfamily upgrade $TEST",
      parsedIntentJson: JSON.stringify({ kind: "command", command: { kind: "upgrade_fees", token: "TEST" } }) }];
    const invoke = ctx.runQuery;
    ctx.runQuery = async (ref: any, args: any) => getFunctionName(ref) === "xReplies:getRetryContext"
      ? { user: { xUserId: "123" }, interaction: ctx.rows.xReplyInteractions[0] } : invoke(ref,args);
    ctx.runAction = async (ref: any) => {
      if (getFunctionName(ref) === "wallets:ensureWallet") return { address: a(1) };
      if (getFunctionName(ref) === "wallets:executeCommand") return { ok: true, message: "", pending: true, deferred: true };
      throw new Error("unexpected action " + getFunctionName(ref));
    };
    await handler(xReplies.retryInteraction)(ctx, { postId: "post" });
    expect(ctx.rows.xReplyInteractions[0]).toMatchObject({ status: "failed", safeError: "automated fee workflow continuation required" });
    expect(ctx.scheduled).toContainEqual({ name: "xReplies:retryInteraction", args: { postId: "post" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("controller workflow identity and strict handoff", () => {
  it("permits only bound children and retains cross-request exclusion", async () => {
    const ctx = fixture();
    const original = await handler(engine.reserveControllerChange)(ctx, root);
    expect((await handler(engine.reserveControllerChange)(ctx, root))._id).toBe(original._id);
    const child = { requestId: "root:controller-sweep", parentRequestId: "root", programId: "p", operation: "reassign",
      previousControllerAddress: a(1), newControllerAddress: a(2), newBeneficiaryAddress: a(2) };
    await handler(engine.reserveControllerChange)(ctx, child);
    await expect(handler(engine.reserveControllerChange)(ctx, { ...root, requestId: "other" })).rejects.toThrow("another automated fee controller");
    await expect(handler(engine.reserveControllerChange)(ctx, { ...child, newControllerAddress: a(9) })).rejects.toThrow("child identity");
    await expect(handler(engine.reserveControllerChange)(ctx, { ...child, requestId: "root:evil" })).rejects.toThrow("child identity");
  });
  it("maps prepare and quote responses to exactly the accepted fields", () => {
    const fields = automatedFeePreparedFields({ transactionHash: h(1), signedTransaction: "0x1234", nonce: 2 });
    const schema = JSON.parse((engine.persistControllerTransaction as any).exportArgs());
    expect(Object.keys({ requestId: "x", ...fields }).every(k => k in schema.value)).toBe(true);
    expect(fields).not.toHaveProperty("nonce");
    const quote = { signature: "0x" + "1".repeat(130), authorizer: a(4), nonce: "1", pairAsset: a(0), grossClaimEstimate: "100",
      deadline: 2_000_000_000, maxBuybackAmount: "5", minPonsbotOut: "1", minSweepBuybackTokensOut: "0", routeTarget: a(5), routeData: "0x" };
    const request = { idempotencyKey: "test-reassign", chainId: 4663, ownerReference: "x:123", walletRef: a(1), expectedAddress: a(1), vaultAddress: a(21),
      operation: { type: "reassign", newController: a(2), newBeneficiary: a(2), execution: automatedFeeExecutionFields(quote) } };
    expect(automatedFeeControllerTransactionRequestSchema.safeParse(request).success).toBe(true);
    expect(request.operation.execution).not.toHaveProperty("signature");
  });
  it("fences simultaneous execution of the same controller request", async () => {
    const ctx = fixture(); await handler(engine.reserveControllerChange)(ctx, root);
    expect(await handler(engine.acquireControllerExecutionLease)(ctx, { requestId: "root", leaseId: "a" })).toBe(true);
    expect(await handler(engine.acquireControllerExecutionLease)(ctx, { requestId: "root", leaseId: "b" })).toBe(false);
    await handler(engine.releaseControllerExecutionLease)(ctx, { requestId: "root", leaseId: "b" });
    expect(await handler(engine.acquireControllerExecutionLease)(ctx, { requestId: "root", leaseId: "b" })).toBe(false);
  });
});

describe("durable enrollment and shared-wallet serialization", () => {
  it("prioritizes a persisted deployment behind more than ten unsigned enrollments", async () => {
    const ctx = database();
    ctx.rows.automatedFeePrograms = Array.from({ length: 36 }, (_, i) => ({ _id: `p${i}`, status: "prepared", nextEnrollmentAttemptAt: 1 }));
    ctx.rows.automatedFeePrograms.push({ _id: "submitted", status: "prepared", nextEnrollmentAttemptAt: 2, deploymentTransactionHash: h(1) });
    const due = await handler(engine.duePreparedEnrollments)(ctx, { now: 3 });
    expect(due).toHaveLength(10);
    expect(due[0]._id).toBe("submitted");
  });
  it("defers contention without changing signed envelopes or consuming an attempt", async () => {
    const ctx = database();
    ctx.rows.automatedFeePrograms = [{ _id: "p", status: "prepared", nextEnrollmentAttemptAt: 1, enrollmentAttempts: 2, deploymentTransactionHash: h(1) }];
    const before = Date.now();
    await handler(engine.deferBlockedEnrollment)(ctx, { programId: "p" });
    expect(ctx.rows.automatedFeePrograms[0]).toMatchObject({ enrollmentAttempts: 2, deploymentTransactionHash: h(1) });
    expect(ctx.rows.automatedFeePrograms[0].nextEnrollmentAttemptAt).toBeGreaterThanOrEqual(before + 60_000);
  });
  it("settles a verified deployment without falsely finalizing enrollment", async () => {
    const ctx = database(); ctx.rows.automatedFeePrograms = [{ _id: "p", status: "prepared", deploymentTransactionHash: h(1) }];
    await expect(handler(engine.markVaultDeploymentConfirmed)(ctx, { programId: "p", transactionHash: h(2) })).rejects.toThrow("mismatch");
    await handler(engine.markVaultDeploymentConfirmed)(ctx, { programId: "p", transactionHash: h(1) });
    expect(ctx.rows.automatedFeePrograms[0].status).toBe("prepared");
    expect(ctx.rows.automatedFeePrograms[0].deploymentConfirmedAt).toBeGreaterThan(0);
    expect(await handler(engine.acquireDeploymentLease)(ctx, { programId: "other", leaseId: "next" })).toBe(true);
  });
  it("binds a matching confirmed launch after expiry, idempotently", async () => {
    const ctx = fixture(); ctx.rows.automatedFeePrograms = [];
    ctx.rows.automatedFeeEnrollmentReservations = [{ _id: "r", ...root, requestId: "launch", status: "expired", expiresAt: 1,
      normalizedPredictedTokenAddress: a(20), normalizedPredictedVaultAddress: a(21), deploymentSalt: h(1), distributionMode: "wallet" }];
    const args = { reservationId: "r", launchId: "l", actualTokenAddress: a(20), actualVaultAddress: a(21) };
    const id = await handler(engine.bindPrelaunchEnrollment)(ctx,args);
    expect(await handler(engine.bindPrelaunchEnrollment)(ctx,args)).toBe(id);
    expect(ctx.rows.automatedFeePrograms).toHaveLength(1);
    await expect(handler(engine.bindPrelaunchEnrollment)(ctx,{ ...args, actualTokenAddress: a(99) })).rejects.toThrow("binding mismatch");
  });
  it("does not expire a reservation with a persisted transaction or live launch request", async () => {
    const ctx = database();
    ctx.rows.automatedFeeEnrollmentReservations = ["signed", "waiting", "safe"].map(id => ({ _id: id, requestId: id, status: "reserved", expiresAt: 1 }));
    ctx.rows.walletTransactions = [{ _id: "tx", requestId: "signed", status: "prepared" }];
    ctx.rows.walletRequests = [{ _id: "req", requestId: "waiting", status: "accepted" }];
    expect(await handler(engine.expirePrelaunchEnrollments)(ctx,{})).toBe(1);
    expect(ctx.rows.automatedFeeEnrollmentReservations.map((r: any) => r.status)).toEqual(["reserved", "reserved", "expired"]);
  });
  it("reschedules confirmed unbound launches even without their original callback", async () => {
    const ctx = fixture();
    ctx.rows.automatedFeeEnrollmentReservations = [{ _id: "r", requestId: "launch", status: "reserved", updatedAt: 1 }];
    await handler(engine.recoverPreparedEnrollments)(ctx,{});
    expect(ctx.scheduled).toContainEqual({ name: "automatedFeeEngine:bindAndDeployNewLaunch", args: { requestId: "launch" } });
  });
  it.each([false, true])("recovers upgrade deployment before assignment unless confirmed=%s", async confirmed => {
    const ctx = database(); ctx.rows.automatedFeePrograms = [{ _id: "p", status: "prepared", enrollmentSource: "upgrade", nextEnrollmentAttemptAt: 1,
      deploymentTransactionHash: h(1), ...(confirmed ? { deploymentConfirmedAt: 2 } : {}) }];
    await handler(engine.recoverPreparedEnrollments)(ctx,{});
    expect(ctx.scheduled[0].name).toBe(confirmed ? "automatedFeeEngine:recoverUpgradeAssignment" : "automatedFeeEngine:deployPreparedEnrollment");
  });
  it("serializes admin signing and retains nonce ownership after action lease release", async () => {
    const ctx = database(); ctx.rows.automatedFeePrograms = [{ _id: "p", status: "prepared" }, { _id: "p2", status: "prepared" }];
    expect(await handler(engine.acquireDeploymentLease)(ctx,{ programId: "p", leaseId: "one" })).toBe(true);
    expect(await handler(engine.acquireDeploymentLease)(ctx,{ programId: "p2", leaseId: "two" })).toBe(false);
    ctx.rows.automatedFeePrograms[0].deploymentTransactionHash = h(1);
    await handler(engine.releaseDeploymentLease)(ctx,{ programId: "p", leaseId: "one" });
    expect(await handler(engine.acquireDeploymentLease)(ctx,{ programId: "p2", leaseId: "two" })).toBe(false);
    ctx.rows.automatedFeePrograms[0].deploymentConfirmedAt = 2;
    expect(await handler(engine.acquireDeploymentLease)(ctx,{ programId: "p2", leaseId: "two" })).toBe(true);
  });
  it("does not treat a large unsigned backlog as an in-flight nonce", async () => {
    const ctx = database();
    ctx.rows.automatedFeePrograms = Array.from({ length: 150 }, (_, i) => ({ _id: `p${i}`, status: "prepared" }));
    ctx.rows.automatedFeeRuns = Array.from({ length: 150 }, (_, i) => ({ _id: `run${i}`, status: "deferred" }));
    expect(await handler(engine.acquireDeploymentLease)(ctx,{ programId: "p0", leaseId: "one" })).toBe(true);
    expect(await handler(engine.acquireKeeperLease)(ctx,{ runId: "run0", leaseId: "two", now: Date.now() })).toBe(true);
  });
  it("shares the keeper lock between engine and controller transactions", async () => {
    const ctx = database();
    expect(await handler(engine.acquireKeeperLease)(ctx,{ runId: "run", leaseId: "one", now: Date.now() })).toBe(true);
    expect(await handler(engine.acquireKeeperLease)(ctx,{ controllerRequestId: "root", leaseId: "two", now: Date.now() })).toBe(false);
    await handler(engine.releaseKeeperLease)(ctx,{ runId: "run", leaseId: "one" });
    ctx.rows.automatedFeeRuns = [{ _id: "run", status: "submitted", sweepTransactionHash: h(1) }];
    expect(await handler(engine.acquireKeeperLease)(ctx,{ controllerRequestId: "root", leaseId: "two", now: Date.now() })).toBe(false);
    ctx.rows.automatedFeeRuns[0].sweepBlockNumber = "20";
    expect(await handler(engine.acquireKeeperLease)(ctx,{ controllerRequestId: "root", leaseId: "two", now: Date.now() })).toBe(true);
  });
  it("reserves a user's persisted controller nonce against unrelated wallet actions", async () => {
    const ctx = fixture(); ctx.rows.cryptoWallets = [{ _id: "wallet", ownerXUserId: "123" }];
    await handler(engine.reserveControllerChange)(ctx, root);
    await handler(engine.persistControllerTransaction)(ctx, { requestId: "root", transactionHash: h(1), signedTransaction: "0x1234", transactionNonce: 1 });
    expect(await handler(wallets.acquireWalletExecutionLock)(ctx, { walletId: "wallet", requestId: "buy", leaseToken: "buy" })).toBe(false);
    expect(await handler(wallets.acquireWalletExecutionLock)(ctx, { walletId: "wallet", requestId: "root", leaseToken: "root" })).toBe(true);
    await handler(wallets.releaseWalletExecutionLock)(ctx, { walletId: "wallet", requestId: "root", leaseToken: "root" });
    await handler(engine.markControllerChangeStatus)(ctx, { requestId: "root", status: "confirmed" });
    expect(await handler(wallets.acquireWalletExecutionLock)(ctx, { walletId: "wallet", requestId: "buy", leaseToken: "buy" })).toBe(true);
  });
  it("background controller recovery waits for the normal wallet execution lock", async () => {
    const ctx = fixture(); ctx.rows.cryptoWallets = [{ _id: "wallet", ownerXUserId: "123", status: "active", chainId: 4663, address: a(1) }];
    await handler(engine.reserveControllerChange)(ctx, root);
    await handler(wallets.acquireWalletExecutionLock)(ctx, { walletId: "wallet", requestId: "trade", leaseToken: "trade" });
    await handler(engine.recoverControllerChanges)(ctx, {});
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.rows.walletExecutionLocks[0].requestId).toBe("trade");
  });
});

describe("complete public controller path with a strict mock signer", () => {
  it("retries a curve reassignment using the saved authorization and delivery amount", async () => {
    const ctx = fixture();
    let nonce = 0, sweepDone = false, reassigned = false, failBroadcast = true, deliveryPending = true;
    let amount = "95";
    const calls: Array<{ path: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); const path = new URL(url).pathname;
      calls.push({ path, body }); let result: any;
      if (path.endsWith("/inspect")) result = { active: true, paused: false, phase: 0, controller: a(reassigned ? 2 : 1), beneficiary: a(reassigned ? 2 : 1), executionNonce: "0", lastCurveSweepBlock: sweepDone ? "99" : "0" };
      else if (path.endsWith("/prepare-controller-sweep") || path.endsWith("/prepare-delivery") || path.endsWith("/prepare-controller")) {
        if (path.endsWith("/prepare-controller")) automatedFeeControllerTransactionRequestSchema.parse(body);
        result = { transactionHash: h(++nonce), signedTransaction: "0x1234", nonce };
      } else if (path.endsWith("/broadcast-controller")) {
        automatedFeeControllerBroadcastRequestSchema.parse(body);
        if (failBroadcast) { failBroadcast = false; throw new Error("simulated network disconnect before send"); }
        reassigned = true; result = { status: "broadcast" };
      } else if (path.endsWith("/broadcast-controller-sweep") || path.endsWith("/broadcast-delivery")) result = { status: "broadcast" };
      else if (path.endsWith("/controller-sweep-status")) { sweepDone = true; result = { status: "confirmed" }; }
      else if (path.endsWith("/controller-status")) result = { status: "confirmed", blockNumber: "100" };
      else if (path.endsWith("/authorize")) result = { signature: "0x" + "1".repeat(130), authorizer: a(4), nonce: "0", pairAsset: a(0), grossClaimEstimate: "100", deadline: body.deadline,
        maxBuybackAmount: "5", minPonsbotOut: "1", minSweepBuybackTokensOut: "0", routeTarget: a(5), routeData: "0x" };
      else if (path.endsWith("/claimable")) result = { amount };
      else if (path.endsWith("/status")) result = deliveryPending ? { status: "pending" } : { status: "confirmed", blockNumber: "102", amount: "95" };
      else throw new Error("unexpected endpoint: " + path);
      return new Response(JSON.stringify(result));
    }));
    const args = { requestId: "root", programId: "p", ownerXUserId: "123", walletRef: a(1), expectedAddress: a(1), operation: "reassign", recipient: a(2) };
    await expect(handler(engine.executeVerifiedControllerChange)(ctx,args)).rejects.toThrow("simulated network disconnect");
    const operation = ctx.rows.automatedFeeControllerChanges.find((r: any) => r.requestId === "root").operationJson;
    await expect(handler(engine.executeVerifiedControllerChange)(ctx,args)).rejects.toThrow("continuation required");
    // Another allocation can arrive while the original transfer is pending.
    amount = "100"; deliveryPending = false;
    expect((await handler(engine.executeVerifiedControllerChange)(ctx,args)).outcome).toBe("reassigned");
    expect(ctx.rows.walletRequests[0].status).toBe("confirmed");
    for (const suffix of ["/authorize", "/prepare-controller", "/prepare-controller-sweep", "/prepare-delivery"])
      expect(calls.filter(c => c.path.endsWith(suffix))).toHaveLength(1);
    expect(calls.filter(c => c.path.endsWith("/broadcast-controller")).map(c => JSON.stringify(c.body.operation))).toEqual([operation, operation]);
    expect(ctx.rows.automatedFeeControllerChanges.find((r: any) => r.requestId.endsWith("former-beneficiary-delivery")).deliveryAmount).toBe("95");
  });
  it.each(["reassign", "holders"] as const)("completes %s and updates both wallet response and public assignment", async operation => {
    const ctx = fixture();
    let nonce = 0;
    const posted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); const path = new URL(url).pathname; posted.push(path);
      let result: any = {};
      if (path.endsWith("/inspect")) result = { active: true, paused: false, phase: 2, controller: a(1), beneficiary: a(1), executionNonce: "0", lastCurveSweepBlock: "0" };
      else if (path.endsWith("/authorize")) result = { signature: "0x" + "1".repeat(130), authorizer: a(4), nonce: "0", pairAsset: a(0), grossClaimEstimate: "100", deadline: body.deadline,
        maxBuybackAmount: "5", minPonsbotOut: "1", minSweepBuybackTokensOut: "0", routeTarget: a(5), routeData: "0x" };
      else if (path.endsWith("/prepare-controller")) {
        automatedFeeControllerTransactionRequestSchema.parse(body);
        result = { transactionHash: h(++nonce), signedTransaction: "0x1234", nonce, from: a(1), to: a(21) };
      } else if (path.endsWith("/broadcast-controller")) { automatedFeeControllerBroadcastRequestSchema.parse(body); result = { status: "broadcast" }; }
      else if (path.endsWith("/controller-status")) result = { status: "confirmed", blockNumber: "100" };
      else if (path.endsWith("/claimable")) result = { amount: "0" };
      else throw new Error("unexpected signer endpoint: " + path);
      return new Response(JSON.stringify(result));
    }));
    const result = await handler(engine.executeVerifiedControllerChange)(ctx,{ requestId: "root", programId: "p", ownerXUserId: "123", walletRef: a(1), expectedAddress: a(1), operation, recipient: a(2) });
    expect(result.outcome).toBe(operation === "holders" ? "holders" : "reassigned");
    expect(ctx.rows.tokenLaunches[0].creatorFeeRecipient).toBe(a(2));
    expect(ctx.rows.walletRequests[0].status).toBe("confirmed");
    expect(ctx.rows.automatedFeeControllerChanges.find((r: any) => r.requestId === "root").workflowCompletedAt).toBeTruthy();
    expect(posted.filter(p => p.endsWith("/prepare-controller"))).toHaveLength(operation === "holders" ? 2 : 1);
  });
  it("background upgrade completion uses the required V2 wording, page link and beneficiary", async () => {
    const ctx = fixture(); Object.assign(ctx.rows.automatedFeePrograms[0], { enrollmentSource: "upgrade", enrollmentTransactionHash: h(1), beneficiaryAddress: a(2), normalizedBeneficiaryAddress: a(2) });
    await handler(engine.finalizeRecoveredWalletRequest)(ctx,{ requestId: "root", programId: "p", operation: "upgrade", transactionHash: h(1) });
    expect(ctx.rows.walletRequests[0].finalMessage).toBe(automatedFeeOutcomeMessage("upgrade", "TEST", a(20), h(1)));
    expect(ctx.rows.walletRequests[0].finalMessage).not.toContain("/tx/");
    expect(ctx.rows.tokenLaunches[0].creatorFeeRecipient).toBe(a(2));
  });
});
