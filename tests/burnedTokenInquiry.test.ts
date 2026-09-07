import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { parseBurnedTokenInquiry, BURNED_TOKEN_CA_MESSAGE, burnedTokenMessage } from "../lib/burned-token-inquiry";
import { parseWalletCommand, isValueMovingCommand, isTerminalCommand } from "../convex/walletCommands";
import { parseXWalletIntent } from "../convex/xWalletIntent";
import { executeCommand } from "../convex/wallets";
import { save, resume } from "../convex/burnedLookups";
import { shouldHandlePassiveChainText } from "../convex/xReplies";
import { straightforwardCommandOperation } from "../convex/xWalletIntent";
const ca = "0xdba76f1cf96dbef90e5e1083b70d15ce6e87b76a";
const invoke = (f: any, ctx: any, args: any) => f._handler(ctx, args);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("burn inquiries", () => {
  it("admits the actual STARTUP reply including inherited participant mentions", async () => {
    const text = "@StartupRH_ @ponsbotfamily how much $STARTUP 0xcc3cc9ce3a657472f3c10749ab8ebd3885b4b19e has been burned?";
    const command = { kind: "show_burned", token: "0xcc3cc9ce3a657472f3c10749ab8ebd3885b4b19e", expectedTicker: "STARTUP" };
    expect(parseBurnedTokenInquiry(text)).toEqual(command);
    expect(straightforwardCommandOperation(text)).toBe("show_burned");
    expect(shouldHandlePassiveChainText(text)).toBe(true);
    expect(await parseXWalletIntent(text, false)).toEqual({ kind: "command", command });
    expect(shouldHandlePassiveChainText("@StartupRH_ @ponsbotfamily so many burns lately")).toBe(false);
  });
  it("shows whole tokens, supply percentage and current-MCap value without a footer", () => {
    expect(burnedTokenMessage(ca, { raw: "100055", decimals: 2, totalSupplyRaw: "1000000", symbol: "WSB", usdValue: 2.5 }))
      .toBe("🔥 $WSB (0xdba7...b76a)\nBurned: 1,001 WSB (10.0%) ($2.50 at current MCap)");
    expect(burnedTokenMessage(ca, { raw: "0", decimals: 18, totalSupplyRaw: "0", symbol: "WSB" }))
      .toContain("Burned: 0 WSB (N/A)");
  });
  it.each([
    "How much $WSB is burned?", "how many WSB tokens have been burnt so far?",
    "Hey, @Ponsbotfamily could you tell me how much $WSB has been burned, please?",
    "Show me the total amount of WSB burned", "What's the burned supply of $WSB?",
    "Check WSB burn total", "$WSB burns?", "Total burned amount for WSB",
    "How much WSB is in the dead wallet?", "How much of WSB has burned in total?",
  ])("accepts natural inquiry: %s", text => {
    expect(parseBurnedTokenInquiry(text)).toMatchObject({ kind: "show_burned", token: "WSB" });
  });
  it.each(["burn all WSB", "please burn 100 WSB", "buy and burn $20 of WSB", "WSB burn 20", "show burn amount for 100 WSB"])("keeps actions/amounts separate: %s", text => {
    expect(parseBurnedTokenInquiry(text)).toBeNull();
  });
  it.each(["WSB", "$WSB", "$COIN", "CA", ca, `$WSB CA: ${ca}`, "$パペット"])("recognizes %s without transaction authority", async token => {
    const text = `@Ponsbotfamily How much ${token} has been burned?`;
    const command = parseWalletCommand(text);
    expect(command.kind).toBe("show_burned");
    expect(isValueMovingCommand(command)).toBe(false);
    expect(isTerminalCommand(command)).toBe(true);
    expect(await parseXWalletIntent(text, false)).toEqual({ kind: "command", command });
  });
  it.each([`burn 100 ${ca}`, `How much $WSB has been burned? burn all WSB`, "How much $WSB $OTHER has been burned?"])("does not treat %s as a burn inquiry", text => {
    expect(parseBurnedTokenInquiry(text)).toBeNull();
  });
  it.each(["found", "missing", "ambiguous", "mismatch"])("handles token resolution: %s", async mode => {
    vi.stubEnv("WALLET_SIGNER_URL", "https://signer.example"); vi.stubEnv("WALLET_SIGNER_TOKEN", "test");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ raw: "100000", decimals: 2, totalSupplyRaw: "1000000", usdValue: 2.5, symbol: "WSB" })));
    vi.stubGlobal("fetch", fetchMock);
    const mutations: string[] = [];
    const ctx = {
      runQuery: async (ref: any) => {
        const name = getFunctionName(ref);
        if (name.endsWith("getXUserAndWallet")) return { user: { username: "tester" }, wallet: { _id: "w", status: "active", address: ca } };
        if (name.endsWith("resolveKnownToken")) { if (mode === "ambiguous") throw new Error("that ticker matches more than one token"); return mode === "missing" ? "WSB" : ca; }
        throw new Error(name);
      },
      runAction: async (ref: any) => {
        if (getFunctionName(ref).endsWith("resolveHeldTokenTicker")) return { status: "not_found" };
        if (getFunctionName(ref).endsWith("verifyTokenTickerContract")) return { matches: false };
        throw new Error("Unexpected action");
      },
      runMutation: async (ref: any) => { mutations.push(getFunctionName(ref)); },
    };
    const text = `How much ${mode === "mismatch" ? `$WSB ${ca}` : "$WSB"} has been burned?`;
    const result = await invoke(executeCommand, ctx, { xUserId: "owner", sourcePostId: "p", text });
    if (mode === "found") {
      expect(result.ok).toBe(true); expect(result.message).toContain("$WSB (0xdba7...b76a)"); expect(result.message).toContain("1,000 WSB (10.0%) ($2.50 at current MCap)");
    } else {
      expect(result.ok).toBe(false); expect(fetchMock).not.toHaveBeenCalled();
      expect(result.message).toContain(mode === "missing" ? BURNED_TOKEN_CA_MESSAGE : mode === "ambiguous" ? "More than one" : "does not match");
    }
    expect(mutations.every(n => n === "burnedLookups:save")).toBe(true);
  });
  it("binds CA continuations, retains read retries, clears superseded work and expires", async () => {
    let row: any;
    const ctx = { db: {
      query: () => ({ withIndex: (_: any, filter: any) => { const expected: any = {}; const q: any = { eq: (k: string, v: any) => { expected[k] = v; return q; } }; filter(q); return { unique: async () => row && Object.entries(expected).every(([k,v]) => row[k] === v) ? row : null }; } }),
      delete: async () => { row = undefined; }, insert: async (_: any, value: any) => { row = { ...value, _id: "r" }; },
    } };
    await invoke(save, ctx, { owner: "a", source: "terminal", ticker: "WSB" });
    expect(await invoke(resume, ctx, { owner: "b", source: "terminal", text: ca })).toBeNull();
    expect(await invoke(resume, ctx, { owner: "a", source: "telegram", text: ca })).toBeNull();
    expect(await invoke(resume, ctx, { owner: "a", source: "terminal", text: ca })).toBe(`How much $WSB ${ca} has been burned?`);
    expect(await invoke(resume, ctx, { owner: "a", source: "terminal", text: ca })).toContain(ca);
    expect(await invoke(resume, ctx, { owner: "a", source: "terminal", text: ca, superseded: true })).toBeNull();
    await invoke(save, ctx, { owner: "a", source: "terminal", ticker: "WSB", scope: "s1" });
    expect(await invoke(resume, ctx, { owner: "a", source: "terminal", text: ca, scope: "s2" })).toBeNull();
    await invoke(save, ctx, { owner: "a", source: "terminal", ticker: "WSB" });
    expect(await invoke(resume, ctx, { owner: "a", source: "terminal", text: "buy $5 of ABC" })).toBeNull();
    await invoke(save, ctx, { owner: "a", source: "terminal", ticker: "WSB" }); row.expiresAt = 0;
    expect(await invoke(resume, ctx, { owner: "a", source: "terminal", text: ca })).toBe("expired");
  });
});
