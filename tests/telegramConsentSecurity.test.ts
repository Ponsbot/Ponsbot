import { describe, it, expect, vi, afterEach } from "vitest";
import { createTelegramConsent, readTelegramConsent } from "../lib/telegram-link-consent";
import { boundUpdateLink, executionAuthorized } from "../convex/telegram";
afterEach(() => vi.restoreAllMocks());
describe("Telegram wallet consent", () => {
  it.each(["valid", "revoked", "missing", "wrong-owner", "wrong-chat", "legacy"])("execution rechecks the exact stored link: %s", async scenario => {
    const update = { linkBindingVersion: scenario === "legacy" ? undefined : 1, boundLinkId: "original", boundOwnerXUserId: "123", telegramUserId: "456", telegramChatId: "456" };
    const link = scenario === "missing" ? null : { ownerXUserId: "123", telegramUserId: "456", telegramChatId: scenario === "wrong-chat" ? "789" : "456", revokedAt: scenario === "revoked" ? 1 : undefined };
    const get = vi.fn(async () => link);
    const ctx = { db: { query: () => ({ withIndex: () => ({ unique: async () => update }) }), get } };
    const result = await (executionAuthorized as any)._handler(ctx, { updateId: "u", ownerXUserId: scenario === "wrong-owner" ? "other" : "123" });
    expect(result).toBe(scenario === "valid");
    if (get.mock.calls.length) expect(get).toHaveBeenCalledWith("original");
  });
  it("binds nonce and authenticated owner, rejects tampering and expiry", () => {
    const token = createTelegramConsent("a".repeat(64), "123", "owner", "secret");
    expect(readTelegramConsent(token, "secret")?.ownerXUserId).toBe("123");
    expect(readTelegramConsent(token + "x", "secret")).toBeNull();
    expect(readTelegramConsent(token, "other")).toBeNull();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601000);
    expect(readTelegramConsent(token, "secret")).toBeNull();
  });
  it.each(["same", "relinked", "revoked", "legacy", "unlinked-at-intake"])("checks intake binding: %s", async scenario => {
    const row = { telegramUserId: "1", telegramChatId: "1", linkBindingVersion: scenario === "legacy" ? undefined : 1, boundLinkId: scenario === "unlinked-at-intake" ? undefined : "old", boundOwnerXUserId: "123" };
    const links = scenario === "revoked" ? [] : [{ _id: scenario === "relinked" ? "new" : "old", ownerXUserId: "123", telegramChatId: "1" }];
    const ctx = { db: { query: () => ({ withIndex: () => ({ unique: async () => row, collect: async () => links }) }) } };
    const result = await (boundUpdateLink as any)._handler(ctx, { updateId: "u", telegramUserId: "1", telegramChatId: "1" });
    expect(result.valid).toBe(scenario === "same");
  });
});
