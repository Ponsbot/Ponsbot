import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import * as claims from "../convex/automatedFeeClaimInfo";
import * as engine from "../convex/automatedFeeEngine";
import * as queue from "../convex/automatedFeeQueue";
import * as wallets from "../convex/wallets";
import { VAULT_CLAIM_REMINDER, vaultClaimResponse } from "../lib/vault-claim-response";
import { FEE_ACCUMULATION_THRESHOLD_WEI, nextFeeCheck } from "../lib/automated-fee-scheduling";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const handler = (fn: any) => fn._handler;
const gross = "2000000000000000", net = "1900000000000000";

beforeEach(() => {
  ["VAULT_FACTORY", "VAULT_IMPLEMENTATION", "EXECUTION_ADAPTER", "NATIVE_BUYBACK_EXECUTOR", "PAIRED_BUYBACK_EXECUTOR", "ADMIN", "KEEPER", "QUOTE_AUTHORIZER", "PAUSE_GUARDIAN", "CONTROL", "V3_ROUTER", "V3_QUOTER", "WETH"]
    .forEach((key, i) => vi.stubEnv(`AUTOMATED_FEE_${key}_ADDRESS`, a(i + 1)));
  for (const role of ["QUOTE", "KEEPER", "ADMIN"]) vi.stubEnv(`AUTOMATED_FEE_${role}_CDP_ACCOUNT_NAME`, `test-${role}`);
  for (const key of ["AUTOMATED_BUYBACK_BURN_ENABLED", "AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED", "AUTOMATED_FEE_BOT_COMMANDS_ENABLED", "X_CRYPTO_EXECUTION_ENABLED"]) vi.stubEnv(key, "true");
  vi.stubEnv("WALLET_SIGNER_URL", "https://signer.test"); vi.stubEnv("WALLET_SIGNER_TOKEN", "unit-test-only");
  vi.stubEnv("AUTOMATED_FEE_ENROLLMENT_SECRET", "unit-test-only");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.ponsbot.family"); vi.stubEnv("X_BOT_USER_ID", "999");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network request"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture() {
  const now = Date.now();
  const wallet = { _id: "wallet", ownerXUserId: "123", address: a(99), signerWalletRef: "test-wallet", chainId: 4663, status: "active" };
  const program: any = { _id: "p", status: "enrolled", launchId: "launch", tokenAddress: a(20), normalizedTokenAddress: a(20),
    vaultAddress: a(21), normalizedVaultAddress: a(21), controllerAddress: wallet.address, normalizedControllerAddress: wallet.address,
    beneficiaryAddress: wallet.address, normalizedBeneficiaryAddress: wallet.address, pairTokenAddress: a(0), normalizedPairTokenAddress: a(0),
    distributionMode: "wallet", workState: "idle", scheduleAnchorAt: now - 120_000, nextProcessAt: now + 780_000,
    lifetimeGrossClaimed: "0", lifetimeBeneficiaryAllocated: "0", lifetimeBuybackSpent: "0", lifetimePonsbotBurned: "0", createdAt: now, updatedAt: now };
  const request = { _id: "request", requestId: "x:1234567:claim_fees", sourcePostId: "1234567", ownerXUserId: "123", walletId: "wallet",
    kind: "claim_fees", status: "simulating", source: "x", channel: "x_reply", normalizedJson: JSON.stringify({ kind: "claim_fees" }),
    vaultClaimVersion: 1, claimWorkflowVersion: 2, claimWorkflowJson: "[]", claimWorkflowCursor: 0, createdAt: now, updatedAt: now };
  const rows: Record<string, any[]> = {
    cryptoWallets: [wallet], automatedFeePrograms: [program], walletRequests: [request],
    tokenLaunches: [{ _id: "launch", tokenAddress: a(20), normalizedTokenAddress: a(20), symbol: "TEST", publicPublished: true, creatorFeeRecipient: a(21), ownerXUserId: "123" }],
  };
  const db: any = {
    get: async (id: string) => Object.values(rows).flat().find(r => r._id === id) ?? null,
    query(table: string) {
      const tests: any[] = []; const b: any = {};
      for (const [op, predicate] of Object.entries({ eq: (x: any, y: any) => x === y, gt: (x: any, y: any) => x > y, lte: (x: any, y: any) => x === undefined || x <= y }))
        b[op] = (k: string, v: any) => { tests.push((r: any) => predicate(r[k], v)); return b; };
      const result = () => (rows[table] ?? []).filter(r => tests.every(f => f(r)));
      const q: any = { withIndex: (_: string, cb: any) => { cb(b); return q; }, order: () => q,
        filter: (cb: any) => { tests.push(cb({ field: (k: string) => (r: any) => r[k], eq: (f: any, v: any) => (r: any) => f(r) === v,
          neq: (f: any, v: any) => (r: any) => f(r) !== v, and: (...fs: any[]) => (r: any) => fs.every(f => f(r)), or: (...fs: any[]) => (r: any) => fs.some(f => f(r)) })); return q; },
        unique: async () => result()[0] ?? null, first: async () => result()[0] ?? null, collect: async () => result(), take: async (n: number) => result().slice(0, n) };
      return q;
    },
    insert: async (table: string, data: any) => { const _id = `${table}-${rows[table]?.length ?? 0}`; (rows[table] ??= []).push({ _id, ...data }); return _id; },
    patch: async (id: string, data: any) => Object.assign(await db.get(id), data),
    delete: async (id: string) => { for (const t of Object.keys(rows)) rows[t] = rows[t].filter(r => r._id !== id); },
  };
  const scheduled: any[] = [], calls: any[] = [];
  const invoke = async (ref: any, args: any): Promise<any> => {
    const name = getFunctionName(ref); calls.push({ name, args });
    if (name === "wallets:getXUserAndWallet") return { wallet, user: { xUserId: "123", username: "test", subscriptionType: "premium", verified: true } };
    if (name === "registry:ensureInitialized") return;
    if (name === "registry:runtimeConfig") return { contracts: { pons_v2_factory: a(9) }, pairs: [] };
    if (name === "wallets:listOwnedLaunchTokens") return [a(20)];
    if (name === "wallets:resolveKnownToken") return args.identifier;
    if (name === "wallets:claimMayIncludeOtherLaunches") return false;
    if (name === "wallets:recordConfirmedExecution") {
      const r = await db.query("walletRequests").withIndex("by_request_id", (q: any) => q.eq("requestId", args.requestId)).unique();
      await db.patch(r._id, { status: "confirmed", transactionHash: args.transactionHash });
      await db.insert("walletTransactions", { ...args, status: "confirmed" }); return;
    }
    const [module, fn] = name.split(":");
    return handler(({ automatedFeeClaimInfo: claims, automatedFeeEngine: engine, automatedFeeQueue: queue, wallets } as any)[module][fn])(ctx, args);
  };
  const ctx: any = { db, runQuery: invoke, runMutation: invoke, runAction: invoke,
    scheduler: { runAfter: vi.fn(async (delay: number, ref: any, args: any) => scheduled.push({ delay, name: getFunctionName(ref), args })) } };
  const prepare = () => handler(claims.prepareRequestedClaims)(ctx, { requestId: request.requestId });
  const result = (legacyMessage?: string) => handler(claims.requestedClaimResult)(ctx, { requestId: request.requestId, legacyMessage });
  const assess = (amount = gross, extra = {}) => {
    Object.assign(program, { workLeaseId: "work", workState: "running" });
    return handler(engine.recordFeeAssessment)(ctx, { programId: "p", workLeaseId: "work", valueWei: amount, assetAmount: amount, operatorWait: false, ...extra });
  };
  const reserve = () => handler(engine.reserveProcessingRun)(ctx, { programId: "p", processThroughBlock: "100", executionNonce: "0", phaseAtReservation: 0, leaseId: "run-lease", now: Date.now() });
  const delivered = async () => {
    const r = await reserve();
    Object.assign(rows.automatedFeeRuns.find(v => v._id === r.runId), { status: "confirmed", workflowStage: "cycle_confirmed", beneficiaryAllocated: net, beneficiaryDelivered: net,
      deliveryBlockNumber: "103", deliveryTransactionHash: h(7), grossClaimed: gross, buybackSpent: "100000000000000", ponsbotBurned: "123000000000000000000" });
  };
  const execute = () => handler(wallets.executeCommand)(ctx, { sourcePostId: request.sourcePostId, xUserId: "123", source: request.source, channel: request.channel,
    requestId: request.requestId, text: "claim my fees", parsedCommandJson: request.normalizedJson });
  return { ctx, rows, wallet, program, request, scheduled, calls, prepare, result, assess, reserve, delivered, execute };
}

describe("explicit vault claim admission", () => {
  it("queues a future-due vault immediately without altering its fixed schedule", async () => {
    const f = fixture(), due = f.program.nextProcessAt;
    await f.prepare(); await f.prepare();
    expect(f.rows.automatedFeeClaimRequests).toHaveLength(1);
    expect(f.program.workState).toBe("waiting"); expect(f.program.workDueAt).toBeLessThanOrEqual(Date.now());
    expect(f.program.nextProcessAt).toBe(due); expect(f.scheduled).toHaveLength(1);
  });
  it.each(["AUTOMATED_BUYBACK_BURN_ENABLED", "AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED", "AUTOMATED_FEE_BOT_COMMANDS_ENABLED", "X_CRYPTO_EXECUTION_ENABLED"])("respects disabled %s", async key => {
    vi.stubEnv(key, "false"); const f = fixture(); await f.prepare(); expect(f.rows.automatedFeeClaimRequests).toBeUndefined();
  });
  it.each(["confirmed", "rejected", "failed", "skipped"])("never revives a %s request", async status => {
    const f = fixture(); f.request.status = status; await f.prepare(); expect(f.scheduled).toHaveLength(0);
  });
  it("does not opt old pending claims into new wallet execution", async () => {
    const f = fixture(); delete (f.request as any).vaultClaimVersion; await f.prepare(); expect(f.scheduled).toHaveLength(0);
  });
  it.each([
    { normalizedBeneficiaryAddress: a(77) }, { privateTest: true }, { status: "exited" }, { distributionMode: "holders" },
  ])("does not trigger for unrelated/private/exited/holder programs %j", async patch => {
    const f = fixture(); Object.assign(f.program, patch); await f.prepare(); expect(f.scheduled).toHaveLength(0);
  });
  it("mere token holdings or old launch ownership never grant fee rights", async () => {
    const f = fixture(); f.program.normalizedBeneficiaryAddress = a(77);
    f.rows.walletTokenIndex = [{ walletId: "wallet", tokenAddress: a(20) }]; await f.prepare(); expect(f.scheduled).toHaveLength(0);
  });
  it("validates the persisted request's wallet owner", async () => {
    const f = fixture(); f.request.ownerXUserId = "attacker"; await expect(f.prepare()).rejects.toThrow("binding");
  });
  it("joins an active cycle once rather than creating another", async () => {
    const f = fixture(); await f.reserve(); await f.prepare(); await f.prepare();
    expect(f.rows.automatedFeeRuns).toHaveLength(1);
    expect(f.rows.automatedFeeClaimRequests[0]).toMatchObject({ status: "running", runId: f.rows.automatedFeeRuns[0]._id });
  });
  it("only queues a non-ETH pair when requested specifically", async () => {
    const f = fixture(); f.program.pairTokenAddress = a(30); f.program.normalizedPairTokenAddress = a(30);
    f.rows.tokenRegistry = [{ _id: "pair", normalizedAddress: a(30), symbol: "cbBTC", decimals: 8 }];
    await f.prepare(); expect(f.rows.automatedFeeClaimRequests[0].reason).toBe("claim_pair_individually");
    expect((await f.result()).message).toContain("claimed individually"); expect(f.program.workState).toBe("idle");
    const specific = fixture(); Object.assign(specific.program, { pairTokenAddress: a(30), normalizedPairTokenAddress: a(30) });
    specific.rows.tokenRegistry = f.rows.tokenRegistry;
    await handler(claims.prepareRequestedClaims)(specific.ctx, { requestId: specific.request.requestId, tokenAddress: a(20) });
    expect(specific.rows.automatedFeeClaimRequests[0]).toMatchObject({ status: "queued", assetSymbol: "cbBTC", assetDecimals: 8 });
  });
});

describe("threshold override and existing safety checks", () => {
  it("bypasses only the accumulation threshold for a valid claim", async () => {
    const f = fixture(); expect(BigInt(gross)).toBeLessThan(FEE_ACCUMULATION_THRESHOLD_WEI);
    await f.prepare(); expect(await f.assess()).toBe(true); await f.reserve();
    expect(f.rows.automatedFeeRuns[0].requestedClaim).toBe(true);
    expect(f.rows.automatedFeeClaimRequests[0].runId).toBe(f.rows.automatedFeeRuns[0]._id);
    expect(f.program.nextProcessAt).toBe(nextFeeCheck(f.program, Date.now()));
  });
  it("leaves ordinary scheduled cycles below threshold alone", async () => {
    const f = fixture(); expect(await f.assess()).toBe(false); expect(f.program.processingDiagnosticCode).toBe("ACCUMULATING");
  });
  it.each(["0", "1", "9999"])("does not process %s base units below the immutable contract floor", async amount => {
    const f = fixture(); await f.prepare(); expect(await f.assess(amount)).toBe(false); expect((await f.result()).pending).toBe(false);
  });
  it("reports Pons operator dependency instead of inventing a payout", async () => {
    const f = fixture(); await f.prepare(); expect(await f.assess(gross, { operatorWait: true, phase: 2, escrowAmount: "0" })).toBe(false);
    expect((await f.result()).message).toContain("waiting for Pons"); expect((await f.result()).paid).toBe(false);
  });
  it("can use already-released graduated escrow below threshold", async () => {
    const f = fixture(); await f.prepare(); expect(await f.assess(gross, { operatorWait: true, phase: 2, escrowAmount: gross, escrowValueWei: gross })).toBe(true);
  });
  it("does not let an old claimant force a cycle after reassignment", async () => {
    const f = fixture(); await f.prepare(); f.program.normalizedBeneficiaryAddress = a(77);
    expect(await f.assess()).toBe(false); expect(f.rows.automatedFeeClaimRequests[0].status).toBe("unavailable");
  });
  it("does not force cancelled claims or ones that expired before a run", async () => {
    for (const cancel of [true, false]) {
      const f = fixture(); await f.prepare();
      if (cancel) f.request.status = "rejected"; else f.rows.automatedFeeClaimRequests[0].createdAt = Date.now() - 16 * 60_000;
      expect(await f.assess()).toBe(false);
    }
  });
  it("paused vaults return an explicit unavailable outcome without a cycle", async () => {
    const f = fixture(); f.program.status = "paused"; await f.prepare(); const r = await f.result();
    expect(r.pending).toBe(false); expect(r.unavailable).toBe(true); expect(f.program.workState).toBe("idle");
  });
});

describe("confirmed net claim responses", () => {
  it("waits for delivery, then reports net amount and the exact V2 reminder", async () => {
    const f = fixture(); await f.prepare(); await f.reserve();
    Object.assign(f.rows.automatedFeeRuns[0], { beneficiaryAllocated: net, grossClaimed: gross, processingBlockNumber: "102" });
    expect((await f.result()).pending).toBe(true); expect((await f.result()).paid).toBe(false);
    await f.delivered(); const result = await f.result();
    expect(result.pending).toBe(false); expect(result.message).toContain("0.0019 ETH"); expect(result.message).not.toContain("0.002 ETH");
    expect(result.message).toContain("and burned 123 $PONSBOT.");
    expect(result.message).not.toContain("after the 95% creator allocation");
    expect(result.message).toContain(VAULT_CLAIM_REMINDER); expect(result.message).toContain(`/tx/${h(7)}`);
  });
  it("preserves legacy results and omits the reminder for mixed accounts", async () => {
    const f = fixture(); f.rows.tokenLaunches.push({ _id: "legacy", publicPublished: true, ownerXUserId: "123", tokenAddress: a(22), creatorFeeRecipient: a(99) });
    await f.prepare(); await f.delivered(); const r = await f.result("✅ Claimed 0.0004 ETH in legacy creator fees!");
    expect(r.message).toContain("0.0019 ETH"); expect(r.message).toContain("0.0004 ETH"); expect(r.message).not.toContain(VAULT_CLAIM_REMINDER);
  });
  it("never reports an allocation to a different beneficiary as received", async () => {
    const f = fixture(); await f.prepare(); await f.delivered(); f.rows.automatedFeeRuns[0].beneficiaryAddress = a(77);
    expect((await f.result()).paid).toBe(false); expect((await f.result()).pending).toBe(false);
  });
  it("reports partial completion and does not refund gas-funded quota", async () => {
    const f = fixture(); await f.prepare(); await f.delivered();
    expect((await f.result("⚠️ The legacy claim failed.")).message).toContain("legacy claim failed");
    expect(await handler(wallets.refundWalletLimitIfPreBroadcast)(f.ctx, { requestId: f.request.requestId, xUserId: "123" })).toBe(false);
  });
  it("formats a paired-asset payout in its own decimals", () => {
    const text = vaultClaimResponse([{ tokenSymbol: "TEST", assetSymbol: "cbBTC", assetDecimals: 8, amount: "19000", state: "paid" }], false);
    expect(text).toContain("0.00019 cbBTC"); expect(text).not.toContain("ETH");
  });
  it("keeps many vault payouts compact without losing totals or mixing assets", () => {
    const outcomes = Array.from({ length: 100 }, (_, i) => ({ tokenSymbol: `TOKEN${i}`, assetSymbol: "ETH", assetDecimals: 18,
      amount: net, state: "paid" as const, transactionHash: h(i + 1) }));
    const text = vaultClaimResponse([...outcomes, { tokenSymbol: "PAIRED", assetSymbol: "MSFT", assetDecimals: 18, amount: "5000000000000000000", state: "paid" }], true);
    expect(text).toContain("0.19 ETH"); expect(text).toContain("5 MSFT"); expect(text).toContain("and other launches");
    expect(text).toContain(VAULT_CLAIM_REMINDER); expect(text.length).toBeLessThan(1000);
  });
  it("seals completed explicit claims against retrying the same post", async () => {
    const f = fixture(); await f.prepare(); f.request.status = "failed";
    const { _id, status, ...args } = f.request;
    expect(await handler(wallets.reserveWalletRequest)(f.ctx, args)).toMatchObject({ inserted: false });
  });
});

describe("complete keeper cycles using mocked signer receipts", () => {
  it("stops a zero-output quote without signing, weakening minimums or repeatedly retrying", async () => {
    const f = fixture(); await f.prepare();
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      if (path.endsWith("/inspect")) return new Response(JSON.stringify({ blockNumber: "100", token: a(20), pairAsset: a(0), controller: a(99), beneficiary: a(99),
        creatorFeeRecipient: a(21), active: true, paused: false, phase: 2, executionNonce: "0", lastCurveSweepBlock: "0",
        escrowBalance: "10000", availableCreatorFees: "10000", availableCreatorFeesEthWei: "10000", escrowCreatorFeesEthWei: "10000" }));
      expect(path).toMatch(/\/authorize$/);
      return new Response(JSON.stringify({ error: "automated PONSBOT quote is below minimum output" }), { status: 400 });
    }));
    expect(await handler(engine.processProgram)(f.ctx, { programId: "p" })).toMatchObject({ status: "cycle_no_fees_or_dust" });
    expect(f.rows.automatedFeeRuns[0].status).toBe("confirmed"); expect((await f.result()).pending).toBe(false);
    expect((await f.result()).message).toContain("too small"); expect(paths).toHaveLength(2);
  });
  it.each([0, 2])("runs under-threshold phase %s through buyback, burn and delivery exactly once", async phase => {
    const f = fixture(); await f.prepare();
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any, options: any) => {
      const path = new URL(String(url)).pathname, body = JSON.parse(options.body);
      paths.push(path); const run = f.rows.automatedFeeRuns?.[0];
      let output: any;
      if (path.endsWith("/inspect")) output = { blockNumber: "100", token: a(20), pairAsset: a(0), controller: a(99), beneficiary: a(99),
        creatorFeeRecipient: a(21), active: true, paused: false, phase, executionNonce: "0", lastCurveSweepBlock: "0",
        escrowBalance: run?.processingTransactionHash ? "0" : phase === 2 || run?.sweepBlockNumber ? gross : "0",
        availableCreatorFees: gross, availableCreatorFeesEthWei: gross, escrowCreatorFeesEthWei: phase === 2 ? gross : "0" };
      else if (path.endsWith("/prepare-sweep")) output = { transactionHash: h(1), signedTransaction: "0x1234", nonce: 1 };
      else if (path.endsWith("/authorize")) output = { maxBuybackAmount: "100000000000000", minPonsbotOut: "1", minSweepBuybackTokensOut: "1",
        deadline: Math.floor(Date.now() / 1000) + 300, routeTarget: a(3), routeData: "0x", signature: "0x1234" };
      else if (path.endsWith("/prepare-delivery")) {
        expect(body.amount).toBe(net); expect(body.beneficiary).toBe(a(99));
        output = { transactionHash: h(3), signedTransaction: "0x1234", nonce: 3 };
      } else if (path.endsWith("/prepare")) output = { transactionHash: h(2), signedTransaction: "0x1234", nonce: 2 };
      else if (path.includes("/broadcast")) output = { transactionHash: body.transactionHash };
      else if (path.endsWith("/status")) output = { status: "confirmed", blockNumber: "103", gasCostWei: "10",
        ...(body.stage === "processing" ? { grossClaimed: gross, beneficiaryAllocated: net, buybackSpent: "100000000000000", ponsbotBurned: "123000000000000000000" } : {}),
        ...(body.stage === "delivery" ? { amount: net } : {}) };
      else throw new Error(`unexpected mocked endpoint ${path}`);
      return new Response(JSON.stringify(output));
    }));
    const stages: string[] = [];
    for (let i = 0; i < 8; i++) {
      const run = f.rows.automatedFeeRuns?.[0];
      if (run?.status === "confirmed") break;
      if (run) Object.assign(run, { nextRetryAt: 0, leaseUntil: 0 });
      Object.assign(f.program, { workDueAt: 0 });
      const result = await handler(engine.processProgram)(f.ctx, { programId: "p" }); stages.push(result.status);
      expect(result.status, JSON.stringify({ stages, run })).not.toBe("failed");
    }
    expect(f.rows.automatedFeeRuns).toHaveLength(1); expect(f.rows.automatedFeeRuns[0].status).toBe("confirmed");
    expect(f.program.lifetimeGrossClaimed).toBe(gross); expect(f.program.lifetimeBeneficiaryAllocated).toBe(net);
    expect((await f.result()).message).toContain("0.0019 ETH");
    expect(paths.filter(p => p.endsWith("/prepare"))).toHaveLength(1);
    expect(paths.filter(p => p.endsWith("/prepare-delivery"))).toHaveLength(1);
    expect(paths.filter(p => p.endsWith("/prepare-sweep"))).toHaveLength(phase === 0 ? 1 : 0);
    expect(await handler(engine.processProgram)(f.ctx, { programId: "p", runId: f.rows.automatedFeeRuns[0]._id })).toMatchObject({ status: "already_complete" });
  });
  it("requires a still-authorized claim at reservation for below-threshold work", async () => {
    const f = fixture(); await f.prepare(); expect(await f.assess()).toBe(true); f.request.status = "rejected";
    await expect(handler(engine.reserveProcessingRun)(f.ctx, { programId: "p", processThroughBlock: "100", executionNonce: "0",
      phaseAtReservation: 0, leaseId: "lease", now: Date.now(), requiresClaim: true })).rejects.toThrow("REQUEST_CANCELLED");
    expect(f.rows.automatedFeeRuns).toBeUndefined();
  });
});

