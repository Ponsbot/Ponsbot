import { describe, expect, it } from "vitest";
import { houdiniFailureDiagnostic, houdiniResponseDiagnostic } from "../lib/houdini-diagnostics";

describe("private Houdini rejection diagnostics", () => {
  it.each([
    ["Amount below minimum", "amount_below_minimum"], ["Amount exceeds maximum", "amount_above_maximum"],
    ["No available route", "route_unavailable"], ["Unsupported chain", "unsupported_asset_or_chain"],
    ["Quote expired", "quote_expired"], ["Invalid destination address", "destination_validation"],
    ["Required field missing", "request_validation"],
  ])("classifies %s without keeping raw provider text", (message, category) => {
    expect(houdiniFailureDiagnostic(422, { message })).toBe(`HTTP 422; ${category}`);
  });
  it("keeps validation field names but never echoes addresses, values, credentials, URLs or unknown fields", () => {
    const result = houdiniFailureDiagnostic(422, { detail: [{ loc: ["body", "amount", "secret-name"], msg: "minimum amount 0x1234 https://secret.example?key=123 user:password", input: "sensitive" }], authorization: "Bearer SECRET" });
    expect(result).toBe("HTTP 422; amount_below_minimum; fields=amount");
  });
  it("does not consume the response needed by the normal workflow", async () => {
    const payload = { message: "Route not available" };
    const response = Response.json(payload, { status: 422 });
    expect(await houdiniResponseDiagnostic(response)).toBe("HTTP 422; route_unavailable");
    expect(await response.json()).toEqual(payload);
  });
  it("bounds oversized and non-JSON diagnostics", async () => {
    expect(await houdiniResponseDiagnostic(new Response("x".repeat(20_000), { status: 422 }))).toBe("HTTP 422; provider_rejection");
    expect(await houdiniResponseDiagnostic(new Response("Invalid parameter", { status: 422 }))).toBe("HTTP 422; request_validation");
  });
});
