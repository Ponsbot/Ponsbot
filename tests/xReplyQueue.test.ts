import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { readFileSync } from "node:fs";
import * as queue from "../convex/xReplyQueue";
import * as replies from "../convex/xReplies";
import { replyQueueExpiresAt, replyQueuePriority, replyQueueWaitMs } from "../lib/x-reply-queue-policy";
import { feeUpgradeSuccessMessage } from "../lib/fee-upgrade-command";

// Real Convex handlers with an index-aware in-memory DB; no live X, AI or wallets.
type Row = Record<string, any>;
const invoke = (fn: any, ctx: any, args: any = {}) => fn._handler(ctx, args);
function fixture() {
  const rows: Record<string, Row[]> = {};
  let sequence = 0;
  const indexes: Record<string, string[]> = {
    by_status_priority_ready: ["status", "priority", "readyAt"], by_status_expiry: ["status", "expiresAt"],
    by_status_kind_ready: ["status", "kind", "readyAt"],
    by_created_at: ["createdAt"], by_post_id: ["postId"],
  };
  const compare = (a: any, b: any) => a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
  const db = {
    async insert(table: string, row: Row) {
      const id = `${table}:${++sequence}`;
      (rows[table] ??= []).push({ ...row, _id: id, _creationTime: sequence });
      return id;
    },
    async get(id: string) { return Object.values(rows).flat().find(r => r._id === id) ?? null; },
    async patch(id: string, patch: Row) {
      const row = await db.get(id); if (!row) throw Error(`Missing ${id}`);
      Object.assign(row, patch);
    },
    query(table: string) {
      const predicates: Array<(r: Row) => boolean> = [];
      let keys: string[] = [], direction = 1;
      const idx = {
        eq(k: string, v: any) { predicates.push(r => r[k] === v); return idx; },
        gt(k: string, v: any) { predicates.push(r => r[k] > v); return idx; },
        gte(k: string, v: any) { predicates.push(r => r[k] >= v); return idx; },
        lte(k: string, v: any) { predicates.push(r => r[k] <= v); return idx; },
      };
      const get = () => (rows[table] ?? []).filter(r => predicates.every(p => p(r))).sort((a, b) => {
        for (const key of [...keys, "_creationTime"]) { const diff = compare(a[key], b[key]); if (diff) return direction * diff; }
        return 0;
      });
      const q = {
        withIndex(name: string, fn?: any) { keys = indexes[name] ?? []; fn?.(idx); return q; },
        order(d: string) { direction = d === "desc" ? -1 : 1; return q; },
        async unique() { const all = get(); if (all.length > 1) throw Error("not unique"); return all[0] ?? null; },
        async first() { return get()[0] ?? null; }, async take(n: number) { return get().slice(0, n); },
      };
      return q;
    },
  };
  const ctx: any = { db, rows, scheduler: { runAfter: vi.fn() }, runAction: vi.fn(() => { throw Error("Wallet/AI forbidden"); }) };
  const call = (ref: any, args: any) => {
    const [module, name] = getFunctionName(ref).split(":");
    if (!["xReplyQueue", "xReplies"].includes(module)) throw Error(`Forbidden module ${module}`);
    return invoke((module === "xReplyQueue" ? queue : replies as any)[name], ctx, args);
  };
  ctx.runMutation = vi.fn(call); ctx.runQuery = vi.fn(call);
  return ctx;
}
const state = (ctx: ReturnType<typeof fixture>) => ctx.rows.xReplyQueueState[0];
const row = (ctx: ReturnType<typeof fixture>, key: string) => ctx.rows.xReplyQueue.find((r: Row) => r.key === key)!;
async function source(ctx: ReturnType<typeof fixture>, id: string, kind = "buy", extra: Row = {}) {
  await ctx.db.insert("xReplyUsers", { xUserId: id, username: `user${id}` });
  return ctx.db.insert("xReplyInteractions", { postId: id, authorXUserId: id, text: "user request", commandKind: kind,
    status: "processing", createdAt: Date.now(), updatedAt: Date.now(), ...extra });
}
async function add(ctx: ReturnType<typeof fixture>, key: string, priority: "A" | "B" | "C", extra: Row = {}) {
  await source(ctx, key, priority === "C" ? "help" : "buy");
  return invoke(queue.enqueue, ctx, { key, postId: key, kind: "reply", text: priority === "A" ? "✅ Bought 10 TEST!" : priority === "B" ? "⚠️ More than one indexed token uses that ticker." : "💡 Tell me buy or sell.", ...extra });
}
const take = (ctx: ReturnType<typeof fixture>) => invoke(queue.takeNext, ctx, { wakeToken: state(ctx).wakeToken });
async function done(ctx: ReturnType<typeof fixture>, picked: any, extra: Row = {}) {
  return invoke(queue.finish, ctx, { queueId: picked.row._id, leaseToken: picked.leaseToken, outcome: "published", responsePostId: `reply-${picked.row.key}`, ...extra });
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-31T18:00:00Z"));
  vi.stubEnv("X_REPLIES_ENABLED", "true"); vi.stubEnv("X_STANDALONE_MENTIONS_ENABLED", "false");
  vi.stubEnv("X_SUPPRESS_ROUTINE_FAILURE_REPLIES", "false"); vi.stubEnv("X_GRADUATION_POSTS_ENABLED", "true");
  for (const name of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]) vi.stubEnv(name, "offline-test-only");
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden"); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("priority categories", () => {
  it("keeps actual no-emoji upgrade confirmations in A without promoting automatic-fee notices", () => {
    expect(replyQueuePriority(feeUpgradeSuccessMessage("PONSBOT", "https://www.ponsbot.family/token/example"), "upgrade_fees", true)).toBe("A");
    expect(replyQueuePriority("ℹ️ $PONSBOT is a Pons Bot V2 token. Creator-fee claims and payouts are automated; 5% buys back and burns $PONSBOT.", "claim_fees", true)).toBe("C");
    expect(replyQueuePriority("ℹ️ There aren't any creator fees available to claim in that asset right now.", "claim_fees", true)).toBe("C");
  });
  it.each([
    ["✅ Success! Launched Help (HELP) on Pons V2!", "launch", "A"],
    ["✅ Your Pons Bot wallet is ready!", "show_wallet", "C"],
    ["🔄 Buy, sell, send and burn with me!", "help", "C"],
    ["⏳ Private swap submitted to Houdini Swap.", "houdini_progress", "A"],
    ["❌ Swap failed.", "houdini_final", "A"],
    ["🚀 $TEST has graduated!", "graduation", "A"],
    ["Choose a range for your position.", "liquidity", "A"],
    ["⚠️ The buy completed, but the send did not.", "buy_and_send", "A"],
    ["⚠️ The MSFT sale completed, but the purchase of PONSBOT failed.", "swap", "A"],
    ["⚠️ The holder distributor was created, but future fees were not reassigned.", "reassign_fees", "A"],
    ["⏳ An upgrade is already being processed for that token. Please wait for the result.", "upgrade_fees", "A"],
    ["There's an issue with this token's upgrade - please DM @Ponsbotfamily for help", "upgrade_fees", "A"],
    ["The MSFT purchase completed, but the final launch did not.", "launch", "A"],
    ["❌ I couldn't complete that wallet request. Check the details and give it another try!", "buy", "A"],
    ["🌐 The network couldn't submit that transaction.", "send", "A"],
    ["💧 I couldn't find enough liquidity or a usable route for that trade.", "buy", "A"],
    ["⛽ Network fees moved too quickly before broadcast.", "launch", "A"],
    ["⚠️ More than one indexed token uses that ticker.", "buy", "B"],
    ["⚠️ That pairing asset isn't currently supported on Pons V2.", "launch", "B"],
    ["🔒 You don't have the rights to reassign fees.", "reassign_fees", "B"],
    ["❌ You don't have enough of this token's paired asset yet.", "buy", "B"],
    ["❌ There aren't enough funds for that amount.", "buy", "B"],
    ["⛽ There isn't enough ETH in your wallet to cover this transaction and network gas.", "send", "C"],
    ["ℹ️ There aren't any creator fees available to claim in that asset right now.", "claim_fees", "C"],
    ["ℹ️ $PONSBOT is a Pons Bot V2 token. Creator-fee claims and payouts are automated; 5% buys back and burns $PONSBOT.", "claim_fees", "C"],
    ["ℹ️ $PONSBOT is already a Pons Bot V2 token.", "upgrade_fees", "C"],
    ["⏳ Your wallet is still processing an earlier transaction.", "launch", "C"],
    ["🤔 I couldn't quite make that out. Try show my wallet.", "unknown_wallet", "C"],
    ["🟢 What would you like to buy?", "guided_help:buy", "B"],
    ["✅ Bought 10 TEST!\n\nAnything else?", "guided_execution", "A"],
  ])("%s -> %s/%s", (text, kind, expected) => expect(replyQueuePriority(text, kind)).toBe(expected));
});

