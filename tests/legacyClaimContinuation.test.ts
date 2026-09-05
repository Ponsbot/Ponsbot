import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import * as wallets from "../convex/wallets";
import * as legacyClaims from "../convex/legacyClaims";
import * as automatedFeeClaimInfo from "../convex/automatedFeeClaimInfo";
import { canSkipUnsubmittedSweep, legacyClaimSigningKey, LEGACY_CLAIM_SUPERSEDED, resumableLegacyClaim, storedClaimWorkflow } from "../lib/legacy-claim-workflow";
import { withClaimLpFeeOffer } from "../lib/guided-help-workflow";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const handler = (f: any) => f._handler;
const command = { kind: "claim_fees" };
const sessionId = "web_123456789012345678901234";
const eventId = "event_12345678901234567890123456789012345678";

function fixture(source: "x" | "terminal" = "terminal", tokens = [a(1), a(2), a(3)], claimableLpFees = false) {
  const rows: Record<string, any[]> = {};
  const db: any = {
    query(table: string) {
      const tests: any[] = []; const b: any = { eq: (k: string, v: any) => { tests.push((r: any) => r[k] === v); return b; } };
      const result = () => (rows[table] ?? []).filter(r => tests.every(f => f(r)));
      const q: any = { withIndex: (_: string, cb: any) => { cb(b); return q; },
        filter: (cb: any) => { tests.push(cb({ field: (k: string) => (r: any) => r[k], eq: (f: any, v: any) => (r: any) => f(r) === v })); return q; },
        unique: async () => result()[0] ?? null, first: async () => result()[0] ?? null,
        collect: async () => result(), take: async (n: number) => result().slice(0, n) };
      return q;
    },
    get: async (id: string) => Object.values(rows).flat().find(r => r._id === id) ?? null,
    insert: async (table: string, data: any) => { const _id = `${table}-${rows[table]?.length ?? 0}`; (rows[table] ??= []).push({ _id, ...data }); return _id; },
    patch: async (id: string, data: any) => Object.assign(await db.get(id), data),
    delete: async (id: string) => { for (const t of Object.keys(rows)) rows[t] = rows[t].filter(r => r._id !== id); },
  };
  const wallet = { _id: "wallet", ownerXUserId: "123", address: a(99), signerWalletRef: "test-wallet", chainId: 4663, status: "active" };
  rows.cryptoWallets = [wallet];
  const requestId = source === "terminal" ? `terminal:${sessionId}:${eventId}:claim_fees` : "x:1234567:claim_fees";
  const sourcePostId = source === "terminal" ? eventId : "1234567";
  const args = { requestId, sourcePostId, xUserId: "123", source, channel: source === "terminal" ? "terminal_chat" : "x_reply", text: "claim all my fees", parsedCommandJson: JSON.stringify(command) };
  const calls: { name: string; args: any }[] = [], scheduled: { delay: number; name: string; args: any }[] = [], executions: any[] = [];
  const invoke = async (ref: any, data: any): Promise<any> => {
    const name = getFunctionName(ref); calls.push({ name, args: data });
    if (name === "wallets:getXUserAndWallet") return { wallet, user: { xUserId: "123", username: "test", verified: true, subscriptionType: "premium" } };
    if (name === "registry:ensureInitialized") return;
    if (name === "registry:runtimeConfig") return { contracts: { pons_v2_factory: a(9) }, pairs: [] };
    if (name === "wallets:listOwnedLaunchTokens") return tokens;
    if (name === "wallets:resolveKnownToken") return data.identifier;
    if (name === "wallets:claimMayIncludeOtherLaunches") return false;
    if (name === "liquidity:hasClaimableLpFees") return claimableLpFees;
    if (name === "wallets:recordConfirmedExecution") {
      const r = await db.query("walletRequests").withIndex("by_request_id", (q: any) => q.eq("requestId", data.requestId)).unique();
      await db.patch(r._id, { status: "confirmed", transactionHash: data.transactionHash });
      await db.insert("walletTransactions", { ...data, status: "confirmed" }); return;
    }
    if (name === "wallets:getReconciliationContext") {
      const request = (rows.walletRequests ?? []).find(r => r.requestId === data.requestId);
      return request ? { request, wallet, transaction: (rows.walletTransactions ?? []).find(r => r.requestId === data.requestId) ?? null, launch: null } : null;
    }
    const [module, fn] = name.split(":");
    if (module === "automatedFeeClaimInfo") return handler((automatedFeeClaimInfo as any)[fn])(ctx, data);
    return handler((module === "wallets" ? wallets : legacyClaims as any)[fn])(ctx, data);
  };
  const ctx: any = { db, runQuery: invoke, runMutation: invoke, runAction: invoke,
    scheduler: { runAfter: vi.fn(async (delay: number, ref: any, data: any) => scheduled.push({ delay, name: getFunctionName(ref), args: data })) } };
  const fetcher = vi.fn(async (url: any, options: any) => {
    const body = JSON.parse(options.body);
    if (body.method === "eth_getBalance") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1" }));
    if (String(url).endsWith("/claim-plan")) return new Response(JSON.stringify({ tokenAddresses: tokens }));
    if (String(url).endsWith("/balance")) return new Response(JSON.stringify({ symbol: "PAIR" }));
    expect(String(url)).toContain("/transactions/execute");
    expect(body.idempotencyKey.length).toBeLessThanOrEqual(128);
    executions.push(body);
    return new Response(JSON.stringify({ status: "confirmed", transactionHash: h(executions.length), valueWei: "0", toAddress: a(8),
      ...(body.operation.type === "pons_v2_claim_fees" ? { claimedDisplay: "0.001 ETH" } : {}) }));
  });
  vi.stubGlobal("fetch", fetcher);
  const seed = (overrides: any = {}) => {
    const request = { _id: "root", requestId, sourcePostId, source, channel: args.channel, ownerXUserId: "123", walletId: "wallet", kind: "claim_fees",
      status: "simulating", normalizedJson: JSON.stringify(command), claimWorkflowJson: JSON.stringify(tokens), claimWorkflowCursor: 1, createdAt: 1, updatedAt: 1, ...overrides };
    (rows.walletRequests ??= []).push(request); return request;
  };
  return { ctx, rows, args, calls, scheduled, executions, fetcher, seed };
}

