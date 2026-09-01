import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import * as xReplies from "../convex/xReplies";
import * as flood from "../convex/xFloodProtection";
import * as replyQueue from "../convex/xReplyQueue";
import { compareXPriority, isWalletLookupInteraction, isWalletLookupText, readOnlyReplyCategory, reserveLookupSlot, reserveWalletRequestSlot, walletLookupLimit, type LookupSlot } from "../lib/x-wallet-flood-policy";
import { LIQUIDITY_TEST_OWNER } from "./liquidityFixtures";
import { xInteractionDispatchDelay } from "../lib/x-operational-policy";

// Actual Convex handlers, in-memory database. No X, wallet, or AI requests.
type Row = Record<string, any>;
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
function fixture() {
  const rows: Record<string, Row[]> = {};
  let sequence = 0;
  const db = {
    async insert(table: string, row: Row) { const id = `${table}:${++sequence}`; (rows[table] ??= []).push({ ...row, _id: id }); return id; },
    async patch(id: string, patch: Row) { Object.assign(Object.values(rows).flat().find(r => r._id === id)!, patch); },
    async get(id: string) { return Object.values(rows).flat().find(r => r._id === id) ?? null; },
    query(table: string) {
      const predicates: Array<(r: Row) => boolean> = []; let desc = false;
      const idx = { eq(k: string, v: any) { predicates.push(r => r[k] === v); return idx; }, gte(k: string, v: any) { predicates.push(r => r[k] >= v); return idx; }, gt(k: string, v: any) { predicates.push(r => r[k] > v); return idx; }, lte(k: string, v: any) { predicates.push(r => r[k] <= v); return idx; } };
      const get = () => (rows[table] ?? []).filter(r => predicates.every(p => p(r))).sort((a,b) => (desc ? -1 : 1) * ((a.createdAt ?? 0) - (b.createdAt ?? 0)));
      const q = { withIndex(_name: string, fn: any) { fn(idx); return q; }, order(d: string) { desc = d === "desc"; return q; },
        async unique() { const all = get(); if (all.length > 1) throw Error("not unique"); return all[0] ?? null; },
        async first() { return get()[0] ?? null; }, async collect() { return get(); }, async take(n: number) { return get().slice(0,n); } };
      return q;
    },
  };
  const ctx: any = { db, rows, scheduler: { runAfter: vi.fn() }, runAction: vi.fn(() => { throw Error("No wallet/AI actions allowed"); }) };
  const call = (ref: any, args: any) => { const [module, name] = getFunctionName(ref).split(":"); return invoke((module === "xFloodProtection" ? flood : module === "xReplyQueue" ? replyQueue : xReplies as any)[name], ctx, args); };
  ctx.runMutation = vi.fn(call); ctx.runQuery = vi.fn(call);
  return ctx;
}
async function interaction(ctx: ReturnType<typeof fixture>, postId: string, text = "show my wallet", extra: Row = {}) {
  await ctx.db.insert("xReplyInteractions", { postId, authorXUserId: `user${postId}`, text, status: "received", createdAt: Date.now(), updatedAt: Date.now(), ...extra });
  return ctx.rows.xReplyInteractions.at(-1)!;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-30T22:00:00Z")); vi.stubEnv("X_REPLIES_ENABLED", "true"); vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network disabled"); })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("pre-profile admission", () => {
  it("limits only repeated wallet requests by the same user before fetching profiles", async () => {
    const ctx = fixture();
    for (const [i, text] of ["show my wallet", "show my balance", "help"].entries()) {
      expect(await invoke(flood.admitBeforeProfile, ctx, { postId: `${i}1`, authorXUserId: "1", text })).toBe(true);
      expect(await invoke(flood.admitBeforeProfile, ctx, { postId: `${i}2`, authorXUserId: "2", text })).toBe(true);
      expect(await invoke(flood.admitBeforeProfile, ctx, { postId: `${i}3`, authorXUserId: "1", text })).toBe(text !== "show my wallet");
    }
    expect(ctx.rows.xReplyInteractions).toHaveLength(1);
    expect(ctx.rows.xReplyInteractions.every((r: Row) => r.status === "rejected")).toBe(true);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    expect(ctx.runAction).not.toHaveBeenCalled();
  });
  it("reuses admission after profile failure and at final queued guard", async () => {
    const ctx = fixture(), args = { postId: "1", authorXUserId: "user1", text: "show my wallet" };
    expect(await invoke(flood.admitBeforeProfile, ctx, args)).toBe(true);
    expect(await invoke(flood.admitBeforeProfile, ctx, args)).toBe(true);
    expect(ctx.rows.xReplyInteractions).toBeUndefined();
    await interaction(ctx, "1");
    expect(await invoke(flood.guardQueued, ctx, { postId: "1" })).toEqual({ suppressed: false });
    expect(ctx.rows.xWalletLookupBudgets[0].slots).toHaveLength(1);
  });
  it("skips existing cancelled posts but never applies lookup quota to trades or launches", async () => {
    const ctx = fixture();
    await interaction(ctx, "1", "buy 1 PONSBOT", { commandKind: "operator_cancelled" });
    expect(await invoke(flood.admitBeforeProfile, ctx, { postId: "1", authorXUserId: "user1", text: "buy 1 PONSBOT" })).toBe(false);
    for (const [i, text] of ["buy 1 PONSBOT", "launch Test ticker TEST", "send 1 ETH to @friend"].entries())
      expect(await invoke(flood.admitBeforeProfile, ctx, { postId: `${i}2`, authorXUserId: "user1", text })).toBe(true);
    expect(ctx.rows.xWalletLookupBudgets).toBeUndefined();
  });
});

