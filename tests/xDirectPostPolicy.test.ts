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
    "Done", "Done ✅", "funded", "I funded it", "wallet funded!",
    "funds added", "added ETH", "sent the ETH", "deposited eth",
    "ready now", "all set", "go ahead", "try again", "retry please",
    "continue", "proceed now", "yes", "I'm done", "I’m done", "did it",
    "finished", "good to go", "it's funded",
  ])("accepts %s", text => expect(isResumeReply(text)).toBe(true));

  it.each([
    "resume my launch", "can you resume", "@alice resume", "resume and buy",
    "done with the launch", "ready to launch something else", "send ETH to @alice",
    "I added ETH and want to buy PONSBOT",
  ])("rejects %s", text => expect(isResumeReply(text)).toBe(false));
});