beforeEach(() => {
  vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "true");
  vi.stubEnv("X_BOT_USER_ID", "999");
  vi.stubEnv("WALLET_SIGNER_URL", "https://signer.test"); vi.stubEnv("WALLET_SIGNER_TOKEN", "unit-test-only");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.ponsbot.family");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("legacy claim continuations", () => {
  it.each(["x", "terminal"] as const)("checks empty creator fees before gas and offers LP fees on %s", async source => {
    const f = fixture(source, [], true);
    const success = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, options) => String(url).endsWith("/claim-plan")
      ? new Response(JSON.stringify({ tokenAddresses: [], hasClaimableFees: false, escrowBalance: "0" }))
      : success(url, options));
    const result = await handler(wallets.executeCommand)(f.ctx, f.args);
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("You haven't launched any tokens to generate creator fees.");
    expect(result.message).toContain("Did you mean claim LP fees?");
    expect(f.executions).toEqual([]);
    expect(f.rows.walletRequests[0]).toMatchObject({ status: "skipped", diagnosticCode: "NO_CREATOR_FEE_SOURCE" });
  });

  it.each(["x", "terminal"] as const)("does not offer an LP claim when a non-launcher has no claimable LP fees on %s", async source => {
    const f = fixture(source, [], false);
    const success = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, options) => String(url).endsWith("/claim-plan")
      ? new Response(JSON.stringify({ tokenAddresses: [], hasClaimableFees: false, escrowBalance: "0" }))
      : success(url, options));
    const result = await handler(wallets.executeCommand)(f.ctx, f.args);
    expect(result.message).toBe("ℹ️ You haven't launched any tokens to generate creator fees.");
    expect(result.message).not.toContain("Did you mean claim LP fees?");
    expect(f.executions).toEqual([]);
  });

  it("offers LP fees when a launcher has no creator fees available and LP fees are claimable", async () => {
    const f = fixture("terminal", [a(1)], true);
    f.rows.tokenLaunches = [{ _id: "launch", tokenAddress: a(1), symbol: "EMPTY", ownerXUserId: "123", publicPublished: true }];
    const success = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, options) => String(url).endsWith("/claim-plan")
      ? new Response(JSON.stringify({ tokenAddresses: [], hasClaimableFees: false, escrowBalance: "0" }))
      : success(url, options));
    const result = await handler(wallets.executeCommand)(f.ctx, f.args);
    expect(result.message).toContain("creator fees available");
    expect(result.message).toContain("Did you mean claim LP fees?");
    expect(result.message).not.toContain("haven't launched");
    expect(f.executions).toEqual([]);
  });

  it.each(["x", "terminal"] as const)("still claims escrow after an empty sweep plan on %s", async source => {
    const f = fixture(source, []);
    expect((await handler(wallets.executeCommand)(f.ctx, f.args)).ok).toBe(true);
    expect(f.executions.map(e => e.operation.type)).toEqual(["pons_v2_claim_fees"]);
  });
  it.each(["x", "terminal"] as const)("skips an unsigned empty specific-token sweep but claims escrow on %s", async source => {
    const f = fixture(source, [a(1)]); const success = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, options) => JSON.parse(options.body).operation?.type === "pons_v2_sweep_fees"
      ? new Response(JSON.stringify({ error: "nothing to sweep", diagnosticCode: "EMPTY_CURVE_SWEEP" }), { status: 400 }) : success(url, options));
    const args = { ...f.args, parsedCommandJson: JSON.stringify({ kind: "claim_fees", token: a(1) }) };
    expect((await handler(wallets.executeCommand)(f.ctx, args)).ok).toBe(true);
    expect(f.executions.map(e => e.operation.type)).toEqual(["pons_v2_claim_fees"]);
    expect(f.rows.walletRequests.some(r => r.status === "skipped" && r.workflowStage === "preparatory_sweep_skipped")).toBe(true);
  });
  it.each(["x", "terminal"] as const)("explains automated claims after an empty legacy escrow on %s without submitting or retrying", async source => {
    const f = fixture(source, [], true);
    f.rows.automatedFeePrograms = [{ _id: "program", launchId: "launch", normalizedControllerAddress: a(99),
      normalizedTokenAddress: a(1), normalizedVaultAddress: a(88), status: "enrolled", distributionMode: "wallet" }];
    f.rows.launches = [{ _id: "launch", tokenAddress: a(1), symbol: "DAMPER", publicPublished: true, creatorFeeRecipient: a(88) }];
    const success = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, options) => JSON.parse(options.body).operation?.type === "pons_v2_claim_fees"
      ? new Response(JSON.stringify({ error: "no claimable creator fees are available in ETH" }), { status: 400 }) : success(url, options));
    const result = await handler(wallets.executeCommand)(f.ctx, f.args);
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toBe(withClaimLpFeeOffer(automatedFeeClaimInfo.EMPTY_CLAIM_MESSAGES.v2));
    expect(f.rows.walletRequests[0]).toMatchObject({ status: "skipped", diagnosticCode: "AUTOMATED_CREATOR_FEES" });
    expect(f.calls.filter(c => c.name === "wallets:refundWalletLimitIfPreBroadcast")).toHaveLength(1);
    expect(f.scheduled).toHaveLength(0);
    expect(f.executions).toHaveLength(0);
  });
  it("does not offer LP claims after an empty automated claim when no LP fees are claimable", async () => {
    const f = fixture("x", [], false);
    f.rows.automatedFeePrograms = [{ _id: "program", launchId: "launch", normalizedControllerAddress: a(99),
      normalizedTokenAddress: a(1), normalizedVaultAddress: a(88), status: "enrolled", distributionMode: "wallet" }];
    f.rows.launches = [{ _id: "launch", tokenAddress: a(1), symbol: "DAMPER", publicPublished: true, creatorFeeRecipient: a(88) }];
    const success = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, options) => JSON.parse(options.body).operation?.type === "pons_v2_claim_fees"
      ? new Response(JSON.stringify({ error: "no claimable creator fees are available in ETH" }), { status: 400 }) : success(url, options));
    const result = await handler(wallets.executeCommand)(f.ctx, f.args);
    expect(result.message).toBe(automatedFeeClaimInfo.EMPTY_CLAIM_MESSAGES.v2);
    expect(result.message).not.toContain("Did you mean claim LP fees?");
  });
  it("keeps an ordinary empty legacy claim as no fees, not automated guidance", async () => {
    const f = fixture("x", []); const success = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, options) => JSON.parse(options.body).operation?.type === "pons_v2_claim_fees"
      ? new Response(JSON.stringify({ error: "no claimable creator fees are available in ETH" }), { status: 400 }) : success(url, options));
    const result = await handler(wallets.executeCommand)(f.ctx, f.args);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("fees available");
    expect(result.message).not.toContain("automated");
  });
  it.each(["x", "terminal"] as const)("persists legacy-only and mixed no-fee guidance correctly for %s", async source => {
    for (const mixed of [false, true]) {
      const f = fixture(source, [], true);
      f.rows.tokenLaunches = [{ _id: "legacy", ownerXUserId: "123", tokenAddress: a(2), normalizedTokenAddress: a(2),
        creatorFeeRecipient: a(99), normalizedCreatorFeeRecipient: a(99), symbol: "OLDER", publicPublished: true }];
      if (mixed) {
        f.rows.automatedFeePrograms = [{ _id: "program", launchId: "launch", normalizedControllerAddress: a(99),
          normalizedTokenAddress: a(1), normalizedVaultAddress: a(88), status: "enrolled", distributionMode: "wallet" }];
        f.rows.tokenLaunches.push({ _id: "launch", ownerXUserId: "123", tokenAddress: a(1), symbol: "DAMPER", publicPublished: true, creatorFeeRecipient: a(88) });
      }
      const success = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementation(async (url, options) => JSON.parse(options.body).operation?.type === "pons_v2_claim_fees"
        ? new Response(JSON.stringify({ error: "no claimable creator fees are available in ETH" }), { status: 400 }) : success(url, options));
      const result = await handler(wallets.executeCommand)(f.ctx, f.args);
      expect(result).toMatchObject({ ok: mixed, message: withClaimLpFeeOffer(automatedFeeClaimInfo.EMPTY_CLAIM_MESSAGES[mixed ? "mixed" : "legacy"]) });
      expect(f.rows.walletRequests[0]).toMatchObject({ status: mixed ? "skipped" : "failed", finalMessage: result.message,
        diagnosticCode: mixed ? "AUTOMATED_CREATOR_FEES" : "NO_CLAIMABLE_CREATOR_FEES" });
      expect(f.calls.filter(c => c.name === "wallets:refundWalletLimitIfPreBroadcast")).toHaveLength(1);
      expect(f.scheduled).toHaveLength(0);
      expect(f.executions).toHaveLength(0);
    }
  });
  it("still collects legacy escrow left behind by an upgrade instead of substituting V2 guidance", async () => {
    const f = fixture("x", []);
    f.rows.automatedFeePrograms = [{ _id: "program", launchId: "launch", normalizedControllerAddress: a(99),
      normalizedTokenAddress: a(1), normalizedVaultAddress: a(88), status: "enrolled", distributionMode: "wallet" }];
    f.rows.tokenLaunches = [{ _id: "launch", tokenAddress: a(1), symbol: "DAMPER", publicPublished: true, creatorFeeRecipient: a(88) }];
    const result = await handler(wallets.executeCommand)(f.ctx, f.args);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Claimed 0.001 ETH");
    expect(f.rows.walletRequests[0].status).toBe("confirmed");
    expect(f.calls.some(c => c.name === "automatedFeeClaimInfo:emptyLegacyClaimMessage")).toBe(false);
  });
  it.each(["x", "terminal"] as const)("runs a three-token %s claim through every cursor and signs the final claim once", async source => {
    const f = fixture(source);
    for (let i = 0; i < 3; i++) {
      const result = await handler(wallets.executeCommand)(f.ctx, f.args);
      expect(result.ok).toBe(true);
      expect(Boolean(result.deferred)).toBe(i < 2);
      expect(f.rows.walletRequests[0].claimWorkflowCursor).toBe(i + 1);
    }
    expect(f.executions.map(e => e.operation.type)).toEqual(["pons_v2_sweep_fees", "pons_v2_sweep_fees", "pons_v2_sweep_fees", "pons_v2_claim_fees"]);
    expect(f.rows.walletRequests[0].status).toBe("confirmed");
    expect(f.calls.filter(c => c.name === "wallets:consumeWalletLimit")).toHaveLength(1);
    await handler(wallets.executeCommand)(f.ctx, f.args);
    expect(f.executions).toHaveLength(4);
    expect(f.scheduled.filter(s => s.name === "legacyClaims:resumeTerminalClaim")).toHaveLength(source === "terminal" ? 2 : 0);
  });
  it("does not automatically reactivate pre-fix claims at deployment", async () => {
    const f = fixture(); f.seed();
    expect((await handler(wallets.executeCommand)(f.ctx, f.args)).pending).toBe(true);
    expect(f.executions).toHaveLength(0);
  });
  it("reuses confirmed sweep receipts after a recovery rewind", async () => {
    const f = fixture(); f.seed({ claimWorkflowVersion: 2, claimWorkflowCursor: 0 });
    f.rows.walletRequests.push({ ...f.rows.walletRequests[0], _id: "child", requestId: `${f.args.requestId}:sweep:${a(1)}`, status: "confirmed", transactionHash: h(77) });
    expect((await handler(wallets.executeCommand)(f.ctx, f.args)).deferred).toBe(true);
    expect(f.rows.walletRequests[0].claimWorkflowCursor).toBe(1);
    expect(f.executions).toHaveLength(0);
  });
  it("does not skip or advance after a CDP error", async () => {
    const f = fixture(); f.seed({ claimWorkflowVersion: 2, claimWorkflowCursor: 0 });
    f.fetcher.mockImplementation(async () => new Response(JSON.stringify({ diagnosticCode: "SIGNER_INTERNAL_FAILURE", error: "X-Idempotency-Key is invalid" }), { status: 400 }));
    const result = await handler(wallets.executeCommand)(f.ctx, f.args);
    expect(result.ok).toBe(false);
    expect(f.rows.walletRequests[0].claimWorkflowCursor).toBe(0);
    expect(f.rows.walletRequests[1].status).toBe("failed");
    expect(f.rows.walletRequests[0].workflowStage).toBe("claim_sweep");
  });
  it("keeps a pending sweep at the same cursor without signing another transaction", async () => {
    const f = fixture(); const root = f.seed({ claimWorkflowVersion: 2, claimWorkflowCursor: 0 });
    const childId = `${root.requestId}:sweep:${a(1)}`;
    f.rows.walletRequests.push({ ...root, _id: "child", requestId: childId, status: "broadcast", transactionHash: h(50) });
    f.rows.walletTransactions = [{ requestId: childId, status: "broadcast", transactionHash: h(50) }];
    const runAction = f.ctx.runAction;
    f.ctx.runAction = async (ref: any, args: any) => getFunctionName(ref) === "wallets:reconcileTransaction"
      ? Promise.reject(new Error("transaction confirmation timed out")) : runAction(ref, args);
    expect(await handler(wallets.executeCommand)(f.ctx, f.args)).toMatchObject({ pending: true, deferred: true });
    expect(root.claimWorkflowCursor).toBe(0);
    expect(f.rows.walletRequests[1].status).toBe("broadcast");
    expect(f.executions).toHaveLength(0);
    expect(f.scheduled).toHaveLength(1);
  });
  it("rechecks final completion after an overlapping continuation acquires the lease", async () => {
    const f = fixture(); const root = f.seed({ claimWorkflowVersion: 2, claimWorkflowCursor: 0 });
    const mutate = f.ctx.runMutation;
    f.ctx.runMutation = async (ref: any, args: any) => {
      if (getFunctionName(ref) === "wallets:acquireWalletExecutionLock") {
        Object.assign(root, { status: "confirmed", transactionHash: h(90), finalMessage: "Fees claimed" });
      }
      return mutate(ref, args);
    };
    expect(await handler(wallets.executeCommand)(f.ctx, f.args)).toMatchObject({ ok: true, message: "Fees claimed" });
    expect(f.executions).toHaveLength(0);
  });
  it("retains a prepared final claim as pending if confirmation transport fails", async () => {
    const f = fixture("terminal", []); const root = f.seed({ claimWorkflowVersion: 2, claimWorkflowCursor: 0 });
    f.fetcher.mockImplementation(async () => new Response(JSON.stringify({ status: "prepared", transactionHash: h(88), signedTransaction: "0x1234", toAddress: a(8), valueWei: "0" })));
    const mutate = f.ctx.runMutation;
    f.ctx.runMutation = async (ref: any, args: any) => {
      if (getFunctionName(ref) === "wallets:recordPreparedExecution") {
        Object.assign(root, { status: "prepared", transactionHash: args.transactionHash });
        f.rows.walletTransactions = [{ ...args, status: "prepared" }]; return;
      }
      return mutate(ref, args);
    };
    f.ctx.runAction = async () => { throw new Error("transaction confirmation timed out"); };
    expect(await handler(wallets.executeCommand)(f.ctx, f.args)).toMatchObject({ pending: true, deferred: true });
    expect(root.status).toBe("prepared");
    expect(f.scheduled).toHaveLength(1);
    expect(f.calls.filter(c => c.name === "wallets:refundWalletLimitIfPreBroadcast")).toHaveLength(0);
  });
  it("keeps specific paired-asset claims specific through the final operation", async () => {
    const f = fixture("terminal", [a(1)]);
    const args = { ...f.args, parsedCommandJson: JSON.stringify({ kind: "claim_fees", token: a(1) }) };
    expect((await handler(wallets.executeCommand)(f.ctx, args)).ok).toBe(true);
    expect(f.executions.at(-1).operation).toMatchObject({ type: "pons_v2_claim_fees", token: a(1) });
  });
  it("allows a prior beneficiary to claim escrow when they can no longer sweep", async () => {
    const f = fixture("terminal", [a(1)]); const success = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, options) => JSON.parse(options.body).operation?.type === "pons_v2_sweep_fees"
      ? new Response(JSON.stringify({ error: "wallet is not the launch creator fee beneficiary" }), { status: 400 }) : success(url, options));
    expect((await handler(wallets.executeCommand)(f.ctx, f.args)).ok).toBe(true);
    expect(f.executions.map(e => e.operation.type)).toEqual(["pons_v2_claim_fees"]);
  });
  it("continues an accepted terminal claim without an active login and replaces its prior status message", async () => {
    const f = fixture("terminal", [a(1)]); f.seed({ claimWorkflowVersion: 2, claimWorkflowCursor: 0 });
    f.rows.terminalMessages = [{ _id: "message", sessionId, requestId: eventId, role: "assistant", text: "already being processed" }];
    await handler(legacyClaims.resumeTerminalClaim)(f.ctx, { requestId: f.args.requestId });
    expect(f.rows.terminalMessages).toHaveLength(1);
    expect(f.rows.terminalMessages[0].text).toContain("0.001 ETH");
    expect(f.rows.walletRequests[0].status).toBe("confirmed");
  });
  it("recovers the final terminal reply when the receipt confirmed before its message was saved", async () => {
    const f = fixture(); f.seed({ claimWorkflowVersion: 2, status: "confirmed", transactionHash: h(99), finalMessage: undefined });
    await handler(legacyClaims.resumeTerminalClaim)(f.ctx, { requestId: f.args.requestId });
    expect(f.executions).toHaveLength(0);
    expect(f.rows.terminalMessages).toHaveLength(1);
    expect(f.rows.terminalMessages[0].text).toContain(h(99));
  });
  it.each(["ownerXUserId", "walletId", "sourcePostId", "normalizedJson", "source", "channel"])("rejects resumed claims with a different %s", async field => {
    const f = fixture(); const r = f.seed({ claimWorkflowVersion: 2 });
    const args = { requestId: r.requestId, sourcePostId: r.sourcePostId, ownerXUserId: r.ownerXUserId, walletId: r.walletId,
      normalizedJson: r.normalizedJson, kind: r.kind, source: r.source, channel: r.channel, [field]: "different" };
    await expect(handler(wallets.reserveWalletRequest)(f.ctx, args)).rejects.toThrow("identity mismatch");
  });
  it("silently refuses cancelled/superseded claims even from stale callbacks", async () => {
    const f = fixture(); f.seed({ claimWorkflowVersion: 2, status: "rejected", diagnosticCode: LEGACY_CLAIM_SUPERSEDED });
    expect(await handler(wallets.executeCommand)(f.ctx, f.args)).toMatchObject({ message: "", deferred: true });
    expect(f.executions).toHaveLength(0);
  });
  it("preview is read-only and explicit recovery rewinds only the selected request", async () => {
    const f = fixture(); const root = f.seed({ createdAt: 2 });
    const older = { ...root, _id: "old", requestId: `terminal:${sessionId}:older:claim_fees`, sourcePostId: "older", createdAt: 1 };
    f.rows.walletRequests.push(older);
    const args = { requestIds: [root.requestId], supersededRequestIds: [older.requestId] };
    expect((await handler(legacyClaims.continueStuckClaims)(f.ctx, args)).mutationSent).toBe(false);
    expect(root.claimWorkflowVersion).toBeUndefined(); expect(f.scheduled).toHaveLength(0);
    await handler(legacyClaims.continueStuckClaims)(f.ctx, { ...args, execute: true });
    expect(root).toMatchObject({ claimWorkflowVersion: 2, claimWorkflowCursor: 0 });
    expect(older).toMatchObject({ status: "rejected", diagnosticCode: LEGACY_CLAIM_SUPERSEDED });
    expect(f.scheduled.map(s => s.name)).toEqual(["legacyClaims:resumeTerminalClaim"]);
  });
  it("refuses recovery when any child transaction is unresolved", async () => {
    const f = fixture(); const root = f.seed();
    f.rows.walletRequests.push({ ...root, _id: "child", requestId: `${root.requestId}:sweep:${a(1)}`, status: "skipped" });
    f.rows.walletTransactions = [{ requestId: f.rows.walletRequests[1].requestId, status: "prepared", transactionHash: h(2) }];
    await expect(handler(legacyClaims.continueStuckClaims)(f.ctx, { requestIds: [root.requestId], execute: true })).rejects.toThrow("unresolved signed child");
    expect(root.claimWorkflowVersion).toBeUndefined(); expect(f.scheduled).toHaveLength(0);
  });
});