describe("per-user ten-minute wallet admission", () => {
  it("has no cross-user cap, no sliding rejection timer, and no budget scaling", () => {
    vi.stubEnv("X_REPLY_BUDGET_SCALE", "0.5");
    const now = Date.now(), first = reserveWalletRequestSlot([], "first", "alice", now);
    expect(first.allowed).toBe(true);
    expect(reserveWalletRequestSlot(first.slots, "bob-first", "bob", now).allowed).toBe(true);
    expect(reserveWalletRequestSlot(first.slots, "first", "alice", now + 599999).allowed).toBe(true);
    const denied = reserveWalletRequestSlot(first.slots, "second", "alice", now + 599999);
    expect(denied).toEqual({ allowed: false, slots: first.slots });
    expect(reserveWalletRequestSlot(denied.slots, "third", "alice", now + 600000).allowed).toBe(true);
  });
  it("preserves admitted retries past ten minutes without displacing a fresh admission", async () => {
    const ctx = fixture(); await interaction(ctx, "old", "show my wallet", { authorXUserId: "alice" });
    expect(await invoke(flood.guardQueued, ctx, { postId: "old" })).toEqual({ suppressed: false });
    vi.advanceTimersByTime(600000);
    await interaction(ctx, "new", "show my wallet", { authorXUserId: "alice" });
    expect(await invoke(flood.guardQueued, ctx, { postId: "new" })).toEqual({ suppressed: false });
    expect(await invoke(flood.guardQueued, ctx, { postId: "old" })).toEqual({ suppressed: false });
    expect(ctx.rows.xWalletLookupBudgets[0].slots[0].postId).toBe("new");
  });
  it("catches unusual wording at the parsed-intent guard", async () => {
    const ctx = fixture(); await interaction(ctx, "first", "show my wallet", { authorXUserId: "alice" });
    await invoke(flood.guardQueued, ctx, { postId: "first" });
    const row = await interaction(ctx, "second", "deposit details please", { authorXUserId: "alice" });
    expect(await invoke(flood.guardQueued, ctx, { postId: "second" })).toEqual({ suppressed: false });
    await ctx.db.patch(row._id, { parsedIntentJson: JSON.stringify({ kind: "command", command: { kind: "show_wallet" } }) });
    expect(await invoke(flood.guardQueued, ctx, { postId: "second" })).toEqual({ suppressed: true });
    expect(row.nextRetryAt).toBeUndefined(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
});

describe("liquidity bypasses internal admission limits only", () => {
  async function saturated(ctx: ReturnType<typeof fixture>, owner = LIQUIDITY_TEST_OWNER) {
    const now = Date.now();
    for (const key of [`user:${owner}`, "global"]) await ctx.db.insert("xReplyRateLimits", {
      key, utcDay: new Date(now).toISOString().slice(0,10), dailyCount: 1000000,
      windowCount: 1000000, windowStartedAt: now, lastAcceptedAt: now, updatedAt: now,
    });
    vi.stubEnv("X_REPLY_COOLDOWN_SECONDS", "300");
  }
  it("does not charge user/global counters for an allowed liquidity request", async () => {
    const ctx = fixture(); await saturated(ctx);
    const source = await interaction(ctx, "lp", "create a liquidity position for PONSBOT", { authorXUserId: LIQUIDITY_TEST_OWNER });
    const counters = structuredClone(ctx.rows.xReplyRateLimits);
    expect(await invoke(flood.guardQueued, ctx, { postId: source.postId })).toEqual({ suppressed: false });
    expect(await invoke(xReplies.consumeReplyLimit, ctx, { postId: source.postId, xUserId: LIQUIDITY_TEST_OWNER, premium: false })).toMatchObject({ allowed: true, reason: "liquidity workflow" });
    expect(ctx.rows.xReplyRateLimits).toEqual(counters);
    expect(ctx.rows.xWalletLookupBudgets).toBeUndefined(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("exempts owner follow-ups and questions only on the current published prompt", async () => {
    const ctx = fixture(); await saturated(ctx);
    const conversationId = await ctx.db.insert("liquidityConversations", { ownerXUserId: LIQUIDITY_TEST_OWNER, active: true, expiresAt: Date.now() + 600000 });
    const turnId = await ctx.db.insert("liquidityTurns", { conversationId, responsePostId: "current-prompt" });
    await ctx.db.patch(conversationId, { currentTurnId: turnId });
    for (const [i, text] of ["3", "yes", "what does this mean?", "help"].entries()) {
      const args = { postId: `reply-${i}`, authorXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "current-prompt", text };
      expect(await invoke(flood.admitBeforeProfile, ctx, args)).toBe(true);
      await interaction(ctx, args.postId, text, args);
      expect(await invoke(flood.guardQueued, ctx, { postId: args.postId })).toEqual({ suppressed: false });
      expect(await invoke(xReplies.consumeReplyLimit, ctx, { postId: args.postId, xUserId: LIQUIDITY_TEST_OWNER, premium: false })).toMatchObject({ allowed: true, reason: "liquidity workflow" });
    }
    expect(ctx.rows.xWalletLookupBudgets).toBeUndefined();
    await interaction(ctx, "ordinary-command", "show my wallet", { authorXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "current-prompt" });
    expect(await invoke(xReplies.consumeReplyLimit, ctx, { postId: "ordinary-command", xUserId: LIQUIDITY_TEST_OWNER, premium: false })).toMatchObject({ allowed: false });
    await interaction(ctx, "not-current", "yes", { authorXUserId: LIQUIDITY_TEST_OWNER, parentPostId: "old-prompt" });
    expect(await invoke(xReplies.consumeReplyLimit, ctx, { postId: "not-current", xUserId: LIQUIDITY_TEST_OWNER, premium: false })).toMatchObject({ allowed: false });
  });
  it.each([
    ["outsider", "create liquidity for PONSBOT", {}],
    [LIQUIDITY_TEST_OWNER, "buy $10 PONSBOT with liquidity", { commandKind: "liquidity" }],
    [LIQUIDITY_TEST_OWNER, "create liquidity for PONSBOT", { commandKind: "operator_cancelled", status: "rejected" }],
  ])("never bypasses authorization/cancellation/ordinary commands for %s: %s", async (owner, text, extra) => {
    const ctx = fixture(); await saturated(ctx, owner as string);
    await interaction(ctx, "attempt", text as string, { authorXUserId: owner, ...extra as Row });
    expect(await invoke(xReplies.consumeReplyLimit, ctx, { postId: "attempt", xUserId: owner, premium: false })).toMatchObject({ allowed: false });
  });
});

describe("wallet lookup classification and priority", () => {
  it.each(["@Ponsbotfamily @Ponsbotfamily show my wallet", "what’s my wallet?", "give me my wallet address", "create my wallet", "wallet", "where do I send funds?", "need my receiving address"])("screens %s before AI", text => expect(isWalletLookupText(text)).toBe(true));
  it.each(["what's my wallet balance?", "show my holdings", "send 1 ETH to my wallet", "launch Wallet ticker WAL", "buy 1 PONSBOT", "claim my fees", "give 1 ETH to @user", "sell all of my PONSBOT"])("does not throttle unrelated command %s", text => expect(isWalletLookupText(text)).toBe(false));
  it("uses parsed intent to catch wording not matched by the cheap filter", () => {
    expect(isWalletLookupInteraction({ text: "deposit details please", parsedIntentJson: JSON.stringify({ kind: "command", command: { kind: "show_wallet" } }) })).toBe(true);
    expect(isWalletLookupInteraction({ text: "show my wallet", parsedIntentJson: JSON.stringify({ kind: "command", command: { kind: "send" } }) })).toBe(false);
  });
  it("puts transactions ahead of verified wallet lookups and preserves chronological ties", () => {
    const queue = [
      { id: "1", text: "show my wallet", verified: true },
      { id: "3", text: "buy 1 PONSBOT", verified: false, operation: "buy" },
      { id: "2", text: "launch TEST", verified: false, operation: "launch" },
      { id: "4", text: "show my wallet", verified: false },
    ].sort(compareXPriority);
    expect(queue.map(r => r.id)).toEqual(["2", "3", "1", "4"]);
    expect(xInteractionDispatchDelay(199)).toBe(39_000);
  });
});

describe("atomic wallet-address admission and publication budgets", () => {
  it("allows five distinct accounts in a rolling five minutes and treats duplicate jobs idempotently", () => {
    let slots: LookupSlot[] = [];
    const start = Date.now();
    for (let i=0; i<5; i++) {
      const result = reserveLookupSlot(slots, `${i}`, `user${i}`, start+i*60_000);
      expect(result.allowed).toBe(true); slots = result.slots;
    }
    expect(slots).toHaveLength(5);
    expect(reserveLookupSlot(slots, "0", "user0", start+270_000)).toMatchObject({ allowed: true, slots });
    expect(reserveLookupSlot(slots, "11", "user11", start+299_999).allowed).toBe(false);
    expect(reserveLookupSlot(slots, "12", "user0", start+270_000).allowed).toBe(false);
    expect(reserveLookupSlot(slots, "13", "user13", start+300_000).allowed).toBe(true);
  });
  it("does not allow a boundary burst or accumulate capacity while idle", () => {
    const now = Date.now();
    let slots = reserveLookupSlot([], "first", "a", now+59_999).slots;
    expect(reserveLookupSlot(slots, "second", "b", now+60_000).allowed).toBe(false);
    expect(reserveLookupSlot(slots, "second", "b", now+119_998).allowed).toBe(false);
    const second = reserveLookupSlot(slots, "second", "b", now+119_999);
    expect(second.allowed).toBe(true);
    slots = second.slots;
    const afterIdle = reserveLookupSlot(slots, "idle", "c", now+600_000);
    expect(afterIdle.allowed).toBe(true);
    expect(reserveLookupSlot(afterIdle.slots, "burst", "d", now+600_001).allowed).toBe(false);
  });
  it("does not let rejected attempts extend the gap or high five-minute limits remove it", () => {
    const now=Date.now(), slots=reserveLookupSlot([], "first", "a", now, 25).slots;
    const rejected=reserveLookupSlot(slots, "rejected", "b", now+59_999, 25);
    expect(rejected).toEqual({allowed:false,slots});
    expect(reserveLookupSlot(rejected.slots, "next", "c", now+60_000, 25).allowed).toBe(true);
    expect(reserveLookupSlot(slots, "same-owner", "a", now+60_000).allowed).toBe(false);
    expect(reserveLookupSlot(slots, "same-owner", "a", now+300_000).allowed).toBe(true);
  });
  it("does not let publication retries reuse a stale timestamp or bypass another reply", () => {
    const now=Date.now();
    let slots=reserveLookupSlot([], "a", "user-a", now, 10, true).slots;
    slots=reserveLookupSlot(slots, "b", "user-b", now+60_000, 10, true).slots;
    expect(reserveLookupSlot(slots, "a", "user-a", now+60_001, 10, true).allowed).toBe(false);
    const retry=reserveLookupSlot(slots, "a", "user-a", now+120_000, 10, true);
    expect(retry.allowed).toBe(true);
    expect(retry.slots).toHaveLength(2);
    expect(reserveLookupSlot(retry.slots, "c", "user-c", now+120_001, 10, true).allowed).toBe(false);
    expect(reserveLookupSlot(retry.slots, "c", "user-c", now+180_000, 10, true).allowed).toBe(true);
  });
  it("supports a bounded configurable limit with the safe default", () => {
    expect(walletLookupLimit()).toBe(10); vi.stubEnv("X_WALLET_LOOKUP_MAX_PER_5_MIN", "5"); expect(walletLookupLimit()).toBe(5);
    vi.stubEnv("X_WALLET_LOOKUP_MAX_PER_5_MIN", "1000"); expect(walletLookupLimit()).toBe(25);
    vi.stubEnv("X_WALLET_LOOKUP_MAX_PER_5_MIN", "no"); expect(walletLookupLimit()).toBe(10);
  });
  it("silently and permanently drops excess queued wallet lookups before AI or wallet work", async () => {
    const ctx = fixture();
    for (let i=0;i<5;i++) { if (i) vi.advanceTimersByTime(60_000); await interaction(ctx, `${i}`); expect(await invoke(flood.guardQueued,ctx,{postId:`${i}`})).toEqual({suppressed:false}); }
    await interaction(ctx,"excess", "show my wallet", { authorXUserId: "user0" }); await ctx.db.insert("xReplyUsers",{xUserId:"user0"});
    await invoke(xReplies.retryInteraction,ctx,{postId:"excess"});
    expect(ctx.rows.xReplyInteractions.at(-1)).toMatchObject({status:"rejected",walletLookupSuppressed:true});
    expect(ctx.runAction).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600_001);
    expect(await invoke(flood.guardQueued,ctx,{postId:"excess"})).toEqual({suppressed:true});
    await invoke(xReplies.updateInteraction,ctx,{postId:"excess",status:"processing"});
    expect(ctx.rows.xReplyInteractions.at(-1)?.status).toBe("rejected");
    await interaction(ctx,"fresh"); expect(await invoke(flood.guardQueued,ctx,{postId:"fresh"})).toEqual({suppressed:false});
  });
  it("does not consume another slot on retry and enforces one per account", async () => {
    const ctx = fixture(); await interaction(ctx,"1");
    await invoke(flood.guardQueued,ctx,{postId:"1"}); await invoke(flood.guardQueued,ctx,{postId:"1"});
    expect(ctx.rows.xWalletLookupBudgets[0].slots).toHaveLength(1);
    await interaction(ctx,"2","give me my wallet",{authorXUserId:"user1"});
    expect(await invoke(flood.guardQueued,ctx,{postId:"2"})).toEqual({suppressed:true});
  });
  it("never interferes with already-started transactions regardless of verification", async () => {
    const ctx=fixture(); await interaction(ctx,"tx","show my wallet and send ETH",{status:"failed",parsedIntentJson:JSON.stringify({kind:"command",command:{kind:"send"}})});
    expect(await invoke(flood.guardQueued,ctx,{postId:"tx"})).toEqual({suppressed:false});
    expect(ctx.rows.xReplyInteractions[0].status).toBe("failed"); expect(ctx.rows.xWalletLookupBudgets).toBeUndefined();
  });
  it("enforces a second cap at publication even when preexisting admissions were delayed", async () => {
    const ctx = fixture();
    for (let i=0;i<5;i++) { if (i) vi.advanceTimersByTime(60_000); const row=await interaction(ctx,`${i}`); expect(await flood.suppressReadOnlyReply(ctx,row,true)).toBe(false); }
    const overflow=await interaction(ctx,"overflow","show my wallet",{walletLookupAdmittedAt:Date.now()-400_000});
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:overflow.postId})).toEqual({reserved:false,waitMs:0});
    expect(overflow.walletLookupSuppressed).toBe(true); expect(ctx.rows.xPublicationEvents).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("drops the same user's simultaneous lookup before AI, but leaves a concurrent trade eligible", async () => {
    const ctx=fixture(); await interaction(ctx,"first"); await interaction(ctx,"second", "show my wallet", { authorXUserId: "userfirst" });
    expect(await invoke(flood.guardQueued,ctx,{postId:"first"})).toEqual({suppressed:false});
    await ctx.db.insert("xReplyUsers",{xUserId:"userfirst"});
    await invoke(xReplies.retryInteraction,ctx,{postId:"second"});
    expect(ctx.rows.xReplyInteractions[1]).toMatchObject({status:"rejected",walletLookupSuppressed:true});
    await interaction(ctx,"trade","buy 1 PONSBOT");
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"trade"})).toMatchObject({reserved:true});
    expect(ctx.runAction).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("spaces delayed publication workers as well as intake", async () => {
    const ctx=fixture();
    await interaction(ctx,"first","show my wallet",{walletLookupAdmittedAt:Date.now()-120_000});
    await interaction(ctx,"second","show my wallet",{walletLookupAdmittedAt:Date.now()-60_000});
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"first"})).toMatchObject({reserved:true});
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"second"})).toEqual({reserved:false,waitMs:0});
    expect(ctx.rows.xReplyInteractions[1].walletLookupSuppressed).toBe(true);
    vi.advanceTimersByTime(60_000);
    await interaction(ctx,"third","show my wallet",{walletLookupAdmittedAt:Date.now()-60_000});
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"third"})).toMatchObject({reserved:true});
    expect(ctx.rows.xPublicationEvents).toHaveLength(2);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});

