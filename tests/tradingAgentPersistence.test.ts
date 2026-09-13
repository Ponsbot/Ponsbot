import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agents from "../convex/tradingAgents";

type Row = Record<string, unknown> & { _id: string };
// Small deterministic persistence double; Convex itself supplies serializable mutations in deployment.
function database() {
  const tables = new Map<string, Map<string, Row>>();
  let sequence = 0;
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
  const get = (id: string) => [...tables.values()].map(t => t.get(id)).find(Boolean) ?? null;
  return {
    get: async (id: string) => get(id),
    insert: async (name: string, values: Record<string, unknown>) => {
      const id = `${name}-${++sequence}`; table(name).set(id, { ...structuredClone(values), _id: id }); return id;
    },
    patch: async (id: string, values: Record<string, unknown>) => {
      const row = get(id); if (!row) throw new Error("missing row");
      for (const [key, value] of Object.entries(values)) { if (value === undefined) delete row[key]; else row[key] = structuredClone(value); }
    },
    query: (name: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      const index = {
        eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return index; },
        lt: (key: string, value: number) => { filters.push(row => Number(row[key]) < value); return index; },
        lte: (key: string, value: number) => { filters.push(row => Number(row[key]) <= value); return index; },
      };
      let descending = false;
      const rows = () => [...table(name).values()].filter(row => filters.every(f => f(row)))
        .sort((a, b) => descending ? Number(b.createdAt) - Number(a.createdAt) : Number(a.nextRunAt ?? a.createdAt) - Number(b.nextRunAt ?? b.createdAt));
      const query = {
        withIndex: (_name: string, filter?: (builder: typeof index) => unknown) => { filter?.(index); return query; },
        order: (direction: string) => { descending = direction === "desc"; return query; },
        take: async (n: number) => rows().slice(0, n), first: async () => rows()[0] ?? null,
        paginate: async (options: { cursor: string | null; numItems: number }) => {
          const all = rows(), offset = Number(options.cursor ?? "0");
          return { page: all.slice(offset, offset + options.numItems), isDone: offset + options.numItems >= all.length,
            continueCursor: String(offset + options.numItems) };
        },
        unique: async () => { const result = rows(); if (result.length > 1) throw new Error("nonunique"); return result[0] ?? null; },
      };
      return query;
    },
  };
}
const invoke = <T = unknown>(fn: unknown, ctx: unknown, args: unknown): Promise<T> =>
  (fn as { _handler: (context: unknown, parameters: unknown) => Promise<T> })._handler(ctx, args);
const policy = { intervalMs: 60_000, maxTradeWei: "1000", maxDailyTurnoverWei: "3000", maxGasPerTradeWei: "20",
  maxDailyGasWei: "100", reserveWei: "100", maxPositions: 2, maxSlippageBps: 100, maxTradesPerDay: 5 };
const create = { ownerXUserId: "123", creationKey: "create-once", name: "Paper test", strategy: "Only platform tokens", policy, initialPaperCashWei: "10000" };
const leaseToken = "worker_token_123456789012345";
const token = `0x${"1".repeat(40)}`;
type Lease = { agent: Row; cycleId: string; cycleKey: string; leaseUntil: number; kind?: "thought" | "trade" };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
  vi.stubEnv("TRADING_AGENTS_ENABLED", "true"); vi.stubEnv("TRADING_AGENTS_PAPER_ENABLED", "true");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function setup() {
  const db = database(), ctx = { db };
  const id = await invoke<string>(agents.createPaperAgent, ctx, create);
  await invoke(agents.setPaperState, ctx, { agentId: id, ownerXUserId: "123", running: true });
  const launchId = await db.insert("tokenLaunches", { tokenAddress: token, normalizedTokenAddress: token, publicPublished: true,
    launchMode: "pons", transactionHash: `0x${"a".repeat(64)}`, symbol: "TEST", createdAt: Date.now() });
  return { db, ctx, id, launchId };
}
function completion(lease: Lease) {
  return { cycleId: lease.cycleId, leaseToken,
    decisionJson: JSON.stringify({ action: "buy", token, amount: "200", reason: "paper test" }),
    quoteJson: JSON.stringify({ chainId: 4663, agentId: lease.agent._id, cycleId: lease.cycleKey, policyVersion: lease.agent.policyVersion,
      action: "buy", token, amountIn: "200", amountOut: "5000", minAmountOut: "4990", gasWei: "10", observedAt: Date.now(), expiresAt: Date.now() + 10_000 }) };
}

