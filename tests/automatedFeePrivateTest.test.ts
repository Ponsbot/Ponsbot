import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automatedFeeEngineConfiguration, automatedFeeEnrollmentAllowed, automatedFeeProcessingAllowed, automatedFeeProofMessage, automatedFeeBroadcastPayload } from "../lib/automated-fee-policy";
import { automatedFeeBroadcastRequestSchema } from "../lib/wallet-signer/policy";
import type { AutomatedFeeEngineEnvironment } from "../lib/automated-fee-policy";
import { preparePrivateTestProgram, processProgram, reserveProcessingRun, finalizeDeliveredRun, registerPrivateTestLaunch, prepareOperatorUpgradeProgram, pausePrivateTestForExit, prepareExistingLaunchUpgrade } from "../convex/automatedFeeEngine";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const token = address(30), vault = address(31);
const privateTestLauncher = address(98);
const input = { tokenAddress: token, vaultAddress: vault, deploymentSalt: `0x${"1".repeat(64)}`,
  launchTransactionHash: `0x${"2".repeat(64)}`, vaultTransactionHash: `0x${"3".repeat(64)}` };
// Convex exposes the original handler for unit testing without a deployment.
const handler = (fn: unknown) => (fn as { _handler: (ctx: any, args: any) => Promise<any> })._handler;
function database() {
  const rows: Record<string, any[]> = {};
  const db = {
    query: vi.fn((table: string) => {
      const query: any = { withIndex: () => query, filter: () => query, collect: async () => rows[table] ?? [],
        first: async () => rows[table]?.[0] ?? null, unique: async () => rows[table]?.[0] ?? null };
      return query;
    }),
    get: vi.fn(async (id: string) => Object.values(rows).flat().find((r) => r._id === id) ?? null),
    insert: vi.fn(async (table: string, value: any) => {
      const _id = `${table}-${(rows[table]?.length ?? 0) + 1}`;
      (rows[table] ??= []).push({ _id, ...value }); return _id;
    }),
    patch: vi.fn(async (id: string, patch: any) => {
      const row = Object.values(rows).flat().find((r) => r._id === id);
      if (!row) throw new Error("missing row"); Object.assign(row, patch);
    }),
  };
  return { db, rows, scheduler: { runAfter: vi.fn(async () => "mock-job") } };
}