describe("claim identifiers and state validation", () => {
  it("makes long CDP keys bounded, stable and unique while preserving short keys and unrelated operations", () => {
    const id = `terminal:${sessionId}:${eventId}:claim_fees:sweep:${a(1)}`;
    expect(id.length).toBeGreaterThan(128);
    const key = legacyClaimSigningKey(id, "pons_v2_sweep_fees");
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toBe(legacyClaimSigningKey(id, "pons_v2_sweep_fees"));
    expect(key).not.toBe(legacyClaimSigningKey(`${id}2`, "pons_v2_sweep_fees"));
    expect(legacyClaimSigningKey("x:1:claim_fees", "pons_v2_claim_fees")).toBe("x:1:claim_fees");
    expect(legacyClaimSigningKey(id, "pons_v2_launch")).toBe(id);
  });
  it.each([-1, 2, 0.5, NaN])("rejects invalid saved cursor %s", cursor => {
    expect(() => storedClaimWorkflow({ requestId: "x:1:claim_fees", kind: "claim_fees", status: "simulating", claimWorkflowJson: JSON.stringify([a(1)]), claimWorkflowCursor: cursor })).toThrow();
  });
  it("does not allow child records or transaction-bearing parents to re-sign", () => {
    const r = { requestId: "x:1:claim_fees", kind: "claim_fees", status: "simulating", claimWorkflowVersion: 2, claimWorkflowJson: "[]" };
    expect(resumableLegacyClaim(r)).toBe(true);
    expect(resumableLegacyClaim({ ...r, requestId: `${r.requestId}:sweep:${a(1)}` })).toBe(false);
    expect(resumableLegacyClaim({ ...r, transactionHash: h(1) })).toBe(false);
  });
  it.each(["SIGNER_TIMEOUT", "X-Idempotency-Key too long", "RPC 429", "network unavailable", "transaction confirmation timed out"])("does not silently skip %s", error => {
    expect(canSkipUnsubmittedSweep(new Error(error))).toBe(false);
  });
});