describe("three independent global read-only limits", () => {
  const commands = {
    wallet: { kind: "command", command: { kind: "show_wallet" } },
    balance: { kind: "command", command: { kind: "show_balance" } },
    information: { kind: "help", topic: "launch" },
  };
  it.each([
    ["@Ponsbotfamily what's my wallet?", "wallet"],
    ["give me my wallet please", "wallet"],
    ["create my wallet", "wallet"],
    ["where do I send funds?", "wallet"],
    ["What's my wallet balance?", "balance"],
    ["Hey @Ponsbotfamily show me my holdings please", "balance"],
    ["give me my ETH balance", "balance"],
    ["show everything in my wallet", "balance"],
    ["portfolio check", "balance"],
    ["how do I burn tokens?", "information"],
    ["which assets are supported?", "information"],
    ["what can you do?", "information"],
  ])("cheap screening categorizes %s as %s", (text, category) => {
    expect(readOnlyReplyCategory({ text })).toBe(category);
  });
  it.each([
    "show my wallet then buy $20 PONSBOT", "buy 1 PONSBOT with my balance",
    "launch Wallet ticker WAL", "create a token named wallet", "claim my fees",
    "sell all of my PONSBOT balance", "how do I buy? Actually buy $20 PONSBOT",
    "create a liquidity position", "show everything in my wallet then burn all my MSFT",
    "give me my wallet and purchase $1 PONSBOT", "where do I send funds? send 1 ETH to @friend",
  ])("never preemptively discards transaction-containing text: %s", text => {
    expect(readOnlyReplyCategory({ text })).toBeUndefined();
  });
  it("treats parsed intent as authoritative and shares every help topic's category", () => {
    for (const topic of ["wallet", "balance", "capabilities", "fund", "send", "buy_sell", "cross_chain", "cross_chain_assets", "burn", "launch", "pairs", "fees"]) {
      expect(readOnlyReplyCategory({ text: "show my wallet", parsedIntentJson: JSON.stringify({ kind: "help", topic }) })).toBe("information");
    }
    for (const [category, intent] of Object.entries(commands)) {
      expect(readOnlyReplyCategory({ text: "unusual wording", parsedIntentJson: JSON.stringify(intent) })).toBe(category);
    }
    expect(readOnlyReplyCategory({ text: "show my wallet", parsedIntentJson: JSON.stringify({ kind: "command", command: { kind: "buy" } }) })).toBeUndefined();
    expect(readOnlyReplyCategory({ text: "show my wallet", commandKind: "liquidity" })).toBeUndefined();
    expect(readOnlyReplyCategory({ text: "show my wallet", commandKind: "houdini_execute" })).toBeUndefined();
    expect(readOnlyReplyCategory({ text: "show my wallet", parsedIntentJson: JSON.stringify({ kind: "irrelevant" }) })).toBeUndefined();
  });
  it("admits different users without global category caps, rejecting only repeat wallet lookups", async () => {
    const ctx = fixture();
    for (const [category, intent] of Object.entries(commands)) {
      const extra = { authorXUserId: "same-user", parsedIntentJson: JSON.stringify(intent) };
      await interaction(ctx, category, "unusual wording", extra);
      expect(await invoke(flood.guardQueued, ctx, { postId: category })).toEqual({ suppressed: false });
      const row = await interaction(ctx, `${category}-excess`, "unusual wording", { ...extra, authorXUserId: "different-user" });
      expect(await invoke(flood.guardQueued, ctx, { postId: row.postId })).toEqual({ suppressed: false });
      const repeated = await interaction(ctx, `${category}-repeat`, "unusual wording", extra);
      expect(await invoke(flood.guardQueued, ctx, { postId: repeated.postId })).toEqual({ suppressed: category === "wallet" });
      expect(row.nextRetryAt).toBeUndefined();
    }
    expect(ctx.rows.xPublicationEvents).toBeUndefined();
    expect(ctx.rows.xWalletLookupBudgets.map((r: Row) => r.key).sort()).toEqual([
      "wallet:user:different-user:admission", "wallet:user:same-user:admission",
    ]);
    vi.advanceTimersByTime(600_000);
    for (const [category, intent] of Object.entries(commands)) {
      await interaction(ctx, `${category}-new`, "unusual wording", { parsedIntentJson: JSON.stringify(intent) });
      expect(await invoke(flood.guardQueued, ctx, { postId: `${category}-new` })).toEqual({ suppressed: false });
    }
    expect(fetch).not.toHaveBeenCalled(); expect(ctx.runAction).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("does not reserve an informational admission budget for any topic", async () => {
    const ctx = fixture();
    await interaction(ctx, "help1", "how do I burn tokens?");
    expect(await invoke(flood.guardQueued, ctx, { postId: "help1" })).toEqual({ suppressed: false });
    await interaction(ctx, "help2", "which assets are supported?");
    expect(await invoke(flood.guardQueued, ctx, { postId: "help2" })).toEqual({ suppressed: false });
    expect(ctx.rows.xWalletLookupBudgets).toBeUndefined();
  });
  it.each(["balance", "information"] as const)("does not drop repeated %s through obsolete category limits", async category => {
    const ctx = fixture(), text = category === "balance" ? "show my balance" : "what can you do?";
    await interaction(ctx, "first", text);
    expect(await invoke(flood.guardQueued, ctx, { postId: "first" })).toEqual({ suppressed: false });
    const row = await interaction(ctx, "excess", text, { status: "failed", nextRetryAt: Date.now() });
    expect(await invoke(flood.guardQueued, ctx, { postId: "excess" })).toEqual({ suppressed: false });
    expect(row.status).toBe("failed"); expect(row.replySuppressedReason).toBeUndefined();
    expect(ctx.rows.xWalletLookupBudgets).toBeUndefined();
    expect(ctx.runAction).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it.each(["balance", "information"] as const)("enforces %s publication spacing even if intake workers were delayed", async category => {
    const ctx = fixture(), extra = { parsedIntentJson: JSON.stringify(commands[category]) };
    await interaction(ctx, "first", "unusual wording", extra);
    await interaction(ctx, "second", "unusual wording", extra);
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "first" })).toMatchObject({ reserved: true });
    vi.advanceTimersByTime(59_999);
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "second" })).toMatchObject({ reserved: false, waitMs: 0 });
    vi.advanceTimersByTime(1);
    await interaction(ctx, "third", "unusual wording", extra);
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "third" })).toMatchObject({ reserved: true });
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("does not re-limit an early wallet guess when parsed as help", async () => {
    const ctx = fixture();
    await interaction(ctx, "prior", "what can you do?");
    await invoke(flood.guardQueued, ctx, { postId: "prior" });
    const row = await interaction(ctx, "changed", "show my wallet");
    expect(await invoke(flood.guardQueued, ctx, { postId: "changed" })).toEqual({ suppressed: false });
    await ctx.db.patch(row._id, { parsedIntentJson: JSON.stringify(commands.information) });
    expect(await invoke(flood.guardQueued, ctx, { postId: "changed" })).toEqual({ suppressed: false });
    expect(row.replySuppressedReason).toBeUndefined();
  });
  it("carries over retained admissions for the same user, never the obsolete global gap", async () => {
    const ctx = fixture();
    await ctx.db.insert("xWalletLookupBudgets", { key: "admission", slots: [{ postId: "old", owner: "old-user", at: Date.now() - 30_000 }], updatedAt: Date.now() - 30_000 });
    await interaction(ctx, "new", "show my wallet");
    expect(await invoke(flood.guardQueued, ctx, { postId: "new" })).toEqual({ suppressed: false });
    await interaction(ctx, "repeat-old", "show my wallet", { authorXUserId: "old-user" });
    expect(await invoke(flood.guardQueued, ctx, { postId: "repeat-old" })).toEqual({ suppressed: true });
  });
  it("silently rejects read-only publication when X capacity is exhausted, without delaying transactions differently", async () => {
    const ctx = fixture();
    await ctx.db.insert("xPublicationEvents", { postId: "prior", status: "published", createdAt: Date.now() - 1000, rateLimitRemaining: 0, rateLimitReset: Date.now() / 1000 + 600 });
    for (const [category, intent] of Object.entries(commands)) {
      const row = await interaction(ctx, category, "unusual wording", { parsedIntentJson: JSON.stringify(intent) });
      expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: category })).toMatchObject({ reserved: false, waitMs: 0 });
      expect(row).toMatchObject({ status: "rejected", replySuppressedReason: `${category}_reply_budget` });
    }
    await interaction(ctx, "trade", "buy 1 PONSBOT");
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "trade" })).toMatchObject({ reserved: false, waitMs: 600_000 });
    expect(ctx.rows.xPublicationEvents).toHaveLength(1);
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});

