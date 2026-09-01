import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { redactSignerDiagnostic } from "../lib/signer-diagnostics";

describe("signer diagnostic redaction", () => {
  it("redacts credentials and signed payloads while preserving useful messages", () => {
    const result = redactSignerDiagnostic(`insufficient gas https://rpc.example/v2/my-secret Bearer short-secret api_key=tiny 0x${"ab".repeat(100)}`);
    expect(result).toContain("insufficient gas");
    for (const secret of ["my-secret", "short-secret", "tiny", "ab".repeat(100)]) expect(result).not.toContain(secret);
  });
  it("bounds details", () => { expect(redactSignerDiagnostic("gas ".repeat(300), 240)).toHaveLength(240); });
  it("does not log raw errors, causes, stacks or validation issues", () => {
    const source = readFileSync(new URL("../app/api/wallet-signer/[...path]/route.ts", import.meta.url), "utf8");
    expect(source).not.toContain('console.error("wallet_signer_zod_error", error.issues)');
    const log = source.slice(source.indexOf('console.error("wallet_signer_failed"'), source.indexOf("const safe ="));
    expect(log).toContain("diagnosticDetail");
    expect(log).not.toMatch(/\b(?:message|stack|cause|name)\s*[:,]/);
  });
});
