import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { reserveTurn, saveTurn, attachPrompt, isContinuation, queueExecution, handle, resolveContext, execute, executionContext, persistSteps, retryRevertedOpen, executionHeartbeat, deferExecution, finishExecution, recoverExecutions, reserveDelivery, settleDelivery, deliverExecution, health, monitorHealth } from "../convex/liquidity";
import { getFunctionName } from "convex/server";
import { guardThread } from "../convex/liquidity";
import { executionWritesEnabled } from "../convex/liquidity";
import { LIQUIDITY_TERMINAL_TEST_OWNER, LIQUIDITY_TERMINAL_TEST_WALLET, LIQUIDITY_TEST_OWNER, LIQUIDITY_TEST_WALLET } from "./liquidityFixtures";
import { serializeTransaction, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";
import { LIQUIDITY_TOTAL_ATTEMPTS } from "../lib/liquidity-recovery";
vi.mock("../convex/llm", () => ({ openRouter: vi.fn() }));
const chain = vi.hoisted(() => ({ getTransactionReceipt: vi.fn(), getTransaction: vi.fn() }));
vi.mock("../lib/liquidity-markets", () => ({ liquidityRpc: () => chain, discoverLiquidityPools: vi.fn() }));
import { openRouter } from "../convex/llm";
import { discoverLiquidityPools } from "../lib/liquidity-markets";
import { newLiquidityDraft } from "../lib/liquidity-workflow";
import { liquidityPoolId, liquidityPoolKey, prepareLiquidityOpen, prepareLiquidityClaim, prepareLiquidityClose } from "../lib/liquidity-contracts";
import { recordTerminalMessage } from "../convex/wallets";
// Test the actual Convex handlers against a small indexed in-memory store.
// No deployment, network, AI, wallet, or X publication is involved.
type Row = Record<string, any>; // Test-only fake database records.
function store() {
  const data = new Map<string, Row>(); let sequence = 0;
  const reads = { paginateCalls: 0, positionRows: 0, indexes: [] as string[] };
  const beginCall = () => { reads.paginateCalls = 0; reads.positionRows = 0; reads.indexes = []; };
  const db = {
    async get(id: string) { return data.get(id) ?? null; },
    async insert(table: string, value: Row) { const id = `${table}:${++sequence}`; data.set(id, { ...value, _id: id, _creationTime: sequence }); return id; },
    async patch(id: string, value: Row) { Object.assign(data.get(id)!, value); },
    query(table: string) {
      const predicates: Array<(row: Row) => boolean> = []; let descending = false;
      const index = {
        eq(key: string, value: unknown) { predicates.push(row => row[key] === value); return index; },
        gt(key: string, value: number) { predicates.push(row => row[key] > value); return index; },
        lte(key: string, value: number) { predicates.push(row => row[key] <= value); return index; },
      };
      const rows = () => [...data.values()].filter(row => String(row._id).startsWith(`${table}:`) && predicates.every(test => test(row))).sort((a, b) => descending ? b._creationTime - a._creationTime : a._creationTime - b._creationTime);
      const query = {
        withIndex(name: string, fn: (q: typeof index) => unknown) { reads.indexes.push(`${table}:${name}`); fn(index); return query; },
        order(direction: string) { descending = direction === "desc"; return query; },
        async unique() { const values = rows(); if (values.length > 1) throw new Error("not unique"); return values[0] ?? null; },
        async first() { return rows()[0] ?? null; }, async take(n: number) { return rows().slice(0, n); },
        async paginate({ numItems, cursor }: { numItems: number; cursor: string | null }) {
          if (++reads.paginateCalls > 1) throw new Error("Only one paginated query is allowed per Convex function");
          const offset = Number(cursor || 0), all = rows(); return { page: all.slice(offset, offset + numItems), continueCursor: String(offset + numItems), isDone: offset + numItems >= all.length };
        },
        async *[Symbol.asyncIterator]() {
          for (const row of rows()) { if (table === "liquidityManagedPositions") reads.positionRows++; yield row; }
        },
      }; return query;
    },
  };
  return { db, scheduler: { runAfter: vi.fn() }, data, reads, beginCall };
}
async function invoke(fn: unknown, ctx: unknown, args: unknown): Promise<any> {
  (ctx as { beginCall?: () => void }).beginCall?.();
  return (fn as { _handler: (ctx: unknown, args: unknown) => unknown })._handler(ctx, args);
}
const base = { ownerXUserId: LIQUIDITY_TEST_OWNER, source: "terminal", scope: "terminal:web_example", requestKey: "terminal:unique-event-001", text: "create a liquidity position for PONSBOT" };
async function setup(ownerXUserId: string = LIQUIDITY_TEST_OWNER) {
  const ctx = store();
  const address = ownerXUserId === LIQUIDITY_TERMINAL_TEST_OWNER ? LIQUIDITY_TERMINAL_TEST_WALLET : LIQUIDITY_TEST_WALLET;
  const walletId = await ctx.db.insert("cryptoWallets", { ownerXUserId, status: "active", address });
  await ctx.db.insert("xReplyUsers", { xUserId: ownerXUserId, walletId }); return ctx;
}
describe("public authenticated liquidity access", () => {
  async function botSetup() {
    const ctx = await setup();
    const walletId = await ctx.db.insert("cryptoWallets", { ownerXUserId: LIQUIDITY_TERMINAL_TEST_OWNER, status: "active", address: LIQUIDITY_TERMINAL_TEST_WALLET });
    await ctx.db.insert("xReplyUsers", { xUserId: LIQUIDITY_TERMINAL_TEST_OWNER, walletId });
    return { ctx, walletId, request: { ...base, ownerXUserId: LIQUIDITY_TERMINAL_TEST_OWNER } };
  }
  it("admits the authenticated bot terminal account and queues only after confirmation", async () => {
    vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "true");
    const { ctx, walletId, request } = await botSetup();
    const turn = await invoke(reserveTurn, ctx, request);
    expect(turn).toMatchObject({ handled: true, walletId });
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    const found = await invoke(resolveContext, ctx, { ownerXUserId: request.ownerXUserId, source: "terminal", listPositions: true });
    expect(found.wallet._id).toBe(walletId);
    const d = newLiquidityDraft(); d.executionPlanJson = "approved-plan";
    d.review = { hash: `0x${"a".repeat(64)}`, executionReady: true, expiresAt: Date.now() + 60000 };
    await invoke(saveTurn, ctx, { turnId: turn.turnId, state: JSON.stringify(d), message: "Review", active: true });
    const confirm = await invoke(reserveTurn, ctx, { ...request, requestKey: "terminal:bot-confirm", text: "confirm" });
    const executionId = await invoke(queueExecution, ctx, { turnId: confirm.turnId, planJson: "approved-plan" });
    expect(executionId).toBeTruthy();
    expect(ctx.data.get(executionId)?.turnId).toBe(confirm.turnId);
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
  });
  it("admits the same authenticated account through X, terminal, and internal ownership lookup", async () => {
    const { ctx, request } = await botSetup();
    expect(await invoke(reserveTurn, ctx, { ...request, source: "x", scope: "x:bot", requestKey: "x:bot" })).toHaveProperty("turnId");
    expect((await invoke(resolveContext, ctx, { ownerXUserId: request.ownerXUserId })).wallet.ownerXUserId).toBe(request.ownerXUserId);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("rejects a mismatched wallet owner and cross-owner terminal scope reuse", async () => {
    const { ctx, walletId, request } = await botSetup();
    const original = await invoke(reserveTurn, ctx, base);
    await expect(invoke(reserveTurn, ctx, { ...request, requestKey: "terminal:other-owner" })).rejects.toThrow("LP access denied");
    await ctx.db.patch(original.conversationId, { active: false });
    await ctx.db.patch(walletId, { ownerXUserId: "2086128304545783808" });
    expect(await invoke(reserveTurn, ctx, { ...request, requestKey: "terminal:wrong-wallet" })).not.toHaveProperty("turnId");
    await expect(invoke(resolveContext, ctx, { ownerXUserId: request.ownerXUserId, source: "terminal" })).rejects.toThrow("LP access denied");
  });
  it.each(["x", "terminal"] as const)("admits a non-pilot account with its own wallet through %s", async source => {
    const ownerXUserId = "2099999999999999999";
    const ctx = await setup(ownerXUserId);
    const request = {
      ...base,
      ownerXUserId,
      source,
      scope: source === "x" ? `x:${ownerXUserId}` : "terminal:web_public_user",
      requestKey: source === "x" ? "x:public-user-request" : "terminal:web_public_user:event_public_001",
    };
    const reserved = await invoke(reserveTurn, ctx, request);
    expect(reserved).toHaveProperty("turnId");
    const resolved = await invoke(resolveContext, ctx, { ownerXUserId, source });
    expect(resolved.wallet).toMatchObject({ ownerXUserId, status: "active" });
  });
  it("keeps ordinary buy/send/launch commands outside the LP exception", async () => {
    const { ctx, request } = await botSetup();
    for (const text of ["buy $10 of PONSBOT", "send 0.01 ETH to @friend", "launch Test ticker TEST"]) {
      expect(await invoke(reserveTurn, ctx, { ...request, text })).toEqual({ handled: false });
    }
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
});
function actionContext(ctx: ReturnType<typeof store>) {
  const mutations: Record<string, unknown> = { reserveTurn, saveTurn, queueExecution };
  return {
    runMutation: vi.fn((ref, args) => invoke(mutations[getFunctionName(ref).split(":")[1]], ctx, args)),
    runQuery: vi.fn((ref, args) => {
      if (getFunctionName(ref) !== "liquidity:resolveContext") throw new Error("Unexpected query");
      return invoke(resolveContext, ctx, args);
    }),
    runAction: vi.fn(() => { throw new Error("No wallet or external action allowed in this test"); }),
  };
}
function shapeDraft() {
  const d = newLiquidityDraft("open", { token: "PONSBOT", amount: "100", unit: "usd", pair: "ETH", version: 4, feePips: 3000, tickSpacing: 60, downPercent: 25, upPercent: 25 });
  d.phase = "shape"; d.analyzed = true; d.custom = true; d.tokenAddress = "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07"; d.symbol = "PONSBOT"; return d;
}
beforeEach(() => {
  vi.mocked(discoverLiquidityPools).mockReset().mockImplementation(async (_token, _budget, _prices, options) => ({
    symbol: "PONSBOT", candidates: [], selected: options?.selected,
    analysis: { checkedAt: Date.now(), stage: "high", summaries: 3, checkedPools: 3, verifiedPools: 3, diagnostics: [] },
  }));
});
describe("concise setup through the actual handler", () => {
  it.each((["x", "terminal"] as const).flatMap(source => ([
    ["token", "💧 What token would you like to create a liquidity position for? Provide a ticker or contract address."],
    ["budget", "💰 What is your position budget?\n\nExample: $100 or 0.1 ETH"],
    ["pair", "💧 Would you like to create an ETH or USDG pool?"],
  ] as const).map(([phase, expected]) => ({ source, phase, expected }))))("keeps $source $phase wording intact", async ({ source, phase, expected }) => {
    const ctx = await setup(), root = { ...base, source, scope: `${source}:short-setup`, requestKey: `${source}:short-root` };
    const first = await invoke(reserveTurn, ctx, root), d = newLiquidityDraft(); d.phase = phase;
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "Question", active: true });
    if (source === "x") await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "short-prompt" });
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: null, updates: [] }));
    const result = await invoke(handle, actionContext(ctx), { ...root, requestKey: `${source}:short-answer`, text: "not sure", ...(source === "x" ? { parentPostId: "short-prompt" } : {}) });
    expect(result.message).toBe(expected); expect(result.message).not.toContain("LQ-");
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it.each(["x", "terminal"])("advances an old spacing draft without asking on %s", async source => {
    const ctx = await setup(), root = { ...base, source, scope: `${source}:spacing-setup`, requestKey: `${source}:spacing-root` };
    const first = await invoke(reserveTurn, ctx, root), d = shapeDraft();
    delete d.fields.tickSpacing; delete d.fields.downPercent; delete d.fields.upPercent; d.phase = "spacing";
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "Old spacing prompt", active: true });
    if (source === "x") await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "spacing-prompt" });
    vi.mocked(openRouter).mockClear(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network expected"); }));
    const result = await invoke(handle, actionContext(ctx), { ...root, requestKey: `${source}:spacing-refresh`, text: "refresh", ...(source === "x" ? { parentPostId: "spacing-prompt" } : {}) });
    const saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved.phase).toBe("range"); expect(saved.fields.tickSpacing).toBe(60);
    expect(result.message).toContain("What MCap range"); expect(result.message).not.toMatch(/LQ-|spacing/i);
    expect(fetch).not.toHaveBeenCalled(); expect(openRouter).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
});
describe("read-only NFT listing through the real liquidity workflow", () => {
  async function nftPosition(ctx: Awaited<ReturnType<typeof setup>>, extra: Row = {}) {
    const wallet = [...ctx.data.values()].find(r => r._id.startsWith("cryptoWallets:"))!;
    return ctx.db.insert("liquidityManagedPositions", { publicId: "LP-760EF1A7", ownerXUserId: LIQUIDITY_TEST_OWNER, walletId: wallet._id,
      status: "active", token: shapeDraft().tokenAddress, symbol: "PONSBOT", version: 4, fieldsJson: "{}",
      legsJson: JSON.stringify([{ tokenId: "1324119" }, { tokenId: "1324120" }]), ...extra });
  }
  it("does not serialize an NFT lookup behind a simultaneous position-status lookup", async () => {
    const ctx = await setup(); await nftPosition(ctx);
    const status = await invoke(reserveTurn, ctx, { ...base, source: "x", scope: `x:${LIQUIDITY_TEST_OWNER}`, requestKey: "x:parallel-status", text: "Check my $PONSBOT position" });
    const nfts = await invoke(reserveTurn, ctx, { ...base, source: "x", scope: `x:${LIQUIDITY_TEST_OWNER}`, requestKey: "x:parallel-nfts", text: "View my $PONSBOT position NFTs" });
    expect(status.turnId).toBeTruthy(); expect(nfts.turnId).toBeTruthy();
    expect(nfts.message).toBeUndefined(); expect(nfts.conversationId).not.toBe(status.conversationId);
  });
  it.each(["x", "terminal"].flatMap(source => ["760ef1a7", "LP-760EF1A7"].map(position => ({ source, position }))))("returns NFT links on $source for $position without AI, RPC, quote or execution", async ({ source, position }) => {
    const ctx = await setup(); await nftPosition(ctx); const actions = actionContext(ctx);
    vi.mocked(openRouter).mockReset(); const network = vi.fn(); vi.stubGlobal("fetch", network);
    const result = await invoke(handle, actions, { ...base, source, scope: `${source}:nfts`, text: `Show me the NFTs for position ${position}` });
    expect(result.message).toContain("/instance/1324119"); expect(result.message).toContain("/instance/1324120");
    expect(result.message).not.toContain("Confirm"); expect(result.deferred).not.toBe(true);
    expect(openRouter).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(actions.runAction).not.toHaveBeenCalled();
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    expect([...ctx.data.keys()].some(k => k.startsWith("liquidityExecutions:"))).toBe(false);
  });
  it.each([{ ownerXUserId: "someone-else" }, { walletId: "other-wallet" }].flatMap(extra => ["760ef1a7", "LP-760EF1A7"].map(position => ({ extra, position }))))("does not expose another owner/wallet's NFT records: %j", async ({ extra, position }) => {
    const ctx = await setup(); await nftPosition(ctx, extra);
    const result = await invoke(handle, actionContext(ctx), { ...base, text: `show NFTs for ${position}` });
    expect(result.message).toContain("doesn’t belong to your wallet"); expect(result.message).not.toContain("1324119");
  });
  it("does not fall back to another owned position for an unknown ID", async () => {
    const ctx = await setup(); await nftPosition(ctx);
    const result = await invoke(handle, actionContext(ctx), { ...base, text: "show NFTs for LP-00000000" });
    expect(result.message).toContain("doesn’t belong to your wallet"); expect(result.message).not.toContain("1324119");
  });
  it("can show closed NFT history without allowing ordinary management of closed positions", async () => {
    const ctx = await setup(); await nftPosition(ctx, { status: "closed" });
    const result = await invoke(handle, actionContext(ctx), { ...base, text: "show NFTs for LP-760EF1A7" });
    expect(result.message).toContain("historical NFTs"); expect(result.message).toContain("/instance/1324119");
    expect((await invoke(resolveContext, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, position: "LP-760EF1A7" })).position).toBeUndefined();
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it.each(["Show my NFTs", "Show NFTs for LP-760EF1A7 and LP-1234ABCD"])("asks for one LP ID instead of broadening %s", async text => {
    const ctx = await setup(); await nftPosition(ctx);
    const result = await invoke(handle, actionContext(ctx), { ...base, text });
    expect(result.message).toContain("Tell me one position's LP ID"); expect(result.message).not.toContain("1324119");
  });
  it.each(["x", "terminal"])("preserves an in-progress %s quote and its unread terms", async source => {
    const ctx = await setup(); await nftPosition(ctx);
    const root = { ...base, source, scope: `${source}:nft-setup`, requestKey: `${source}:nft-root` };
    const first = await invoke(reserveTurn, ctx, root), draft = shapeDraft(), actions = actionContext(ctx);
    draft.phase = "review"; draft.fields.shape = "flat"; draft.fields.bands = 1;
    draft.review = { hash: `0x${"c".repeat(64)}`, executionReady: true, expiresAt: Date.now() + 60000 };
    draft.executionPlanJson = "must-not-change"; draft.remainingPages = ["Unread funding terms", "Unread confirmation terms"];
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "Review quote", active: true });
    if (source === "x") await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "nft-parent" });
    const result = await invoke(handle, actions, { ...root, requestKey: `${source}:nft-lookup`, text: "show NFTs for LP-760EF1A7", ...(source === "x" ? { parentPostId: "nft-parent" } : {}) });
    expect(result.message).toContain("/instance/1324119"); expect(result.message).not.toMatch(/still preparing|please wait/i);
    expect(JSON.parse(ctx.data.get(first.conversationId)!.stateJson)).toEqual(draft);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("accepts an NFT request replying to a completed X result without replaying execution", async () => {
    const ctx = await setup(); await nftPosition(ctx);
    const root = { ...base, source: "x", scope: `x:${LIQUIDITY_TEST_OWNER}`, requestKey: "x:completed-open" };
    const first = await invoke(reserveTurn, ctx, root);
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(shapeDraft()), message: "Position opened", active: false });
    await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "completed-result" });
    const executionId = await ctx.db.insert("liquidityExecutions", { conversationId: first.conversationId, status: "confirmed", response: "Position opened" });
    const result = await invoke(handle, actionContext(ctx), { ...root, requestKey: "x:nfts-after-open", parentPostId: "completed-result", text: "Show me the NFTs for position LP-760EF1A7" });
    expect(result.message).toContain("/instance/1324119");
    expect(ctx.data.get(executionId)).toMatchObject({ status: "confirmed", response: "Position opened" });
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
});
function mockOpenQuote(bandCount: number) {
  vi.stubEnv("WALLET_SIGNER_URL", "https://signer.invalid"); vi.stubEnv("WALLET_SIGNER_TOKEN", "offline-test");
  const d = shapeDraft(), deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const key = liquidityPoolKey(d.tokenAddress as `0x${string}`, "ETH", 4, 3000, 60);
  const plan = { owner: LIQUIDITY_TEST_WALLET, token: d.tokenAddress, symbol: "PONSBOT", version: 4,
    operation: "open", poolId: liquidityPoolId(key), quoteId: `0x${"1".repeat(64)}`, proof: "2".repeat(64),
    expiresAt: Number(deadline) * 1000 - 600_000, executionDeadline: Number(deadline) * 1000, priorLegs: [],
    summary: ["Review the position and its funding."], calls: [prepareLiquidityOpen({ version: 4, pool: d.tokenAddress as `0x${string}`, key,
      bands: Array.from({ length: bandCount }, (_, i) => ({ tickLower: -600 + i * 120, tickUpper: -480 + i * 120, liquidity: 1000n, amount0: 10n, amount1: 20n, amount0Max: 11n, amount1Max: 21n })),
      deadline, minimumTick: -60, maximumTick: 60, slippageBps: 100 })] };
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify(plan))));
  return plan;
}
function mockManagementQuote() {
  vi.stubEnv("WALLET_SIGNER_URL", "https://signer.invalid"); vi.stubEnv("WALLET_SIGNER_TOKEN", "offline-test");
  vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "true");
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const { draft: d, legs, claimPositions, expectedFrom } = JSON.parse(init.body);
    const first = claimPositions?.[0];
    const plan = { owner: expectedFrom, token: d.tokenAddress, symbol: d.symbol, version: d.fields.version,
      operation: d.operation, poolId: first?.poolId ?? liquidityPoolId(liquidityPoolKey(d.tokenAddress, d.fields.pair, d.fields.version, d.fields.feePips, d.fields.tickSpacing)),
      quoteId: `0x${"1".repeat(64)}`, proof: "2".repeat(64), expiresAt: Date.now() + 90_000, executionDeadline: Date.now() + 690_000,
      priorLegs: legs, summary: ["Checked ownership, gas and exact NFT calls."], ...(claimPositions ? { claimPositions } : {}),
      calls: claimPositions ? claimPositions.map((p: any) => prepareLiquidityClaim(p.version, p.legs))
        : d.operation === "claim" ? [prepareLiquidityClaim(d.fields.version, legs)]
        : [prepareLiquidityClaim(d.fields.version, legs), prepareLiquidityClose(d.fields.version, legs, legs.map(() => ({ amount0: "1", amount1: "1" })))] };
    return new Response(JSON.stringify(plan));
  }));
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.mocked(openRouter).mockReset(); });
describe("liquidity ownership and alternative choices", () => {
  async function addPosition(ctx: Awaited<ReturnType<typeof setup>>, publicId = "LP-1234ABCD", extra: Row = {}) {
    const wallet = [...ctx.data.values()].find(r => r._id.startsWith("cryptoWallets:"))!, d = shapeDraft();
    return ctx.db.insert("liquidityManagedPositions", { publicId, walletId: wallet._id, ownerXUserId: LIQUIDITY_TEST_OWNER, status: "active", token: d.tokenAddress, symbol: "PONSBOT", version: 4,
      poolId: liquidityPoolId(liquidityPoolKey(d.tokenAddress as `0x${string}`, "ETH", 4, 3000, 60)), fieldsJson: JSON.stringify({ ...d.fields, shape: "flat", bands: 1 }), legsJson: JSON.stringify([{ tokenId: publicId.slice(3) === "1234ABCD" ? "123" : "124", liquidity: "1000", tickLower: -600, tickUpper: 600 }]), ...extra });
  }
  it.each(["withdraw", "withdraw my liquidity", "withdraw my ponsbot liquidity", "withdraw LP-1234ABCD", "claim LP fees", "withdraw liquidity fees", "withdraw all liquidity fees"])("executes %s directly for the sole owned position, only once", async text => {
    const ctx = await setup(); await addPosition(ctx); mockManagementQuote();
    const actions = actionContext(ctx), request = { ...base, text };
    const result = await invoke(handle, actions, request);
    expect(result).toEqual({ handled: true, deferred: true });
    const executions = [...ctx.data.values()].filter(r => r._id.startsWith("liquidityExecutions:"));
    expect(executions).toHaveLength(1); expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
    const plan = JSON.parse(executions[0].planJson);
    expect(plan.operation).toBe(/fees/.test(text) ? "claim" : "withdraw");
    expect(plan.calls.map((c: any) => c.purpose)).toEqual(/fees/.test(text) ? ["claim"] : ["claim", "withdraw"]);
    expect(plan.calls.every((c: any) => c.value === "0")).toBe(true);
    const conversation = ctx.data.get(executions[0].conversationId)!, d = JSON.parse(conversation.stateJson);
    if (plan.operation === "withdraw") expect(d.fields.withdrawPercent).toBe(100);
    expect(d.fields.amount).toBeUndefined(); expect(d.fields.unit).toBeUndefined();
    expect(vi.mocked(openRouter)).not.toHaveBeenCalled();
    await invoke(handle, actions, request);
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["withdraw", "claim LP fees"])("lists multiple positions before %s, then executes only the selected one", async text => {
    const ctx = await setup(); await addPosition(ctx); await addPosition(ctx, "LP-1234ABCE"); mockManagementQuote();
    const actions = actionContext(ctx);
    const options = await invoke(handle, actions, { ...base, text });
    expect(options.message).toContain("1. LP-1234ABCD"); expect(options.message).toContain("2. LP-1234ABCE");
    expect(options.message).not.toContain("LQ-"); expect(options.message).not.toContain("Confirm");
    expect(fetch).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    const result = await invoke(handle, actions, { ...base, requestKey: "terminal:choose-position", text: "2" });
    expect(result).toEqual({ handled: true, deferred: true }); expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
    const request = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(request.draft.fields.position).toBe("LP-1234ABCE"); expect(request.legs[0].tokenId).toBe("124");
  });
  it("does not replace a wrong/foreign/closed explicit ID with the one owned active position", async () => {
    for (const extra of [{ ownerXUserId: "outsider" }, { walletId: "other-wallet" }, { status: "closed" }]) {
      const ctx = await setup(); await addPosition(ctx); await addPosition(ctx, "LP-1234ABCE", extra); mockManagementQuote();
      const result = await invoke(handle, actionContext(ctx), { ...base, text: "withdraw LP-1234ABCE" });
      expect(result.message).toContain("doesn’t belong to your wallet"); expect(fetch).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    }
  });
  it("lists a bounded selection, never assumes the first position of a truncated set", async () => {
    const ctx = await setup();
    for (let i = 0; i < 25; i++) await addPosition(ctx, `LP-${i.toString(16).padStart(8, "0").toUpperCase()}`);
    const result = await invoke(resolveContext, ctx, { ownerXUserId: base.ownerXUserId, source: "terminal", selectPosition: true });
    expect(result.position).toBeUndefined(); expect(result.positionChoices).toHaveLength(20); expect(result.morePositionChoices).toBe(true);
    expect(ctx.reads.positionRows).toBe(21);
  });
  it("explicit half withdrawal never becomes full without a yes, which executes directly", async () => {
    const ctx = await setup(); await addPosition(ctx); mockManagementQuote();
    const actions = actionContext(ctx);
    const partial = await invoke(handle, actions, { ...base, text: "withdraw half my liquidity" });
    expect(partial.message).toContain("Partial withdrawals"); expect(fetch).not.toHaveBeenCalled();
    const accepted = await invoke(handle, actions, { ...base, requestKey: "terminal:accept-full", text: "yes" });
    expect(accepted).toEqual({ handled: true, deferred: true });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).draft.fields.withdrawPercent).toBe(100);
  });
  it.each(["How do I withdraw liquidity?", "Can I withdraw half?", "What does claim LP fees mean?"])("does not make a quote or a pending action for the question %s", async text => {
    const ctx = await setup(); await addPosition(ctx); mockManagementQuote();
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: "help", inquiryTopics: ["management"], updates: [] }));
    const result = await invoke(handle, actionContext(ctx), { ...base, text });
    expect(result.deferred).not.toBe(true); expect(fetch).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    const conversations = [...ctx.data.values()].filter(r => r._id.startsWith("liquidityConversations:"));
    expect(conversations.every(c => !c.active && !JSON.parse(c.stateJson).executionPlanJson)).toBe(true);
  });
  it("cancellation or a newer turn during preparation prevents automatic management execution", async () => {
    const ctx = await setup(); await addPosition(ctx); mockManagementQuote();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      const response = await originalFetch(...args);
      const cancel = await invoke(reserveTurn, ctx, { ...base, requestKey: "terminal:cancel-race", text: "cancel" });
      const d = JSON.parse(cancel.state); d.phase = "cancelled";
      await invoke(saveTurn, ctx, { turnId: cancel.turnId, revision: cancel.revision, state: JSON.stringify(d), message: "Cancelled", active: false });
      return response;
    });
    await expect(invoke(handle, actionContext(ctx), { ...base, text: "withdraw" })).rejects.toThrow("LP_STALE_TURN");
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("does not queue management when execution is disabled", async () => {
    const ctx = await setup(); await addPosition(ctx); mockManagementQuote(); vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "false");
    const result = await invoke(handle, actionContext(ctx), { ...base, text: "withdraw" });
    expect(result.deferred).not.toBe(true); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("retains complete assistant quotes without expanding accepted user input", async () => {
    const ctx = await setup(), text = "Details ".repeat(200) + "Reply Confirm LQ-1234ABCD";
    const args = { sessionId: "session", ownerXUserId: base.ownerXUserId, messageType: "chat", text };
    const assistantId = await invoke(recordTerminalMessage, ctx, { ...args, role: "assistant" });
    const userId = await invoke(recordTerminalMessage, ctx, { ...args, role: "user" });
    expect(ctx.data.get(assistantId)!.text).toBe(text); expect(ctx.data.get(userId)!.text).toHaveLength(1000);
  });
  it("an empty model extraction at review does not regenerate a quote", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), d = shapeDraft();
    d.fields.shape = "flat"; d.fields.bands = 1; d.phase = "review";
    d.review = { hash: `0x${"a".repeat(64)}`, executionReady: true, expiresAt: Date.now() + 60000 }; d.executionPlanJson = "existing-plan";
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "Review", active: true });
    mockManagementQuote(); vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: null, updates: [], inquiryTopics: [] }));
    await invoke(handle, actionContext(ctx), { ...base, requestKey: "terminal:no-new-fields", text: "hmm okay" });
    expect(fetch).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    expect(JSON.parse(ctx.data.get(first.conversationId)!.stateJson).executionPlanJson).toBe("existing-plan");
  });
  it("the direct-management entry cannot skip confirmation for an opening", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), d = shapeDraft();
    d.fields.shape = "flat"; d.fields.bands = 1; d.phase = "review";
    d.review = { hash: `0x${"a".repeat(64)}`, executionReady: true, expiresAt: Date.now() + 60000 }; d.executionPlanJson = "opening-plan";
    vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "true");
    await expect(invoke(queueExecution, ctx, { turnId: first.turnId, revision: first.revision, planJson: "opening-plan", preparedState: JSON.stringify(d) })).rejects.toThrow("LP_DIRECT_OPERATION_INVALID");
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("queues a direct X withdrawal without a quote response, with ownership still bound to its author", async () => {
    const ctx = await setup(); await addPosition(ctx); mockManagementQuote();
    const result = await invoke(handle, actionContext(ctx), { ...base, source: "x", scope: "x:direct-owner", requestKey: "x:direct-withdraw", text: "withdraw my liquidity" });
    expect(result).toEqual({ handled: true, deferred: true }); expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
    const execution = [...ctx.data.values()].find(r => r._id.startsWith("liquidityExecutions:"))!;
    expect(execution.ownerXUserId).toBe(base.ownerXUserId); expect(ctx.data.get(execution.conversationId)!.source).toBe("x");
  });
  it.each(["yes", "claim all LP fees", "send 1 ETH to @someone", "what does this mean?"])("silently blocks outsider interjection %s, including through another outsider", async text => {
    const ctx = await setup(), root = { ...base, source: "x", requestKey: "x:root", scope: "x:owner" };
    const first = await invoke(reserveTurn, ctx, root);
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: first.state, message: "Token?", active: true });
    await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "bot-prompt" });
    const before = ctx.data.get(first.conversationId)!.stateJson;
    expect(await invoke(guardThread, ctx, { ownerXUserId: "outsider", parentPostId: "root", postId: "foreign-1", text })).toBe("silent");
    const result = await invoke(reserveTurn, ctx, { ...root, ownerXUserId: "other", parentPostId: "foreign-1", requestKey: "x:foreign-2", text });
    expect(result).toMatchObject({ handled: true, silent: true });
    expect(ctx.data.get(first.conversationId)!.stateJson).toBe(before);
    expect([...ctx.data.values()].filter(r => r._id.startsWith("liquidityTurns:"))).toHaveLength(1);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("redirects create-liquidity outsiders without creating a draft or authorizing them", async () => {
    const ctx = await setup(), root = { ...base, source: "x", requestKey: "x:root", scope: "x:owner" };
    await invoke(reserveTurn, ctx, root);
    const result = await invoke(reserveTurn, ctx, { ...root, ownerXUserId: "outsider", parentPostId: "root", requestKey: "x:foreign", text: "create liquidity for PONSBOT" });
    expect(result.message).toContain("new post"); expect(result.silent).toBe(false);
    expect([...ctx.data.values()].filter(r => r._id.startsWith("liquidityConversations:"))).toHaveLength(1);
  });
  it.each(["x", "terminal"])("offers a matching new %s position, then requires a new budget without inheriting old funding", async source => {
    const ctx = await setup(); await addPosition(ctx);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No quote until new budget"); }));
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: "add", updates: [{ field: "position", value: "LP-1234ABCD", evidence: "LP-1234ABCD" }], inquiryTopics: [] }));
    const root = { ...base, source, scope: `${source}:copy`, requestKey: `${source}:root`, text: "add liquidity to LP-1234ABCD" };
    const offered = await invoke(handle, actionContext(ctx), root);
    expect(offered.message).toContain("same settings");
    if (source === "x") await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "copy-prompt" });
    const accepted = await invoke(handle, actionContext(ctx), { ...root, requestKey: `${source}:yes`, text: "yes", ...(source === "x" ? { parentPostId: "copy-prompt" } : {}) });
    expect(accepted.message).toContain("budget"); expect(accepted.message).toContain("Example: $100");
    const d = JSON.parse([...ctx.data.values()].find(r => r._id.startsWith("liquidityConversations:"))!.stateJson);
    expect(d.operation).toBe("open"); expect(d.copyFromPosition).toBe("LP-1234ABCD");
    expect(d.fields).toMatchObject({ version: 4, pair: "ETH", shape: "flat", bands: 1 });
    expect(d.fields.amount).toBeUndefined(); expect(d.fields.position).toBeUndefined(); expect(d.review).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("partial withdrawal needs explicit full permission and an invalid signer response still cannot execute", async () => {
    const ctx = await setup(); await addPosition(ctx);
    vi.stubEnv("WALLET_SIGNER_URL", "https://signer.invalid"); vi.stubEnv("WALLET_SIGNER_TOKEN", "offline");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: "withdraw", updates: [{ field: "position", value: "LP-1234ABCD", evidence: "LP-1234ABCD" }, { field: "withdrawPercent", value: "50", evidence: "half" }], inquiryTopics: [] }));
    const offered = await invoke(handle, actionContext(ctx), { ...base, text: "withdraw half of LP-1234ABCD" });
    expect(offered.message).toContain("Partial withdrawals"); expect(fetch).not.toHaveBeenCalled();
    await invoke(handle, actionContext(ctx), { ...base, requestKey: "terminal:yes", text: "yes" });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.draft.fields.withdrawPercent).toBe(100); expect(body.draft.operation).toBe("withdraw");
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("finds all own active matching positions beyond the first page, never other wallets or closed ones", async () => {
    const ctx = await setup();
    for (let i = 0; i < 105; i++) await addPosition(ctx, `LP-${i.toString(16).padStart(8, "0").toUpperCase()}`, { status: "closed" });
    await addPosition(ctx); await addPosition(ctx, "LP-000000AA", { ownerXUserId: "outsider" }); await addPosition(ctx, "LP-000000BB", { walletId: "different-wallet" });
    const result = await invoke(resolveContext, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, claimPositions: true, token: "ponsbot" });
    expect(result.claimPositions.map((p: { positionId: string }) => p.positionId)).toEqual(["LP-1234ABCD"]);
    expect(ctx.reads.paginateCalls).toBe(0); expect(ctx.reads.positionRows).toBe(1);
    expect(ctx.reads.indexes).toContain("liquidityManagedPositions:by_owner_wallet_status");
    const all = await invoke(resolveContext, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, claimPositions: true, allPositions: true });
    expect(all.claimPositions).toHaveLength(1);
    expect(ctx.reads.paginateCalls).toBe(0); expect(ctx.reads.positionRows).toBe(1);
  });
  it("does not truncate token claims after 100 nonmatching active positions", async () => {
    const ctx = await setup();
    for (let i = 0; i < 105; i++) await addPosition(ctx, `LP-${i.toString(16).padStart(8, "0").toUpperCase()}`, { symbol: "OTHER", token: "0x1111111111111111111111111111111111111111" });
    await addPosition(ctx);
    const result = await invoke(resolveContext, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, claimPositions: true, token: "PONSBOT" });
    expect(result.claimPositions.map((p: { positionId: string }) => p.positionId)).toEqual(["LP-1234ABCD"]);
    expect(ctx.reads.paginateCalls).toBe(0); expect(ctx.reads.positionRows).toBe(106);
  });
  it("does not silently claim the wrong same-ticker token or truncate all claims", async () => {
    const ctx = await setup(); await addPosition(ctx); await addPosition(ctx, "LP-000000AA", { token: "0x1111111111111111111111111111111111111111" });
    await expect(invoke(resolveContext, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, claimPositions: true, token: "PONSBOT" })).rejects.toThrow("LP_CLAIM_AMBIGUOUS");
    for (let i = 0; i < 19; i++) await addPosition(ctx, `LP-${i.toString(16).padStart(8, "0").toUpperCase()}`);
    await expect(invoke(resolveContext, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, claimPositions: true, allPositions: true })).rejects.toThrow("LP_CLAIM_TOO_MANY");
    expect(ctx.reads.paginateCalls).toBe(0); expect(ctx.reads.positionRows).toBe(21);
  });
  it("a single-ID refresh never broadens to other positions after inheriting the token", async () => {
    const ctx = await setup(); await addPosition(ctx); await addPosition(ctx, "LP-000000AA");
    const result = await invoke(resolveContext, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, claimPositions: true, position: "LP-1234ABCD", token: "PONSBOT" });
    expect(result.position.publicId).toBe("LP-1234ABCD"); expect(result.claimPositions).toEqual([]);
  });
  it("an explicit token still narrows database selection when allPositions is also supplied", async () => {
    const ctx = await setup(); await addPosition(ctx);
    await addPosition(ctx, "LP-000000AA", { symbol: "OTHER", token: "0x1111111111111111111111111111111111111111" });
    for (const token of ["PONSBOT", shapeDraft().tokenAddress!.toUpperCase().replace(/^0X/, "0x")]) {
      const result = await invoke(resolveContext, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, claimPositions: true, token, allPositions: true });
      expect(result.claimPositions.map((p: { positionId: string }) => p.positionId)).toEqual(["LP-1234ABCD"]);
    }
  });
});

