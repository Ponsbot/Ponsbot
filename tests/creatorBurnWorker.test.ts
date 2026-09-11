import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import * as worker from "../convex/creatorBurnEngine";

const signer = vi.hoisted(() => vi.fn());
vi.mock("../convex/automatedFeeEngine", () => ({ signerRequest: signer }));
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const handler = (fn: any) => fn._handler;
function fixture() {
  const rows: Record<string, any[]> = {
    automatedFeePrograms: [
      {
        _id: "p",
        vaultAddress: a(1),
        beneficiaryAddress: a(2),
        normalizedControllerAddress: a(2),
        normalizedBeneficiaryAddress: a(2),
      },
    ],
    creatorBurnLayers: [
      {
        _id: "l",
        programId: "p",
        layerAddress: a(3),
        ownerAddress: a(2),
        bps: 5000,
        active: true,
        nextCheckAt: 0,
        failures: 0,
        burnRetryAt: 0,
        hasPending: false,
      },
    ],
    creatorBurnOwners: [{ _id: "o", layerId: "l", ownerAddress: a(2) }],
  };
  const db: any = {
    get: async (id: string) =>
      Object.values(rows)
        .flat()
        .find((r) => r._id === id) ?? null,
    patch: async (id: string, patch: any) =>
      Object.assign(await db.get(id), patch),
    insert: async (table: string, row: any) => {
      const id = `${table}:${(rows[table] ??= []).length}`;
      rows[table].push({ _id: id, ...row });
      return id;
    },
    query: (table: string) => {
      const predicates: Array<(r: any) => boolean> = [];
      const b: any = {
        eq: (k: string, v: any) => {
          predicates.push((r) => r[k] === v);
          return b;
        },
        lte: (k: string, v: any) => {
          predicates.push((r) => r[k] <= v);
          return b;
        },
      };
      const results = () =>
        (rows[table] ?? []).filter((r) => predicates.every((p) => p(r)));
      const q: any = {
        withIndex: (_: string, cb: any) => {
          cb(b);
          return q;
        },
        filter: (cb: any) => {
          predicates.push(
            cb({
              field: (k: string) => (r: any) => r[k],
              eq: (f: any, v: any) => (r: any) => f(r) === v,
              and:
                (...ps: any[]) =>
                (r: any) =>
                  ps.every((p) => p(r)),
            }),
          );
          return q;
        },
        unique: async () => results()[0] ?? null,
        first: async () => results()[0] ?? null,
        take: async (n: number) => results().slice(0, n),
        collect: async () => results(),
        paginate: async () => ({
          page: results(),
          isDone: true,
          continueCursor: "",
        }),
      };
      return q;
    },
  };
  const mutations: string[] = [];
  const ctx: any = {
    db,
    scheduler: { runAfter: vi.fn() },
    runMutation: async (ref: any, args: any) => {
      const [module, name] = getFunctionName(ref).split(":");
      mutations.push(name);
      if (module === "automatedFeeEngine") return true;
      if (module === "creatorBurnEnrollment" && name === "due") return [];
      return handler((worker as any)[name])(ctx, args);
    },
  };
  const snapshot = {
    layer: a(3),
    owner: a(2),
    primaryController: a(3),
    active: true,
    exited: false,
    bps: 5000,
    cash: "0",
    reserve: "0",
    upstreamClaimable: "0",
  };
  signer.mockImplementation(async (path: string) => {
    if (path.endsWith("inspect")) return snapshot;
    if (path.endsWith("prepare"))
      return { transactionHash: h(1), signedTransaction: "0xab" };
    if (path.endsWith("status")) return { status: "pending" };
    return {};
  });
  return {
    rows,
    ctx,
    mutations,
    snapshot,
    layer: rows.creatorBurnLayers[0],
    run: () => handler(worker.run)(ctx, { layerId: "l" }),
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("history recovery", () => {
  it("leases one scan and backs off failures without moving the cursor", async () => {
    const f=fixture();
    expect(await handler(worker.claimHistoryScan)(f.ctx,{layerId:"l",leaseId:"first"})).not.toBeNull();
    expect(await handler(worker.claimHistoryScan)(f.ctx,{layerId:"l",leaseId:"second"})).toBeNull();
    expect(await handler(worker.finishHistoryScan)(f.ctx,{layerId:"l",leaseId:"wrong",failed:true})).toBeNull();
    expect(await handler(worker.finishHistoryScan)(f.ctx,{layerId:"l",leaseId:"first",failed:true})).toBe(300000);
    expect(f.layer.historyNextBlock).toBeUndefined();
    expect(f.layer.historyDiagnostic).toBe("CREATOR_BURN_HISTORY_READ_RETRY");
    expect(await handler(worker.claimHistoryScan)(f.ctx,{layerId:"l",leaseId:"third"})).toBeNull();
  });
  it("releases the scan after failure and schedules exactly one bounded retry", async () => {
    const f=fixture(); f.ctx.runQuery=async()=>f.rows.automatedFeePrograms[0];
    signer.mockRejectedValueOnce(new Error("secret provider URL timed out"));
    await handler(worker.scan)(f.ctx,{layerId:"l"});
    expect(f.layer.historyLeaseId).toBeUndefined();
    expect(f.layer.historyFailures).toBe(1);
    expect(f.ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
    expect(f.ctx.scheduler.runAfter.mock.calls[0][0]).toBe(300000);
    expect(f.mutations).not.toContain("saveHistoryCursor");
  });
});
describe("creator layer durable worker", () => {
  it("makes no provider calls when disabled and no transaction exists", async () => {
    const f = fixture();
    await f.run();
    expect(signer).not.toHaveBeenCalled();
  });
  it("persists the exact envelope before broadcasting", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const f = fixture();
    f.snapshot.upstreamClaimable = "100";
    signer.mockImplementation(async (path: string) => {
      if (path.endsWith("inspect")) return f.snapshot;
      if (path.endsWith("prepare"))
        return { transactionHash: h(1), signedTransaction: "0xab" };
      expect(f.layer.pending).toMatchObject({
        transactionHash: h(1),
        signedTransaction: "0xab",
      });
      return {};
    });
    await f.run();
    expect(f.layer.pending.stage).toBe("collect");
    expect(f.layer.hasPending).toBe(true);
  });
  it("retains an envelope after an uncertain broadcast and never prepares again", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const f = fixture();
    f.snapshot.cash = "20";
    signer.mockImplementation(async (path: string) => {
      if (path.endsWith("inspect")) return f.snapshot;
      if (path.endsWith("prepare"))
        return { transactionHash: h(1), signedTransaction: "0xab" };
      if (path.endsWith("status")) return { status: "pending" };
      throw new Error("timeout");
    });
    await f.run();
    expect(f.layer.pending.transactionHash).toBe(h(1));
    await f.run();
    expect(
      signer.mock.calls.filter(([p]) => p.endsWith("prepare")),
    ).toHaveLength(1);
  });
  it("reconciles confirmed receipts while disabled without broadcasting", async () => {
    const f = fixture();
    f.layer.pending = {
      key: "key",
      stage: "burn",
      transactionHash: h(1),
      signedTransaction: "0xab",
    };
    f.layer.hasPending = true;
    signer.mockResolvedValue({
      status: "confirmed",
      blockNumber: "10",
      events: [],
    });
    await f.run();
    expect(f.layer.pending).toBeUndefined();
    expect(f.layer.hasPending).toBe(false);
    expect(signer).toHaveBeenCalledTimes(1);
    expect(f.ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("schedules immediate continuation after confirmation when enabled", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const f = fixture();
    f.layer.pending = { key: "key", stage: "collect", transactionHash: h(1) };
    signer.mockResolvedValue({
      status: "confirmed",
      blockNumber: "10",
      events: [],
    });
    await f.run();
    expect(f.ctx.scheduler.runAfter).toHaveBeenCalledWith(
      0,
      expect.anything(),
      { layerId: "l" },
    );
  });
  it("pays the previous owner's cash before attempting a current-owner burn", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const f = fixture();
    f.rows.creatorBurnOwners.push({
      _id: "old",
      layerId: "l",
      ownerAddress: a(4),
    });
    signer.mockImplementation(async (path: string, args: any) => {
      if (path.endsWith("inspect"))
        return {
          ...f.snapshot,
          reserve: "100",
          cash: args.beneficiary === a(4) ? "10" : "0",
        };
      if (path.endsWith("prepare"))
        return { transactionHash: h(1), signedTransaction: "0xab" };
      return {};
    });
    await f.run();
    expect(f.layer.pending).toMatchObject({
      stage: "payout",
      beneficiary: a(4),
    });
  });
  it("does not burn before collecting and paying new upstream fees", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const f = fixture();
    Object.assign(f.snapshot, { reserve: "50", upstreamClaimable: "100" });
    await f.run();
    expect(f.layer.pending.stage).toBe("collect");
  });
  it("releases an unsigned failed preparation without losing a signed one", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const f = fixture();
    f.snapshot.cash = "20";
    signer.mockImplementation(async (path: string) => {
      if (path.endsWith("inspect")) return f.snapshot;
      throw new Error("prepare failed");
    });
    await f.run();
    expect(f.layer.pending).toBeUndefined();
    expect(f.layer.hasPending).toBe(false);
  });
  it("does not overlap primary processing or an unfinished controller workflow", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const f = fixture();
    f.rows.automatedFeeRuns = [{ programId: "p", status: "submitted" }];
    await f.run();
    expect(signer).not.toHaveBeenCalled();
    f.rows.automatedFeeRuns = [];
    f.rows.automatedFeeControllerChanges = [
      { programId: "p", status: "confirmed", workflowRoot: true },
    ];
    await f.run();
    expect(signer).not.toHaveBeenCalled();
  });
  it("does not overwrite an existing signed envelope", async () => {
    const f = fixture();
    f.layer.pending = {
      key: "k",
      transactionHash: h(1),
      signedTransaction: "0xab",
    };
    await expect(
      handler(worker.saveEnvelope)(f.ctx, {
        layerId: "l",
        key: "k",
        transactionHash: h(2),
        signedTransaction: "0xcd",
      }),
    ).rejects.toThrow("immutable");
  });
  it("ingests a receipt once and rejects conflicting duplicate data", async () => {
    const f = fixture(),
      event = {
        key: `4663:${a(3)}:${h(1)}:1`,
        owner: a(2),
        kind: "allocation",
        received: "100",
        cashAllocated: "50",
        reserveAllocated: "50",
        cashDebited: "0",
        cashReceived: "0",
        reserveSpent: "0",
        tokensBurned: "0",
      };
    const args = {
      programId: "p",
      layerAddress: a(3),
      transactionHash: h(1),
      blockNumber: "10",
      events: [event],
    };
    await handler(worker.ingest)(f.ctx, args);
    await handler(worker.ingest)(f.ctx, args);
    expect(f.rows.creatorBurnEvents).toHaveLength(1);
    await expect(
      handler(worker.ingest)(f.ctx, {
        ...args,
        events: [{ ...event, cashAllocated: "51" }],
      }),
    ).rejects.toThrow("conflicting");
  });
  it("rejects initial registration with a different owner", async () => {
    const f = fixture();
    await expect(
      handler(worker.recordVerifiedLayer)(f.ctx, {
        programId: "p",
        layerAddress: a(9),
        ownerAddress: a(8),
        bps: 5000,
        active: true,
      }),
    ).rejects.toThrow("owner differs");
  });
});