beforeEach(() => {
  const contracts = ["VAULT_FACTORY", "VAULT_IMPLEMENTATION", "EXECUTION_ADAPTER", "NATIVE_BUYBACK_EXECUTOR",
    "PAIRED_BUYBACK_EXECUTOR", "ADMIN", "KEEPER", "QUOTE_AUTHORIZER", "PAUSE_GUARDIAN", "CONTROL", "V3_ROUTER", "V3_QUOTER", "WETH"];
  contracts.forEach((key, index) => vi.stubEnv(`AUTOMATED_FEE_${key}_ADDRESS`, address(index + 1)));
  for (const role of ["QUOTE", "KEEPER", "ADMIN"]) vi.stubEnv(`AUTOMATED_FEE_${role}_CDP_ACCOUNT_NAME`, `test-${role}`);
  vi.stubEnv("AUTOMATED_FEE_ENROLLMENT_SECRET", "unit-test-secret");
  vi.stubEnv("AUTOMATED_FEE_PRIVATE_TEST_LAUNCHER_ADDRESS", privateTestLauncher);
  vi.stubEnv("AUTOMATED_BUYBACK_BURN_ENABLED", "true");
  vi.stubEnv("AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED", "true");
  for (const feature of ["NEW_LAUNCH_ENROLLMENT", "EXISTING_LAUNCH_UPGRADE", "BOT_COMMANDS", "MANUAL_TEST"]) {
    vi.stubEnv(`AUTOMATED_FEE_${feature}_ENABLED`, "false");
  }
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("private scheduled-engine test enrollment", () => {
  it("passes strict broadcast validation while excluding prepare-only metadata", () => {
    const prepared = { transactionHash: input.launchTransactionHash, signedTransaction: "0x1234", from: address(1), to: vault, nonce: 7 };
    expect(automatedFeeBroadcastRequestSchema.safeParse({ ...prepared, vaultAddress: vault }).success).toBe(false);
    expect(automatedFeeBroadcastRequestSchema.parse(automatedFeeBroadcastPayload(prepared, vault))).toEqual({
      transactionHash: input.launchTransactionHash, signedTransaction: "0x1234", vaultAddress: vault,
    });
  });
  it("signs the exact path format used by the existing signer route verifier", () => {
    const expected = `1788045000000:v1/automated-fees/verify-enrollment:${vault}:body-digest`;
    expect(automatedFeeProofMessage("1788045000000", "/v1/automated-fees/verify-enrollment", vault.toUpperCase(), "body-digest")).toBe(expected);
    expect(automatedFeeProofMessage("1788045000000", "v1/automated-fees/verify-enrollment", vault, "body-digest")).toBe(expected);
  });
  it("continues processing without enabling public enrollment", () => {
    const config = automatedFeeEngineConfiguration(process.env as AutomatedFeeEngineEnvironment);
    expect(automatedFeeProcessingAllowed(config)).toBe(true);
    expect(automatedFeeEnrollmentAllowed(config, token, "new_launch", true, true)).toBe(false);
    expect(automatedFeeEnrollmentAllowed(config, token, "upgrade", true, true)).toBe(false);
  });
  it("creates only a private program with a fixed test beneficiary, and retries idempotently", async () => {
    const ctx = database();
    const id = await handler(preparePrivateTestProgram)(ctx, input);
    expect(await handler(preparePrivateTestProgram)(ctx, input)).toBe(id);
    expect(ctx.db.insert).toHaveBeenCalledTimes(1);
    expect(Object.keys(ctx.rows)).toEqual(["automatedFeePrograms"]);
    expect(ctx.rows.automatedFeePrograms[0]).toMatchObject({ privateTest: true, status: "prepared", buybackBps: 500,
      controllerAddress: privateTestLauncher, beneficiaryAddress: privateTestLauncher });
    expect(ctx.rows.automatedFeePrograms[0].launchId).toBeUndefined();
    expect(ctx.rows.automatedFeePrograms[0].nextProcessAt).toBeUndefined();
  });
  it("does not replace existing public entries or another enrollment", async () => {
    const ctx = database();
    ctx.rows.tokenLaunches = [{ _id: "launch" }];
    await expect(handler(preparePrivateTestProgram)(ctx, input)).rejects.toThrow("public index");
    ctx.rows.tokenLaunches = [];
    await handler(preparePrivateTestProgram)(ctx, input);
    await expect(handler(preparePrivateTestProgram)(ctx, { ...input, deploymentSalt: `0x${"4".repeat(64)}` })).rejects.toThrow("identity conflict");
  });
  it("leaves legitimate buyer tracking intact without publishing a launch", async () => {
    const ctx = database();
    ctx.rows.walletTokenIndex = [{ _id: "buyer-holding", symbol: "TEST", involvedByTransaction: true }];
    await handler(preparePrivateTestProgram)(ctx, input);
    expect(ctx.rows.walletTokenIndex).toEqual([{ _id: "buyer-holding", symbol: "TEST", involvedByTransaction: true }]);
    expect(ctx.rows.tokenLaunches).toBeUndefined();
    expect(ctx.rows.tokenRegistry).toBeUndefined();
  });
  it.each(["NEW_LAUNCH_ENROLLMENT", "EXISTING_LAUNCH_UPGRADE", "BOT_COMMANDS", "MANUAL_TEST"])("rejects private registration if %s is enabled", async (feature) => {
    vi.stubEnv(`AUTOMATED_FEE_${feature}_ENABLED`, "true");
    await expect(handler(preparePrivateTestProgram)(database(), input)).rejects.toThrow("switches off");
  });
  it("uses the standard receipt/on-chain verification before final enrollment", async () => {
    const ctx = { runMutation: vi.fn(async () => "private-program"), runQuery: vi.fn(async () => ({ program: { status: "prepared" } })), runAction: vi.fn(async () => {}) };
    expect(await handler(registerPrivateTestLaunch)(ctx, input)).toMatchObject({ status: "privately_enrolled_for_scheduled_processing" });
    expect(ctx.runAction).toHaveBeenCalledWith(expect.anything(), { programId: "private-program",
      deploymentTransactionHash: input.vaultTransactionHash, enrollmentTransactionHash: input.launchTransactionHash });
  });
  it("reserves a normal processing run with enrollment switches off", async () => {
    const ctx = database();
    const id = await handler(preparePrivateTestProgram)(ctx, input);
    await ctx.db.patch(id, { status: "enrolled" });
    expect(await handler(reserveProcessingRun)(ctx, { programId: id, processThroughBlock: "123", executionNonce: "0", phaseAtReservation: 0, leaseId: "test", now: Date.now() })).toMatchObject({ created: true });
  });
  it("stops before signer calls when the processing switch is off", async () => {
    vi.stubEnv("AUTOMATED_FEE_SWEEP_BUYBACK_BURN_ENABLED", "false");
    expect(await handler(processProgram)({}, { programId: "test" })).toEqual({ status: "processing_disabled" });
    await expect(handler(preparePrivateTestProgram)(database(), input)).rejects.toThrow("switches off");
  });
  it("continues a submitted processing transaction even after it has emptied escrow", async () => {
    const db = database();
    await handler(preparePrivateTestProgram)(db, input);
    const program = { ...db.rows.automatedFeePrograms[0], status: "enrolled" };
    const run = { _id: "run", programId: program._id, status: "submitted", sweepTransactionHash: input.vaultTransactionHash,
      sweepBroadcastAt: Date.now(), sweepBlockNumber: "120", processingTransactionHash: input.launchTransactionHash,
      processingBroadcastAt: Date.now(), processingTransactionNonce: 1 };
    vi.stubEnv("WALLET_SIGNER_URL", "https://signer.example/api/wallet-signer");
    vi.stubEnv("WALLET_SIGNER_TOKEN", "test-only");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requests.push(url);
      return new Response(JSON.stringify(url.endsWith("/inspect") ? {
        blockNumber: "125", token, pairAsset: program.pairTokenAddress, controller: program.controllerAddress,
        beneficiary: program.beneficiaryAddress, creatorFeeRecipient: vault, active: true, paused: false,
        phase: 0, escrowBalance: "0", executionNonce: "1",
      } : { status: "pending" }));
    }));
    const ctx = { runQuery: vi.fn(async () => ({ program, run })), runMutation: vi.fn(async () => ({ manualReview: false })),
      scheduler: { runAfter: vi.fn(async () => "scheduled") } };
    expect(await handler(processProgram)(ctx, { programId: program._id, runId: run._id })).toEqual({ status: "processing_pending", runId: "run" });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatch(/\/status$/);
  });
  it("keeps private accounting out of platform totals", async () => {
    const ctx = database();
    const programId = await handler(preparePrivateTestProgram)(ctx, input);
    const runId = await ctx.db.insert("automatedFeeRuns", { programId, status: "submitted", workflowStage: "delivery_confirmed",
      grossClaimed: "100", beneficiaryAllocated: "95", buybackSpent: "5", ponsbotBurned: "8", deliveryBlockNumber: "123", beneficiaryDelivered: "95" });
    await handler(finalizeDeliveredRun)(ctx, { runId, deliveryBlockNumber: "123", beneficiaryDelivered: "95" });
    expect(ctx.rows.automatedFeePrograms[0].lifetimePonsbotBurned).toBe("8");
    expect(ctx.rows.automatedFeeEngineState).toBeUndefined();
    expect(ctx.rows.automatedFeeAssetTotals).toBeUndefined();
  });
  it("adds public cycle burns once per confirmed delivery without losing precision", async () => {
    const ctx = database();
    const programId = await ctx.db.insert("automatedFeePrograms", {
      privateTest: false, normalizedPairTokenAddress: address(0), pairTokenAddress: address(0),
    });
    const amount = "123456789012345678901";
    const runId = await ctx.db.insert("automatedFeeRuns", { programId, status: "submitted", workflowStage: "delivery_confirmed",
      grossClaimed: "100", beneficiaryAllocated: "95", buybackSpent: "5", ponsbotBurned: amount, deliveryBlockNumber: "123", beneficiaryDelivered: "95" });
    expect(ctx.rows.automatedFeeEngineState).toBeUndefined();
    await handler(finalizeDeliveredRun)(ctx, { runId, deliveryBlockNumber: "123", beneficiaryDelivered: "95" });
    expect(ctx.rows.automatedFeeEngineState[0].lifetimePonsbotBurned).toBe(amount);
    await expect(handler(finalizeDeliveredRun)(ctx, { runId, deliveryBlockNumber: "123", beneficiaryDelivered: "95" }))
      .rejects.toThrow("not ready to finalize");
    expect(ctx.rows.automatedFeeEngineState[0].lifetimePonsbotBurned).toBe(amount);
  });
});

