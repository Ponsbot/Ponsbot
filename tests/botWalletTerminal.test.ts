import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { executeCommand, executeTerminalCommand } from "../convex/wallets";
import { GENERAL_GUIDED_HELP_MESSAGE, guidedHelpPrompt } from "../lib/guided-help-workflow";

const bot = "9876543210987654321";
const sessionId = "web_123456789012345678901234";
const eventId = "event_12345678901234567890";
const sell = { kind: "sell", amount: "100", unit: "percent", token: "USDG", slippageBps: 250 };
const handler = (fn: any) => fn._handler;
const activeSession = () => ({ ownerXUserId: bot, expiresAt: Math.floor(Date.now() / 1000) + 3600 });

function fixture(session: any = activeSession(), guidedContext: any = null) {
  const calls: Array<{ name: string; args: any }> = [];
  const invoke = vi.fn(async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    if (name === "wallets:getXUserAndWallet") return {
      user: { xUserId: args.xUserId, verified: true },
      wallet: { _id: "wallet", ownerXUserId: args.xUserId, address: "0x1111111111111111111111111111111111111111", status: "active" },
    };
    if (name === "wallets:webSessionRecord") return session;
    if (name === "wallets:terminalGuidedHelpContext") return guidedContext;
    if (name === "liquidity:handle") return { handled: false };
    // Stop at the existing idempotency boundary: no quotes, signing or chain calls.
    if (name === "wallets:reserveWalletRequest") return {
      inserted: false, request: { status: "confirmed", finalMessage: "Previously completed test request" },
    };
    if (name === "wallets:consumeTerminalLimit") return true;
    if (name === "wallets:recordTerminalMessage") return;
    if (name === "wallets:executeCommand") return handler(executeCommand)(ctx, args);
    throw new Error(`Unexpected downstream work: ${name}`);
  });
  const ctx: any = { runQuery: invoke, runMutation: invoke, runAction: invoke, scheduler: { runAfter: vi.fn() } };
  return { ctx, calls, reserved: () => calls.some(c => c.name === "wallets:reserveWalletRequest") };
}
function args(command: any = sell, overrides: any = {}) {
  return { sourcePostId: eventId, xUserId: bot, text: "sell all of my USDG", parsedCommandJson: JSON.stringify(command),
    source: "terminal", channel: "terminal_chat", terminalSessionId: sessionId,
    requestId: `terminal:${sessionId}:${eventId}:${command.kind}`, ...overrides };
}

