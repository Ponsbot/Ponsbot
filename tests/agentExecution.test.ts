import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/wallet-signer/service", () => ({ broadcastTransaction: vi.fn(), prepareExecutionEnvelope: vi.fn(), provisionWallet: vi.fn(), signPreparedEnvelope: vi.fn() }));
import { runBotExecution, type ExecutionDependencies, type ExecutionStore } from "../lib/wallet-signer/agent-execution";
import { ownerBotIntent, ownerBotExecutionEnabled, type BotExecution } from "../lib/trading-agents/execution";
import { create, save } from "../convex/tradingAgentExecution";
const invoke = (fn: unknown, ctx: unknown, args: unknown): Promise<unknown> => (fn as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> })._handler(ctx, args);
const from = `0x${"1".repeat(40)}`, destination = `0x${"2".repeat(40)}`;
const envelope = { unsignedTransaction: "0x0200", toAddress: destination, nonce: 3, valueWei: "10", approval: false };
const signed = { transactionHash: `0x${"a".repeat(64)}`, signedTransaction: "0x0201" };
let job: BotExecution;
let store: ExecutionStore, deps: ExecutionDependencies;
beforeEach(() => {
  job = { _id: "job123456789", agentId: "agent12345678", ownerXUserId: "123", from, destination, intentJson: JSON.stringify({ kind: "withdraw", amount: "0.01" }), state: "active", step: 0, hashes: [] };
  store = { read: vi.fn(async () => structuredClone(job)), save: vi.fn(async (step, kind, value) => {
    if (step !== job.step || job.state !== "active") return false;
    if (kind === "envelope") job.envelopeJson ??= value;
    if (kind === "signed") job.signedJson ??= value;
    if (kind === "receipt") job.state = JSON.parse(value).success ? "confirmed" : "failed";
    if (kind === "failure" && !job.envelopeJson) job.state = "failed";
    return true;
  }) };
  deps = { prepare: vi.fn(async () => envelope), sign: vi.fn(async () => signed), broadcast: vi.fn(async () => ({})), receipt: vi.fn(async () => null) };
});
afterEach(() => vi.unstubAllEnvs());
describe("dedicated bot execution recovery", () => {
  it("persists unsigned and signed payloads before broadcasting", async () => {
    deps.sign = vi.fn(async () => { expect(job.envelopeJson).toBeDefined(); return signed; });
    deps.broadcast = vi.fn(async () => { expect(JSON.parse(job.signedJson!)).toEqual(signed); });
    await runBotExecution(store, deps);
    expect(deps.broadcast).toHaveBeenCalledOnce();
  });
  it("does not broadcast when persisting the signature fails", async () => {
    store.save = vi.fn(async (_step, kind, value) => { if (kind === "envelope") job.envelopeJson = value; else throw new Error("timeout"); });
    await expect(runBotExecution(store, deps)).rejects.toThrow("timeout");
    expect(deps.broadcast).not.toHaveBeenCalled();
  });
  it("retries the exact persisted envelope after an uncertain signature", async () => {
    deps.sign = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(signed);
    await expect(runBotExecution(store, deps)).rejects.toThrow();
    await runBotExecution(store, deps);
    expect(deps.prepare).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.sign).mock.calls[0][1]).toEqual(vi.mocked(deps.sign).mock.calls[1][1]);
  });
  it("reuses signed bytes after broadcast timeout without preparing or signing again", async () => {
    deps.broadcast = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({});
    await expect(runBotExecution(store, deps)).rejects.toThrow();
    await runBotExecution(store, deps);
    expect(deps.prepare).toHaveBeenCalledOnce(); expect(deps.sign).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.broadcast).mock.calls[1][2]).toEqual(signed);
  });
  it("reconciles an existing receipt without rebroadcast", async () => {
    job.envelopeJson = JSON.stringify(envelope); job.signedJson = JSON.stringify(signed);
    deps.receipt = vi.fn(async () => ({ success: true, block: "20" }));
    await runBotExecution(store, deps); expect(job.state).toBe("confirmed"); expect(deps.broadcast).not.toHaveBeenCalled();
  });
  it("leaves an uncertain receipt locked", async () => {
    deps.receipt = vi.fn().mockRejectedValue(new Error("RPC timeout"));
    await expect(runBotExecution(store, deps)).rejects.toThrow(); expect(job.state).toBe("active");
  });
  it("does nothing for completed transactions", async () => {
    job.state = "confirmed"; await runBotExecution(store, deps); expect(deps.prepare).not.toHaveBeenCalled();
  });
  it("retries a lagging RPC after a confirmed approval", async () => {
    deps.prepare = vi.fn().mockRejectedValue(new Error("AGENT_RPC_BEHIND"));
    await runBotExecution(store, deps); expect(job.state).toBe("active"); expect(deps.sign).not.toHaveBeenCalled();
  });
});
describe("owner operation boundaries", () => {
  it.each(["-1", "0", "1e3", "NaN", "1.0000000000000000001", "100%"])("rejects invalid withdrawal %s", amount => {
    expect(ownerBotIntent.safeParse({ kind: "withdraw", amount }).success).toBe(false);
  });
  it("rejects supplied recipient, arbitrary calldata, buys and non-contract tickers", () => {
    expect(ownerBotIntent.safeParse({ kind: "withdraw", amount: "1", recipient: from }).success).toBe(false);
    expect(ownerBotIntent.safeParse({ kind: "sell", token: from, data: "0x" }).success).toBe(false);
    expect(ownerBotIntent.safeParse({ kind: "buy", token: from }).success).toBe(false);
    expect(ownerBotIntent.safeParse({ kind: "sell", token: "PONSBOT" }).success).toBe(false);
  });
  it("is disabled by default and needs both flags", () => {
    expect(ownerBotExecutionEnabled({})).toBe(false);
    expect(ownerBotExecutionEnabled({ TRADING_AGENTS_OWNER_EXECUTION_ENABLED: "true" })).toBe(false);
  });
  it("never releases a lock on a timeout after envelope persistence", async () => {
    vi.stubEnv("WALLET_SIGNER_TOKEN", "test"); job.envelopeJson = JSON.stringify(envelope);
    const patch = vi.fn();
    expect(await invoke(save, { db: { get: async () => job, patch } }, { secret: "test", jobId: job._id, step: 0, kind: "failure", value: "timeout" })).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });
  it("rejects a different owner before reserving or scheduling anything", async () => {
    vi.stubEnv("TRADING_AGENTS_ENABLED", "true"); vi.stubEnv("TRADING_AGENTS_OWNER_EXECUTION_ENABLED", "true");
    const insert = vi.fn();
    await expect(invoke(create, { db: { get: async () => ({ ownerXUserId: "999" }), insert } }, { agentId: job.agentId, ownerXUserId: "123", requestKey: "test-key-123456789", intentJson: job.intentJson })).rejects.toThrow("AGENT_NOT_FOUND");
    expect(insert).not.toHaveBeenCalled();
  });
  it("rejects unsigned journal access without signer authority", async () => {
    vi.stubEnv("WALLET_SIGNER_TOKEN", "test");
    await expect(invoke(save, {}, { secret: "wrong", jobId: job._id, step: 0, kind: "failure", value: "failed" })).rejects.toThrow("UNAUTHORIZED");
  });
  it("advances a confirmed approval with a nonce floor and schedules the sale", async () => {
    vi.stubEnv("WALLET_SIGNER_TOKEN", "test");
    job.envelopeJson = JSON.stringify({ ...envelope, approval: true }); job.signedJson = JSON.stringify(signed);
    const patch = vi.fn(), runAfter = vi.fn();
    await invoke(save, { db: { get: async () => job, patch }, scheduler: { runAfter } }, { secret: "test", jobId: job._id, step: 0, kind: "receipt", value: JSON.stringify({ success: true, block: "200" }) });
    expect(patch.mock.calls[0][1]).toMatchObject({ step: 1, envelopeJson: undefined, signedJson: undefined, minimumNonce: 4, confirmedBlock: "200" });
    expect(runAfter).toHaveBeenCalledOnce();
  });
  it("does not advance or schedule after a reverted approval", async () => {
    vi.stubEnv("WALLET_SIGNER_TOKEN", "test");
    job.envelopeJson = JSON.stringify({ ...envelope, approval: true }); job.signedJson = JSON.stringify(signed);
    const patch = vi.fn(), runAfter = vi.fn();
    await invoke(save, { db: { get: async () => job, patch }, scheduler: { runAfter } }, { secret: "test", jobId: job._id, step: 0, kind: "receipt", value: JSON.stringify({ success: false, block: "200" }) });
    expect(patch.mock.calls[0][1].state).toBe("failed"); expect(runAfter).not.toHaveBeenCalled();
  });
  it("rejects a delayed write from a previous step", async () => {
    vi.stubEnv("WALLET_SIGNER_TOKEN", "test"); job.step = 1;
    const patch = vi.fn();
    expect(await invoke(save, { db: { get: async () => job, patch } }, { secret: "test", jobId: job._id, step: 0, kind: "signed", value: JSON.stringify(signed) })).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });
  it("cannot change the first persisted unsigned envelope", async () => {
    vi.stubEnv("WALLET_SIGNER_TOKEN", "test"); job.envelopeJson = JSON.stringify(envelope);
    const patch = vi.fn();
    expect(await invoke(save, { db: { get: async () => job, patch } }, { secret: "test", jobId: job._id, step: 0, kind: "envelope", value: JSON.stringify({ ...envelope, nonce: 7 }) })).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });
});