describe("public upgrade live authority", () => {
  const controller = address(70), pair = address(71);
  const args = { launchId: "legacy-launch", requestId: "post-1", controllerAddress: controller,
    beneficiaryAddress: controller, pairTokenAddress: pair, ponsFactoryAddress: address(72) };
  function setup(live: Record<string, unknown>) {
    vi.stubEnv("AUTOMATED_FEE_EXISTING_LAUNCH_UPGRADE_ENABLED", "true");
    vi.stubEnv("AUTOMATED_FEE_BOT_COMMANDS_ENABLED", "true");
    vi.stubEnv("WALLET_SIGNER_URL", "https://signer.example/api/wallet-signer");
    vi.stubEnv("WALLET_SIGNER_TOKEN", "test-only");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith("/holder-distributor") ? live : { vaultAddress: vault },
    ))));
    return { runQuery: vi.fn().mockResolvedValueOnce({ launch: { tokenAddress: token, poolAddress: address(73),
      normalizedCreatorFeeRecipient: address(74) } })
      .mockResolvedValueOnce({ contracts: { pons_holder_distributor_factory: address(75) } }).mockResolvedValue(null),
      runMutation: vi.fn(async () => "new-program"), scheduler: { runAfter: vi.fn(async () => "scheduled") } };
  }
  it("allows the current on-chain fee owner even when the cached owner is old", async () => {
    const ctx = setup({ exists: true, creatorFeeRecipient: controller, pairToken: pair, distributor: null });
    expect(await handler(prepareExistingLaunchUpgrade)(ctx, args)).toEqual({ programId: "new-program", vaultAddress: vault, alreadyEnrolled: false });
    expect(ctx.runMutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ controllerAddress: controller, beneficiaryAddress: controller }));
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
  });
  it.each(["wrong-owner", "holder-sharing", "wrong-pair", "missing-launch", "different-beneficiary"])("stops %s before reserving or scheduling a vault", async (scenario) => {
    const live = { exists: true, creatorFeeRecipient: controller, pairToken: pair, distributor: null as string | null };
    if (scenario === "wrong-owner") live.creatorFeeRecipient = address(74);
    if (scenario === "holder-sharing") live.distributor = controller;
    if (scenario === "wrong-pair") live.pairToken = address(99);
    if (scenario === "missing-launch") live.exists = false;
    const ctx = setup(live);
    await expect(handler(prepareExistingLaunchUpgrade)(ctx, { ...args, ...(scenario === "different-beneficiary" ? { beneficiaryAddress: address(99) } : {}) })).rejects.toThrow();
    expect(ctx.runMutation).not.toHaveBeenCalled();
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
});

