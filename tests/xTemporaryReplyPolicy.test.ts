import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryXReplySuppressionReason as reason, isInsufficientEthReply } from "../lib/x-temporary-reply-policy";

afterEach(() => vi.unstubAllEnvs());
describe("temporary X response suppression", () => {
  it.each([
    ["🔒 Token launches are currently available to verified X accounts. Once verified, you'll be ready to launch!", "launch_x_restriction"],
    ["Token launches are only available through X posts.", "launch_x_restriction"],
    ["🤔 I couldn't quite make that out. Try “show my wallet.”", "ai_ambiguity"],
    ["❌ This request did not complete. Check the earlier reply or try a new post.", "request_not_completed"],
  ])("suppresses the selected preset: %s", (message, expected) => {
    expect(reason(message, true)).toBe(expected);
    expect(reason(message, false)).toBeUndefined();
  });
  it.each([
    "✅ Success! Launched Not Enough ETH (NEE) on Pons V2!",
    "🚀 Verified X accounts can launch on Pons V2! Tell me a name and ticker.",
    "💰 Ask for your wallet and send ETH. Keep enough ETH available for gas!",
    "👛 Your Pons Bot wallet is ready!\nYour wallet: https://www.ponsbot.family/wallet/0x123",
    "✅ This request was already completed!\nYour TXN: https://explorer.test/tx/123",
    "⚠️ More than one indexed token uses that ticker. Send me a new command with the contract address.",
    "❌ I couldn't complete that wallet request. Check the details and give it another try!",
    "❌ You don't have enough of this token's paired asset yet.",
  ])("preserves unrelated replies: %s", message => expect(reason(message, true)).toBeUndefined());
  it("uses an explicit reversible environment switch", () => {
    vi.stubEnv("X_SUPPRESS_ROUTINE_FAILURE_REPLIES", "false");
    expect(reason("This request did not complete.")).toBeUndefined();
    vi.stubEnv("X_SUPPRESS_ROUTINE_FAILURE_REPLIES", "true");
    expect(reason("This request did not complete.")).toBe("request_not_completed");
  });
  it.each([
    "⛽ There isn't enough ETH in your wallet to cover the launch and network gas.\nYour wallet: https://www.ponsbot.family/wallet/0x123",
    "❌ There isn't enough ETH for the transfer plus gas.",
    "⛽ This wallet needs a little more ETH for gas.",
    "There isn’t enough ETH in your wallet for that developer buy.",
    "❌ You don't have enough ETH for this swap.",
  ])("routes insufficient ETH to a budget, not blanket suppression: %s", message => {
    expect(isInsufficientEthReply(message)).toBe(true);
    expect(reason(message, true)).toBeUndefined();
  });
  it.each([
    "✅ Success! Launched Not Enough ETH (NEE) on Pons V2!",
    "❌ You don't have enough of this token's paired asset yet.",
    "The MSFT purchase completed, but the final launch did not. There isn't enough ETH.",
  ])("doesn't throttle unrelated outcomes as ETH failures: %s", message => expect(isInsufficientEthReply(message)).toBe(false));
});
