import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("post-launch holder sharing outcome", () => {
  const source = readFileSync(new URL("../convex/wallets.ts", import.meta.url), "utf8");

  it("never converts a confirmed launch into a holder-sharing failure response", () => {
    expect(source).not.toContain("The token launched, but holder fee sharing was not enabled");
    expect(source).toContain("attemptHolderFeeSharingAfterLaunch");
    expect(source).toContain("recordInitialHolderFeeSharingFailure");
  });

  it("uses the non-throwing holder-sharing attempt in every launch result path", () => {
    expect(source.match(/await attemptHolderFeeSharingAfterLaunch\(/g)).toHaveLength(3);
  });
});
