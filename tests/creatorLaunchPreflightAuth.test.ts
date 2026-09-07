import { createHash, createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { verifyCreatorFeeLaunchSetup, safeFailure } from "../convex/wallets";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("authenticates the launch preflight using the exact proof required by the signer", async () => {
  vi.stubEnv("WALLET_SIGNER_URL", "https://signer.test");
  vi.stubEnv("WALLET_SIGNER_TOKEN", "test-bearer");
  vi.stubEnv("AUTOMATED_FEE_ENROLLMENT_SECRET", "test-enrollment-secret");
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://signer.test/v1/creator-burn/new-launch-preflight");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-bearer");
    const timestamp = headers.get("x-automated-fee-timestamp");
    expect(timestamp).toMatch(/^\d{13}$/);
    const digest = createHash("sha256").update(String(init.body)).digest("hex");
    const proof = createHmac("sha256", "test-enrollment-secret")
      .update(`${timestamp}:v1/creator-burn/new-launch-preflight::${digest}`).digest("hex");
    expect(headers.get("x-automated-fee-proof")).toBe(proof);
    return new Response(JSON.stringify({ ready: true }));
  });
  vi.stubGlobal("fetch", fetchMock);
  await expect(verifyCreatorFeeLaunchSetup()).resolves.toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("retains the underlying private failure and keeps the public launch rejection safe", async () => {
  vi.stubEnv("WALLET_SIGNER_URL", "https://signer.test");
  vi.stubEnv("WALLET_SIGNER_TOKEN", "test-bearer");
  vi.stubEnv("AUTOMATED_FEE_ENROLLMENT_SECRET", "test-enrollment-secret");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    error: "wallet signer request failed", diagnosticDetail: "CREATOR_BURN_SERVICE_UNFUNDED",
  }), { status: 400 })));
  const error = await verifyCreatorFeeLaunchSetup().catch(error => error);
  expect(error.message).toContain("CREATOR_BURN_SERVICE_UNFUNDED");
  expect(safeFailure(error)).toBe("⚠️ I couldn't verify the requested creator-fee setup. No token was launched.");
});