describe("private test exit isolation", () => {
  const owner = privateTestLauncher;
  const args = { tokenAddress: token, vaultAddress: vault, controllerAddress: owner };
  async function fixture() {
    const ctx = database();
    const id = await handler(preparePrivateTestProgram)(ctx, input);
    await ctx.db.patch(id, { status: "enrolled", nextProcessAt: Date.now() });
    ctx.db.patch.mockClear();
    return { ctx, id };
  }
  it("stops the test atomically and prevents a new processing reservation", async () => {
    const { ctx, id } = await fixture();
    ctx.rows.automatedFeePrograms.push({ _id: "other", status: "enrolled", nextProcessAt: 123 });
    expect(await handler(pausePrivateTestForExit)(ctx, args)).toEqual({ programId: id, status: "paused" });
    expect(ctx.rows.automatedFeePrograms[0].nextProcessAt).toBeUndefined();
    expect(ctx.rows.automatedFeePrograms[1]).toEqual({ _id: "other", status: "enrolled", nextProcessAt: 123 });
    await expect(handler(reserveProcessingRun)(ctx, { programId: id })).rejects.toThrow("not executable");
    expect(await handler(pausePrivateTestForExit)(ctx, args)).toEqual({ programId: id, status: "paused" });
  });
  it.each(["public-program", "wrong-wallet", "wrong-vault", "active-run", "controller-change"])("refuses %s without mutation", async (scenario) => {
    const { ctx } = await fixture();
    const request = { ...args };
    if (scenario === "public-program") ctx.rows.automatedFeePrograms[0].launchId = "public-launch";
    if (scenario === "wrong-wallet") request.controllerAddress = address(99);
    if (scenario === "wrong-vault") request.vaultAddress = address(99);
    if (scenario === "active-run") ctx.rows.automatedFeeRuns = [{ status: "submitted" }];
    if (scenario === "controller-change") ctx.rows.automatedFeeControllerChanges = [{ status: "reserved" }];
    await expect(handler(pausePrivateTestForExit)(ctx, request)).rejects.toThrow();
    expect(ctx.db.patch).not.toHaveBeenCalled();
  });
});