describe("wallet action integration without X or wallet transactions", () => {
  it.each(["x", "terminal"])("admits a vault claim and waits on %s even with an empty user wallet", async source => {
    const f = fixture(); f.rows.walletRequests = [];
    Object.assign(f.request, source === "terminal" ? { requestId: "terminal:web_123456789012345678901234:event_12345678901234567890123456789012345678:claim_fees", sourcePostId: "event_12345678901234567890123456789012345678", source, channel: "terminal_chat" } : {});
    const fetcher = vi.fn(async (url: any, options: any) => {
      const body = JSON.parse(options.body);
      if (body.method === "eth_getBalance") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x0" }));
      if (String(url).endsWith("/claim-plan")) return new Response(JSON.stringify({ tokenAddresses: [] }));
      throw new Error("must not execute a wallet transaction while vault cycle is pending");
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await f.execute(); expect(result).toMatchObject({ pending: true, deferred: true, message: "" });
    expect(f.rows.automatedFeeClaimRequests).toHaveLength(1);
    expect(fetcher.mock.calls.some(([, o]) => JSON.parse(o.body).method === "eth_getBalance")).toBe(false);
    expect(f.rows.walletRateLimits[0].count).toBe(1);
    await f.execute(); expect(f.rows.walletRateLimits[0].count).toBe(1); expect(f.rows.automatedFeeClaimRequests).toHaveLength(1);
  });
  it("returns the net vault payout when legacy escrow is empty", async () => {
    const f = fixture(); await f.prepare(); await f.delivered();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "no claimable creator fees are available in ETH" }), { status: 400 })));
    const result = await f.execute(); expect(result.ok).toBe(true); expect(result.message).toContain("0.0019 ETH");
    expect(result.message).toContain(VAULT_CLAIM_REMINDER); expect(f.request.status).toBe("confirmed");
    const again = await f.execute(); expect(again.message).toBe(result.message); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not turn an unresolved specific token into claim-all", async () => {
    const f = fixture(); f.request.normalizedJson = JSON.stringify({ kind: "claim_fees", token: "NOTFOUND" });
    const result = await f.execute(); expect(result.ok).toBe(false); expect(f.rows.automatedFeeClaimRequests).toBeUndefined();
  });
});
