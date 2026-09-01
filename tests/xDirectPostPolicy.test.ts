import { describe, expect, it } from "vitest";
import { directPostCommandText, isResumeReply } from "../lib/x-direct-post-policy";

describe("direct X post command text", () => {
  it("removes automatically prepended reply-chain participants", () => {
    expect(directPostCommandText("@Ponsbotfamily @Ponsboyfamily what's my wallet?"))
      .toBe("what's my wallet?");
  });

  it("preserves recipient handles inside the direct command", () => {
    expect(directPostCommandText("@Ponsbotfamily send 5 PONSBOT to @alice"))
      .toBe("send 5 PONSBOT to @alice");
    expect(directPostCommandText("@Ponsbotfamily send 5 PONSBOT to @Ponsbotfamily"))
      .toBe("send 5 PONSBOT to @Ponsbotfamily");
  });

  it("does not strip unrelated direct prose or inspect parent content", () => {
    expect(directPostCommandText("Hey @Ponsbotfamily, show my wallet"))
      .toBe("Hey @Ponsbotfamily, show my wallet");
    expect(directPostCommandText("@alice send 5 PONSBOT to @bob"))
      .toBe("@alice send 5 PONSBOT to @bob");
  });
});

describe("X resume reply normalization", () => {
  it.each([
    "resume", "Resume!", "please resume.", "@Ponsbotfamily resume",
    "@Ponsbotfamily @Ponsboyfamily, please resume!",
  ])("accepts %s", text => expect(isResumeReply(text)).toBe(true));

  it.each([
    "resume my launch", "can you resume", "@alice resume", "resume and buy",
  ])("rejects %s", text => expect(isResumeReply(text)).toBe(false));
});
