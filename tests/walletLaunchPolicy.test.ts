import { describe, expect, it } from "vitest";
import { walletCanLaunch } from "../lib/wallet-launch-policy";

describe("private wallet launch permission", () => {
  it("defaults existing and new-compatible records to allowed", () => {
    expect(walletCanLaunch(undefined)).toBe(true);
    expect(walletCanLaunch(true)).toBe(true);
  });

  it("blocks only an explicit false value", () => {
    expect(walletCanLaunch(false)).toBe(false);
  });
});