describe("dormant agent persistence", () => {
  it("reserves names globally across owners and preserves idempotent creation", async () => {
    const db = database(), ctx = { db };
    const id = await invoke(agents.createPaperAgent, ctx, create);
    expect(await invoke(agents.createPaperAgent, ctx, create)).toBe(id);
    await expect(invoke(agents.createPaperAgent, ctx, { ...create, ownerXUserId: "456", creationKey: "another", name: "PAPER  TEST" })).rejects.toThrow("BOT_NAME_TAKEN");
    const result = await invoke<{ reply: string }>(agents.checkBotPost, ctx, { text: "@ponsbotfamily check on Paper test" });
    expect(result.reply).toContain("No completed trades yet");
  });
  it("status selects completed trades even after many later thought cycles", async () => {
    const { db, ctx, id } = await setup();
    const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    await invoke(agents.finishPaperCycle, ctx, completion(lease));
    await db.insert("tokenRegistry", { normalizedAddress: token, symbol: "TEST", decimals: 3 });
    for (let n = 0; n < 40; n++) await db.insert("tradingAgentCycles", { agentId: id, kind: "thought", status: "held", thought: `Observation ${n}`, createdAt: Date.now() + n + 1 });
    const result = await invoke<{ reply: string; allowLongPost: boolean }>(agents.checkBotPost, ctx, { text: "@ponsbotfamily check on paper test!" });
    expect(result.reply).toContain("Observation 39"); expect(result.reply).toContain("Paper bought 5 TEST");
    expect(result.reply).toContain("5 TEST"); expect(result.allowLongPost).toBe(true);
  });
  it("creates a draft once, never a real wallet", async () => {
    const db = database(), ctx = { db };
    const first = await invoke(agents.createPaperAgent, ctx, create), second = await invoke(agents.createPaperAgent, ctx, create);
    expect(second).toBe(first); expect(await db.get(String(first))).toMatchObject({ status: "draft", mode: "paper", portfolio: { cashWei: "10000" } });
    expect(await db.query("cryptoWallets").take(10)).toEqual([]);
    await expect(invoke(agents.createPaperAgent, ctx, { ...create, initialPaperCashWei: "20000" })).rejects.toThrow("KEY_CONFLICT");
  });
  it("blocks creation and cycles with staging disabled", async () => {
    const { ctx } = await setup(); vi.stubEnv("TRADING_AGENTS_ENABLED", "false");
    await expect(invoke(agents.createPaperAgent, ctx, { ...create, creationKey: "other" })).rejects.toThrow("DISABLED");
    await expect(invoke(agents.leaseNextPaperCycle, ctx, { leaseToken })).rejects.toThrow("DISABLED");
  });
  it("enforces owner isolation for state, reads and policy", async () => {
    const { ctx, id } = await setup();
    await expect(invoke(agents.inspect, ctx, { agentId: id, ownerXUserId: "456" })).rejects.toThrow("NOT_FOUND");
    await expect(invoke(agents.setPaperState, ctx, { agentId: id, ownerXUserId: "456", running: false })).rejects.toThrow("NOT_FOUND");
    await expect(invoke(agents.updatePaperPolicy, ctx, { agentId: id, ownerXUserId: "456", policy, strategy: "override" })).rejects.toThrow("NOT_FOUND");
  });
  it("bounds per-owner creation and never merges owners with identical names or keys", async () => {
    const { ctx } = await setup();
    for (let i = 0; i < 2; i++) await invoke(agents.createPaperAgent, ctx, { ...create, name: `Bot ${i}`, creationKey: `agent-${i}` });
    await expect(invoke(agents.createPaperAgent, ctx, { ...create, name: "Overflow", creationKey: "overflow" })).rejects.toThrow("AGENT_COUNT_LIMIT");
    await expect(invoke(agents.createPaperAgent, ctx, { ...create, ownerXUserId: "456" })).rejects.toThrow("BOT_NAME_TAKEN");
    await expect(invoke(agents.createPaperAgent, ctx, { ...create, name: "Another owner", ownerXUserId: "456" })).resolves.toBeTruthy();
  });
  it("discovery ignores generic registered stocks and paginates tied launch times without omission", async () => {
    const { ctx, db } = await setup();
    await db.insert("tokenRegistry", { symbol: "STOCK", address: `0x${"f".repeat(40)}`, active: true });
    for (let i = 2; i <= 102; i++) await db.insert("tokenLaunches", { tokenAddress: `0x${i.toString(16).padStart(40, "0")}`,
      publicPublished: true, launchMode: "pons", transactionHash: `0x${"b".repeat(64)}`, symbol: `TEST${i}`, createdAt: Date.now() });
    const first = await invoke<{ tokens: Array<{ symbol: string }>; nextCursor: string }>(agents.platformTokens, ctx, {});
    const second = await invoke<{ tokens: Array<{ symbol: string }>; nextCursor: string | null }>(agents.platformTokens, ctx, { cursor: first.nextCursor });
    expect(first.tokens).toHaveLength(100); expect(second.tokens).toHaveLength(2); expect(second.nextCursor).toBeNull();
    expect([...first.tokens, ...second.tokens].some(t => t.symbol === "STOCK")).toBe(false);
  });
  it("allows just one active lease and exactly one settlement", async () => {
    const { ctx, id, db } = await setup();
    const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    expect(await invoke(agents.leaseNextPaperCycle, ctx, { leaseToken: `${leaseToken}2` })).toBeNull();
    expect(await invoke(agents.finishPaperCycle, ctx, completion(lease))).toMatchObject({ status: "paper_filled" });
    const firstPortfolio = structuredClone((await db.get(id))?.portfolio);
    expect(await invoke(agents.finishPaperCycle, ctx, completion(lease))).toMatchObject({ status: "paper_filled" });
    expect((await db.get(id))?.portfolio).toEqual(firstPortfolio);
    expect(await db.query("walletTransactions").take(10)).toEqual([]);
    expect(await db.query("tokenActivity").take(10)).toEqual([]);
  });
  it("rejects the wrong worker lease", async () => {
    const { ctx } = await setup(); const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    await expect(invoke(agents.finishPaperCycle, ctx, { ...completion(lease), leaseToken: "other" })).rejects.toThrow("CYCLE_NOT_FOUND");
  });
  it("does not report a prior successful fill as success for different replayed instructions", async () => {
    const { ctx } = await setup(); const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    const payload = completion(lease); await invoke(agents.finishPaperCycle, ctx, payload);
    await expect(invoke(agents.finishPaperCycle, ctx, { ...payload, decisionJson: JSON.stringify({ action: "hold", reason: "different" }) }))
      .rejects.toThrow("CYCLE_COMPLETION_CONFLICT");
  });
  it("pauses even with the master off, fencing the outstanding decision", async () => {
    const { ctx, id, db } = await setup(); const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    vi.stubEnv("TRADING_AGENTS_ENABLED", "false");
    await invoke(agents.setPaperState, ctx, { agentId: id, ownerXUserId: "123", running: false });
    vi.stubEnv("TRADING_AGENTS_ENABLED", "true");
    expect(await invoke(agents.finishPaperCycle, ctx, completion(lease))).toMatchObject({ status: "abandoned" });
    expect((await db.get(id))?.portfolio).toMatchObject({ cashWei: "10000" });
  });
  it("stopping the master flag blocks a previously leased settlement", async () => {
    const { ctx, db, id } = await setup(); const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    vi.stubEnv("TRADING_AGENTS_ENABLED", "false");
    await expect(invoke(agents.finishPaperCycle, ctx, completion(lease))).rejects.toThrow("DISABLED");
    expect((await db.get(id))?.portfolio).toMatchObject({ cashWei: "10000" });
  });
  it("policy edits pause and invalidate old work without resetting budget", async () => {
    const { ctx, id, db } = await setup(); const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    await invoke(agents.updatePaperPolicy, ctx, { agentId: id, ownerXUserId: "123", policy: { ...policy, maxTradeWei: "500" }, strategy: "updated" });
    expect(await invoke(agents.finishPaperCycle, ctx, completion(lease))).toMatchObject({ status: "abandoned" });
    expect(await db.get(id)).toMatchObject({ status: "paused", portfolio: { cashWei: "10000" } });
  });
  it("recovers expired paper leases without accepting late fills", async () => {
    const { ctx } = await setup(); const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    vi.advanceTimersByTime(120_001);
    await expect(invoke(agents.finishPaperCycle, ctx, completion(lease))).rejects.toThrow("STALE_AGENT_CYCLE");
    const replacement = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken: `${leaseToken}2` });
    expect(replacement.cycleKey).not.toBe(lease.cycleKey);
    expect(await invoke(agents.finishPaperCycle, ctx, completion(lease))).toMatchObject({ status: "abandoned" });
  });
  it("rechecks launch publication at settlement", async () => {
    const { ctx, launchId, db, id } = await setup(); const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    await db.patch(launchId, { publicPublished: false });
    expect(await invoke(agents.finishPaperCycle, ctx, completion(lease))).toMatchObject({ status: "rejected" });
    expect(await db.get(lease.cycleId)).toMatchObject({ diagnosticCode: "NOT_PONS_BOT_PLATFORM_TOKEN" });
    expect((await db.get(id))?.portfolio).toMatchObject({ cashWei: "10000" });
  });
  it("does not persist invalid raw payloads or provider errors", async () => {
    const { ctx, db } = await setup(); const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    await invoke(agents.finishPaperCycle, ctx, { ...completion(lease), decisionJson: "invalid secret provider output" });
    const row = await db.get(lease.cycleId);
    expect(row).toMatchObject({ status: "rejected", diagnosticCode: "INVALID_PAPER_INPUT" });
    expect(JSON.stringify(row)).not.toContain("secret provider");
  });
  it("skips missed cadence slots after completion", async () => {
    const { ctx, id, db } = await setup(); vi.advanceTimersByTime(900_000);
    const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    await invoke(agents.finishPaperCycle, ctx, completion(lease));
    expect((await db.get(id))?.nextRunAt).toBe(Date.now() + 60_000);
    expect(await invoke(agents.leaseNextPaperCycle, ctx, { leaseToken })).toBeNull();
  });
});

