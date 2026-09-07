import { afterEach, describe, it, expect, vi } from "vitest";
import { getFunctionName } from "convex/server";
import * as enrollment from "../convex/creatorBurnEnrollment";
const signer = vi.hoisted(() => vi.fn());
vi.mock("../convex/automatedFeeEngine", () => ({ signerRequest: signer }));
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
function setup() {
  const rows: Record<string, any[]> = {
    automatedFeePrograms: [
      {
        _id: "p",
        status: "enrolled",
        distributionMode: "wallet",
        normalizedTokenAddress: a(1),
        tokenAddress: a(1),
        normalizedControllerAddress: a(2),
        vaultAddress: a(3),
      },
    ],
    cryptoWallets: [
      {
        _id: "w",
        ownerXUserId: "owner",
        address: a(2),
        status: "active",
        chainId: 4663,
      },
    ],
    creatorBurnRequests: [],
  };
  const db: any = {
    get: async (id: string) =>
      Object.values(rows)
        .flat()
        .find((r) => r._id === id),
    patch: async (id: string, p: any) => Object.assign(await db.get(id), p),
    insert: async (t: string, r: any) => {
      const id = `${t}${(rows[t] ??= []).length}`;
      rows[t].push({ _id: id, ...r });
      return id;
    },
    query: (t: string) => {
      const f: any[] = [];
      const b: any = {
        eq: (k: string, v: any) => {
          f.push((r: any) => r[k] === v);
          return b;
        },
      };
      const result = () =>
        (rows[t] ?? []).filter((r) => f.every((fn) => fn(r)));
      const q: any = {
        withIndex: (_: string, cb: any) => {
          cb(b);
          return q;
        },
        unique: async () => result()[0] ?? null,
        first: async () => result()[0] ?? null,
        collect: async () => result(),
      };
      return q;
    },
  };
  return { rows, ctx: { db, scheduler: { runAfter: vi.fn() } } };
}
const args = {
  requestId: "test-request",
  tokenAddress: a(1),
  ownerXUserId: "owner",
  bps: 5000,
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("creator burn enrollment authorization and persistence", () => {
  it("pins the canonical half-total conversion without rewriting old requests", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const { ctx, rows } = setup();
    const tokenAddress = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07";
    Object.assign(rows.automatedFeePrograms[0], { tokenAddress, normalizedTokenAddress: tokenAddress });
    await enrollment.queueCreatorBurnRequest(ctx as any, { ...args, tokenAddress });
    expect(rows.creatorBurnRequests[0]).toMatchObject({ bps: 5000, executionBps: 4737 });
    delete rows.creatorBurnRequests[0].executionBps;
    await enrollment.queueCreatorBurnRequest(ctx as any, { ...args, tokenAddress });
    expect(rows.creatorBurnRequests[0].executionBps).toBeUndefined();
  });
  it.each([false, true])("caps unsigned failures but preserves unresolved signed work: %s", async (signed) => {
    const { ctx, rows } = setup();
    rows.creatorBurnRequests.push({ _id: "r", ...args, programId: "p", attempts: 12, leaseId: "lease", status: "pending",
      ...(signed ? { deploymentSigned: "0x1234" } : {}) });
    await (enrollment.save as any)._handler(ctx, { id: "r", leaseId: "lease", diagnostic: "RPC unavailable" });
    expect(rows.creatorBurnRequests[0].status).toBe(signed ? "pending" : "manual_review");
  });
  it("rejects disabled enrollment", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "false");
    const { ctx } = setup();
    await expect(
      enrollment.queueCreatorBurnRequest(ctx as any, args),
    ).rejects.toThrow("not enabled");
  });
  it.each(["different", "frozen", "wrong-chain"])(
    "rejects %s wallet",
    async (kind) => {
      vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
      const { ctx, rows } = setup();
      if (kind === "different") rows.cryptoWallets[0].address = a(9);
      if (kind === "frozen") rows.cryptoWallets[0].status = "frozen";
      if (kind === "wrong-chain") rows.cryptoWallets[0].chainId = 1;
      await expect(
        enrollment.queueCreatorBurnRequest(ctx as any, args),
      ).rejects.toThrow("Only the current");
      expect(rows.creatorBurnRequests).toHaveLength(0);
    },
  );
  it("deduplicates the same request and refuses changed parameters", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const { ctx, rows } = setup();
    const id = await enrollment.queueCreatorBurnRequest(ctx as any, args);
    expect(await enrollment.queueCreatorBurnRequest(ctx as any, args)).toBe(id);
    await expect(
      enrollment.queueCreatorBurnRequest(ctx as any, { ...args, bps: 1000 }),
    ).rejects.toThrow("conflict");
    expect(rows.creatorBurnRequests).toHaveLength(1);
  });
  it("blocks competing percentage requests", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const { ctx } = setup();
    await enrollment.queueCreatorBurnRequest(ctx as any, args);
    await expect(
      enrollment.queueCreatorBurnRequest(ctx as any, {
        ...args,
        requestId: "sibling",
      }),
    ).rejects.toThrow("already processing");
  });
  it("reuses saved deployment envelope without another signature", async () => {
    vi.stubEnv("CREATOR_SELF_BUYBACK_ENABLED", "true");
    const calls: any[] = [];
    const r = {
      _id: "r",
      requestId: "root",
      programId: "p",
      ownerXUserId: "owner",
      ownerAddress: a(2),
      bps: 5000,
      deploymentSigned: "0x1234",
      deploymentIdentity: h(8),
    };
    signer.mockImplementation(async (path, body) => {
      calls.push({ path, body });
      if (path.endsWith("discover")) return { layer: null };
      if (path.endsWith("deploy-layer")) return { status: "pending" };
      throw new Error(path);
    });
    const ctx: any = {
      runQuery: vi.fn(async (ref: any) =>
        getFunctionName(ref).endsWith("controllerRecoveryWallet")
          ? "w"
          : { _id: "p", status: "enrolled", vaultAddress: a(3) },
      ),
      runMutation: vi.fn(async (ref: any) => {
        const n = getFunctionName(ref);
        if (n.endsWith(":begin")) return r;
        if (n.includes("acquire")) return true;
      }),
      runAction: vi.fn(),
    };
    await (enrollment.run as any)._handler(ctx, { id: "r" });
    expect(calls.filter((c) => c.path.endsWith("deploy-layer"))).toEqual([
      {
        path: "/v1/creator-burn/deploy-layer",
        body: expect.objectContaining({ signedTransaction: "0x1234" }),
      },
    ]);
    expect(ctx.runAction).not.toHaveBeenCalled();
  });
});
