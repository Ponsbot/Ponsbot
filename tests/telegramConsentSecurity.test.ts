import { describe, it, expect, vi, afterEach } from "vitest";
import { createTelegramConsent, readTelegramConsent } from "../lib/telegram-link-consent";
import { boundUpdateLink } from "../convex/telegram";
afterEach(() => vi.restoreAllMocks());
describe("Telegram wallet consent", () => {
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