describe("guided help thread ownership", () => {
  it("limits one owner's workflow to 20 continuations in 15 minutes", async () => {
    const ctx = fixture();
    for (let index = 0; index < 20; index += 1)
      expect(await invoke(replies.admitWorkflowContinuation, ctx, { ownerXUserId: "101", postId: `step-${index}` }))
        .toMatchObject({ allowed: true, notify: false });
    expect(await invoke(replies.admitWorkflowContinuation, ctx, { ownerXUserId: "101", postId: "step-20" }))
      .toMatchObject({ allowed: false, notify: true });
    expect(await invoke(replies.admitWorkflowContinuation, ctx, { ownerXUserId: "101", postId: "step-21" }))
      .toMatchObject({ allowed: false, notify: false });
    expect(await invoke(replies.admitWorkflowContinuation, ctx, { ownerXUserId: "202", postId: "other" }))
      .toMatchObject({ allowed: true, notify: false });
  });
  it("recognizes only the original author's direct reply to an insufficient-ETH notice", async () => {
    const ctx = fixture();
    await ctx.db.insert("xReplyInteractions", {
      postId: "failed-buy", authorXUserId: "101", text: "buy $20 of TEST",
      commandKind: "buy", responsePostId: "bot-gas-reply",
      safeError: "⛽ This wallet needs a little more ETH for gas. Top it up, then reply with the request again!",
      status: "rejected", createdAt: Date.now(), updatedAt: Date.now(),
    });
    expect(await invoke(replies.insufficientEthReplyContext, ctx, { ownerXUserId: "101", parentPostId: "bot-gas-reply" })).toBe(true);
    expect(await invoke(replies.insufficientEthReplyContext, ctx, { ownerXUserId: "202", parentPostId: "bot-gas-reply" })).toBe(false);
    expect(await invoke(replies.insufficientEthReplyContext, ctx, { ownerXUserId: "101", parentPostId: "unrelated" })).toBe(false);
  });

  it("carries the exact failed command into an owner-bound resume reply", async () => {
    const ctx = fixture();
    await ctx.db.insert("xReplyInteractions", {
      postId: "failed-swap", authorXUserId: "101",
      text: "no", commandKind: "guided_help",
      responsePostId: "bot-gas-swap",
      safeError: "⛽ You'll need to fund your wallet with ETH for gas to complete this cross-chain swap. Fund it, then reply “resume”.",
      guidedHelpStateJson: JSON.stringify({
        type: "gas_resume",
        sourceText: "send $25 to 0x1111111111111111111111111111111111111111 as ETH on Base",
        explicitMentionAuthorized: true,
      }),
      status: "rejected", createdAt: Date.now(), updatedAt: Date.now(),
    });
    expect(await invoke(replies.insufficientEthResumeContext, ctx, {
      ownerXUserId: "101", parentPostId: "bot-gas-swap",
    })).toMatchObject({
      resumable: true,
      sourceText: "send $25 to 0x1111111111111111111111111111111111111111 as ETH on Base",
      explicitMentionAuthorized: true,
    });
    expect(await invoke(replies.insufficientEthResumeContext, ctx, {
      ownerXUserId: "202", parentPostId: "bot-gas-swap",
    })).toBeNull();
  });

  it("expires gas resumes after ten minutes", async () => {
    const ctx = fixture();
    await ctx.db.insert("xReplyInteractions", {
      postId: "old-buy", authorXUserId: "101", text: "buy $20 of TEST", commandKind: "buy",
      responsePostId: "old-gas-reply", safeError: "⛽ You'll need to fund your wallet with ETH for gas to buy. Fund it, then reply “resume”.",
      guidedHelpStateJson: JSON.stringify({ type: "gas_resume", sourceText: "buy $20 of TEST", explicitMentionAuthorized: true }),
      status: "rejected", createdAt: Date.now() - 11 * 60_000, updatedAt: Date.now() - 11 * 60_000,
    });
    expect(await invoke(replies.insufficientEthResumeContext, ctx, {
      ownerXUserId: "101", parentPostId: "old-gas-reply",
    })).toBeNull();
    expect(await invoke(replies.claimInsufficientEthResume, ctx, {
      ownerXUserId: "101", parentPostId: "old-gas-reply", consumerPostId: "resume-one",
    })).toBe(false);
  });

  it("allows one idempotent resume post and rejects sibling or foreign posts", async () => {
    const ctx = fixture();
    await ctx.db.insert("xReplyInteractions", {
      postId: "failed-buy", authorXUserId: "101", text: "buy $20 of TEST", commandKind: "buy",
      responsePostId: "gas-reply", safeError: "⛽ You'll need to fund your wallet with ETH for gas to buy. Fund it, then reply “resume”.",
      guidedHelpStateJson: JSON.stringify({ type: "gas_resume", sourceText: "buy $20 of TEST", explicitMentionAuthorized: true }),
      status: "rejected", createdAt: Date.now(), updatedAt: Date.now(),
    });
    const first = { ownerXUserId: "101", parentPostId: "gas-reply", consumerPostId: "resume-one" };
    expect(await invoke(replies.claimInsufficientEthResume, ctx, first)).toBe(true);
    expect(await invoke(replies.claimInsufficientEthResume, ctx, first)).toBe(true);
    expect(await invoke(replies.claimInsufficientEthResume, ctx, { ...first, consumerPostId: "resume-two" })).toBe(false);
    expect(await invoke(replies.claimInsufficientEthResume, ctx, { ...first, ownerXUserId: "202", consumerPostId: "foreign" })).toBe(false);
    expect(await invoke(replies.insufficientEthResumeContext, ctx, {
      ownerXUserId: "101", parentPostId: "gas-reply",
    })).toBeNull();
  });

  it("reopens guided help after a queued successful completion is published", async () => {
    const ctx = fixture();
    await source(ctx, "guided-success", "guided_help_pending:houdini");
    await invoke(queue.enqueue, ctx, {
      key: "guided-final",
      postId: "guided-success",
      kind: "houdini_final",
      ok: true,
      allowLong: true,
      text: "✅ Swap complete!\n\nAnything else?",
    });
    const picked = await take(ctx);
    await done(ctx, picked, { responsePostId: "guided-success-reply" });
    expect(ctx.rows.xReplyInteractions[0].commandKind).toBe("guided_help");
    expect(await invoke(replies.guidedHelpContext, ctx, {
      ownerXUserId: "guided-success",
      parentPostId: "guided-success-reply",
    })).toMatchObject({ operation: "root", allowed: true });
  });

  it("recognizes only the original author's fresh reply chain", async () => {
    const ctx = fixture();
    await ctx.db.insert("xReplyInteractions", {
      postId: "help-source", authorXUserId: "101", text: "what can you do",
      commandKind: "guided_help:buy", responsePostId: "bot-help-reply",
      status: "completed", createdAt: Date.now(), updatedAt: Date.now(),
    });
    expect(await invoke(replies.guidedHelpContext, ctx, { ownerXUserId: "101", parentPostId: "bot-help-reply" }))
      .toEqual({ operation: "buy", owner: "101", allowed: true, sourceText: "what can you do", sourceExplicitMention: false });
    expect(await invoke(replies.guidedHelpContext, ctx, { ownerXUserId: "202", parentPostId: "bot-help-reply" }))
      .toEqual({ operation: "buy", owner: "101", allowed: false, sourceText: "what can you do", sourceExplicitMention: false });
  });

  it("treats a persisted launch how-to response as an owner-bound guided entry point", async () => {
    const ctx = fixture();
    await ctx.db.insert("xReplyInteractions", {
      postId: "launch-help-source", authorXUserId: "101", text: "@Ponsbotfamily how do I launch?",
      parsedIntentJson: JSON.stringify({ kind: "help", topic: "launch" }),
      responsePostId: "bot-launch-help-reply", status: "completed",
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    expect(await invoke(replies.guidedHelpContext, ctx, {
      ownerXUserId: "101", parentPostId: "bot-launch-help-reply",
    })).toMatchObject({ operation: "root", owner: "101", allowed: true, sourceExplicitMention: true });
    expect(await invoke(replies.guidedHelpContext, ctx, {
      ownerXUserId: "202", parentPostId: "bot-launch-help-reply",
    })).toMatchObject({ operation: "root", owner: "101", allowed: false });
  });

  it("carries an owner-bound guided launch draft only through its published prompt", async () => {
    const ctx = fixture();
    const guidedHelpStateJson = JSON.stringify({ version: 1, phase: "ticker", explicitMentionAuthorized: true, draft: { name: "Green Harbor" } });
    await ctx.db.insert("xReplyInteractions", {
      postId: "launch-name", authorXUserId: "101", text: "Green Harbor",
      commandKind: "guided_help:launch", guidedHelpStateJson,
      responsePostId: "launch-ticker-prompt", status: "completed",
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    expect(await invoke(replies.guidedHelpContext, ctx, { ownerXUserId: "101", parentPostId: "launch-ticker-prompt" }))
      .toMatchObject({ operation: "launch", allowed: true, guidedHelpStateJson });
    expect(await invoke(replies.guidedHelpContext, ctx, { ownerXUserId: "202", parentPostId: "launch-ticker-prompt" }))
      .toMatchObject({ operation: "launch", allowed: false, guidedHelpStateJson });
    expect(await invoke(replies.guidedHelpContext, ctx, { ownerXUserId: "101", parentPostId: "unrelated" })).toBeNull();
  });

  it("allows one idempotent owner reply per guided launch prompt", async () => {
    const ctx = fixture();
    await ctx.db.insert("xReplyInteractions", {
      postId: "launch-name", authorXUserId: "101", text: "Green Harbor",
      commandKind: "guided_help:launch", guidedHelpStateJson: JSON.stringify({ version: 1, phase: "ticker", explicitMentionAuthorized: true, draft: { name: "Green Harbor" } }),
      responsePostId: "launch-ticker-prompt", status: "completed",
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    const args = { ownerXUserId: "101", parentPostId: "launch-ticker-prompt", consumerPostId: "answer-one" };
    expect(await invoke(replies.claimGuidedLaunchStep, ctx, args)).toBe(true);
    expect(await invoke(replies.claimGuidedLaunchStep, ctx, args)).toBe(true);
    expect(await invoke(replies.claimGuidedLaunchStep, ctx, { ...args, consumerPostId: "answer-two" })).toBe(false);
    expect(await invoke(replies.claimGuidedLaunchStep, ctx, { ...args, ownerXUserId: "202", consumerPostId: "foreign" })).toBe(false);
  });

  it("does not revive expired or cancelled guidance", async () => {
    const ctx = fixture();
    const stale = await ctx.db.insert("xReplyInteractions", {
      postId: "stale", authorXUserId: "101", text: "buy", commandKind: "guided_help:buy",
      responsePostId: "stale-reply", status: "completed",
      createdAt: Date.now() - 11 * 60_000, updatedAt: Date.now() - 11 * 60_000,
    });
    await ctx.db.insert("xReplyInteractions", {
      postId: "cancelled", authorXUserId: "101", text: "cancel", commandKind: "guided_help:cancelled",
      responsePostId: "cancelled-reply", status: "completed", createdAt: Date.now(), updatedAt: Date.now(),
    });
    expect(await invoke(replies.guidedHelpContext, ctx, { ownerXUserId: "101", parentPostId: "stale-reply" })).toBeNull();
    expect(await invoke(replies.guidedHelpContext, ctx, { ownerXUserId: "101", parentPostId: "cancelled-reply" })).toBeNull();
    expect(await ctx.db.get(stale)).toBeTruthy();
  });
});

describe("pacing math", () => {
  it("fits six, not seven, into a rolling two-minute chunk below 65% usage", () => {
    const now = Date.now(), attempts = [0, 10, 20, 30, 40, 50].map(delta => ({ at: now + delta }));
    expect(replyQueueWaitMs(attempts.slice(0, 5), "A", now + 60)).toBe(0);
    expect(replyQueueWaitMs(attempts, "A", now + 119_999)).toBe(1);
    expect(replyQueueWaitMs(attempts, "A", now + 120_000)).toBe(0);
  });
  it("uses a one-minute C gap below 65% usage", () => {
    const now = Date.now(), attempts = [{ at: now + 119_999, priority: "C" as const }];
    expect(replyQueueWaitMs(attempts, "C", now + 120_000)).toBe(59_999);
    expect(replyQueueWaitMs(attempts, "A", now + 120_000)).toBe(0);
    expect(replyQueueWaitMs([], "C", 0)).toBe(0);
  });
  it("returns to three per two minutes and a three-minute C gap at 65% usage", () => {
    const now = Date.now();
    const old = Array.from({ length: 192 }, (_, index) => ({ at: now - 60 * 60_000 - index }));
    const recent = [0, 10, 20].map(delta => ({ at: now - delta, priority: "C" as const }));
    expect(replyQueueWaitMs([...old, ...recent], "A", now)).toBe(119_980);
    expect(replyQueueWaitMs([...old, ...recent], "C", now)).toBe(180_000);
  });
  it("holds C at 80% and B/C at 90% while A remains eligible", () => {
    const now = Date.now();
    const attempts240 = Array.from({ length: 240 }, (_, index) => ({ at: now - 60 * 60_000 - index }));
    expect(replyQueueWaitMs(attempts240, "C", now, undefined, "liquidity")).toBeGreaterThan(0);
    expect(replyQueueWaitMs(attempts240, "B", now, undefined, "guided_reply")).toBe(0);
    expect(replyQueueWaitMs(attempts240, "A", now, undefined, "liquidity")).toBe(0);
    const attempts270 = Array.from({ length: 270 }, (_, index) => ({ at: now - 60 * 60_000 - index }));
    expect(replyQueueWaitMs(attempts270, "B", now, undefined, "guided_reply")).toBeGreaterThan(0);
    expect(replyQueueWaitMs(attempts270, "C", now, undefined, "liquidity")).toBeGreaterThan(0);
    expect(replyQueueWaitMs(attempts270, "A", now, undefined, "liquidity")).toBe(0);
  });
  it("honors real X headers and three-hour capacity at rollout", () => {
    const now = Date.now();
    const old = Array.from({ length: 300 }, (_, i) => ({ at: now - 600_000 + i }));
    expect(replyQueueWaitMs(old, "A", now)).toBe(10_200_000);
    expect(replyQueueWaitMs([], "A", now, { remaining: 0, reset: (now + 900_000) / 1000 })).toBe(900_000);
    expect(replyQueueWaitMs([], "A", now, { blockedUntil: now + 60_000 })).toBe(60_000);
  });
  it("has no A expiry; B/C expire from reply readiness", () => {
    expect(replyQueueExpiresAt("A", 0)).toBeUndefined();
    expect(replyQueueExpiresAt("B", 0)).toBe(600_000);
    expect(replyQueueExpiresAt("C", 0)).toBe(420_000);
  });
  it("exempts trusted workflow continuations from the short window without exempting shared limits", () => {
    const now = Date.now(), ordinary = Array.from({ length: 3 }, () => ({ at: now, priority: "A" as const }));
    expect(replyQueueWaitMs(ordinary, "A", now, undefined, "liquidity")).toBe(0);
    expect(replyQueueWaitMs(ordinary, "B", now, undefined, "guided_reply")).toBe(0);
    expect(replyQueueWaitMs(ordinary, "A", now, undefined, "guided_execution")).toBe(0);
    expect(replyQueueWaitMs(ordinary, "B", now, undefined, "thread_continuation")).toBe(0);
    expect(replyQueueWaitMs(ordinary, "A", now, undefined, "reply")).toBe(0);
    expect(replyQueueWaitMs(ordinary, "A", now, undefined, "houdini_final")).toBe(0);
    expect(replyQueueWaitMs(ordinary.map(a => ({ ...a, kind: "liquidity" })), "A", now)).toBe(0);
  });
  it.each(["liquidity", "reply"])("counts LP attempts toward both shared windows for %s", kind => {
    const now = Date.now();
    expect(replyQueueWaitMs(Array.from({ length: 100 }, () => ({ at: now - 180_000, kind: "liquidity" })), "A", now, undefined, kind)).toBe(720_000);
    expect(replyQueueWaitMs(Array.from({ length: 300 }, () => ({ at: now - 1_800_000, kind: "liquidity" })), "A", now, undefined, kind)).toBe(9_000_000);
  });
  it("never exempts LP from exhausted headers or provider cooldowns", () => {
    const now = Date.now();
    expect(replyQueueWaitMs([], "A", now, { remaining: 0, reset: (now + 900_000) / 1000 }, "liquidity")).toBe(900_000);
    expect(replyQueueWaitMs([], "A", now, { blockedUntil: now + 60_000 }, "liquidity")).toBe(60_000);
  });
  it("does not pace LP from projected velocity and stops only before exceeding X's defined windows", () => {
    const now = Date.now();
    const older = Array.from({ length: 200 }, (_, index) => ({ at: now - 60 * 60_000 - index, kind: "liquidity" }));
    const recent99 = Array.from({ length: 99 }, (_, index) => ({ at: now - 60_000 - index, kind: "liquidity" }));
    const attempts299 = [...older, ...recent99];
    // The next LP response is the 100th in 15 minutes and 300th in 3 hours.
    expect(replyQueueWaitMs(attempts299, "A", now, { remaining: 1, reset: (now + 900_000) / 1000 }, "liquidity")).toBe(0);
    const attempts300 = [...attempts299, { at: now, kind: "liquidity" }];
    expect(replyQueueWaitMs(attempts300, "A", now, undefined, "liquidity")).toBeGreaterThan(0);
  });
});

describe("durable queue", () => {
  it("binds later guided prompts to the exempt B queue and successful confirmations to A", async () => {
    const ctx = fixture();
    await source(ctx, "guided-prompt", "guided_help:buy", { parentPostId: "prior-reply" });
    await invoke(queue.enqueue, ctx, { key: "guided-prompt", postId: "guided-prompt", kind: "reply", ok: true, text: "🟢 What would you like to buy?" });
    expect(row(ctx, "guided-prompt")).toMatchObject({ kind: "guided_reply", priority: "B" });
    await source(ctx, "guided-success-a", "guided_help", { parentPostId: "prior-reply-2" });
    await invoke(queue.enqueue, ctx, { key: "guided-success-a", postId: "guided-success-a", kind: "guided_execution", ok: true, text: "✅ Bought 10 TEST!\n\nAnything else?" });
    expect(row(ctx, "guided-success-a")).toMatchObject({ kind: "guided_execution", priority: "A", expiresAt: undefined });
  });

  it("exempts only a same-owner reply to a prior bot response as a thread continuation", async () => {
    const ctx = fixture();
    await source(ctx, "root-request", "buy", { authorXUserId: "owner", responsePostId: "bot-response" });
    await source(ctx, "owner-followup", "buy", { authorXUserId: "owner", parentPostId: "bot-response" });
    await invoke(queue.enqueue, ctx, {
      key: "owner-followup", postId: "owner-followup", kind: "reply", ok: false,
      text: "⚠️ More than one indexed token uses that ticker.",
    });
    expect(row(ctx, "owner-followup")).toMatchObject({ kind: "thread_continuation", priority: "B" });

    await source(ctx, "foreign-followup", "buy", { authorXUserId: "other", parentPostId: "bot-response" });
    await invoke(queue.enqueue, ctx, {
      key: "foreign-followup", postId: "foreign-followup", kind: "reply", ok: false,
      text: "⚠️ More than one indexed token uses that ticker.",
    });
    expect(row(ctx, "foreign-followup")).toMatchObject({ kind: "reply", priority: "B" });
  });

  it("silently closes a guided workflow when its B prompt expires", async () => {
    const ctx = fixture();
    await source(ctx, "guided-expiry", "guided_help:buy", { parentPostId: "prior-reply" });
    await invoke(queue.enqueue, ctx, { key: "guided-expiry", postId: "guided-expiry", kind: "reply", ok: true, text: "🟢 What would you like to buy?" });
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect(await take(ctx)).toBeNull();
    expect(row(ctx, "guided-expiry").status).toBe("expired");
    expect(ctx.rows.xReplyInteractions[0]).toMatchObject({ status: "rejected", commandKind: "guided_help:cancelled" });
  });
  it("publishes LP steps past three attempts without blocking ordinary capacity", async () => {
    const ctx = fixture();
    for (let i = 0; i < 5; i++) {
      await add(ctx, `lp${i}`, "A", { kind: "liquidity" });
      const picked = await take(ctx); expect(picked.row.key).toBe(`lp${i}`); await done(ctx, picked);
    }
    expect(state(ctx).attempts).toHaveLength(5);
    expect(state(ctx).attempts.every((a: Row) => a.kind === "liquidity")).toBe(true);
    await add(ctx, "ordinary", "A"); expect((await take(ctx)).row.key).toBe("ordinary");
  });
  it("lets LP pass a throttled older A while preserving LP FIFO and ordinary pacing", async () => {
    const ctx = fixture();
    for (let i = 0; i < 6; i++) { await add(ctx, `old${i}`, "A"); await done(ctx, await take(ctx)); }
    await add(ctx, "ordinary", "A"); expect(await take(ctx)).toBeNull();
    const oldWake = state(ctx).wakeToken;
    await add(ctx, "lp1", "A", { kind: "liquidity" }); await add(ctx, "lp2", "A", { kind: "liquidity" });
    expect(state(ctx).wakeToken).not.toBe(oldWake);
    expect(await invoke(queue.takeNext, ctx, { wakeToken: oldWake })).toBeNull();
    for (const key of ["lp1", "lp2"]) { const picked = await take(ctx); expect(picked.row.key).toBe(key); await done(ctx, picked); }
    expect(await take(ctx)).toBeNull();
    expect(row(ctx, "ordinary").status).toBe("queued");
    vi.setSystemTime(state(ctx).wakeAt); expect((await take(ctx)).row.key).toBe("ordinary");
  });
  it("keeps an eligible older A ahead of LP", async () => {
    const ctx = fixture(); await add(ctx, "ordinary", "A"); await add(ctx, "lp", "A", { kind: "liquidity" });
    expect((await take(ctx)).row.key).toBe("ordinary");
  });
  it.each([100, 300])("holds LP at the shared %s attempt limit", async count => {
    const ctx = fixture(); await add(ctx, "ordinary", "A"); await add(ctx, "lp", "A", { kind: "liquidity" });
    const at = Date.now() - (count === 100 ? 180_000 : 1_800_000);
    state(ctx).attempts = Array.from({ length: count }, () => ({ at, kind: "liquidity" }));
    expect(await take(ctx)).toBeNull(); expect(row(ctx, "lp").status).toBe("queued");
    expect(state(ctx).wakeAt).toBe(at + (count === 100 ? 900_000 : 10_800_000));
  });
  it("charges each LP attempt against shared capacity before publication", async () => {
    const ctx = fixture(); await add(ctx, "lp1", "A", { kind: "liquidity" }); await add(ctx, "lp2", "A", { kind: "liquidity" });
    state(ctx).attempts = Array.from({ length: 99 }, () => ({ at: Date.now() - 180_000, kind: "reply" }));
    const picked = await take(ctx); expect(picked.row.key).toBe("lp1");
    expect(state(ctx).attempts).toHaveLength(100);
    expect(state(ctx).attempts.at(-1)).toMatchObject({ at: Date.now(), kind: "liquidity" });
    await done(ctx, picked); expect(await take(ctx)).toBeNull(); expect(row(ctx, "lp2").status).toBe("queued");
  });
  it("does not bypass a provider cooldown with LP even behind a waiting ordinary reply", async () => {
    const ctx = fixture(); await add(ctx, "ordinary", "A");
    await done(ctx, await take(ctx), { outcome: "retry", httpStatus: 429, retryAfterMs: 60_000, responsePostId: undefined });
    await add(ctx, "lp", "A", { kind: "liquidity" });
    expect(await take(ctx)).toBeNull(); expect(state(ctx).wakeAt).toBe(Date.now() + 60_000);
  });
  it("still checks cancellation when an LP step overtakes the short-window wait", async () => {
    const ctx = fixture();
    for (let i = 0; i < 6; i++) { await add(ctx, `old${i}`, "A"); await done(ctx, await take(ctx)); }
    await add(ctx, "ordinary", "A"); await add(ctx, "lp", "A", { kind: "liquidity" });
    ctx.rows.xReplyInteractions.find((r: Row) => r.postId === "lp").commandKind = "operator_cancelled";
    expect(await take(ctx)).toBeNull(); expect(row(ctx, "lp").status).toBe("cancelled");
  });
  it("keeps every liquidity step in A with no age expiry and no category admission or C pacing", async () => {
    const ctx = fixture(); await add(ctx, "c1", "C"); await done(ctx, await take(ctx));
    for (const [i, text] of ["Choose a range.", "What budget?", "Here's how fees work.", "There isn't enough ETH in your wallet."].entries()) {
      await source(ctx, `lp${i}`, "liquidity");
      await invoke(queue.enqueue, ctx, { key: `lp${i}`, postId: `lp${i}`, kind: "liquidity", text, allowLong: true });
      expect(row(ctx, `lp${i}`).priority).toBe("A"); expect(row(ctx, `lp${i}`).expiresAt).toBeUndefined();
    }
    expect((await take(ctx)).row.key).toBe("lp0");
    expect(ctx.rows.xWalletLookupBudgets).toBeUndefined(); expect(ctx.rows.xReplyRateLimits).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("always selects A then B then C, FIFO within each group", async () => {
    const ctx = fixture();
    for (const [key, priority] of [["c1", "C"], ["b1", "B"], ["a1", "A"], ["a2", "A"], ["b2", "B"]] as const) {
      await add(ctx, key, priority); vi.setSystemTime(Date.now() + 1);
    }
    const first = await take(ctx); expect(first.row.key).toBe("a1"); await done(ctx, first);
    const second = await take(ctx); expect(second.row.key).toBe("a2"); await done(ctx, second);
    const third = await take(ctx); expect(third.row.key).toBe("b1"); await done(ctx, third);
    const fourth = await take(ctx); expect(fourth.row.key).toBe("b2"); await done(ctx, fourth);
    expect((await take(ctx)).row.key).toBe("c1");
    expect(ctx.runAction).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("new A preempts an already-scheduled C wait", async () => {
    const ctx = fixture(); await add(ctx, "c1", "C"); await done(ctx, await take(ctx)); await add(ctx, "c2", "C");
    expect(await take(ctx)).toBeNull(); const oldWake = state(ctx).wakeToken;
    await add(ctx, "a", "A"); expect(state(ctx).wakeToken).not.toBe(oldWake);
    expect(await invoke(queue.takeNext, ctx, { wakeToken: oldWake })).toBeNull();
    expect((await take(ctx)).row.key).toBe("a");
  });
  it("expires only B/C, even after a week disabled", async () => {
    const ctx = fixture(); vi.stubEnv("X_REPLIES_ENABLED", "false");
    await add(ctx, "a", "A"); await add(ctx, "b", "B"); await add(ctx, "c", "C");
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 7 * 86400_000); vi.stubEnv("X_REPLIES_ENABLED", "true");
    await invoke(queue.kick, ctx); expect((await take(ctx)).row.key).toBe("a");
    expect(row(ctx, "b").status).toBe("expired"); expect(row(ctx, "c").status).toBe("expired");
    expect(ctx.rows.xReplyInteractions.filter((r: Row) => r.status === "rejected")).toHaveLength(2);
  });
  it("duplicate ready notifications preserve text and original expiry", async () => {
    const ctx = fixture(); await add(ctx, "b", "B"); const original = { ...row(ctx, "b") };
    vi.setSystemTime(Date.now() + 590_000);
    expect(await invoke(queue.enqueue, ctx, { key: "b", postId: "b", kind: "reply", text: "✅ Different reply" })).toMatchObject({ status: "queued" });
    expect(row(ctx, "b")).toEqual(original); expect(ctx.rows.xReplyQueue).toHaveLength(1);
  });
  it("cannot start two publishers for the same wake token", async () => {
    const ctx = fixture(); await add(ctx, "a", "A"); await add(ctx, "b", "B"); const token = state(ctx).wakeToken;
    const first = await invoke(queue.takeNext, ctx, { wakeToken: token });
    expect(await invoke(queue.takeNext, ctx, { wakeToken: token })).toBeNull();
    await add(ctx, "other", "A"); expect(state(ctx).activeId).toBe(first.row._id);
    await done(ctx, first, { leaseToken: "wrong" }); expect(row(ctx, "a").status).toBe("sending");
  });
  it("retains A through repeated explicit provider rejections without retrying commands", async () => {
    const ctx = fixture(); await add(ctx, "a", "A");
    for (let i = 0; i < 12; i++) {
      const picked = await take(ctx); expect(picked.row.key).toBe("a");
      await done(ctx, picked, { outcome: "retry", responsePostId: undefined, httpStatus: 429, retryAfterMs: 60_000 });
      expect(await take(ctx)).toBeNull(); vi.setSystemTime(state(ctx).wakeAt);
    }
    expect(row(ctx, "a").attempts).toBe(12); expect(row(ctx, "a").expiresAt).toBeUndefined();
    expect(ctx.runAction).not.toHaveBeenCalled();
    expect(ctx.scheduler.runAfter.mock.calls.every((c: any[]) => getFunctionName(c[1]) === "xReplies:drainReplyQueue")).toBe(true);
  });
  it("shares provider Retry-After across priorities", async () => {
    const ctx = fixture(); await add(ctx, "b", "B"); await done(ctx, await take(ctx), { outcome: "retry", httpStatus: 429, retryAfterMs: 120_000 });
    await add(ctx, "a", "A"); expect(await take(ctx)).toBeNull(); expect(state(ctx).wakeAt).toBe(Date.now() + 120_000);
  });
  it("does not revive cancelled, suppressed or ambiguous pre-rollout requests", async () => {
    const ctx = fixture();
    for (const [key, extra, expected] of [["cancel", { commandKind: "operator_cancelled" }, "cancelled"], ["hidden", { replySuppressedReason: "operator" }, "cancelled"], ["old", { publicationAttempted: true }, "uncertain"], ["done", { status: "rejected" }, "cancelled"]] as const) {
      await source(ctx, key, "buy", extra);
      expect(await invoke(queue.enqueue, ctx, { key, postId: key, kind: "reply", text: "✅ Done" })).toMatchObject({ status: expected });
    }
    expect(ctx.rows.xReplyQueue).toBeUndefined(); expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("checks operator cancellation again before sending", async () => {
    const ctx = fixture(); await add(ctx, "a", "A"); ctx.rows.xReplyInteractions[0].commandKind = "operator_cancelled";
    expect(await take(ctx)).toBeNull(); expect(row(ctx, "a").status).toBe("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("seals temporary suppressed replies without scheduling stale recovery", async () => {
    const ctx = fixture(); vi.stubEnv("X_SUPPRESS_ROUTINE_FAILURE_REPLIES", "true"); await source(ctx, "a");
    expect(await invoke(queue.enqueue, ctx, { key: "a", postId: "a", kind: "reply", text: "🤔 I couldn't quite make that out." })).toMatchObject({ status: "cancelled" });
    expect(ctx.rows.xReplyInteractions[0]).toMatchObject({ status: "rejected", replySuppressedReason: "ai_ambiguity" });
  });
  it("does not rerun wallet work when old retry jobs arrive for queued outcomes", async () => {
    const ctx = fixture(); await add(ctx, "a", "A");
    await invoke(replies.retryInteraction, ctx, { postId: "a" });
    await invoke(replies.scheduleInteractionRetry, ctx, { postId: "a", safeError: "old retry" });
    await invoke(replies.updateInteraction, ctx, { postId: "a", status: "processing" });
    expect(ctx.rows.xReplyInteractions[0]).toMatchObject({ status: "publishing", publicationQueued: true });
    expect(ctx.runAction).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("recovers a lost wake but never automatically repeats an ambiguous POST", async () => {
    const ctx = fixture(); await add(ctx, "a", "A"); await add(ctx, "next", "A"); await take(ctx);
    vi.setSystemTime(Date.now() + 90_001); await invoke(queue.kick, ctx);
    expect(row(ctx, "a").status).toBe("uncertain"); expect((await take(ctx)).row.key).toBe("next");
    expect(ctx.rows.xReplyInteractions[0].publicationQueued).toBe(true);
  });
  it("bootstraps recent use and headers once instead of resetting capacity", async () => {
    const ctx = fixture();
    for (let i = 0; i < 3; i++) await ctx.db.insert("xPublicationEvents", { postId: `old${i}`, status: "published", createdAt: Date.now() - 1000, rateLimitRemaining: 0, rateLimitReset: (Date.now() + 300_000) / 1000 });
    await add(ctx, "a", "A"); expect(await take(ctx)).toBeNull(); expect(state(ctx).wakeAt).toBe(Date.now() + 300_000);
  });
  it("replaces the former half-scale outbound cap", async () => {
    const ctx = fixture(); vi.stubEnv("X_REPLY_BUDGET_SCALE", "0.5");
    for (let i = 0; i < 15; i++) { await add(ctx, `${i}`, "A"); if (i && i % 3 === 0) vi.setSystemTime(Date.now() + 120_000); await done(ctx, await take(ctx)); }
    expect(ctx.rows.xReplyQueue.filter((r: Row) => r.status === "published")).toHaveLength(15);
  });
});

describe("queue-owned completion bindings", () => {
  it("pauses only graduation posts without expiring A or blocking transactions", async () => {
    const ctx = fixture(); const launchId = await ctx.db.insert("tokenLaunches", { publicPublished: true, graduationAnnouncementStatus: "posting" });
    await invoke(replies.publishStandalonePost, ctx, { launchId, publicationKey: "grad", text: "🚀 $TEST graduated!" });
    await add(ctx, "a", "A"); vi.stubEnv("X_GRADUATION_POSTS_ENABLED", "false");
    expect(await take(ctx)).toBeNull(); expect(row(ctx, "grad").status).toBe("paused");
    const trade = await take(ctx); expect(trade.row.key).toBe("a"); await done(ctx, trade);
    vi.setSystemTime(Date.now() + 3600_000); vi.stubEnv("X_GRADUATION_POSTS_ENABLED", "true");
    await invoke(queue.kick, ctx); expect((await take(ctx)).row.key).toBe("grad");
  });
  it("does not announce a token withdrawn from public indexing while queued", async () => {
    const ctx = fixture(); const launchId = await ctx.db.insert("tokenLaunches", { publicPublished: true, graduationAnnouncementStatus: "posting" });
    await invoke(replies.publishStandalonePost, ctx, { launchId, publicationKey: "grad", text: "🚀 $TEST graduated!" });
    await ctx.db.patch(launchId, { publicPublished: false, graduationAnnouncementStatus: "ignored" });
    expect(await take(ctx)).toBeNull(); expect(row(ctx, "grad").status).toBe("cancelled");
    expect((await ctx.db.get(launchId)).graduationAnnouncementStatus).toBe("ignored");
  });
  it("publishes both swap messages against the original source without re-execution", async () => {
    const ctx = fixture(); await source(ctx, "original", "houdini_execute");
    const quoteId = await ctx.db.insert("xHoudiniQuotes", { requestPostId: "original", status: "completed" });
    expect(await invoke(replies.publishHoudiniProgress, ctx, { postId: "original", text: "⏳ Cross-chain swap submitted.", houdiniQuoteId: quoteId })).toEqual({ status: "queued" });
    expect(await invoke(replies.publishHoudiniOutcome, ctx, { postId: "original", text: "✅ Swap complete", ok: true, publicationKey: `houdini-final:${quoteId}`, houdiniQuoteId: quoteId })).toEqual({ status: "queued" });
    expect((await ctx.db.get(quoteId)).finalPublicationStatus).toBe("queued");
    const progress = await take(ctx); expect(progress.row.kind).toBe("houdini_progress"); await done(ctx, progress);
    const final = await take(ctx); expect(final.row.postId).toBe("original"); await done(ctx, final);
    expect(await ctx.db.get(quoteId)).toMatchObject({ finalPublicationStatus: "published", submissionPublicationStatus: "published" });
    expect(ctx.rows.xReplyInteractions[0]).toMatchObject({ status: "completed", publicationQueued: false });
  });
  it("queues graduation and writes its actual post ID only on delivery", async () => {
    const ctx = fixture(); const launchId = await ctx.db.insert("tokenLaunches", { publicPublished: true, graduationAnnouncementStatus: "posting" });
    expect(await invoke(replies.publishStandalonePost, ctx, { launchId, publicationKey: `graduation:${launchId}`, text: "🚀 $TEST graduated!" })).toEqual({ status: "queued" });
    expect((await ctx.db.get(launchId)).graduationAnnouncementStatus).toBe("posting");
    const picked = await take(ctx); expect(picked.row).toMatchObject({ priority: "A", standalone: true }); await done(ctx, picked);
    expect(await ctx.db.get(launchId)).toMatchObject({ graduationAnnouncementStatus: "posted", graduationAnnouncementPostId: `reply-graduation:${launchId}` });
  });
  it("attaches delayed liquidity prompts for follow-up routing", async () => {
    const ctx = fixture(); await source(ctx, "lp", "liquidity");
    const conversationId = await ctx.db.insert("liquidityConversations", {});
    const turnId = await ctx.db.insert("liquidityTurns", { requestKey: "x:lp", conversationId });
    await ctx.db.patch(conversationId, { currentTurnId: turnId });
    await invoke(queue.enqueue, ctx, { key: "lp", postId: "lp", kind: "liquidity", text: "Pick a range", allowLong: true });
    await done(ctx, await take(ctx));
    expect(await ctx.db.get(turnId)).toMatchObject({ responsePostId: "reply-lp" });
    expect(await ctx.db.get(conversationId)).toMatchObject({ lastPromptPostId: "reply-lp" });
  });
});

describe("actual publisher using a mocked X transport", () => {
  it("posts the frozen text once and records headers", async () => {
    const ctx = fixture(); await add(ctx, "a", "A"); const text = row(ctx, "a").text;
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: { id: "published-id" } }), { status: 201, headers: { "x-rate-limit-remaining": "91", "x-rate-limit-reset": String(Date.now() / 1000 + 900) } }));
    const args = { wakeToken: state(ctx).wakeToken }; await invoke(replies.drainReplyQueue, ctx, args); await invoke(replies.drainReplyQueue, ctx, args);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]!.body))).toEqual({ text, reply: { in_reply_to_tweet_id: "a" } });
    expect(row(ctx, "a")).toMatchObject({ status: "published", responsePostId: "published-id" }); expect(state(ctx).remaining).toBe(91);
  });
  it.each([[429, "retry", "queued"], [403, "blocked", "blocked"], [500, "uncertain", "uncertain"], [200, "uncertain", "uncertain"]])("HTTP %s does not replay wallet work", async (http, _outcome, expected) => {
    const ctx = fixture(); await add(ctx, "a", "A"); vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ detail: "Provider rejected this request" }), { status: Number(http) }));
    await invoke(replies.drainReplyQueue, ctx, { wakeToken: state(ctx).wakeToken });
    expect(row(ctx, "a").status).toBe(expected); expect(ctx.runAction).not.toHaveBeenCalled();
  });
  it("retains ambiguous network failures without posting them again", async () => {
    const ctx = fixture(); await add(ctx, "a", "A"); vi.mocked(fetch).mockRejectedValue(new Error("timeout after submission"));
    await invoke(replies.drainReplyQueue, ctx, { wakeToken: state(ctx).wakeToken });
    expect(row(ctx, "a").status).toBe("uncertain"); vi.setSystemTime(Date.now() + 86400_000); await invoke(queue.kick, ctx);
    expect(fetch).toHaveBeenCalledTimes(1); expect(row(ctx, "a")).toHaveProperty("text");
  });
  it("does not post after X is disabled", async () => {
    const ctx = fixture(); await add(ctx, "a", "A"); vi.stubEnv("X_REPLIES_ENABLED", "false");
    await invoke(replies.drainReplyQueue, ctx, { wakeToken: state(ctx).wakeToken });
    expect(row(ctx, "a").status).toBe("queued"); expect(fetch).not.toHaveBeenCalled();
  });
  it("has only one raw POST path and no wallet/AI dependency in the queue", () => {
    const src = readFileSync("convex/xReplies.ts", "utf8"), queueSource = readFileSync("convex/xReplyQueue.ts", "utf8");
    expect(src.match(/method: "POST"/g)).toHaveLength(1);
    expect(queueSource).not.toMatch(/internal\.(?:wallets|llm|liquidity)\./);
  });
});
