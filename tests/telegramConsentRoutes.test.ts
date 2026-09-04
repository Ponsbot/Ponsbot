import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getFunctionName } from "convex/server";
import { createTelegramConsent, TELEGRAM_CONSENT_COOKIE, TELEGRAM_CONSENT_PATH, readTelegramConsent } from "../lib/telegram-link-consent";
const { action } = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("convex/browser", () => ({ ConvexHttpClient: class { action = action; } }));
vi.mock("@/convex/_generated/api", () => import("../convex/_generated/api"));
vi.mock("@/lib/telegram-link-consent", () => import("../lib/telegram-link-consent"));
import { GET, POST } from "../app/api/auth/x/telegram-confirm/route";
const secret = "test-secret-not-production";
let token: string;
function request(method = "GET", options: { origin?: string; csrf?: string; decision?: string; cookie?: string } = {}) {
  return new NextRequest(`https://example.com${TELEGRAM_CONSENT_PATH}`, { method, headers: {
    cookie: `${TELEGRAM_CONSENT_COOKIE}=${options.cookie ?? token}`,
    ...(method === "POST" ? { origin: options.origin ?? "https://example.com", "content-type": "application/x-www-form-urlencoded" } : {}),
  }, ...(method === "POST" ? { body: new URLSearchParams({ csrf: options.csrf ?? readTelegramConsent(token, secret)!.csrf, decision: options.decision ?? "confirm" }) } : {}) });
}
beforeEach(() => {
  vi.stubEnv("WEB_AUTH_SECRET", secret); vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://test.convex.cloud"); vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.com");
  token = createTelegramConsent("a".repeat(64), "123", "owner", secret);
  action.mockReset().mockImplementation(async (ref: any) => getFunctionName(ref) === "telegram:previewLink" ? { telegramUserId: "456", telegramUsername: "<unsafe>" } : { linked: true });
});
afterEach(() => vi.unstubAllEnvs());
describe("Telegram browser consent", () => {
  it("GET displays identity but never grants access", async () => {
    const response = await GET(request()); const html = await response.text();
    expect(html).toContain("456"); expect(html).toContain("&lt;unsafe&gt;");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(action.mock.calls.every(([ref]) => getFunctionName(ref) === "telegram:previewLink")).toBe(true);
  });
  it.each([{ origin: "https://evil.test" }, { csrf: "wrong" }, { cookie: "tampered" }])("rejects forged confirmation %j", async options => {
    expect((await POST(request("POST", options))).status).toBe(403); expect(action).not.toHaveBeenCalled();
  });
  it("cancel clears consent without granting access", async () => {
    const response = await POST(request("POST", { decision: "cancel" }));
    expect(response.status).toBe(303); expect(response.headers.get("set-cookie")).toContain("Max-Age=0"); expect(action).not.toHaveBeenCalled();
  });
  it("confirms only the signed owner and nonce", async () => {
    expect((await POST(request("POST"))).status).toBe(303);
    expect(action.mock.calls.at(-1)?.[1]).toEqual({ secret, nonce: "a".repeat(64), ownerXUserId: "123" });
  });
  it("rejects a stale tab after another consent replaces its cookie", async () => {
    const newCookie = createTelegramConsent("b".repeat(64), "789", "other", secret);
    expect((await POST(request("POST", { cookie: newCookie }))).status).toBe(403); expect(action).not.toHaveBeenCalled();
  });
  it("handles a consumed or expired nonce without granting access", async () => {
    action.mockResolvedValue(null);
    expect((await POST(request("POST"))).status).toBe(410); expect(action).toHaveBeenCalledTimes(1);
  });
  it("handles provider outages without claiming a definitive failure", async () => {
    action.mockRejectedValue(new Error("offline"));
    expect((await GET(request())).status).toBe(503);
    const response = await POST(request("POST")); expect(response.status).toBe(503); expect(await response.text()).toContain("Check Telegram first");
  });
});