describe("Bot Yard staging", () => {
  it("fences expired wallet provisioners and preserves immutable wallet bindings", async () => {
    vi.stubEnv("TRADING_AGENTS_WALLETS_ENABLED", "true");
    const { db, ctx, id } = await yard();
    const first = "provision_lease_first_12345", second = "provision_lease_second_12345";
    expect(await invoke(agents.leaseAgentProvision, ctx, { leaseToken: first })).toEqual({ agentId: id });
    expect(await invoke(agents.leaseAgentProvision, ctx, { leaseToken: second })).toBeNull();
    vi.advanceTimersByTime(300001);
    expect(await invoke(agents.leaseAgentProvision, ctx, { leaseToken: second })).toEqual({ agentId: id });
    const address = `0x${"b".repeat(40)}`;
    await expect(invoke(agents.bindAgentWallet, ctx, { agentId: id, address, leaseToken: first })).rejects.toThrow("STALE");
    await invoke(agents.bindAgentWallet, ctx, { agentId: id, address, leaseToken: second });
    expect((await db.get(id))?.walletProvisionStatus).toBe("ready");
    await expect(invoke(agents.bindAgentWallet, ctx, { agentId: id, address: `0x${"a".repeat(40)}` })).rejects.toThrow("IMMUTABLE");
  });
  it("starts only new drafts and never unpauses an existing bot on a repeated post", async () => {
    const { db, ctx, id } = await yard();
    await invoke(agents.startYardDraft, ctx, { agentId: id }); expect((await db.get(id))?.status).toBe("running");
    await invoke(agents.setPaperState, ctx, { agentId: id, ownerXUserId: "123", running: false });
    await invoke(agents.startYardDraft, ctx, { agentId: id }); expect((await db.get(id))?.status).toBe("paused");
  });
  it("keeps public data closed by default and omits private fields when enabled", async () => {
    const { ctx, id } = await yard();
    expect(await invoke(agents.publicYard, ctx, { selected: id })).toEqual({ bots: [], nextCursor: null });
    vi.stubEnv("TRADING_AGENTS_WEBSITE_ENABLED", "true");
    const result = JSON.stringify(await invoke(agents.publicYard, ctx, { selected: id }));
    expect(result).toContain("ActualCreator"); expect(result).not.toContain("ownerXUserId"); expect(result).not.toContain("leaseToken"); expect(result).not.toContain("policyVersion");
  });
  it("bounds model calls atomically and rejects stale worker authorization", async () => {
    const { ctx, id } = await yard();
    await invoke(agents.setPaperState, ctx, { agentId: id, ownerXUserId: "123", running: true });
    vi.advanceTimersByTime(900000);
    const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    const args = { cycleId: lease.cycleId, leaseToken };
    for (let n = 0; n < 160; n++) expect(await invoke(agents.reserveModelCall, ctx, args)).toBe(true);
    expect(await invoke(agents.reserveModelCall, ctx, args)).toBe(false);
    expect(await invoke(agents.reserveModelCall, ctx, { ...args, leaseToken: "wrong" })).toBe(false);
  });
  it("resolves funding to the bot wallet, using the post author as sender, without executing", async () => {
    const { db, ctx, id } = await yard();
    await db.insert("xReplyInteractions", { postId: "fund1", authorXUserId: "456", text: "@ponsbotfamily Send $20 ETH to the bot Moss" });
    expect(await invoke(agents.prepareBotFundingPost, ctx, { postId: "fund1" })).toMatchObject({ ok: false, message: expect.stringContaining("isn't ready") });
    const address = `0x${"b".repeat(40)}`;
    await db.patch(id, { walletAddress: address });
    const before = structuredClone(await db.get(id));
    expect(await invoke(agents.prepareBotFundingPost, ctx, { postId: "fund1" })).toMatchObject({ ok: true, executionEnabled: false, senderXUserId: "456", recipientAddress: address, botId: id, amount: "20", unit: "usd", asset: "ETH" });
    expect(await db.get(id)).toEqual(before);
    expect(await db.query("tradingAgentCycles").take(10)).toEqual([]);
    await db.patch(id, { walletAddress: `0x${"0".repeat(40)}` });
    expect(await invoke(agents.prepareBotFundingPost, ctx, { postId: "fund1" })).toMatchObject({ ok: false });
  });
  it("permits three X-created bots but rejects a fourth, including paused bots", async () => {
    const db = database(), ctx = { db };
    for (let i = 0; i < 4; i++) await db.insert("xReplyInteractions", { postId: `${100 + i}`, authorXUserId: "123", text: `@ponsbotfamily create a bot named Bot${i} A patient trader.` });
    for (let i = 0; i < 3; i++) {
      const id = await invoke<string>(agents.createYardBotFromPost, ctx, { postId: `${100 + i}` });
      await invoke(agents.setPaperState, ctx, { agentId: id, ownerXUserId: "123", running: false });
    }
    await expect(invoke(agents.createYardBotFromPost, ctx, { postId: "103" })).rejects.toThrow("AGENT_COUNT_LIMIT");
    await expect(invoke(agents.createYardBotFromPost, ctx, { postId: "100" })).resolves.toBeTruthy();
    await expect(invoke(agents.createPaperAgent, ctx, create)).rejects.toThrow("AGENT_COUNT_LIMIT");
  });
  async function yard() {
    const db = database(), ctx = { db };
    await db.insert("xReplyInteractions", { postId: "4567", authorXUserId: "123", text: "@ponsbotfamily create a bot named Moss A thoughtful garden bot who likes Pons Bot tokens." });
    await db.insert("xReplyUsers", { xUserId: "123", username: "ActualCreator" });
    const id = await invoke<string>(agents.createYardBotFromPost, ctx, { postId: "4567" });
    return { db, ctx, id };
  }
  it("retains the complete character brief and stores one reusable sprite per creation post", async () => {
    const { db, ctx, id } = await yard();
    const first = structuredClone(await db.get(id));
    expect(await invoke(agents.createYardBotFromPost, ctx, { postId: "4567" })).toBe(id);
    expect(await db.get(id)).toEqual(first);
    expect(first).toMatchObject({ name: "Moss", description: "A thoughtful garden bot who likes Pons Bot tokens.", status: "draft", sprite: { version: 2, archetype: "plant" }, portfolio: { cashWei: "0" } });
    expect(await db.query("cryptoWallets").take(10)).toEqual([]);
  });
  it("derives ownership from the stored X interaction", async () => {
    const { db, id, ctx } = await yard(); expect((await db.get(id))?.ownerXUserId).toBe("123");
    const detail = await invoke<{ bot: { creatorUsername: string } }>(agents.yardDetail, ctx, { agentId: id });
    expect(detail.bot.creatorUsername).toBe("ActualCreator");
    await expect(invoke(agents.createYardBotFromPost, ctx, { postId: "missing" })).rejects.toThrow("POST_NOT_FOUND");
  });
  it("prepares a creation confirmation only for a successfully created bot", async () => {
    const { ctx } = await yard();
    expect(await invoke(agents.creationReplyForPost, ctx, { postId: "4567" })).toMatchObject({
      reply: expect.stringContaining("Moss has been created!"), allowLongPost: true,
    });
    expect(await invoke(agents.creationReplyForPost, ctx, { postId: "missing" })).toBeNull();
  });
  it("prevents a second X post from creating a case-variant duplicate", async () => {
    const { db, ctx } = await yard();
    await db.insert("xReplyInteractions", { postId: "999", authorXUserId: "456", text: "@ponsbotfamily create a bot named MOSS Another personality." });
    await expect(invoke(agents.createYardBotFromPost, ctx, { postId: "999" })).rejects.toThrow("BOT_NAME_TAKEN");
    expect(await invoke(agents.checkBotPost, ctx, { text: "@ponsbotfamily check on Missing" })).toMatchObject({ reply: expect.stringContaining("couldn't find") });
  });
  it("thinks at 15 and 30 minutes, then thinks and trades separately at 45", async () => {
    const { ctx, id } = await yard();
    await invoke(agents.setPaperState, ctx, { agentId: id, ownerXUserId: "123", running: true });
    expect(await invoke(agents.leaseNextPaperCycle, ctx, { leaseToken })).toBeNull();
    for (let i = 1; i <= 3; i++) {
      vi.advanceTimersByTime(15 * 60_000);
      const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
      expect(lease.kind).toBe("thought");
      expect(await invoke(agents.finishPaperCycle, ctx, { cycleId: lease.cycleId, leaseToken, decisionJson: JSON.stringify({ thought: "Watching for activity." }) })).toMatchObject({ status: "held" });
      if (i < 3) expect(await invoke(agents.leaseNextPaperCycle, ctx, { leaseToken })).toBeNull();
    }
    const trade = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    expect(trade.kind).toBe("trade");
    await invoke(agents.finishPaperCycle, ctx, { cycleId: trade.cycleId, leaseToken, decisionJson: JSON.stringify({ action: "hold", reason: "No funds yet." }) });
    expect(await invoke(agents.leaseNextPaperCycle, ctx, { leaseToken })).toBeNull();
  });
  it("never executes a trade from a thought slot", async () => {
    const { db, ctx, id } = await yard();
    await invoke(agents.setPaperState, ctx, { agentId: id, ownerXUserId: "123", running: true }); vi.advanceTimersByTime(15 * 60_000);
    const lease = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    expect(await invoke(agents.finishPaperCycle, ctx, completion(lease))).toMatchObject({ status: "rejected" });
    expect((await db.get(id))?.portfolio).toMatchObject({ cashWei: "0", trades: 0 });
  });
  it("does not accelerate failed trade slots through lease retries", async () => {
    const { db, ctx, id } = await yard();
    await invoke(agents.setPaperState, ctx, { agentId: id, ownerXUserId: "123", running: true }); vi.advanceTimersByTime(45 * 60_000);
    const thought = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken });
    await invoke(agents.finishPaperCycle, ctx, { cycleId: thought.cycleId, leaseToken, decisionJson: JSON.stringify({ thought: "Ready to check." }) });
    const trade = await invoke<Lease>(agents.leaseNextPaperCycle, ctx, { leaseToken }); expect(trade.kind).toBe("trade");
    vi.advanceTimersByTime(120_001);
    expect(await invoke(agents.leaseNextPaperCycle, ctx, { leaseToken })).toBeNull();
    expect(await db.get(trade.cycleId)).toMatchObject({ status: "abandoned" });
    expect((await db.get(id))?.schedule).toMatchObject({ nextTradeAt: Date.parse("2026-09-12T13:30:00Z") });
  });
  it("does not expose internal identity, policy, or worker data in Yard DTOs", async () => {
    const { ctx, id } = await yard();
    const listing = await invoke<{ bots: Array<{ id: string }> }>(agents.yardList, ctx, {});
    expect(listing.bots[0].id).toBe(id);
    expect(JSON.stringify(listing)).not.toMatch(/ownerXUserId|leaseToken|creationKey|initialPaperCash|policyVersion/);
    const detail = await invoke(agents.yardDetail, ctx, { agentId: id });
    expect(JSON.stringify(detail)).not.toMatch(/ownerXUserId|leaseToken|creationKey|initialPaperCash|policyVersion/);
  });
});