describe("liquidity persistent conversations", () => {
  it.each(["ai", "repaired", "fallback"])("persists private %s ranking diagnostics without exposing provider details", async mode => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), d = shapeDraft();
    d.phase = "pool"; d.custom = false;
    await ctx.db.insert("tokenRegistry", { symbol: "PONSBOT", active: true, normalizedAddress: d.tokenAddress });
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "Pools", active: true });
    const p = { id: `0x${"1".repeat(40)}`, version: 3 as const, pair: "ETH" as const, token0: `0x${"0".repeat(40)}`, token1: d.tokenAddress!,
      feePips: 3000, tickSpacing: 60, netLpFeePercent: .3, traderFeePercent: .3, tokenPriceUsd: .01, activeLiquidity: "10000",
      volumeHourUsd: 1000, swapsHour: 20, activeDepthUsd: 5000, observedAt: Date.now(), marketObservedAt: Date.now(), blockNumber: "100", reasons: ["fee_paying", "range_risk"] as const };
    vi.mocked(discoverLiquidityPools).mockResolvedValueOnce({ symbol: "PONSBOT", candidates: [{ ...p, reasons: [...p.reasons] }],
      analysis: { checkedAt: Date.now(), stage: "high", summaries: 1, checkedPools: 1, verifiedPools: 1, diagnostics: [] } });
    vi.mocked(openRouter).mockReset();
    if (mode === "fallback") vi.mocked(openRouter).mockRejectedValue(new Error("provider credential: PRIVATE"));
    else vi.mocked(openRouter).mockResolvedValue(JSON.stringify({ ranking: [{ id: p.id, reasons: mode === "ai" ? ["active_trading", "strong_recent_volume"] : ["INVALID", "range_risk"] }] }));
    const result = await invoke(handle, actionContext(ctx), { ...base, requestKey: `terminal:rank-${mode}`, text: "refresh" });
    const saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved.analysis.rankingMode).toBe(mode);
    expect(saved.analysis.rankingDiagnostics).toEqual(mode === "fallback" ? ["RANK_PROVIDER_UNAVAILABLE"] : mode === "repaired" ? ["POOL_REASONS_REPAIRED"] : []);
    expect(JSON.stringify(saved)).not.toContain("PRIVATE"); expect(result.message).not.toContain("RANK_PROVIDER");
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("invalidates a selected-pool quote if edited bands no longer fit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No network allowed")));
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), d = shapeDraft();
    d.fields.shape = "flat"; d.fields.bands = 1; d.phase = "review"; d.custom = false;
    d.selected = { id: liquidityPoolId(liquidityPoolKey(d.tokenAddress as `0x${string}`, "ETH", 4, 3000, 60)), version: 4, pair: "ETH", token0: `0x${"0".repeat(40)}`, token1: d.tokenAddress!,
      feePips: 3000, tickSpacing: 60, netLpFeePercent: .3, traderFeePercent: .3, tokenPriceUsd: .01, activeLiquidity: "10000", volumeHourUsd: 1000, swapsHour: 20,
      observedAt: Date.now(), marketObservedAt: Date.now(), blockNumber: "100", reasons: ["fee_paying", "range_risk"] };
    d.review = { hash: `0x${"1".repeat(64)}`, expiresAt: Date.now() + 60000, executionReady: true }; d.executionPlanJson = "old-plan";
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "Quote", active: true });
    vi.mocked(discoverLiquidityPools).mockResolvedValueOnce({ symbol: "PONSBOT", candidates: [], currentMarketCapUsd: 100_000, analysis: { checkedAt: Date.now(), stage: "limited", summaries: 1, checkedPools: 1, verifiedPools: 0, diagnostics: ["SELECTED_POOL_RANGE_BANDS_INCOMPATIBLE", "SELECTED_POOL_SETTINGS_INCOMPATIBLE"] } });
    const result = await invoke(handle, actionContext(ctx), { ...base, requestKey: "terminal:incompatible-range", text: "I want 20 bands" });
    expect(result.message).toContain("cannot fit 20 bands");
    expect(result.message).toContain("price spacing");
    const saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved.review).toBeUndefined(); expect(saved.executionPlanJson).toBeUndefined();
    expect(saved.selected.id).toBe(d.selected.id); expect(fetch).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it.each(["x", "terminal"])("replaces an unread %s quote on a band edit and requires a new confirmation", async source => {
    vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "true");
    const ctx = await setup(), root = { ...base, source, scope: `${source}:edit-quote`, requestKey: `${source}:edit-root` };
    const first = await invoke(reserveTurn, ctx, root), d = shapeDraft(), actions = actionContext(ctx);
    d.fields.shape = "flat"; d.fields.bands = 1; d.bandsDefaulted = true; d.phase = "review";
    d.review = { hash: `0x${"a".repeat(64)}`, expiresAt: Date.now() + 60000, executionReady: true };
    d.executionPlanJson = "old-plan"; d.remainingPages = ["Old unread funding terms"];
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "Old quote", active: true });
    if (source === "x") await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "old-quote" });
    const plan = mockOpenQuote(4); vi.mocked(openRouter).mockClear();
    const result = await invoke(handle, actions, { ...root, requestKey: `${source}:band-edit`, text: "I want 4 bands", ...(source === "x" ? { parentPostId: "old-quote" } : {}) });
    const saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(result.message).not.toMatch(/Bands \(|Suggested bands/);
    expect(saved.fields.bands).toBe(4); expect(saved.bandsDefaulted).toBe(false);
    expect(saved.remainingPages).toEqual([]); expect(saved.executionPlanJson).toBe(JSON.stringify(plan));
    expect(saved.review.hash).not.toBe(d.review.hash); expect(saved.review.executionReady).toBe(true);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).draft.fields.bands).toBe(4);
    expect(openRouter).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    if (source === "x") await invoke(attachPrompt, ctx, { requestKey: `${source}:band-edit`, responsePostId: "revised-quote" });
    await invoke(handle, actions, { ...root, requestKey: `${source}:new-confirm`, text: "confirm", ...(source === "x" ? { parentPostId: "revised-quote" } : {}) });
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
    const queued = [...ctx.data.values()].find(row => row._id.startsWith("liquidityExecutions:"))!;
    expect(queued.planJson).toBe(JSON.stringify(plan));
  });
  it.each([true, false])("refreshes live comparison and preserves the selected pool (available=%s)", async available => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), d = shapeDraft();
    d.fields.shape = "flat"; d.fields.bands = 1; d.phase = "review"; d.custom = false;
    const key = liquidityPoolKey(d.tokenAddress as `0x${string}`, "ETH", 4, 3000, 60);
    d.selected = { id: liquidityPoolId(key), token0: key.currency0, token1: key.currency1, version: 4, pair: "ETH", feePips: 3000, tickSpacing: 60,
      netLpFeePercent: .3, traderFeePercent: .3, tokenPriceUsd: .001, activeLiquidity: "10000", volumeHourUsd: 10, swapsHour: 1,
      observedAt: Date.now() - 60000, marketObservedAt: Date.now() - 60000, blockNumber: "99", reasons: ["fee_paying", "range_risk"] };
    d.review = { hash: `0x${"a".repeat(64)}`, expiresAt: Date.now() + 60000, executionReady: true }; d.executionPlanJson = "old-plan";
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "Old quote", active: true });
    mockOpenQuote(1);
    vi.mocked(discoverLiquidityPools).mockResolvedValueOnce({ symbol: "PONSBOT", candidates: [], selected: available ? { ...d.selected, volumeHourUsd: 1500, blockNumber: "100" } : undefined,
      analysis: { checkedAt: Date.now(), stage: "high", summaries: 4, checkedPools: 4, verifiedPools: 3, diagnostics: [] } });
    const result = await invoke(handle, actionContext(ctx), { ...base, requestKey: "terminal:refresh-analysis", text: "refresh" });
    const saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(discoverLiquidityPools).toHaveBeenCalledWith(d.tokenAddress, 100, undefined, { fresh: true, fields: d.fields, selected: d.selected });
    expect(saved.fields).toEqual(d.fields); expect(saved.selected.id).toBe(d.selected.id);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    if (available) { expect(saved.selected.volumeHourUsd).toBe(1500); expect(saved.review.hash).not.toBe(d.review.hash); expect(fetch).toHaveBeenCalledTimes(1); }
    else { expect(result.message).toContain("No different pool was substituted"); expect(saved.review).toBeUndefined(); expect(saved.executionPlanJson).toBeUndefined(); expect(fetch).not.toHaveBeenCalled(); }
  });
  it("refreshes the displayed pool options on an explicit refresh", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), d = shapeDraft();
    d.phase = "pool"; d.custom = false;
    await ctx.db.insert("tokenRegistry", { symbol: "PONSBOT", active: true, normalizedAddress: d.tokenAddress });
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "Pools", active: true });
    await invoke(handle, actionContext(ctx), { ...base, requestKey: "terminal:refresh-options", text: "refresh" });
    expect(discoverLiquidityPools).toHaveBeenCalledExactlyOnceWith(d.tokenAddress, 100, undefined, { fresh: true, fields: d.fields });
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("reruns an empty pool analysis when the user repeats a clear creation request", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), d = shapeDraft();
    d.phase = "pool"; d.custom = false; d.candidates = []; d.analysis = { checkedAt: 1, stage: "limited", summaries: 0, checkedPools: 20, verifiedPools: 0, diagnostics: ["GECKO_HTTP_429"] };
    await ctx.db.insert("tokenRegistry", { symbol: "PONSBOT", active: true, normalizedAddress: d.tokenAddress });
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "No pools", active: true });
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: null, inquiryTopics: [], updates: [] }));
    await invoke(handle, actionContext(ctx), { ...base, requestKey: "terminal:repeat-empty-analysis", text: "Create a $100 liquidity pool for $PONSBOT" });
    expect(discoverLiquidityPools).toHaveBeenCalledExactlyOnceWith(d.tokenAddress, 100, undefined, { fresh: true, fields: d.fields });
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("never silently changes an incompatible explicit band count or keeps its old quote executable", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), d = shapeDraft(), actions = actionContext(ctx);
    d.fields.shape = "bell"; d.fields.bands = 5; d.bandsDefaulted = true; d.phase = "review";
    d.review = { hash: `0x${"a".repeat(64)}`, expiresAt: Date.now() + 60000, executionReady: true };
    d.executionPlanJson = "old-plan";
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "Quote", active: true });
    mockOpenQuote(2);
    const result = await invoke(handle, actions, { ...base, requestKey: "terminal:invalid-bands", text: "I want 2 bands" });
    expect(result.message).toContain("3–20 for bell/bid-ask");
    const saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved.fields.bands).toBe(2); expect(saved.bandsDefaulted).toBe(false); expect(saved.phase).toBe("bands");
    expect(saved.review).toBeUndefined(); expect(saved.executionPlanJson).toBeUndefined();
    await invoke(handle, actions, { ...base, requestKey: "terminal:invalid-confirm", text: "confirm" });
    expect(fetch).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it.each([["x", LIQUIDITY_TEST_OWNER], ["terminal", LIQUIDITY_TEST_OWNER], ["terminal", LIQUIDITY_TERMINAL_TEST_OWNER]])("validates the actual %s quote response for %s before allowing confirmation", async (source, ownerXUserId) => {
    for (const valid of [true, false]) {
      const ctx = await setup(ownerXUserId), root = { ...base, ownerXUserId, source, scope: `${source}:quote-boundary`, requestKey: `${source}:quote-root` };
      const first = await invoke(reserveTurn, ctx, root), draft = shapeDraft();
      draft.phase = "bands"; draft.fields.shape = "flat";
      await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "How many bands?", active: true });
      if (source === "x") await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "bands-prompt" });
      vi.stubEnv("WALLET_SIGNER_URL", "https://signer.invalid"); vi.stubEnv("WALLET_SIGNER_TOKEN", "offline-test");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
      const key = liquidityPoolKey(draft.tokenAddress as `0x${string}`, "ETH", 4, 3000, 60);
      const plan = { owner: ownerXUserId === LIQUIDITY_TERMINAL_TEST_OWNER ? LIQUIDITY_TERMINAL_TEST_WALLET : LIQUIDITY_TEST_WALLET, token: draft.tokenAddress, symbol: "PONSBOT", version: 4,
        operation: "open", poolId: liquidityPoolId(key), quoteId: `0x${"1".repeat(64)}`, proof: "2".repeat(64),
        expiresAt: Number(deadline) * 1000 - 600_000, executionDeadline: Number(deadline) * 1000, priorLegs: [],
        summary: ["Review the position and its funding."], calls: [prepareLiquidityOpen({ version: 4, pool: draft.tokenAddress as `0x${string}`, key,
          bands: [{ tickLower: -600, tickUpper: 600, liquidity: 1000n, amount0: 10n, amount1: 20n, amount0Max: 11n, amount1Max: 21n }],
          deadline, minimumTick: -60, maximumTick: 60, slippageBps: 100 })] };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(valid ? plan : { ...plan, token: plan.owner }))));
      vi.mocked(openRouter).mockClear();
      await invoke(handle, actionContext(ctx), { ...root, requestKey: `${source}:bands-answer`, text: "1", ...(source === "x" ? { parentPostId: "bands-prompt" } : {}) });
      const saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
      if (valid) {
        expect(saved.review.executionReady).toBe(true); expect(saved.executionPlanJson).toBe(JSON.stringify(plan));
        expect(saved.quoteSummary).toEqual(plan.summary);
      } else {
        expect(saved.review).toBeUndefined(); expect(saved.executionPlanJson).toBeUndefined();
        expect(saved.diagnosticCode).toBe("LP_SIGNER_QUOTE_INVALID");
      }
      expect(fetch).toHaveBeenCalledTimes(1); expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://signer.invalid/v1/liquidity/quote");
      expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toMatchObject({ ownerXUserId, source, expectedFrom: plan.owner });
      expect(openRouter).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    }
  });
  it("asks for the budget before doing pool discovery or ranking", async () => {
    const ctx = await setup(), actions = actionContext(ctx);
    vi.mocked(discoverLiquidityPools).mockClear(); vi.mocked(openRouter).mockReset();
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: "open", inquiryTopics: [], updates: [{ field: "token", value: "PONSBOT", evidence: "PONSBOT" }] }));
    const result = await invoke(handle, actions, base);
    expect(result.message).toContain("budget");
    expect(discoverLiquidityPools).not.toHaveBeenCalled(); expect(openRouter).toHaveBeenCalledTimes(1);
    const conversation = [...ctx.data.values()].find(row => row._id.startsWith("liquidityConversations:"))!;
    const saved = JSON.parse(conversation.stateJson);
    expect(saved.phase).toBe("budget"); expect(saved.analyzed).toBe(false);
  });
  it("turns a broad pool-discovery question into the guided setup without an AI call", async () => {
    const ctx = await setup(), actions = actionContext(ctx);
    vi.mocked(discoverLiquidityPools).mockClear(); vi.mocked(openRouter).mockReset();
    const result = await invoke(handle, actions, { ...base, text: "what Pons pools are there?", requestKey: "terminal:broad-pool-entry" });
    expect(result.message).toContain("position budget");
    expect(discoverLiquidityPools).not.toHaveBeenCalled(); expect(openRouter).not.toHaveBeenCalled();
    const conversation = [...ctx.data.values()].find(row => row._id.startsWith("liquidityConversations:"))!;
    const saved = JSON.parse(conversation.stateJson);
    expect(saved.operation).toBe("open"); expect(saved.fields.token).toBe("PONS"); expect(saved.phase).toBe("budget");
  });
  it("runs discovery once the amount and denomination are supplied", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), actions = actionContext(ctx);
    const draft = newLiquidityDraft("open", { token: "PONSBOT" });
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "Budget?", active: true });
    await ctx.db.insert("tokenRegistry", { symbol: "PONSBOT", active: true, normalizedAddress: shapeDraft().tokenAddress });
    vi.mocked(discoverLiquidityPools).mockReset();
    vi.mocked(discoverLiquidityPools).mockResolvedValueOnce({ symbol: "PONSBOT", candidates: [], analysis: { checkedAt: Date.now(), stage: "limited", summaries: 0, checkedPools: 20, verifiedPools: 0, diagnostics: [] } });
    vi.mocked(openRouter).mockReset();
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: null, inquiryTopics: [], updates: [{ field: "amount", value: "100", evidence: "$100" }, { field: "unit", value: "usd", evidence: "$100" }] }));
    await invoke(handle, actions, { ...base, requestKey: "terminal:budget", text: "$100" });
    expect(discoverLiquidityPools).toHaveBeenCalledExactlyOnceWith(shapeDraft().tokenAddress, 100, undefined, { fresh: true, fields: { token: "PONSBOT", amount: "100", unit: "usd" } });
    expect(JSON.parse(ctx.data.get(first.conversationId)!.stateJson).phase).toBe("pool");
  });
  it("pauses an underfunded setup before discovery and resumes it after funding", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), actions = actionContext(ctx);
    const draft = newLiquidityDraft("open", { token: "PONSBOT" });
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "Budget?", active: true });
    await ctx.db.insert("tokenRegistry", { symbol: "PONSBOT", active: true, normalizedAddress: shapeDraft().tokenAddress });
    vi.stubEnv("WALLET_SIGNER_URL", "https://signer.invalid"); vi.stubEnv("WALLET_SIGNER_TOKEN", "offline-test");
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: null, inquiryTopics: [], updates: [{ field: "amount", value: "100", evidence: "$100" }, { field: "unit", value: "usd", evidence: "$100" }] }));
    const network = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sufficient: false, requiredUsd: 100, availableUsd: 0, missing: "FUNDING" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sufficient: true, requiredUsd: 100, availableUsd: 125 })));
    vi.stubGlobal("fetch", network);
    const blocked = await invoke(handle, actions, { ...base, requestKey: "terminal:funding-blocked", text: "$100" });
    expect(blocked.message).toContain("don’t have enough ETH, USDG, or $PONSBOT for this position and gas");
    expect(blocked.message).toContain("reply resume"); expect(blocked.message).toContain("Your wallet:");
    expect(discoverLiquidityPools).not.toHaveBeenCalled();
    let saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved.fundingCheck).toMatchObject({ sufficient: false, missing: "FUNDING" }); expect(saved.phase).toBe("analysis");
    const resumed = await invoke(handle, actions, { ...base, requestKey: "terminal:funding-resume", text: "resume" });
    expect(resumed.message).toContain("pool"); expect(discoverLiquidityPools).toHaveBeenCalledTimes(1);
    saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved.fundingCheck.sufficient).toBe(true); expect(saved.phase).toBe("pool");
    expect(network).toHaveBeenCalledTimes(2); expect(openRouter).toHaveBeenCalledTimes(1);
  });
  it.each(["x", "terminal"])("a %s status request preserves the quote and its unread terms", async source => {
    const ctx = await setup(), root = { ...base, source, scope: `${source}:status-setup`, requestKey: `${source}:status-root` };
    const first = await invoke(reserveTurn, ctx, root), draft = shapeDraft(), actions = actionContext(ctx);
    draft.phase = "review"; draft.fields.shape = "flat"; draft.fields.bands = 1;
    draft.review = { hash: `0x${"c".repeat(64)}`, executionReady: true, expiresAt: Date.now() + 60000 };
    draft.executionPlanJson = "must-not-change"; draft.remainingPages = ["Unread funding terms", "Unread confirmation terms"];
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "Review quote", active: true });
    if (source === "x") await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "status-parent" });
    const result = await invoke(handle, actions, { ...root, requestKey: `${source}:show-positions`, text: "show my positions", ...(source === "x" ? { parentPostId: "status-parent" } : {}) });
    expect(result.message).toContain("No matching active liquidity positions"); expect(result.message).not.toMatch(/still preparing|please wait/i);
    const saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved).toEqual(draft); expect(ctx.data.get(first.conversationId)!.active).toBe(true);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    // A read-only X result is independent. Continue the preserved setup from
    // its actual setup prompt, not by treating the status result as a quote.
    const confirm = await invoke(handle, actions, { ...root, requestKey: `${source}:early-confirm`, text: "confirm", ...(source === "x" ? { parentPostId: "status-parent" } : {}) });
    expect(confirm.message).toContain("remaining details"); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("paginates position lookups independently and resumes the previous setup step", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), draft = shapeDraft(), actions = actionContext(ctx);
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "Shape?", active: true });
    for (let i = 0; i < 25; i++) await ctx.db.insert("liquidityManagedPositions", { publicId: `LP-${i.toString(16).padStart(8, "0").toUpperCase()}`, ownerXUserId: LIQUIDITY_TEST_OWNER, walletId: first.walletId, status: "active", fieldsJson: "{}", legsJson: "[]", symbol: "PONSBOT" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline test")));
    const result = await invoke(handle, actions, { ...base, requestKey: "terminal:status-page-1", text: "show my positions" });
    expect(result.message).toContain("LP-00000018"); expect(result.message).toContain("Reply next");
    let saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved.phase).toBe("shape"); expect(saved.positionInquiry.cursor).toBe("20");
    const next = await invoke(handle, actions, { ...base, requestKey: "terminal:status-page-2", text: "next" });
    expect(next.message).toContain("LP-00000000"); expect(next.message).toContain("setup is unchanged");
    saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved).toEqual(draft);
    mockOpenQuote(1);
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: null, inquiryTopics: [], updates: [{ field: "shape", value: "flat", evidence: "flat" }] }));
    const choice = await invoke(handle, actions, { ...base, requestKey: "terminal:resume-shape", text: "flat" });
    expect(choice.message).toContain("Review your liquidity quote");
    expect(choice.message).not.toContain("Suggested bands"); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("retains setup and its quote if the status lookup itself fails", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), draft = shapeDraft(), actions = actionContext(ctx);
    draft.review = { hash: `0x${"d".repeat(64)}`, executionReady: true, expiresAt: Date.now() + 60000 }; draft.executionPlanJson = "private-plan";
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "Quote", active: true });
    actions.runQuery.mockRejectedValueOnce(new Error("Bearer secret-token; raw RPC 0x123456"));
    const result = await invoke(handle, actions, { ...base, requestKey: "terminal:status-failed", text: "show my positions" });
    expect(result.message).toContain("setup is unchanged");
    expect(JSON.parse(ctx.data.get(first.conversationId)!.stateJson)).toEqual({ ...draft, diagnosticCode: "LP_WORKFLOW_FAILED" });
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("a help question during a position lookup resumes setup explanations, not the old position cursor", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), draft = shapeDraft(), actions = actionContext(ctx);
    draft.positionInquiry = { pages: [], cursor: "20" };
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "Positions, reply next", active: true });
    const result = await invoke(handle, actions, { ...base, requestKey: "terminal:help-after-status", text: "what does this mean?" });
    expect(result.message).toContain("Choose flat");
    const saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved.positionInquiry).toBeUndefined(); expect(saved.fields).toEqual(draft.fields);
    expect(actions.runQuery).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("keeps a paginated standalone status conversation active until every database page is shown", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), draft = newLiquidityDraft("status"), actions = actionContext(ctx);
    draft.remainingPages = ["Last message of this database page. Reply next for more positions."]; draft.positionCursor = "20";
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "First message", active: true });
    await invoke(handle, actions, { ...base, requestKey: "terminal:status-last-message", text: "next" });
    expect(ctx.data.get(first.conversationId)!.active).toBe(true);
    expect(JSON.parse(ctx.data.get(first.conversationId)!.stateJson).positionCursor).toBe("20");
    expect(actions.runQuery).not.toHaveBeenCalled();
  });
  it.each(["x", "terminal"])("uses a bare version answer at the actual current %s step, not a pool choice", async source => {
    const ctx = await setup(), root = { ...base, source, scope: `${source}:version-test`, requestKey: `${source}:version-root` };
    const first = await invoke(reserveTurn, ctx, root), d = shapeDraft();
    delete d.fields.version; delete d.fields.feePips; delete d.fields.tickSpacing; d.phase = "version";
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "V3 or V4?", active: true });
    if (source === "x") await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "version-prompt" });
    vi.mocked(openRouter).mockClear(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network expected"); }));
    const result = await invoke(handle, actionContext(ctx), { ...root, requestKey: `${source}:version-answer`, text: "3", ...(source === "x" ? { parentPostId: "version-prompt" } : {}) });
    const saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved.fields.version).toBe(3); expect(saved.phase).toBe("fee");
    expect(result.message).toContain("Choose 0.01%, 0.05%, 0.3%, or 1%.");
    expect(openRouter).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("does not queue old add-liquidity quotes after removing the synthetic add path", async () => {
    vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "true");
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), draft = newLiquidityDraft("add");
    draft.executionPlanJson = "old-add-plan"; draft.review = { hash: `0x${"a".repeat(64)}`, executionReady: true, expiresAt: Date.now() + 10000 };
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "Quote", active: true });
    await expect(invoke(queueExecution, ctx, { turnId: first.turnId, planJson: "old-add-plan" })).rejects.toThrow("DELTA_NATIVE_ADD_UNVERIFIED");
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it.each(["x", "terminal"])("returns the add-unavailable response without quotes or transactions on %s", async source => {
    const ctx = await setup(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No signer expected"); }));
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: "add", updates: [], inquiryTopics: [] }));
    const result = await invoke(handle, actionContext(ctx), { ...base, source, scope: `${source}:private`, requestKey: `${source}:add`, text: "add liquidity to my position" });
    expect(result.message).toContain("Adding to a position isn’t available");
    expect(result.message).not.toContain("Example:");
    expect(fetch).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("delivers the requested status fields from the signer, without band or version summaries", async () => {
    vi.stubEnv("WALLET_SIGNER_URL", "https://signer.invalid"); vi.stubEnv("WALLET_SIGNER_TOKEN", "test");
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), draft = shapeDraft(); draft.operation = "status";
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "Status", active: true });
    const wallet = [...ctx.data.values()].find(r => r._id.startsWith("cryptoWallets:"))!;
    await ctx.db.insert("liquidityManagedPositions", { publicId: "LP-12345678", ownerXUserId: LIQUIDITY_TEST_OWNER, walletId: wallet._id, status: "active", token: draft.tokenAddress, symbol: "PONSBOT", version: 4, fieldsJson: JSON.stringify(draft.fields), legsJson: "[]" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ block: "100", assets: [{ symbol: "ETH", amount: "0.01", usd: 20, unclaimed: ".001", unclaimedUsd: 2 }, { symbol: "PONSBOT", amount: "100", usd: 20, unclaimed: "10", unclaimedUsd: 2 }], range: { lower: .00001, upper: .00002, unit: "ETH", inRange: false } }))));
    const result = await invoke(handle, actionContext(ctx), { ...base, requestKey: "terminal:refresh-status", text: "refresh" });
    expect(result.message).toContain("LP-12345678"); expect(result.message).toContain("PONSBOT: 100 PONSBOT (~$20.00)");
    expect(result.message).toContain("Unclaimed fees"); expect(result.message).toContain("Outside the funded range");
    expect(result.message).not.toMatch(/V[34]|band|profit|loss/i);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://signer.invalid/v1/liquidity/status");
  });
  it("allows ordinary commands through even with an active parsing draft", async () => {
    const ctx = await setup(); await invoke(reserveTurn, ctx, base);
    for (const text of ["buy $10 LIQUIDITY", "launch token Pool", "send 1 ETH to @bob", "what's my wallet balance?"]) expect(await invoke(reserveTurn, ctx, { ...base, requestKey: text, text })).toEqual({ handled: false });
  });
  it("cancels a busy draft and fences out its previous action", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base);
    const cancelled = await invoke(handle, actionContext(ctx), { ...base, requestKey: "terminal:cancel-busy", text: "cancel" });
    expect(cancelled.message).toContain("cancelled");
    expect(ctx.data.get(first.turnId)).toMatchObject({ status: "cancelled", response: expect.stringContaining("cancelled") });
    await expect(invoke(saveTurn, ctx, { turnId: first.turnId, revision: first.revision, state: first.state, message: "stale", active: true })).rejects.toThrow("LP_STALE_TURN");
  });
  it("recovers an abandoned turn after the lease and fences same-event retries", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base);
    await ctx.db.patch(first.turnId, { createdAt: Date.now() - 400_000 });
    const resumed = await invoke(reserveTurn, ctx, base);
    expect(resumed.revision).toBe(first.revision + 1);
    await expect(invoke(saveTurn, ctx, { turnId: first.turnId, revision: first.revision, state: first.state, message: "stale", active: true })).rejects.toThrow("LP_STALE_TURN");
  });
  it("does not falsely cancel an already queued wallet action", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base);
    await ctx.db.insert("liquidityExecutions", { conversationId: first.conversationId, status: "running" });
    const answer = await invoke(reserveTurn, ctx, { ...base, requestKey: "terminal:cancel-executing", text: "cancel" });
    expect(answer.message).toContain("already executing"); expect(answer.message).not.toContain("No funds were moved");
  });
  it("directly finds an older position beyond 100 and paginates lists newest first", async () => {
    const ctx = await setup(), wallet = [...ctx.data.values()].find(r => r._id.startsWith("cryptoWallets:"))!;
    for (let n = 0; n < 105; n++) await ctx.db.insert("liquidityManagedPositions", { publicId: `LP-${n.toString(16).padStart(8, "0").toUpperCase()}`, ownerXUserId: LIQUIDITY_TEST_OWNER, walletId: wallet._id, status: "active" });
    const direct = await invoke(resolveContext, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, position: "LP-00000000" });
    expect(direct.position.publicId).toBe("LP-00000000");
    const first = await invoke(resolveContext, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, listPositions: true });
    const second = await invoke(resolveContext, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, listPositions: true, cursor: first.nextCursor });
    expect(first.positions).toHaveLength(20); expect(second.positions).toHaveLength(20);
    expect(first.positions[0].publicId).toBe("LP-00000068"); expect(second.positions[0].publicId).toBe("LP-00000054");
  });
  it("allows another valid user to request liquidity but requires their own wallet", async () => {
    const ctx = await setup(), before = ctx.data.size;
    expect(await invoke(reserveTurn, ctx, { ...base, ownerXUserId: "123" })).toEqual({ handled: true, message: "👛 Ask for your wallet first, then start your liquidity request." });
    expect(ctx.data.size).toBe(before);
  });
  it("passes unrelated normal commands through with no conversation", async () => {
    const ctx = await setup(); expect(await invoke(reserveTurn, ctx, { ...base, text: "buy $10 PONSBOT" })).toEqual({ handled: false });
  });
  it("saves only one turn per event and returns the same answer on a retry", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base);
    expect(first.publicId).toMatch(/^LQ-[A-F0-9]{8}$/);
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: first.state, message: "What budget?", active: true });
    const repeated = await invoke(reserveTurn, ctx, base);
    expect(repeated.message).toBe("What budget?");
    expect([...ctx.data.values()].filter(r => String(r._id).startsWith("liquidityTurns:")).length).toBe(1);
    await expect(invoke(reserveTurn, ctx, { ...base, text: "instead use $900" })).rejects.toThrow("LP_REQUEST_ID_REUSED");
  });
  it("does not advance while another turn is still being parsed", async () => {
    const ctx = await setup(); await invoke(reserveTurn, ctx, base);
    expect((await invoke(reserveTurn, ctx, { ...base, requestKey: "terminal:event002", text: "$100" })).message).toContain("preparing");
  });
  it("binds X continuation to the owner and latest actual bot prompt", async () => {
    const ctx = await setup(), root = { ...base, source: "x", scope: `x:${LIQUIDITY_TEST_OWNER}`, requestKey: "x:100" };
    const first = await invoke(reserveTurn, ctx, root);
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: first.state, message: "Budget?", active: true });
    await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "101" });
    expect(await invoke(isContinuation, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "101" })).toBe(true);
    expect(await invoke(isContinuation, ctx, { ownerXUserId: "someone_else", parentPostId: "101" })).toBe(false);
    const next = await invoke(reserveTurn, ctx, { ...root, requestKey: "x:102", parentPostId: "101", text: "$100" });
    await invoke(saveTurn, ctx, { turnId: next.turnId, state: next.state, message: "Choose a pool", active: true });
    await invoke(attachPrompt, ctx, { requestKey: "x:102", responsePostId: "103" });
    expect(await invoke(isContinuation, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "101" })).toBe(false);
    expect(await invoke(isContinuation, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "103" })).toBe(true);
    expect((await invoke(reserveTurn, ctx, { ...root, requestKey: "x:104", parentPostId: "101", text: "confirm" })).message).toContain("latest Pons Bot liquidity message");
  });
  it("does not attach a terminal draft to an X reply", async () => {
    const ctx = await setup(); const first = await invoke(reserveTurn, ctx, base);
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: first.state, message: "Budget?", active: true });
    expect(await invoke(reserveTurn, ctx, { ...base, source: "x", scope: `x:${LIQUIDITY_TEST_OWNER}`, requestKey: "x:200", text: "yes" })).toEqual({ handled: false });
  });
  it("moves an existing X setup to a new collision reply when the owner says continue", async () => {
    const ctx = await setup(), actions = actionContext(ctx);
    const root = { ...base, source: "x" as const, scope: "x:continue-branch", requestKey: "x:continue-root" };
    const first = await invoke(reserveTurn, ctx, root), draft = newLiquidityDraft("open", { token: "PONSBOT" });
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "Budget?", active: true });
    await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "old-budget-prompt" });
    const collision = await invoke(reserveTurn, ctx, { ...root, requestKey: "x:new-comment", text: "create liquidity for $PONS" });
    expect(collision.message).toContain("Respond continue");
    await invoke(attachPrompt, ctx, { requestKey: "x:new-comment", responsePostId: "new-continue-prompt" });
    expect(await invoke(isContinuation, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "new-continue-prompt" })).toBe(true);
    const resumed = await invoke(handle, actions, { ...root, requestKey: "x:continue-answer", parentPostId: "new-continue-prompt", text: "continue" });
    expect(resumed.message).toContain("position budget");
    expect(JSON.parse(ctx.data.get(first.conversationId)!.stateJson).fields.token).toBe("PONSBOT");
  });
  it("thread membership cannot promote an owner yes to a newer executable quote", async () => {
    vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "true");
    const ctx = await setup(), actions = actionContext(ctx), root = { ...base, source: "x", scope: "x:owner", requestKey: "x:root" };
    const first = await invoke(reserveTurn, ctx, root);
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: first.state, message: "Budget?", active: true });
    await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "old-prompt" });
    expect(await invoke(guardThread, ctx, { ownerXUserId: "outsider", parentPostId: "old-prompt", postId: "foreign-1", text: "yes" })).toBe("silent");
    expect(await invoke(guardThread, ctx, { ownerXUserId: "outsider", parentPostId: "foreign-1", postId: "foreign-create", text: "create liquidity for PONSBOT" })).toBe("redirect");
    await ctx.db.insert("liquidityThreadPosts", { postId: "foreign-redirect", conversationId: first.conversationId });
    const next = await invoke(reserveTurn, ctx, { ...root, requestKey: "x:owner-choice", parentPostId: "old-prompt", text: "$100" });
    const draft = shapeDraft(); draft.phase = "review"; draft.fields.shape = "flat"; draft.fields.bands = 1;
    draft.executionPlanJson = "offline-test-plan";
    draft.review = { hash: `0x${"a".repeat(64)}`, executionReady: true, expiresAt: Date.now() + 60000 };
    await invoke(saveTurn, ctx, { turnId: next.turnId, state: JSON.stringify(draft), message: "Current quote. Confirm?", active: true });
    await invoke(attachPrompt, ctx, { requestKey: "x:owner-choice", responsePostId: "current-quote" });
    const before = structuredClone(ctx.data.get(first.conversationId)!);
    for (const parentPostId of ["foreign-1", "foreign-create", "foreign-redirect", "root", "owner-choice", "old-prompt"]) {
      expect(await invoke(isContinuation, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, parentPostId })).toBe(false);
      const result = await invoke(handle, actions, { ...root, requestKey: `x:yes-to-${parentPostId}`, parentPostId, text: "yes" });
      expect(result.message).toContain("latest Pons Bot liquidity message");
      expect(ctx.data.get(first.conversationId)).toEqual(before);
    }
    expect([...ctx.data.values()].filter(r => r._id.startsWith("liquidityExecutions:"))).toHaveLength(0);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled(); expect(actions.runAction).not.toHaveBeenCalled();
    expect(await invoke(isContinuation, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "current-quote" })).toBe(true);
    const confirmed = await invoke(handle, actions, { ...root, requestKey: "x:proper-confirm", parentPostId: "current-quote", text: "yes" });
    expect(confirmed).toMatchObject({ handled: true, deferred: true });
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
    expect([...ctx.data.values()].filter(r => r._id.startsWith("liquidityExecutions:"))).toHaveLength(1);
    expect(actions.runAction).not.toHaveBeenCalled();
  });
  it("recovers a published prompt after attachment failure, never an obsolete replacement", async () => {
    const ctx = await setup(), root = { ...base, source: "x", scope: "x:recovery", requestKey: "x:root" };
    const first = await invoke(reserveTurn, ctx, root);
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: first.state, message: "Budget?", active: true });
    await ctx.db.insert("xReplyInteractions", { postId: "root", responsePostId: "published-prompt" });
    expect(await invoke(isContinuation, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "root" })).toBe(false);
    expect(await invoke(isContinuation, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "published-prompt" })).toBe(true);
    await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "replacement-prompt" });
    expect(await invoke(isContinuation, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "published-prompt" })).toBe(false);
    expect(await invoke(isContinuation, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "replacement-prompt" })).toBe(true);
  });
  it("queues a confirmed current quote once; reviewing pages is not confirmation", async () => {
    vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "true");
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), draft = newLiquidityDraft();
    draft.executionPlanJson = "signed-plan";
    draft.review = { hash: `0x${"a".repeat(64)}`, executionReady: true, expiresAt: Date.now() + 10000 };
    draft.remainingPages = ["Must review remaining terms"];
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "Quote", active: true });
    const confirm = await invoke(reserveTurn, ctx, { ...base, requestKey: "terminal:confirm", text: "confirm" });
    await expect(invoke(queueExecution, ctx, { turnId: confirm.turnId, planJson: "signed-plan" })).rejects.toThrow("Stale");
    draft.remainingPages = [];
    await ctx.db.patch(first.conversationId, { stateJson: JSON.stringify(draft) });
    const id = await invoke(queueExecution, ctx, { turnId: confirm.turnId, planJson: "signed-plan" });
    expect(await invoke(queueExecution, ctx, { turnId: confirm.turnId, planJson: "signed-plan" })).toBe(id);
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
  });
  it("answers a question in the actual terminal handler, keeps the draft, then accepts the choice", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), draft = shapeDraft(), actions = actionContext(ctx);
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(draft), message: "Choose your shape", active: true });
    const question = await invoke(handle, actions, { ...base, requestKey: "terminal:help", text: "what does this mean?" });
    expect(question.message).toContain("Delta calls it spot"); expect(question.message).toContain("Choose flat");
    let saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved.fields).toEqual(draft.fields); expect(saved.operation).toBe("open"); expect(saved.phase).toBe("shape");
    expect(ctx.data.get(first.conversationId)!.active).toBe(true);
    expect(actions.runQuery).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    mockOpenQuote(5);
    vi.mocked(openRouter).mockResolvedValueOnce(JSON.stringify({ operation: null, inquiryTopics: [], updates: [{ field: "shape", value: "bell", evidence: "bell" }] }));
    const choice = await invoke(handle, actions, { ...base, requestKey: "terminal:choose-bell", text: "bell" });
    expect(choice.message).toContain("Shape: Bell"); expect(choice.message).not.toContain("Suggested bands");
    saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved.fields.shape).toBe("bell"); expect(saved.phase).toBe("review"); expect(saved.fields.bands).toBe(5); expect(saved.fields.amount).toBe("100");
    expect(actions.runAction).not.toHaveBeenCalled();
  });
  it("paginates X explanations separately, allows another question, then resumes the untouched quote", async () => {
    const ctx = await setup(), root = { ...base, source: "x", scope: `x:${LIQUIDITY_TEST_OWNER}`, requestKey: "x:500" };
    const first = await invoke(reserveTurn, ctx, root), d = shapeDraft(), actions = actionContext(ctx);
    d.fields.shape = "bell"; d.fields.bands = 3; d.phase = "review";
    d.review = { hash: `0x${"b".repeat(64)}`, executionReady: true, expiresAt: Date.now() + 60000 }; d.executionPlanJson = "unchanged-proof";
    d.remainingPages = ["Original funding terms", "Original confirmation terms"];
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "Quote page one", active: true });
    await invoke(attachPrompt, ctx, { requestKey: root.requestKey, responsePostId: "501" });
    await invoke(handle, actions, { ...root, requestKey: "x:502", parentPostId: "501", text: "what is slippage?" });
    await invoke(attachPrompt, ctx, { requestKey: "x:502", responsePostId: "503" });
    expect(await invoke(isContinuation, ctx, { ownerXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "503" })).toBe(true);
    const second = await invoke(handle, actions, { ...root, requestKey: "x:504", parentPostId: "503", text: "explain gas" });
    expect(second.message).toContain("Gas is the network");
    let saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
    expect(saved.remainingPages).toEqual(d.remainingPages); expect(saved.review).toEqual(d.review); expect(saved.executionPlanJson).toBe("unchanged-proof");
    let request = "x:504", post = 505;
    while (saved.explanationPages.length) {
      await invoke(attachPrompt, ctx, { requestKey: request, responsePostId: String(post) });
      request = `x:${post + 1}`;
      await invoke(handle, actions, { ...root, requestKey: request, parentPostId: String(post), text: "next" });
      post += 2; saved = JSON.parse(ctx.data.get(first.conversationId)!.stateJson);
      expect(saved.remainingPages).toEqual(d.remainingPages);
    }
    await invoke(attachPrompt, ctx, { requestKey: request, responsePostId: String(post) });
    const resume = await invoke(handle, actions, { ...root, requestKey: `x:${post + 1}`, parentPostId: String(post), text: "next" });
    expect(resume.message).toBe("Original funding terms");
    expect(actions.runQuery).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("cannot turn a question during quote review into a wallet action or skip unread terms", async () => {
    const ctx = await setup(), first = await invoke(reserveTurn, ctx, base), d = shapeDraft(), actions = actionContext(ctx);
    d.phase = "review"; d.fields.shape = "bell"; d.fields.bands = 3;
    d.review = { hash: `0x${"b".repeat(64)}`, executionReady: true, expiresAt: Date.now() + 60000 }; d.executionPlanJson = "plan"; d.remainingPages = ["Must read funding terms"];
    await invoke(saveTurn, ctx, { turnId: first.turnId, state: JSON.stringify(d), message: "Quote", active: true });
    const result = await invoke(handle, actions, { ...base, requestKey: "terminal:question-confirm", text: "What happens if I confirm?" });
    expect(result.message).toContain("explicit confirmation");
    const confirm = await invoke(handle, actions, { ...base, requestKey: "terminal:too-early", text: "confirm" });
    expect(confirm.message).toContain("remaining details"); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    expect([...ctx.data.values()].filter(row => row._id.startsWith("liquidityExecutions:"))).toHaveLength(0);
  });
});