describe("operator-staged legacy upgrades", () => {
  const controller = address(40);
  const args = { tokenAddress: token, controllerAddress: controller, vaultAddress: vault,
    deploymentSalt: input.deploymentSalt, requestId: "operator-test", leaseToken: "lease" };
  function fixture() {
    const ctx = database();
    ctx.rows.tokenLaunches = [{ _id: "launch", publicPublished: true, poolAddress: address(50), normalizedCreatorFeeRecipient: controller }];
    ctx.rows.cryptoWallets = [{ _id: "wallet", status: "active", chainId: 4663, signerWalletRef: controller }];
    ctx.rows.walletExecutionLocks = [{ _id: "lock", requestId: args.requestId, leaseToken: args.leaseToken, leaseUntil: Date.now() + 60_000 }];
    return ctx;
  }
  it("preserves the controlling wallet and waits for operator receipts before processing", async () => {
    const ctx = fixture();
    const id = await handler(prepareOperatorUpgradeProgram)(ctx, args);
    expect(ctx.rows.automatedFeePrograms[0]).toMatchObject({ _id: id, launchId: "launch", status: "prepared", enrollmentSource: "upgrade", controllerAddress: controller, beneficiaryAddress: controller });
    expect(ctx.rows.automatedFeePrograms[0].nextEnrollmentAttemptAt).toBeUndefined();
    expect(ctx.rows.automatedFeePrograms[0].nextProcessAt).toBeUndefined();
    expect(await handler(prepareOperatorUpgradeProgram)(ctx, args)).toBe(id);
    expect(ctx.db.insert).toHaveBeenCalledTimes(1);
  });
  it.each(["wrong-controller", "holder-sharing", "frozen-wallet", "missing-lease", "expired-lease"])("rejects %s", async (scenario) => {
    const ctx = fixture();
    if (scenario === "wrong-controller") ctx.rows.tokenLaunches[0].normalizedCreatorFeeRecipient = address(60);
    if (scenario === "holder-sharing") ctx.rows.tokenLaunches[0].holderFeeSharing = true;
    if (scenario === "frozen-wallet") ctx.rows.cryptoWallets[0].status = "frozen";
    if (scenario === "missing-lease") ctx.rows.walletExecutionLocks = [];
    if (scenario === "expired-lease") ctx.rows.walletExecutionLocks[0].leaseUntil = Date.now() - 1;
    await expect(handler(prepareOperatorUpgradeProgram)(ctx, args)).rejects.toThrow();
    expect(ctx.db.insert).not.toHaveBeenCalled();
  });
  it("cannot run with the master disabled", async () => {
    vi.stubEnv("AUTOMATED_BUYBACK_BURN_ENABLED", "false");
    await expect(handler(prepareOperatorUpgradeProgram)(fixture(), args)).rejects.toThrow("operator staging");
  });
});