describe("creator layer recovery regressions", () => {
  it("passes a validated percentage through the verified owner's locked workflow", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const f = fixture();
    const p = {
      ...f.rows.automatedFeePrograms[0],
      creatorBurnLayerAddress: a(3),
      status: "enrolled",
      controllerAddress: a(2),
    };
    f.ctx.runQuery = vi.fn(async (ref: any) =>
      getFunctionName(ref).endsWith("programByToken") ? p : "wallet-id",
    );
    f.ctx.runMutation = vi.fn(async () => true);
    f.ctx.runAction = vi.fn(async () => ({ transactionHash: h(1) }));
    expect(
      await handler(worker.changePercentage)(f.ctx, {
        requestId: "percentage-1",
        ownerXUserId: "owner-id",
        tokenAddress: a(9),
        percentage: "50%",
      }),
    ).toMatchObject({ status: "confirmed", bps: 5000 });
    expect(f.ctx.runAction.mock.calls[0][1]).toMatchObject({
      selfBurnBps: 5000,
      ownerXUserId: "owner-id",
      expectedAddress: a(2),
      recipient: a(2),
    });
  });
  it("rejects a caller without the fee owner's wallet before executing", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const f = fixture();
    f.ctx.runQuery = vi.fn(async (ref: any) =>
      getFunctionName(ref).endsWith("programByToken")
        ? {
            creatorBurnLayerAddress: a(3),
            status: "enrolled",
            controllerAddress: a(2),
          }
        : null,
    );
    f.ctx.runAction = vi.fn();
    await expect(
      handler(worker.changePercentage)(f.ctx, {
        requestId: "percentage-2",
        ownerXUserId: "outsider",
        tokenAddress: a(9),
        percentage: "50",
      }),
    ).rejects.toThrow("current fee owner");
    expect(f.ctx.runAction).not.toHaveBeenCalled();
  });
  it("finds pending work beyond disabled ordinary rows", async () => {
    const f = fixture();
    f.rows.creatorBurnLayers = Array.from({ length: 12 }, (_, i) => ({
      _id: `l${i}`,
      hasPending: false,
      nextCheckAt: 0,
    }));
    f.rows.creatorBurnLayers.push({
      _id: "pending",
      hasPending: true,
      pending: { transactionHash: h(1) },
    });
    f.ctx.runQuery = f.ctx.runMutation;
    await handler(worker.tick)(f.ctx, {});
    expect(
      f.ctx.scheduler.runAfter.mock.calls
        .filter(
          ([, ref]: any) => getFunctionName(ref) === "creatorBurnEngine:run",
        )
        .map(([, , args]: any) => args.layerId),
    ).toEqual(["pending"]);
  });
  it("reconciles an original hash that wins against its replacement", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const f = fixture();
    f.layer.pending = {
      key: "k",
      stage: "burn",
      createdAt: 1,
      transactionHash: h(2),
      signedTransaction: "0xcd",
      previousHashes: [h(1)],
    };
    f.layer.hasPending = true;
    signer.mockImplementation(async (_, args) =>
      args.transactionHash === h(1)
        ? { status: "confirmed", blockNumber: "10", events: [] }
        : { status: "pending" },
    );
    await f.run();
    expect(f.layer.pending).toBeUndefined();
    expect(signer.mock.calls).toHaveLength(1);
  });
  it("persists a replacement and prior hash before sending", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const f = fixture();
    f.layer.pending = {
      key: "k",
      stage: "burn",
      createdAt: 1,
      transactionHash: h(1),
      signedTransaction: "0xab",
    };
    f.layer.hasPending = true;
    signer.mockImplementation(async (path) => {
      if (path.endsWith("status")) return { status: "pending" };
      if (path.endsWith("replace"))
        return { transactionHash: h(2), signedTransaction: "0xcd" };
      expect(f.layer.pending).toMatchObject({
        transactionHash: h(2),
        previousHashes: [h(1)],
      });
      return {};
    });
    await f.run();
    expect(f.rows.creatorBurnTransactionJournal).toHaveLength(1);
  });
  it("quarantines an unknown consumed nonce without holding the global keeper", async () => {
    const f = fixture();
    f.layer.pending = {
      key: "k",
      stage: "burn",
      transactionHash: h(1),
      signedTransaction: "0xab",
    };
    f.layer.hasPending = true;
    signer.mockResolvedValue({ status: "nonce_consumed" });
    await f.run();
    expect(f.layer.manualReview).toBe(true);
    expect(f.layer.hasPending).toBe(false);
    expect(f.rows.automatedFeePrograms[0].status).toBe("manual_review");
  });
  it("tries the previous owner's reserve after the current owner's dust is deferred", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const f = fixture();
    f.rows.creatorBurnOwners.push({
      _id: "old",
      layerId: "l",
      ownerAddress: a(4),
    });
    signer.mockImplementation(async (path, args) => {
      if (path.endsWith("inspect"))
        return {
          ...f.snapshot,
          reserve: args.beneficiary === a(4) ? "100000" : "1",
        };
      if (path.endsWith("prepare"))
        return args.beneficiary === a(2)
          ? { deferred: true }
          : { transactionHash: h(1), signedTransaction: "0xab" };
      return {};
    });
    await f.run();
    await f.run();
    expect(f.layer.pending).toMatchObject({ stage: "burn", beneficiary: a(4) });
  });
  it("counts separately delivered layer cash exactly once", async () => {
    const f = fixture();
    f.rows.automatedFeePrograms[0].normalizedPairTokenAddress = a(0);
    const event = {
      key: `4663:${a(3)}:${h(1)}:1`,
      owner: a(2),
      kind: "payout",
      received: "0",
      cashAllocated: "0",
      reserveAllocated: "0",
      cashDebited: "50",
      cashReceived: "50",
      reserveSpent: "0",
      tokensBurned: "0",
    };
    const args = {
      programId: "p",
      layerAddress: a(3),
      transactionHash: h(1),
      blockNumber: "10",
      events: [event],
    };
    await handler(worker.ingest)(f.ctx, args);
    await handler(worker.ingest)(f.ctx, args);
    expect(f.rows.automatedFeeAssetTotals[0].lifetimeBeneficiaryDelivered).toBe(
      "50",
    );
  });
  it("synchronizes an already registered layer's verified new owner", async () => {
    const f = fixture();
    await handler(worker.recordVerifiedLayer)(f.ctx, {
      programId: "p",
      layerAddress: a(3),
      ownerAddress: a(4),
      bps: 0,
      active: true,
    });
    expect(f.rows.automatedFeePrograms[0].normalizedControllerAddress).toBe(
      a(4),
    );
    expect(f.rows.creatorBurnOwners.map((r) => r.ownerAddress)).toContain(a(2));
  });
});