describe("X publication capacity", () => {
  it("caps all four categories at 20 combined, leaving exactly five overall slots for other posts", async () => {
    const ctx = fixture();
    const categories = [
      { category: "wallet", text: "show my wallet" },
      { category: "balance", text: "show my balance" },
      { category: "information", text: "help" },
      { category: "insufficient_eth", text: "buy 1 PONSBOT", replyText: "⛽ There isn't enough ETH in your wallet." },
    ];
    for (let minute = 0; minute < 5; minute++) {
      if (minute) vi.advanceTimersByTime(60_000);
      for (const item of categories) {
        const postId = `${item.category}-${minute}`;
        await interaction(ctx, postId, item.text);
        expect(await invoke(xReplies.beginReplyPublication, ctx, { postId, replyText: item.replyText })).toMatchObject({ reserved: true });
        expect(ctx.rows.xPublicationEvents.at(-1)?.replyCategory).toBe(item.category);
      }
    }
    expect(ctx.rows.xPublicationEvents).toHaveLength(20);
    vi.advanceTimersByTime(60_000);
    for (const item of categories) {
      const postId = `${item.category}-excess`;
      const row = await interaction(ctx, postId, item.text);
      expect(await invoke(xReplies.beginReplyPublication, ctx, { postId, replyText: item.replyText })).toMatchObject({ reserved: false, waitMs: 0 });
      expect(row).toMatchObject({ status: "rejected", replySuppressedReason: `${item.category}_reply_budget` });
    }
    for (let i = 0; i < 5; i++) {
      const postId = `trade-${i}`; await interaction(ctx, postId, "buy 1 PONSBOT");
      expect(await invoke(xReplies.beginReplyPublication, ctx, { postId })).toMatchObject({ reserved: true });
    }
    await interaction(ctx, "trade-excess", "buy 1 PONSBOT");
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "trade-excess" })).toMatchObject({ reserved: false, waitMs: 600_000 });
    vi.advanceTimersByTime(600_000);
    await interaction(ctx, "fresh-wallet", "show my wallet");
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "fresh-wallet" })).toMatchObject({ reserved: true });
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "wallet-excess" })).toMatchObject({ reserved: false });
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not reset the cumulative allowance for legacy events without category fields", async () => {
    const ctx = fixture();
    for (let i = 0; i < 20; i++) {
      const postId = `old-${i}`;
      await interaction(ctx, postId, i === 19 ? "buy 1 PONSBOT" : "show my wallet", { status: "completed", responsePostId: `response-${i}`, updatedAt: Date.now() - 600_000 });
      await ctx.db.insert("xPublicationEvents", { postId, status: "published", createdAt: Date.now() - 600_000 });
    }
    await ctx.db.insert("walletRequests", { sourcePostId: "old-19", finalMessage: "⛽ There isn't enough ETH in your wallet." });
    await interaction(ctx, "fresh", "help");
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "fresh" })).toMatchObject({ reserved: false, waitMs: 0 });
    expect(ctx.rows.xPublicationEvents).toHaveLength(20);
    await interaction(ctx, "trade", "buy 1 PONSBOT");
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "trade" })).toMatchObject({ reserved: true });
  });
  it("shares the 25-post limit between graduation announcements and replies", async () => {
    const ctx = fixture();
    for (let i = 0; i < 24; i++) {
      await interaction(ctx, `trade-${i}`, "buy 1 PONSBOT");
      expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: `trade-${i}` })).toMatchObject({ reserved: true });
    }
    expect(await invoke(xReplies.beginStandalonePublication, ctx, { publicationKey: "graduation:first" })).toMatchObject({ reserved: true });
    expect(await invoke(xReplies.beginStandalonePublication, ctx, { publicationKey: "graduation:second" })).toMatchObject({ reserved: false, waitMs: 900_000 });
    await interaction(ctx, "overflow", "buy 1 PONSBOT");
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "overflow" })).toMatchObject({ reserved: false, waitMs: 900_000 });
    expect(ctx.rows.xPublicationEvents).toHaveLength(25);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("accounts for standalone X headers and never repeats a successful graduation post", async () => {
    const ctx = fixture();
    for (const name of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]) vi.stubEnv(name, "mock-only");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: { id: "published-grad" } }), {
      status: 201, headers: { "x-rate-limit-limit": "100", "x-rate-limit-remaining": "0", "x-rate-limit-reset": String(Date.now() / 1000 + 600) },
    }));
    const launchId = await ctx.db.insert("tokenLaunches", { publicPublished: true, graduationAnnouncementStatus: "posting" });
    const args = { text: "$TEST graduated", publicationKey: "graduation:test", launchId };
    expect(await invoke(xReplies.publishStandalonePost, ctx, args)).toMatchObject({ status: "queued" });
    await invoke(xReplies.drainReplyQueue, ctx, { wakeToken: ctx.rows.xReplyQueueState[0].wakeToken });
    expect(ctx.rows.xPublicationEvents[0]).toMatchObject({ status: "published", replyCategory: "other", rateLimitRemaining: 0 });
    expect(await invoke(xReplies.publishStandalonePost, ctx, args)).toMatchObject({ status: "posted", postId: "published-grad" });
    await interaction(ctx, "trade", "buy 1 PONSBOT");
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "trade" })).toMatchObject({ reserved: false, waitMs: 600_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry an uncertain graduation publication or publish when disabled", async () => {
    const ctx = fixture();
    for (const name of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]) vi.stubEnv(name, "mock-only");
    vi.mocked(fetch).mockRejectedValue(new Error("network outcome unknown"));
    const launchId = await ctx.db.insert("tokenLaunches", { publicPublished: true, graduationAnnouncementStatus: "posting" });
    const args = { text: "$TEST graduated", publicationKey: "graduation:test", launchId };
    expect(await invoke(xReplies.publishStandalonePost, ctx, args)).toMatchObject({ status: "queued" });
    await invoke(xReplies.drainReplyQueue, ctx, { wakeToken: ctx.rows.xReplyQueueState[0].wakeToken });
    expect(await invoke(xReplies.publishStandalonePost, ctx, args)).toMatchObject({ status: "uncertain" });
    vi.stubEnv("X_REPLIES_ENABLED", "false");
    const pausedLaunch = await ctx.db.insert("tokenLaunches", { publicPublished: true, graduationAnnouncementStatus: "posting" });
    expect(await invoke(xReplies.publishStandalonePost, ctx, { ...args, launchId: pausedLaunch, publicationKey: "graduation:disabled" })).toMatchObject({ status: "queued" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ctx.rows.xPublicationEvents).toHaveLength(1);
  });
  it("gives insufficient ETH its own rolling minute and silently drops excess without replay", async () => {
    vi.stubEnv("X_SUPPRESS_ROUTINE_FAILURE_REPLIES", "true");
    const ctx = fixture();
    const replyText = "⛽ There isn't enough ETH in your wallet to cover the launch and network gas.\nYour wallet: https://www.ponsbot.family/wallet/0x123";
    await interaction(ctx, "first-eth", "launch TEST ticker TEST", { authorXUserId: "same-user" });
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "first-eth", replyText })).toMatchObject({ reserved: true });
    const duplicate = await invoke(xReplies.beginReplyPublication, ctx, { postId: "first-eth", replyText });
    expect(duplicate).toMatchObject({ reserved: false });
    const excess = await interaction(ctx, "extra-eth", "buy $10 PONSBOT");
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: excess.postId, replyText })).toMatchObject({ reserved: false, waitMs: 0 });
    expect(excess).toMatchObject({ replySuppressedReason: "insufficient_eth_reply_budget", status: "rejected" });
    await interaction(ctx, "wallet", "show my wallet");
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "wallet" })).toMatchObject({ reserved: true });
    await interaction(ctx, "trade", "buy $10 PONSBOT");
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "trade", replyText: "✅ Bought PONSBOT!" })).toMatchObject({ reserved: true });
    vi.advanceTimersByTime(60_000);
    await interaction(ctx, "next-eth", "send 1 ETH to @alice", { authorXUserId: "same-user" });
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "next-eth", replyText })).toMatchObject({ reserved: true });
    await invoke(xReplies.retryInteraction, ctx, { postId: excess.postId });
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    expect(ctx.runAction).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never revives historically suppressed ETH replies and drops new ones when X is full", async () => {
    const ctx = fixture(); const replyText = "❌ You don't have enough ETH.";
    await interaction(ctx, "old-eth", "buy 1 PONSBOT", { status: "rejected", replySuppressedReason: "insufficient_eth" });
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "old-eth", replyText })).toMatchObject({ reserved: false });
    await ctx.db.insert("xPublicationEvents", { postId: "prior", status: "published", createdAt: Date.now() - 1000, rateLimitRemaining: 0, rateLimitReset: Date.now() / 1000 + 600 });
    const row = await interaction(ctx, "new-eth", "buy 1 PONSBOT");
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: row.postId, replyText })).toMatchObject({ reserved: false, waitMs: 0 });
    expect(row).toMatchObject({ status: "rejected", replySuppressedReason: "insufficient_eth_reply_budget" });
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("silently drops selected responses before X reservation and never revives them", async () => {
    vi.stubEnv("X_SUPPRESS_ROUTINE_FAILURE_REPLIES", "true");
    const ctx = fixture();
    const row = await interaction(ctx, "silent", "launch TEST ticker TEST", { status: "failed", nextRetryAt: Date.now() + 1000 });
    const replyText = "🤔 I couldn't quite make that out. Try show my wallet.";
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: row.postId, replyText }))
      .toMatchObject({ reserved: false, waitMs: 0, suppressedReason: "ai_ambiguity" });
    expect(row).toMatchObject({ status: "rejected", replySuppressedReason: "ai_ambiguity" });
    expect(row.nextRetryAt).toBeUndefined();
    expect(ctx.rows.xPublicationEvents).toBeUndefined();
    vi.stubEnv("X_SUPPRESS_ROUTINE_FAILURE_REPLIES", "false");
    await invoke(xReplies.updateInteraction, ctx, { postId: row.postId, status: "processing" });
    await invoke(xReplies.scheduleInteractionRetry, ctx, { postId: row.postId, safeError: "retry" });
    await invoke(xReplies.retryInteraction, ctx, { postId: row.postId });
    expect(row.status).toBe("rejected");
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.runAction).not.toHaveBeenCalled();
    await interaction(ctx, "fresh", "buy 1 PONSBOT");
    expect(await invoke(xReplies.beginReplyPublication, ctx, { postId: "fresh", replyText })).toMatchObject({ reserved: true });
  });
  it("does not retry a suppressed Houdini final response or publish a replacement", async () => {
    vi.stubEnv("X_SUPPRESS_ROUTINE_FAILURE_REPLIES", "true");
    const ctx = fixture();
    await interaction(ctx, "houdini", "send $10 to address as Base ETH");
    const result = await invoke(xReplies.publishHoudiniOutcome, ctx, {
      postId: "houdini", text: "❌ This request did not complete. Check the earlier reply or try a new post.", ok: false,
    });
    expect(result).toMatchObject({ status: "rejected", retryable: false });
    expect(ctx.rows.xPublicationEvents).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("does not impose the former one-minute delay just because a backlog exists", async () => {
    const ctx=fixture(); await interaction(ctx,"trade","buy 1 PONSBOT");
    await interaction(ctx,"old","show my wallet",{status:"failed",nextRetryAt:Date.now()+30000});
    await ctx.db.insert("xPublicationEvents",{postId:"prior",status:"published",createdAt:Date.now()-1000,rateLimitRemaining:98,rateLimitReset:Date.now()/1000+600});
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"trade"})).toMatchObject({reserved:true,waitMs:0});
  });
  it("allows exactly 25 requests per rolling 15 minutes but stops the 26th", async () => {
    const ctx=fixture();
    for(let i=0;i<25;i++) {await interaction(ctx,`${i}`,"buy 1 PONSBOT");expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:`${i}`})).toMatchObject({reserved:true});}
    await interaction(ctx,"overflow","buy 1 PONSBOT");expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"overflow"})).toMatchObject({reserved:false,waitMs:900000});
    vi.advanceTimersByTime(900_000);
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"overflow"})).toMatchObject({reserved:true});
  });
  it("honors lower headroom reported by X and counts uncertain attempts", async () => {
    const ctx=fixture(); await interaction(ctx,"trade","buy 1 PONSBOT");
    await ctx.db.insert("xPublicationEvents",{postId:"prior",status:"published",createdAt:Date.now()-1000,rateLimitRemaining:0,rateLimitReset:Date.now()/1000+600});
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"trade"})).toMatchObject({reserved:false,waitMs:600000});
    ctx.rows.xPublicationEvents=Array.from({length:25},(_,i)=>({postId:`prior${i}`,status:"uncertain",createdAt:Date.now()-60000}));
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"trade"})).toMatchObject({reserved:false,waitMs:840000});
  });
  it("preserves the short recovery pacing for actual account-level 403s, not deleted-post 403s", async () => {
    const ctx=fixture(); await interaction(ctx,"trade","buy 1 PONSBOT");
    await ctx.db.insert("xPublicationEvents",{postId:"prior",status:"rejected",httpStatus:403,error:"posting limitation",createdAt:Date.now()-1000});
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"trade"})).toMatchObject({reserved:false,waitMs:59000});
    ctx.rows.xPublicationEvents[0].error="You attempted to reply to a Tweet that is deleted or not visible to you.";
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"trade"})).toMatchObject({reserved:true});
  });
  it("does not reuse stale X headroom across concurrent publication reservations", async () => {
    const ctx=fixture();
    await ctx.db.insert("xPublicationEvents",{postId:"prior",status:"published",createdAt:Date.now()-1000,rateLimitRemaining:1,rateLimitReset:Date.now()/1000+600});
    await interaction(ctx,"first","buy 1 PONSBOT"); await interaction(ctx,"second","buy 1 PONSBOT");
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"first"})).toMatchObject({reserved:true});
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"second"})).toMatchObject({reserved:false,waitMs:600000});
  });
  it("retains duplicate-publication protection", async () => {
    const ctx=fixture(); await interaction(ctx,"trade","buy 1 PONSBOT");
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"trade"})).toMatchObject({reserved:true});
    expect(await invoke(xReplies.beginReplyPublication,ctx,{postId:"trade"})).toEqual({reserved:false,waitMs:0});
    expect(ctx.rows.xPublicationEvents).toHaveLength(1);
  });
});
