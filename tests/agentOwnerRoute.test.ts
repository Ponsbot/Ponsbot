import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("convex/browser", () => ({ ConvexHttpClient: class { action = mocks.action; } }));
vi.mock("../lib/wallet-signer/agents", () => ({ agentWalletHoldings: vi.fn() }));
import { GET, POST } from "../app/api/bot-yard/owner/route";
import { createWebWalletSession, readWebWalletSession, WEB_WALLET_SESSION_COOKIE, webWalletCsrfToken } from "../lib/web-wallet-session";
const secret = "test-only-owner-session-secret", base = "https://ponsbot.example";
let cookie: string, csrf: string;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-12T21:00:00Z"));
  for (const flag of ["TRADING_AGENTS_ENABLED", "TRADING_AGENTS_WEBSITE_ENABLED", "TRADING_AGENTS_OWNER_EXECUTION_ENABLED"]) vi.stubEnv(flag, "true");
  vi.stubEnv("WEB_AUTH_SECRET", secret); vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://test.convex.cloud"); vi.stubEnv("NEXT_PUBLIC_SITE_URL", base);
  cookie = createWebWalletSession(`0x${"1".repeat(40)}`, "123", "owner", secret);
  csrf = webWalletCsrfToken(readWebWalletSession(cookie, secret)!.sessionId, secret);
  mocks.action.mockReset(); mocks.action.mockResolvedValue("job123456789");
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${base}/api/bot-yard/owner`, { method: "POST", headers: { origin: base, "content-type": "application/json", cookie: `${WEB_WALLET_SESSION_COOKIE}=${cookie}`, "x-csrf-token": csrf, ...headers }, body: JSON.stringify(body) });
}
const input = { agentId: "agent123456789", requestKey: "request-key-123456789", intent: { kind: "withdraw", amount: "0.01" } };
describe("owner bot website transaction boundary", () => {
  it("rejects unauthenticated access", async () => {
    expect((await GET(new NextRequest(`${base}/api/bot-yard/owner`))).status).toBe(401);
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it("rejects cross-origin requests", async () => {
    expect((await POST(request(input, { origin: "https://attacker.example" }))).status).toBe(403);
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it("rejects missing CSRF proof", async () => {
    expect((await POST(request(input, { "x-csrf-token": "" }))).status).toBe(403);
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it("requires recent authentication for spending", async () => {
    vi.advanceTimersByTime(31 * 60000);
    expect((await POST(request(input))).status).toBe(401);
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it("rejects a browser-supplied owner and destination", async () => {
    expect((await POST(request({ ...input, ownerXUserId: "999", destination: `0x${"2".repeat(40)}` }))).status).toBe(400);
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it("derives ownership from the signed X session", async () => {
    expect((await POST(request(input))).status).toBe(200);
    expect(mocks.action.mock.calls[0][1]).toMatchObject({ ownerXUserId: "123", agentId: input.agentId, requestKey: input.requestKey });
    expect(mocks.action.mock.calls[0][1]).not.toHaveProperty("destination");
  });
  it("makes no transaction calls with the execution switch off", async () => {
    vi.stubEnv("TRADING_AGENTS_OWNER_EXECUTION_ENABLED", "false");
    expect((await POST(request(input))).status).toBe(503);
    expect(mocks.action).not.toHaveBeenCalled();
  });
});