beforeEach(() => {
  vi.stubEnv("X_BOT_USER_ID", bot);
  vi.stubEnv("WEB_AUTH_SECRET", "test-only-secret");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.ponsbot.family");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network allowed in authorization tests"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("bot wallet terminal-only authorization", () => {
  it.each(["terminal_chat", "terminal_form"])("allows a same-owner authenticated USDG sell through %s", async channel => {
    const f = fixture();
    expect(await handler(executeCommand)(f.ctx, args(sell, { channel }))).toMatchObject({ ok: true });
    expect(f.reserved()).toBe(true);
    expect(f.calls.find(c => c.name === "wallets:webSessionRecord")?.args.sessionIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "buy", amount: "1", unit: "usd", token: "USDG", slippageBps: 250 },
    { kind: "swap_token_for_token", amount: "100", unit: "percent", fromToken: "USDG", toToken: "ETH", slippageBps: 250 },
    { kind: "buy_and_send", amount: "1", unit: "usd", token: "PONSBOT", recipient: "@user", slippageBps: 250 },
    { kind: "buy_and_burn", amount: "1", unit: "usd", token: "PONSBOT", slippageBps: 250 },
    { kind: "send", amount: "1", unit: "token", token: "USDG", recipient: "@user" },
    { kind: "burn", amount: "1", unit: "token", token: "USDG" },
  ])("retains the terminal's existing $kind support", async command => {
    const f = fixture();
    expect(await handler(executeCommand)(f.ctx, args(command))).toMatchObject({ ok: true });
    expect(f.reserved()).toBe(true);
  });

  it.each([
    { source: "x", channel: "x_reply" },
    { source: undefined, channel: "x_reply" },
    { source: "x", channel: "terminal_chat" },
    { source: undefined, channel: "terminal_form" },
    { source: "terminal", channel: "x_reply" },
    { source: "terminal", channel: undefined },
  ])("rejects X/default or inconsistent source/channel even with a valid session: %j", async overrides => {
    const f = fixture();
    expect(await handler(executeCommand)(f.ctx, args(sell, overrides))).toMatchObject({ ok: false });
    expect(f.reserved()).toBe(false);
    expect(f.calls.some(c => c.name === "wallets:webSessionRecord")).toBe(false);
  });

  it.each([undefined, "", "not-a-session"])("rejects absent or malformed session IDs: %s", async terminalSessionId => {
    const f = fixture();
    expect(await handler(executeCommand)(f.ctx, args(sell, { terminalSessionId }))).toMatchObject({ ok: false });
    expect(f.reserved()).toBe(false);
  });

  it.each(["missing", "wrong owner", "expired", "revoked"])("rejects a %s session before reserving any wallet action", async scenario => {
    const session = { ...activeSession(), ...(scenario === "wrong owner" ? { ownerXUserId: "another-user" } : {}),
      ...(scenario === "expired" ? { expiresAt: Math.floor(Date.now() / 1000) } : {}),
      ...(scenario === "revoked" ? { revokedAt: Date.now() } : {}) };
    const f = fixture(scenario === "missing" ? null : session);
    expect(await handler(executeCommand)(f.ctx, args())).toMatchObject({ ok: false, message: "🔒 Reconnect X to use the terminal." });
    expect(f.reserved()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(f.ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("does not enable terminal launches or chat-only swaps through a form", async () => {
    const f = fixture();
    expect(await handler(executeCommand)(f.ctx, args({ kind: "launch", launchMode: "pons", name: "Test", symbol: "TEST" })))
      .toMatchObject({ ok: false, message: "🚀 Launches are available through X posts only." });
    expect(await handler(executeCommand)(f.ctx, args({ kind: "swap_token_for_token", amount: "100", unit: "percent", fromToken: "USDG", toToken: "ETH", slippageBps: 250 }, { channel: "terminal_form" })))
      .toMatchObject({ ok: false, message: "❌ That action is available through terminal chat only." });
    expect(f.reserved()).toBe(false);
  });

  it("leaves another user's ordinary X trading unchanged", async () => {
    const f = fixture(null);
    expect(await handler(executeCommand)(f.ctx, args(sell, { xUserId: "other-user", source: "x", channel: "x_reply", terminalSessionId: undefined })))
      .toMatchObject({ ok: true });
    expect(f.calls.some(c => c.name === "wallets:webSessionRecord")).toBe(false);
  });
});

describe("public terminal entry point", () => {
  const request = { secret: "test-only-secret", ownerXUserId: bot, sessionId, eventId, channel: "terminal_form", commandJson: JSON.stringify(sell) };
  it("forwards an authenticated direct sell with server-set terminal identity", async () => {
    const f = fixture();
    expect(await handler(executeTerminalCommand)(f.ctx, request)).toMatchObject({ ok: true });
    expect(f.calls.find(c => c.name === "wallets:executeCommand")?.args).toMatchObject({ xUserId: bot, source: "terminal", channel: "terminal_form", terminalSessionId: sessionId });
  });
  it.each(["terminal_chat", "terminal_form"])("rejects missing sessions before parsing or actions in %s", async channel => {
    const f = fixture(null);
    await expect(handler(executeTerminalCommand)(f.ctx, { ...request, channel, text: "sell all of my USDG" })).rejects.toThrow("Terminal session expired");
    expect(f.calls.map(c => c.name)).toEqual(["wallets:webSessionRecord"]);
  });
  it("rejects an invalid server secret even with a live session", async () => {
    const f = fixture();
    await expect(handler(executeTerminalCommand)(f.ctx, { ...request, secret: "wrong" })).rejects.toThrow("terminal authorization failed");
    expect(f.calls).toHaveLength(0);
  });
  it("starts general guidance and remembers a selected operation", async () => {
    const baseRequest = { ...request, channel: "terminal_chat" as const, commandJson: undefined };
    const start = fixture();
    expect(await handler(executeTerminalCommand)(start.ctx, { ...baseRequest, text: "what can you do?" }))
      .toMatchObject({ ok: true, message: GENERAL_GUIDED_HELP_MESSAGE });

    const choose = fixture(activeSession(), { operation: "root" });
    expect(await handler(executeTerminalCommand)(choose.ctx, { ...baseRequest, text: "buy" }))
      .toMatchObject({ ok: true, message: guidedHelpPrompt("buy") });
    expect(choose.reserved()).toBe(false);
  });

  it("splits creator-fee claims from LP-fee claims", async () => {
    const baseRequest = { ...request, channel: "terminal_chat" as const, commandJson: undefined };
    const chooseClaim = fixture(activeSession(), { operation: "root" });
    expect(await handler(executeTerminalCommand)(chooseClaim.ctx, { ...baseRequest, text: "claim" }))
      .toMatchObject({ ok: true, message: guidedHelpPrompt("claim") });

    const creator = fixture(activeSession(), { operation: "claim" });
    expect(await handler(executeTerminalCommand)(creator.ctx, { ...baseRequest, text: "creator fees" }))
      .toMatchObject({ ok: true, message: guidedHelpPrompt("claim_fees") });

    const lp = fixture(activeSession(), { operation: "claim" });
    await handler(executeTerminalCommand)(lp.ctx, { ...baseRequest, text: "LP fees" });
    expect(lp.calls.find(c => c.name === "liquidity:handle")?.args.text).toBe("claim LP fees");
  });

  it("routes terminal cross-chain guidance to its dedicated reviewed form", async () => {
    const f = fixture(activeSession(), { operation: "root" });
    const result = await handler(executeTerminalCommand)(f.ctx, {
      ...request, channel: "terminal_chat", commandJson: undefined, text: "cross-chain",
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toContain("Multi-Chain and Private Swaps");
    expect(f.reserved()).toBe(false);
  });

  it("grounds terminal details in the selected operation before normal execution", async () => {
    const f = fixture(activeSession(), { operation: "buy" });
    const result = await handler(executeTerminalCommand)(f.ctx, {
      ...request, channel: "terminal_chat", commandJson: undefined, text: "$5 of PONSBOT",
    });
    expect(result).toMatchObject({ ok: true });
    expect(f.calls.find(c => c.name === "wallets:executeCommand")?.args)
      .toMatchObject({ text: "buy $5 of PONSBOT", source: "terminal", channel: "terminal_chat" });
  });
});
