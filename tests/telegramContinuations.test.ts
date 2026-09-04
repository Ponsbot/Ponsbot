import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { processUpdate, consumeGasResume } from "../convex/telegram";
import { guidedHelpCommandText, CLAIM_LP_FEE_OFFER } from "../lib/guided-help-workflow";
vi.mock("../convex/xWalletIntent", () => ({ parseXWalletIntent: vi.fn(async () => ({ kind: "command", command: { kind: "claim_fees" } })), walletHelpMessage: () => "Help" }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
function fixture(conversation: any = null) {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  const mutations: any[] = [], actions: any[] = [];
  const ctx = {
    runQuery: vi.fn(async (ref: any) => {
      const n = getFunctionName(ref);
      if (n.endsWith(":activeLink")) return { ownerXUserId: "owner", telegramChatId: "1" };
      if (n.endsWith(":activeConversation")) return conversation;
      return null;
    }),
    runMutation: vi.fn(async (ref: any, args: any) => { mutations.push([getFunctionName(ref), args]); return true; }),
    runAction: vi.fn(async (ref: any, args: any) => {
      actions.push([getFunctionName(ref), args]);
      if (getFunctionName(ref) === "liquidity:handle") return args.text === "cancel" ? { handled: true, message: "Cancelled." } : { handled: false };
      return { message: CLAIM_LP_FEE_OFFER };
    }),
    scheduler: { runAfter: vi.fn() },
  };
  const run = (text: string) => invoke(processUpdate, ctx, { updateId: "2", updateJson: JSON.stringify({ message: { message_id: 2, text, from: { id: 1 }, chat: { id: 1, type: "private" } } }) });
  return { ctx, mutations, actions, run };
}
describe("Telegram continuation routing through handler", () => {
  it("registers the creator-to-LP offer", async () => {
    const f = fixture(); await f.run("claim my fees");
    expect(f.mutations).toContainEqual(["telegram:setConversation", expect.objectContaining({ operation: "claim_lp_offer" })]);
  });
  it.each(["/cancel", "cancel!"])("cancels the liquidity setup for %s", async text => {
    const f = fixture(); await f.run(text);
    expect(f.actions).toContainEqual(["liquidity:handle", expect.objectContaining({ text: "cancel", scope: "telegram:telegram_1", ownerXUserId: "owner" })]);
  });
  it("asks for privacy without creating an order", async () => {
    const f = fixture({ operation: "cross_chain" });
    await f.run("Send $25 to 0x1111111111111111111111111111111111111111 as ETH on Base");
    expect(f.mutations).toContainEqual(["telegram:setConversation", expect.objectContaining({ operation: "cross_chain_privacy", resumeOwner: "owner" })]);
    expect(f.actions.some(([n]) => n === "xHoudini:createQuote")).toBe(false);
  });
  it.each(["Send", "Swap"])("retains private mode for a full %s command", verb => {
    expect(guidedHelpCommandText(`${verb} $25 to 0x1111111111111111111111111111111111111111 as ETH on Base`, "private_swap")).toMatch(/^private /);
  });
  it("consumes a privacy answer only once and rejects wrong owners", async () => {
    const row: any = { active: true, expiresAt: Date.now() + 60_000, operation: "cross_chain_privacy", telegramUserId: "1", telegramChatId: "1", resumeOwner: "owner", resumeText: "send request", _id: "c" };
    const ctx = { db: { get: async () => row, patch: async (_id: any, patch: any) => Object.assign(row, patch), query: () => ({ withIndex: () => ({ collect: async () => [{ ownerXUserId: "owner" }] }) }) } };
    const args = { conversationId: "c", telegramUserId: "1", telegramChatId: "1", ownerXUserId: "owner", operation: "cross_chain_privacy" };
    expect(await invoke(consumeGasResume, ctx, { ...args, ownerXUserId: "other" })).toBeNull();
    expect(await invoke(consumeGasResume, ctx, args)).toBe("send request");
    expect(await invoke(consumeGasResume, ctx, args)).toBeNull();
  });
});
