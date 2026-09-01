import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { HoudiniPrePaymentError, houdiniSubmissionFailureOutcome, validateHoudiniPaymentResource } from "../lib/houdini-payment-policy";

const requested = new URL("https://api-partner.houdiniswap.com/v2/tokens?term=ETH");
describe("Houdini x402 resource validation", () => {
  it.each([
    requested.href,
    "http://api-partner.houdiniswap.com/v2/tokens?term=ETH",
    "/v2/tokens?term=ETH",
  ])("accepts the trusted resource %s without changing the transport URL", (resource) => {
    validateHoudiniPaymentResource(resource, requested);
    expect(requested.protocol).toBe("https:");
  });
  it("allows an HTTP exchange challenge without permitting a different endpoint", () => {
    validateHoudiniPaymentResource("http://api-partner.houdiniswap.com/v2/exchanges", new URL("https://api-partner.houdiniswap.com/v2/exchanges"));
  });
  it("allows equivalent query ordering", () => {
    validateHoudiniPaymentResource("http://api-partner.houdiniswap.com/v2/tokens?term=ETH&limit=10", new URL("https://api-partner.houdiniswap.com/v2/tokens?limit=10&term=ETH"));
  });
  it.each([
    "https://evil.example/v2/tokens?term=ETH",
    "https://api-partner.houdiniswap.com.evil.example/v2/tokens?term=ETH",
    "http://api-partner.houdiniswap.com:8080/v2/tokens?term=ETH",
    "https://api-partner.houdiniswap.com:80/v2/tokens?term=ETH",
    "https://user:pass@api-partner.houdiniswap.com/v2/tokens?term=ETH",
    "https://api-partner.houdiniswap.com/v2/exchanges?term=ETH",
    "https://api-partner.houdiniswap.com/v2/tokens?term=BTC",
    "https://api-partner.houdiniswap.com/v2/tokens",
    "https://api-partner.houdiniswap.com/v2/tokens?term=ETH#fragment",
    "ftp://api-partner.houdiniswap.com/v2/tokens?term=ETH",
    "https://[", "", undefined,
  ])("rejects mismatched or unsafe terms %s before payment", (resource) => {
    expect(() => validateHoudiniPaymentResource(resource, requested)).toThrow(HoudiniPrePaymentError);
  });
  it("cannot be used to bless an untrusted request", () => {
    expect(() => validateHoudiniPaymentResource("http://evil.example/v2/tokens", new URL("https://evil.example/v2/tokens"))).toThrow(HoudiniPrePaymentError);
  });
  it("distinguishes known rejection from ambiguous POST/signing/receipt errors", () => {
    expect(houdiniSubmissionFailureOutcome(new HoudiniPrePaymentError("rejected"))).toBe("failed");
    for (const error of [new Error("timeout"), new Error("invalid order response"), { code: "houdini_pre_payment_rejected" }])
      expect(houdiniSubmissionFailureOutcome(error)).toBe("uncertain");
  });
  it("validates before reserving/signing, retains payment restrictions and sends only to the original URL", () => {
    const source = readFileSync("lib/houdini-preview-auth.ts", "utf8");
    const validation = source.indexOf("validateHoudiniPaymentResource(required.resource?.url, url)");
    expect(validation).toBeGreaterThan(0);
    expect(validation).toBeLessThan(source.indexOf("const reservation = await reservePayment"));
    expect(validation).toBeLessThan(source.indexOf("httpClient.createPaymentPayload(sanitized)"));
    for (const guard of ['item.scheme === "exact"', "item.network === BASE_NETWORK", "item.asset.toLowerCase() === BASE_USDC", "OPERATION_MAX_ATOMIC[operation]", "item.maxTimeoutSeconds <= 300", "const paid = await fetch(url,"])
      expect(source).toContain(guard);
  });
  it("carries known pre-payment failures only through the authenticated relay", () => {
    const relay = readFileSync("app/api/internal/houdini-x402/route.ts", "utf8");
    expect(relay.indexOf("error instanceof HoudiniPrePaymentError")).toBeGreaterThan(relay.indexOf("await houdiniFetch("));
    const x = readFileSync("convex/xHoudini.ts", "utf8");
    expect(x.indexOf('payload.code === "houdini_pre_payment_rejected"')).toBeGreaterThan(x.indexOf('new URL("/api/internal/houdini-x402"'));
  });
});
