import { describe, expect, it } from "vitest";
import { isWalletFeatureQuestion, shouldSuppressXResponse } from "../convex/xReplyPolicy";

describe("X reply suppression", () => {
  it("suppresses either requested spelling and casing", () => {
    expect(shouldSuppressXResponse("do not reply")).toBe(true);
    expect(shouldSuppressXResponse("(do not reply)")).toBe(true);
    expect(shouldSuppressXResponse("Please DO NOT REPLY to this." )).toBe(true);
  });

  it("routes mechanics questions to information without authorizing actions", () => {
    expect(isWalletFeatureQuestion("@Ponsbot how does the wallet work?")).toBe(true);
    expect(isWalletFeatureQuestion("explain how token launches and dev buys work")).toBe(true);
    expect(isWalletFeatureQuestion("what commands can I use for the wallet?" )).toBe(true);
    expect(isWalletFeatureQuestion("what is my wallet?")).toBe(false);
    expect(isWalletFeatureQuestion("show my wallet address")).toBe(false);
    expect(isWalletFeatureQuestion("send 0.02 eth to 0x1111111111111111111111111111111111111111")).toBe(false);
  });

  it("does not suppress similar ordinary text", () => {
    expect(shouldSuppressXResponse("do reply when ready")).toBe(false);
    expect(shouldSuppressXResponse("do not send tokens")).toBe(false);
  });
});