describe("liquidity bounded health monitoring", () => {
  it("flags stale work without mutating or scheduling it", async () => {
    const ctx = await setup(), old = Date.now() - 20 * 60_000;
    await ctx.db.insert("liquidityTurns", { conversationId: "liquidityConversations:missing", ownerXUserId: LIQUIDITY_TEST_OWNER, requestKey: "x:stale", status: "processing", createdAt: old });
    const snapshot = await invoke(health, ctx, {});
    expect(snapshot.staleProcessingTurns).toBe(1);
    const result = await invoke(monitorHealth, { runQuery: () => snapshot }, {});
    expect(result.unhealthy).toBe(true);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
});

describe("liquidity execution recovery (no external actions)", () => {
  async function executionSetup(steps: unknown[], calls = [{ purpose: "open", to: "0x1111111111111111111111111111111111111111", value: "0", data: "0x12" }]) {
    vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "true");
    vi.useFakeTimers({ toFake: ["Date"] });
    chain.getTransactionReceipt.mockReset(); chain.getTransaction.mockReset();
    const ctx = await setup(), turn = await invoke(reserveTurn, ctx, base), d = shapeDraft();
    d.fields.shape = "flat"; d.fields.bands = 1;
    await ctx.db.patch(turn.conversationId, { stateJson: JSON.stringify(d) });
    const plan = { owner: LIQUIDITY_TEST_WALLET, token: d.tokenAddress, symbol: "PONSBOT", poolId: `0x${"1".repeat(64)}`, version: 4, operation: "open", calls, expiresAt: Date.now() + 60000, executionDeadline: Date.now() + 660000 };
    const id = await ctx.db.insert("liquidityExecutions", { conversationId: turn.conversationId, walletId: turn.walletId, ownerXUserId: LIQUIDITY_TEST_OWNER, status: "running", planJson: JSON.stringify(plan), stepsJson: JSON.stringify(steps), updatedAt: Date.now(), createdAt: Date.now() });
    const mutations: Record<string, unknown> = { persistSteps, retryRevertedOpen, executionHeartbeat, deferExecution, finishExecution, reserveDelivery, settleDelivery };
    const actions = { scheduler: ctx.scheduler,
      runQuery: (ref: any, args: unknown) => invoke(getFunctionName(ref) === "liquidity:executionWritesEnabled" ? executionWritesEnabled : executionContext, ctx, args),
      runMutation: vi.fn((ref, args): boolean | undefined | ReturnType<typeof invoke> => { const name = getFunctionName(ref).split(":")[1]; return name === "acquireWalletExecutionLock" ? true : name === "releaseWalletExecutionLock" ? undefined : invoke(mutations[name], ctx, args); }),
    };
    vi.stubEnv("WALLET_SIGNER_URL", "https://signer.invalid/api"); vi.stubEnv("WALLET_SIGNER_TOKEN", "offline");
    return { ctx, actions, id, plan };
  }
  function advanceToRetry(ctx: ReturnType<typeof store>, id: string) {
    const due = ctx.data.get(id)?.nextAttemptAt;
    if (due !== undefined) vi.setSystemTime(due);
  }
  const settled = { transactionHash: `0x${"a".repeat(64)}`, signedTransaction: "0xab", toAddress: "0x1111111111111111111111111111111111111111", valueWei: "0", nonce: 1, confirmed: true, blockNumber: "100" };
  it("reprices one reverted final open without repeating its confirmed funding step or publishing a failure", async () => {
    const final = { ...settled, transactionHash: `0x${"b".repeat(64)}`, nonce: 2, confirmed: false };
    const calls = [{ purpose: "funding_buy", to: settled.toAddress, value: "1", data: "0x12" }, { purpose: "open", to: final.toAddress, value: "0", data: "0x34" }];
    const { ctx, actions, id } = await executionSetup([settled, final], calls);
    chain.getTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 101n, transactionHash: final.transactionHash,
      from: LIQUIDITY_TEST_WALLET, to: final.toAddress });
    await invoke(execute, actions, { executionId: id });
    const execution = ctx.data.get(id)!;
    expect(execution).toMatchObject({ status: "running", stage: "retry_reverted_open", diagnostic: "LP_OPEN_PRICE_RETRY", openRecoveryCount: 1 });
    expect(JSON.parse(execution.stepsJson)).toEqual([settled]);
    expect(JSON.parse(execution.revertedOpenStepsJson)).toEqual([{ ...final, reverted: true }]);
    expect(execution.response).toBeUndefined();
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(0, expect.anything(), { executionId: id });
  });
  it("does not loop after a second reverted final open", async () => {
    const calls = [{ purpose: "funding_buy", to: settled.toAddress, value: "1", data: "0x12" }, { purpose: "open", to: settled.toAddress, value: "0", data: "0x34" }];
    const failed = { ...settled, transactionHash: `0x${"c".repeat(64)}`, nonce: 2, confirmed: false, reverted: true };
    const { ctx, id } = await executionSetup([settled, failed], calls);
    await ctx.db.patch(id, { openRecoveryCount: 1 });
    expect(await invoke(retryRevertedOpen, ctx, { executionId: id })).toBe(false);
    expect(JSON.parse(ctx.data.get(id)!.stepsJson)).toHaveLength(2);
  });
  it.each(["prepare", "sign", "broadcast"])("blocks the %s stage after execution is disabled and retains saved state", async stage => {
    const envelope = { unsignedTransaction: serializeTransaction({ type: "eip1559", chainId: 4663, nonce: 1, to: settled.toAddress as `0x${string}`, value: 0n, data: "0x12", gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }), toAddress: settled.toAddress, valueWei: "0", nonce: 1, envelopeProof: "proof" };
    const steps = stage === "prepare" ? [] : stage === "sign" ? [{ toAddress: settled.toAddress, valueWei: "0", nonce: 1, envelope }] : [{ ...settled, confirmed: false }];
    const { ctx, actions, id } = await executionSetup(steps);
    vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "false");
    chain.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: settled.transactionHash as `0x${string}` }));
    chain.getTransaction.mockRejectedValue(new TransactionNotFoundError({ hash: settled.transactionHash as `0x${string}` }));
    vi.stubGlobal("fetch", vi.fn());
    await invoke(execute, actions, { executionId: id });
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.data.get(id)).toMatchObject({ status: "manual_review", diagnostic: "LP_EXECUTION_DISABLED", stepsJson: JSON.stringify(steps) });
    vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "true"); advanceToRetry(ctx, id);
    await invoke(execute, actions, { executionId: id });
    expect(fetch).not.toHaveBeenCalled(); // No automatic new spending after an operator stop.
  });
  it("still reconciles and delivers a completed transaction while execution is disabled", async () => {
    const { ctx, actions, id } = await executionSetup([settled]);
    vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "false");
    const legs = [{ tokenId: "123", tickLower: -600, tickUpper: 600, liquidity: "10" }];
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async url => {
      expect(url).toContain("/liquidity/receipt");
      return new Response(JSON.stringify({ status: "confirmed", legs }));
    }));
    await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)?.status).toBe("confirmed");
  });
  it("carries the bot terminal identity through preparation and final terminal delivery", async () => {
    const { ctx, actions, id } = await executionSetup([]);
    const e = ctx.data.get(id)!, conversation = ctx.data.get(e.conversationId)!;
    const plan = JSON.parse(e.planJson); plan.owner = LIQUIDITY_TERMINAL_TEST_WALLET;
    await ctx.db.patch(e.walletId, { ownerXUserId: LIQUIDITY_TERMINAL_TEST_OWNER, address: LIQUIDITY_TERMINAL_TEST_WALLET });
    await ctx.db.patch(conversation._id, { ownerXUserId: LIQUIDITY_TERMINAL_TEST_OWNER });
    await ctx.db.patch(conversation.currentTurnId, { ownerXUserId: LIQUIDITY_TERMINAL_TEST_OWNER });
    await ctx.db.patch(id, { ownerXUserId: LIQUIDITY_TERMINAL_TEST_OWNER, planJson: JSON.stringify(plan) });
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      expect(JSON.parse(init!.body as string)).toMatchObject({ ownerXUserId: LIQUIDITY_TERMINAL_TEST_OWNER, source: "terminal" });
      throw new Error("offline-stop-before-signing");
    }));
    await invoke(execute, actions, { executionId: id });
    expect(fetch).toHaveBeenCalledOnce();
    await invoke(finishExecution, ctx, { executionId: id, success: true, legsJson: JSON.stringify([{ tokenId: "123", tickLower: -600, tickUpper: 600, liquidity: "10" }]), transactionHash: settled.transactionHash });
    const original = actions.runMutation.getMockImplementation()!, messages: any[] = [];
    actions.runMutation.mockImplementation((ref, args) => {
      if (getFunctionName(ref) === "wallets:recordTerminalMessage") { messages.push(args); return; }
      return original(ref, args);
    });
    await invoke(deliverExecution, actions, { executionId: id });
    expect(messages).toHaveLength(1); expect(messages[0].ownerXUserId).toBe(LIQUIDITY_TERMINAL_TEST_OWNER);
    expect(ctx.data.get(id)?.deliveryStatus).toBe("handed_off");
  });
  it("reconciles each already-confirmed fee collection once and never re-signs it", async () => {
    const second = { ...settled, nonce: 2, transactionHash: `0x${"b".repeat(64)}` };
    const calls = [0, 1].map(() => ({ purpose: "claim", to: settled.toAddress, value: "0", data: "0x12" }));
    const { ctx, actions, id } = await executionSetup([settled, second], calls);
    const e = ctx.data.get(id)!, plan = JSON.parse(e.planJson); plan.operation = "claim";
    plan.claimPositions = [{ positionId: "LP-11111111" }, { positionId: "LP-22222222" }];
    e.planJson = JSON.stringify(plan);
    const conversation = ctx.data.get(e.conversationId)!, draft = JSON.parse(conversation.stateJson); draft.operation = "claim"; conversation.stateJson = JSON.stringify(draft);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body); expect(body.step).toBe(1);
      return new Response(JSON.stringify({ status: "confirmed", legs: [], received: ["2 PONSBOT"] }));
    }));
    const steps = JSON.parse(e.stepsJson); steps[0].received = ["0.001 ETH"]; e.stepsJson = JSON.stringify(steps);
    await invoke(execute, actions, { executionId: id });
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.mocked(fetch).mock.calls[0][0]).toContain("/liquidity/receipt");
    expect(ctx.data.get(id)!.status).toBe("confirmed");
    expect(ctx.data.get(id)!.response).toContain("LP-11111111: 0.001 ETH"); expect(ctx.data.get(id)!.response).toContain("LP-22222222: 2 PONSBOT");
    expect(chain.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it("reports collected fees when the later close fails, not an undifferentiated failure", async () => {
    const { ctx, id } = await executionSetup([{ ...settled, received: ["0.001 ETH"] }], [{ purpose: "claim", to: settled.toAddress, value: "0", data: "0x12" }, { purpose: "withdraw", to: settled.toAddress, value: "0", data: "0x34" }]);
    await invoke(finishExecution, ctx, { executionId: id, success: false, legsJson: "[]", diagnostic: "LIQUIDITY_TRANSACTION_REVERTED" });
    expect(ctx.data.get(id)!.response).toContain("Some LP fees were collected");
    expect(ctx.data.get(id)!.response).toContain("0.001 ETH");
    expect(ctx.data.get(id)!.response).toContain(settled.transactionHash);
  });
  it("fails an expired unstarted quote without preparation, signing, or broadcasting", async () => {
    const { ctx, actions, id, plan } = await executionSetup([]);
    vi.setSystemTime(plan.expiresAt); vi.stubGlobal("fetch", vi.fn());
    await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)?.status).toBe("failed"); expect(ctx.data.get(id)?.diagnostic).toBe("LIQUIDITY_QUOTE_EXPIRED");
    expect(fetch).not.toHaveBeenCalled(); expect(chain.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it.each(["approval", "claim", "withdraw", "open"])("never broadcasts an expired saved %s transaction, but preserves it for reconciliation", async purpose => {
    const { ctx, actions, id, plan } = await executionSetup([{ ...settled, confirmed: false }], [{ purpose, to: settled.toAddress, value: "0", data: "0x12" }]);
    vi.setSystemTime(plan.executionDeadline);
    chain.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: settled.transactionHash as `0x${string}` }));
    chain.getTransaction.mockRejectedValue(new TransactionNotFoundError({ hash: settled.transactionHash as `0x${string}` }));
    vi.stubGlobal("fetch", vi.fn());
    await invoke(execute, actions, { executionId: id });
    expect(fetch).not.toHaveBeenCalled(); expect(chain.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(ctx.data.get(id)?.status).toBe("manual_review");
    expect(ctx.data.get(id)?.diagnostic).toBe("LP_EXPIRED_ENVELOPE_REQUIRES_REVIEW");
    expect(JSON.parse(ctx.data.get(id)!.stepsJson)[0].signedTransaction).toBe(settled.signedTransaction);
    expect(ctx.data.get(id)?.response).toBeUndefined();
  });
  it("does not resume signing a prepared envelope after expiration", async () => {
    const step = { toAddress: settled.toAddress, valueWei: "0", nonce: 1, envelope: { unsignedTransaction: "0x12", envelopeProof: "proof" } };
    const { ctx, actions, id, plan } = await executionSetup([step]);
    vi.setSystemTime(plan.executionDeadline); vi.stubGlobal("fetch", vi.fn());
    await invoke(execute, actions, { executionId: id });
    expect(fetch).not.toHaveBeenCalled(); expect(JSON.parse(ctx.data.get(id)!.stepsJson)).toEqual([step]);
    expect(ctx.data.get(id)?.status).toBe("manual_review");
  });
  it("can reconcile a late successful final receipt after expiration without rebroadcasting", async () => {
    const { ctx, actions, id, plan } = await executionSetup([{ ...settled, confirmed: false }]);
    vi.setSystemTime(plan.executionDeadline + 60000);
    chain.getTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 123n, transactionHash: settled.transactionHash, from: plan.owner, to: settled.toAddress });
    const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "confirmed", legs: [{ tokenId: "123", tickLower: -600, tickUpper: 600, liquidity: "10" }] })));
    vi.stubGlobal("fetch", network);
    await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)?.status).toBe("confirmed");
    expect(network).toHaveBeenCalledTimes(1); expect(network.mock.calls[0][0]).toMatch(/\/receipt$/);
  });
  it("stops before another funding step if the execution window expires after an approval", async () => {
    const { ctx, actions, id, plan } = await executionSetup([settled], [{ purpose: "approval", to: settled.toAddress, value: "0", data: "0x12" }, { purpose: "open", to: settled.toAddress, value: "100", data: "0x34" }]);
    vi.setSystemTime(plan.executionDeadline); vi.stubGlobal("fetch", vi.fn());
    await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)?.status).toBe("failed"); expect(ctx.data.get(id)?.response).toContain("some steps completed");
    expect(fetch).not.toHaveBeenCalled(); expect(JSON.parse(ctx.data.get(id)!.stepsJson)).toEqual([settled]);
  });
  it("does not save raw signer transport exceptions to execution diagnostics", async () => {
    const { ctx, actions, id } = await executionSetup([]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Authorization: Bearer secret; signedTransaction 0xdeadbeef")));
    await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)?.diagnostic).toBe("LP_EXECUTION_FAILED");
  });
  it("deduplicates lock-contention retries without consuming the transaction retry budget", async () => {
    const { ctx, actions, id } = await executionSetup([]), original = actions.runMutation.getMockImplementation()!;
    actions.runMutation.mockImplementation((ref, args) => getFunctionName(ref).endsWith(":acquireWalletExecutionLock") ? false : original(ref, args));
    vi.stubGlobal("fetch", vi.fn());
    await invoke(execute, actions, { executionId: id });
    await invoke(execute, actions, { executionId: id });
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
    expect(ctx.data.get(id)?.retryCount).toBe(0);
    expect(ctx.data.get(id)?.diagnostic).toBe("LP_WALLET_BUSY");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never treats a receipt RPC outage as permission to broadcast and honors the retry time", async () => {
    const { ctx, actions, id } = await executionSetup([{ ...settled, confirmed: false }]);
    chain.getTransactionReceipt.mockRejectedValue(new Error("429 RPC unavailable"));
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No signer or broadcast allowed"); }));
    await invoke(execute, actions, { executionId: id });
    const before = { ...ctx.data.get(id)! }, jobs = ctx.scheduler.runAfter.mock.calls.length;
    for (let n = 0; n < 5; n++) await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)).toEqual(before); expect(before.retryCount).toBe(1);
    expect(before.diagnostic).toBe("LP_RECEIPT_RPC_UNAVAILABLE");
    expect(chain.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(chain.getTransaction).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(jobs);
    advanceToRetry(ctx, id); await invoke(execute, actions, { executionId: id });
    expect(chain.getTransactionReceipt).toHaveBeenCalledTimes(2);
  });
  it.each([null, 123n])("waits for a known transaction instead of rebroadcasting (block %s)", async blockNumber => {
    const { ctx, actions, id } = await executionSetup([{ ...settled, confirmed: false }]);
    chain.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: settled.transactionHash as `0x${string}` }));
    chain.getTransaction.mockResolvedValue({ hash: settled.transactionHash, blockNumber });
    vi.stubGlobal("fetch", vi.fn());
    await invoke(execute, actions, { executionId: id });
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.data.get(id)?.diagnostic).toBe(blockNumber === null ? "LP_TRANSACTION_PENDING" : "LP_RECEIPT_INDEXING");
    expect(JSON.parse(ctx.data.get(id)!.stepsJson)[0].confirmed).toBe(false);
  });
  it("does not rebroadcast when the secondary transaction lookup fails", async () => {
    const { ctx, actions, id } = await executionSetup([{ ...settled, confirmed: false }]);
    chain.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: settled.transactionHash as `0x${string}` }));
    chain.getTransaction.mockRejectedValue(new Error("RPC timeout")); vi.stubGlobal("fetch", vi.fn());
    await invoke(execute, actions, { executionId: id });
    expect(fetch).not.toHaveBeenCalled(); expect(ctx.data.get(id)?.diagnostic).toBe("LP_TRANSACTION_RPC_UNAVAILABLE");
  });
  it("does not mark a malformed receipt as a reverted transaction", async () => {
    const { ctx, actions, id } = await executionSetup([{ ...settled, confirmed: false }]);
    chain.getTransactionReceipt.mockResolvedValue({ blockNumber: 123n }); vi.stubGlobal("fetch", vi.fn());
    await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)?.diagnostic).toBe("LP_RECEIPT_RPC_INVALID");
    expect(JSON.parse(ctx.data.get(id)!.stepsJson)[0].reverted).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("stops endless polling but preserves an uncertain transaction for manual review", async () => {
    const { ctx, actions, id } = await executionSetup([{ ...settled, confirmed: false }]);
    chain.getTransactionReceipt.mockRejectedValue(new Error("RPC unavailable")); vi.stubGlobal("fetch", vi.fn());
    for (let n = 0; n < LIQUIDITY_TOTAL_ATTEMPTS; n++) { advanceToRetry(ctx, id); await invoke(execute, actions, { executionId: id }); }
    expect(ctx.data.get(id)?.status).toBe("manual_review");
    expect(ctx.data.get(id)?.nextAttemptAt).toBeUndefined();
    const jobs = ctx.scheduler.runAfter.mock.calls.length;
    vi.setSystemTime(Date.now() + 3600000);
    await invoke(recoverExecutions, ctx, {}); await invoke(execute, actions, { executionId: id });
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(jobs);
    expect(chain.getTransactionReceipt).toHaveBeenCalledTimes(LIQUIDITY_TOTAL_ATTEMPTS);
    expect(JSON.parse(ctx.data.get(id)!.stepsJson)[0].signedTransaction).toBe("0xab");
    expect(ctx.data.get(id)?.response).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not let stopped manual reviews hide other due work from the watchdog", async () => {
    const { ctx, id } = await executionSetup([]);
    for (let n = 0; n < 12; n++) await ctx.db.insert("liquidityExecutions", { status: "manual_review", retryCount: LIQUIDITY_TOTAL_ATTEMPTS, leaseUntil: 0, updatedAt: 1 });
    const due = await ctx.db.insert("liquidityExecutions", { status: "manual_review", retryCount: 8, nextAttemptAt: Date.now() - 1, leaseUntil: 0, updatedAt: 1 });
    await invoke(recoverExecutions, ctx, {});
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(1);
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(0, expect.anything(), { executionId: due });
    expect(ctx.data.get(id)?.status).toBe("running");
  });
  it("does not resume spending when a manual-review approval receives a late receipt", async () => {
    const calls = [{ purpose: "approval", to: settled.toAddress, data: "0x12", value: "0" }, { purpose: "open", to: settled.toAddress, data: "0x34", value: "100" }];
    const { ctx, actions, id } = await executionSetup([{ ...settled, confirmed: false }], calls);
    await ctx.db.patch(id, { status: "manual_review", retryCount: 6 });
    chain.getTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 123n, transactionHash: settled.transactionHash, from: LIQUIDITY_TEST_WALLET, to: settled.toAddress }); vi.stubGlobal("fetch", vi.fn());
    await invoke(execute, actions, { executionId: id });
    expect(JSON.parse(ctx.data.get(id)!.stepsJson)[0].confirmed).toBe(true);
    expect(ctx.data.get(id)?.status).toBe("manual_review");
    expect(ctx.data.get(id)?.diagnostic).toBe("LP_MANUAL_REVIEW_REQUIRED");
    expect(ctx.data.get(id)?.nextAttemptAt).toBeUndefined();
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("can finish read-only reconciliation of the final deposit after manual review", async () => {
    const { ctx, actions, id } = await executionSetup([{ ...settled, confirmed: false }]);
    await ctx.db.patch(id, { status: "manual_review", retryCount: 6 });
    chain.getTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 123n, transactionHash: settled.transactionHash, from: LIQUIDITY_TEST_WALLET, to: settled.toAddress });
    const network = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "confirmed", legs: [{ tokenId: "123", tickLower: -600, tickUpper: 600, liquidity: "10" }] })));
    vi.stubGlobal("fetch", network);
    await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)?.status).toBe("confirmed");
    expect(network).toHaveBeenCalledTimes(1); expect(network.mock.calls[0][0]).toMatch(/\/receipt$/);
  });
  it("keeps successful deposits reconciling after an RPC/indexing error, then indexes once", async () => {
    const { ctx, actions, id } = await executionSetup([settled]);
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("RPC timeout")).mockResolvedValue(new Response(JSON.stringify({ status: "confirmed", legs: [{ tokenId: "123", tickLower: -600, tickUpper: 600, liquidity: "10" }] })));
    vi.stubGlobal("fetch", fetchMock);
    await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)?.status).toBe("reconciling"); expect(ctx.data.get(id)?.response).toBeUndefined();
    advanceToRetry(ctx, id);
    await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)?.status).toBe("confirmed");
    await invoke(execute, actions, { executionId: id });
    expect([...ctx.data.values()].filter(r => r._id.startsWith("liquidityManagedPositions:"))).toHaveLength(1);
    expect(fetchMock.mock.calls.every(c => c[0].endsWith("/receipt"))).toBe(true);
  });
  it("bounds broadcasts and retains nonce reservation for uncertain outcomes", async () => {
    const { ctx, actions, id } = await executionSetup([{ ...settled, confirmed: false }]);
    chain.getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: settled.transactionHash as `0x${string}` }));
    chain.getTransaction.mockRejectedValue(new TransactionNotFoundError({ hash: settled.transactionHash as `0x${string}` }));
    const fetchMock = vi.fn().mockRejectedValue(new Error("RPC rejected")); vi.stubGlobal("fetch", fetchMock);
    for (let n = 0; n < 8; n++) { advanceToRetry(ctx, id); await invoke(execute, actions, { executionId: id }); }
    expect(fetchMock).toHaveBeenCalledTimes(6); expect(ctx.data.get(id)?.status).toBe("manual_review");
    expect(JSON.parse(ctx.data.get(id)!.stepsJson)[0].signedTransaction).toBe("0xab"); expect(ctx.data.get(id)?.diagnostic).toContain("LP_PENDING_TRANSACTION");
  });
  it("persists the exact unsigned envelope before requesting a CDP signature", async () => {
    const { ctx, actions, id } = await executionSetup([]);
    const envelope = { unsignedTransaction: serializeTransaction({ type: "eip1559", chainId: 4663, to: settled.toAddress as `0x${string}`, data: "0x12", value: 0n, nonce: 1, gas: 100000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }), envelopeProof: "proof", toAddress: settled.toAddress, valueWei: "0", nonce: 1 };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/prepare-envelope")) return new Response(JSON.stringify(envelope));
      if (url.endsWith("/sign-envelope")) { expect(JSON.parse(ctx.data.get(id)!.stepsJson)[0].envelope).toEqual(envelope); throw new Error("CDP temporarily unavailable"); }
      throw new Error("Unexpected network path");
    }); vi.stubGlobal("fetch", fetchMock);
    await invoke(execute, actions, { executionId: id }); advanceToRetry(ctx, id); await invoke(execute, actions, { executionId: id });
    expect(fetchMock.mock.calls.filter(c => c[0].endsWith("/prepare-envelope"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(c => c[0].endsWith("/sign-envelope"))).toHaveLength(2);
  });
  it("does not mark a confirmed NFT deposit failed even after repeated reconciliation errors", async () => {
    const { ctx, actions, id } = await executionSetup([settled]); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("NFT read timeout")));
    for (let n = 0; n < 8; n++) { advanceToRetry(ctx, id); await invoke(execute, actions, { executionId: id }); }
    expect(ctx.data.get(id)?.status).toBe("manual_review"); expect(ctx.data.get(id)?.response).toBeUndefined();
  });
  it("recovers an abandoned job through the watchdog", async () => {
    const { ctx, id } = await executionSetup([]); await ctx.db.patch(id, { updatedAt: Date.now() - 400000 });
    await invoke(recoverExecutions, ctx, {});
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(0, expect.anything(), { executionId: id });
  });
  it("does not merge a new pool into an existing managed position", async () => {
    const { ctx, id, plan } = await executionSetup([settled]);
    const e = ctx.data.get(id)!, conversation = ctx.data.get(e.conversationId)!, d = JSON.parse(conversation.stateJson); d.operation = "add"; d.fields.position = "LP-11111111";
    await ctx.db.patch(conversation._id, { stateJson: JSON.stringify(d) });
    await ctx.db.insert("liquidityManagedPositions", { publicId: d.fields.position, ownerXUserId: LIQUIDITY_TEST_OWNER, token: plan.token, version: 3, poolId: "other-pool", legsJson: "[]" });
    await expect(invoke(finishExecution, ctx, { executionId: id, success: true, legsJson: "[]" })).rejects.toThrow("LP_POSITION_SETTINGS_CONFLICT");
  });
  it.each(["transactionHash", "from", "to"])("does not advance a step from a receipt with mismatched %s", async key => {
    const { ctx, actions, id } = await executionSetup([{ ...settled, confirmed: false }]);
    chain.getTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 123n, transactionHash: settled.transactionHash, from: LIQUIDITY_TEST_WALLET, to: settled.toAddress, [key]: "0xwrong" });
    vi.stubGlobal("fetch", vi.fn());
    await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)?.diagnostic).toBe("LP_RECEIPT_RPC_INVALID");
    expect(JSON.parse(ctx.data.get(id)!.stepsJson)[0].confirmed).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not index or report an open as successful from an empty successful signer response", async () => {
    const { ctx, actions, id } = await executionSetup([settled]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "confirmed", legs: [] }))));
    await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)?.status).toBe("reconciling"); expect(ctx.data.get(id)?.diagnostic).toBe("LP_SIGNER_RECEIPT_INVALID");
    expect([...ctx.data.values()].filter(row => row._id.startsWith("liquidityManagedPositions:"))).toHaveLength(0);
  });
  it("rejects malformed preparation without saving undefined fields or signing", async () => {
    const { ctx, actions, id } = await executionSetup([]);
    const network = vi.fn().mockResolvedValue(new Response('{"status":"ok"}')); vi.stubGlobal("fetch", network);
    await invoke(execute, actions, { executionId: id });
    expect(ctx.data.get(id)?.diagnostic).toBe("LP_SIGNER_ENVELOPE_INVALID");
    expect(JSON.parse(ctx.data.get(id)!.stepsJson)).toEqual([]); expect(network).toHaveBeenCalledTimes(1);
  });

  async function completedDelivery(source: "terminal" | "x" = "terminal") {
    const test = await executionSetup([settled]), { ctx, id, actions } = test;
    const e = ctx.data.get(id)!, conversation = ctx.data.get(e.conversationId)!;
    await ctx.db.patch(conversation._id, { source });
    if (source === "x") {
      const originalTurnId = conversation.currentTurnId;
      await ctx.db.patch(id, { turnId: originalTurnId });
      await ctx.db.patch(originalTurnId, { requestKey: "x:original-confirm", responsePostId: "other-prompt" });
      const newerTurnId = await ctx.db.insert("liquidityTurns", {
        requestKey: "x:newer-message", ownerXUserId: e.ownerXUserId, conversationId: conversation._id,
        input: "check my positions", revision: conversation.revision + 1, status: "ready", createdAt: Date.now() + 1,
      });
      await ctx.db.patch(conversation._id, { currentTurnId: newerTurnId, revision: conversation.revision + 1 });
    }
    await invoke(finishExecution, ctx, { executionId: id, success: true, legsJson: JSON.stringify([{ tokenId: "123", tickLower: -600, tickUpper: 600, liquidity: "10" }]), transactionHash: settled.transactionHash });
    ctx.scheduler.runAfter.mockClear(); actions.runMutation.mockClear();
    return test;
  }
  it("recovers delivery after a committed terminal message returns an error without duplicating it or repeating transactions", async () => {
    const { ctx, actions, id } = await completedDelivery();
    const messages = new Map<string, string>(), original = actions.runMutation.getMockImplementation()!;
    let first = true;
    actions.runMutation.mockImplementation((ref, args) => {
      if (getFunctionName(ref) !== "wallets:recordTerminalMessage") return original(ref, args);
      messages.set(args.requestId, args.text);
      if (first) { first = false; throw new Error("Response lost after commit; private provider detail"); }
      return undefined;
    });
    vi.stubGlobal("fetch", vi.fn());
    const before = ctx.data.get(id)!.stepsJson;
    await invoke(deliverExecution, actions, { executionId: id });
    expect(ctx.data.get(id)?.deliveryStatus).toBe("pending");
    expect(ctx.data.get(id)?.deliveryDiagnostic).toBe("LP_RESULT_DELIVERY_RETRY");
    await invoke(deliverExecution, actions, { executionId: id }); // Early duplicate cannot retry.
    expect(ctx.data.get(id)?.deliveryAttempts).toBe(1);
    vi.setSystemTime(ctx.data.get(id)!.deliveryNextAttemptAt);
    await invoke(deliverExecution, actions, { executionId: id });
    await invoke(deliverExecution, actions, { executionId: id });
    expect(ctx.data.get(id)?.deliveryStatus).toBe("handed_off");
    expect(ctx.data.get(id)?.status).toBe("confirmed"); expect(ctx.data.get(id)?.stepsJson).toBe(before);
    expect(messages.size).toBe(1); expect(messages.has(`liquidity-result:${id}`)).toBe(true);
    expect(actions.runMutation.mock.calls.every(([ref]) => ["liquidity:reserveDelivery", "liquidity:settleDelivery", "wallets:recordTerminalMessage"].includes(getFunctionName(ref)))).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); expect(chain.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it("keeps completion bound to the authorizing turn if the conversation pointer changes", async () => {
    const { ctx, id } = await executionSetup([settled]);
    const execution = ctx.data.get(id)!, conversation = ctx.data.get(execution.conversationId)!;
    const originalTurnId = conversation.currentTurnId;
    await ctx.db.patch(id, { turnId: originalTurnId });
    const newerTurnId = await ctx.db.insert("liquidityTurns", {
      requestKey: "terminal:newer-unrelated-request", ownerXUserId: execution.ownerXUserId,
      conversationId: conversation._id, input: "check my positions", revision: conversation.revision + 1,
      status: "ready", createdAt: Date.now() + 1,
    });
    await ctx.db.patch(conversation._id, { currentTurnId: newerTurnId, revision: conversation.revision + 1 });
    expect((await invoke(executionContext, ctx, { executionId: id })).turn._id).toBe(originalTurnId);
    await invoke(finishExecution, ctx, {
      executionId: id, success: true,
      legsJson: JSON.stringify([{ tokenId: "123", tickLower: -600, tickUpper: 600, liquidity: "10" }]),
      transactionHash: settled.transactionHash,
    });
    expect(ctx.data.get(originalTurnId)?.response).toContain("position opened");
    expect(ctx.data.get(newerTurnId)?.response).toBeUndefined();
  });
  it("hands the final X message to the existing queue using the original confirmation post", async () => {
    const { ctx, actions, id } = await completedDelivery("x");
    const runAction = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const delivery = { ...actions, runAction };
    await invoke(deliverExecution, delivery, { executionId: id });
    expect(ctx.data.get(id)?.deliveryStatus).toBe("pending");
    vi.setSystemTime(ctx.data.get(id)!.deliveryNextAttemptAt);
    await invoke(deliverExecution, delivery, { executionId: id });
    expect(ctx.data.get(id)?.deliveryStatus).toBe("handed_off");
    expect(runAction.mock.calls.map(([ref, args]) => [getFunctionName(ref), args])).toEqual([
      ["xReplies:deliverLiquidityResult", { postId: "original-confirm", executionId: id }],
      ["xReplies:deliverLiquidityResult", { postId: "original-confirm", executionId: id }],
    ]);
  });
  it("recovers a terminated delivery lease but does not revive historical final results", async () => {
    const { ctx, actions, id } = await completedDelivery();
    const old = await ctx.db.insert("liquidityExecutions", { status: "confirmed", response: "old", updatedAt: 1 });
    const first = await invoke(reserveDelivery, ctx, { executionId: id });
    expect(first).toBe(1);
    await invoke(recoverExecutions, ctx, {}); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 180001);
    await invoke(recoverExecutions, ctx, {});
    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(0, expect.anything(), { executionId: id });
    const second = await invoke(reserveDelivery, ctx, { executionId: id });
    await invoke(settleDelivery, ctx, { executionId: id, attempt: first, handedOff: true });
    expect(ctx.data.get(id)?.deliveryStatus).toBe("pending"); expect(second).toBe(2);
    await invoke(deliverExecution, actions, { executionId: old });
    expect(ctx.data.get(old)?.deliveryStatus).toBeUndefined();
  });
  it("retires an orphaned processing turn left behind by a cancelled conversation", async () => {
    const ctx = await setup();
    const first = await invoke(reserveTurn, ctx, base);
    await ctx.db.patch(first.conversationId, { active: false });

    await invoke(recoverExecutions, ctx, {});

    expect(ctx.data.get(first.turnId)).toMatchObject({
      status: "cancelled",
      response: expect.stringContaining("cancelled"),
    });
  });
  it("bounds failed result delivery while retaining the completed action and its result for review", async () => {
    const { ctx, actions, id } = await completedDelivery("x"), delivery = { ...actions, runAction: vi.fn().mockResolvedValue(false) };
    for (let n = 0; n < 12; n++) {
      vi.setSystemTime(ctx.data.get(id)!.deliveryNextAttemptAt);
      await invoke(deliverExecution, delivery, { executionId: id });
    }
    expect(ctx.data.get(id)?.deliveryStatus).toBe("manual_review");
    expect(ctx.data.get(id)?.status).toBe("confirmed"); expect(ctx.data.get(id)?.response).toContain("position opened");
    ctx.scheduler.runAfter.mockClear(); vi.setSystemTime(Date.now() + 3600000);
    await invoke(recoverExecutions, ctx, {}); await invoke(deliverExecution, delivery, { executionId: id });
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled(); expect(delivery.runAction).toHaveBeenCalledTimes(12);
  });
});
