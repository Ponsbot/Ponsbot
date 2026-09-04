import { expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { retryInteraction } from "../convex/xReplies";
import { grokLaunchFeeRejection, GROK_EXTERNAL_LAUNCH_FEES } from "../lib/launch-recipient-policy";
import { executeCommand } from "../convex/wallets";
import type { WalletCommand } from "../convex/walletCommands";

const wallet = `0x${"1".repeat(40)}`;
const other = `0x${"2".repeat(40)}`;
const launch: WalletCommand = { kind: "launch", launchMode: "pons", name: "Example", symbol: "EXAMPLE" };

it.each(["@someone", other, "@GrokFan"])("blocks Grok assigning fees to %s", recipient => {
  expect(grokLaunchFeeRejection({ ...launch, feeRecipient: recipient }, "GrOk", wallet)).toBe(GROK_EXTERNAL_LAUNCH_FEES);
});

it.each(["@someone", other])("silently rejects the actual X handler for external recipient %s", async recipient => {
  vi.stubEnv("X_REPLIES_ENABLED", "true");
  vi.stubEnv("X_STANDALONE_MENTIONS_ENABLED", "false");
  const updates: any[] = [];
  const actions: string[] = [];
  const mutations: string[] = [];
  const current = {
    user: { username: "grok", xUserId: "trusted-author-id" },
    interaction: { postId: "123", status: "processing", createdAt: Date.now(),
      text: `@Ponsbotfamily launch Example $EXAMPLE assign fees to ${recipient}`,
      parsedIntentJson: JSON.stringify({ kind: "command", command: { ...launch, feeRecipient: recipient } }) },
  };
  const ctx = {
    runQuery: async (ref: any) => {
      const name = getFunctionName(ref);
      if (name === "xReplies:getRetryContext") return current;
      if (name === "wallets:getXUserAndWallet") return { user: current.user, wallet: { address: wallet } };
      return null;
    },
    runMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref); mutations.push(name);
      if (name === "xFloodProtection:guardQueued") return { suppressed: false };
      if (name === "xReplies:updateInteraction") { updates.push(args); return null; }
      if (name === "liquidity:guardThread") return null;
      throw new Error(`Unexpected mutation: ${name}`);
    },
    runAction: async (ref: any) => { actions.push(getFunctionName(ref)); throw new Error("No action permitted"); },
  };
  try {
    await (retryInteraction as any)._handler(ctx, { postId: "123" });
    expect(updates).toContainEqual(expect.objectContaining({ status: "rejected", commandKind: "grok_external_launch_fees_blocked" }));
    expect(updates.every(update => !update.responsePostId)).toBe(true);
    expect(actions).toEqual([]);
    expect(mutations).not.toContain("xReplies:reservePublication");
  } finally { vi.unstubAllEnvs(); }
});
it.each([undefined, "@GROK", wallet])("allows Grok retaining its own fees (%s)", recipient => {
  expect(grokLaunchFeeRejection({ ...launch, feeRecipient: recipient }, "grok", wallet)).toBeUndefined();
});
it("does not apply to other authors, holder sharing or other commands", () => {
  expect(grokLaunchFeeRejection({ ...launch, feeRecipient: "@someone", name: "Grok" }, "someone", wallet)).toBeUndefined();
  expect(grokLaunchFeeRejection({ ...launch, holderFeeSharing: true }, "grok", wallet)).toBeUndefined();
  expect(grokLaunchFeeRejection({ kind: "show_wallet" }, "grok", wallet)).toBeUndefined();
});
it("rejects at the execution boundary before wallet creation, reservation or signing", async () => {
  let mutations = 0;
  let actions = 0;
  const ctx = {
    runQuery: async () => ({ user: { username: "grok" }, wallet: { address: wallet } }),
    runMutation: async () => { mutations++; throw new Error("must not mutate"); },
    runAction: async () => { actions++; throw new Error("must not sign"); },
  };
  const result = await (executeCommand as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<{ok: boolean; message: string}> })._handler(ctx, {
    xUserId: "trusted-author-id", sourcePostId: "123", text: "launch Example $EXAMPLE assign fees to @someone",
    parsedCommandJson: JSON.stringify({ ...launch, feeRecipient: "@someone" }),
  });
  expect(result).toEqual({ ok: false, message: GROK_EXTERNAL_LAUNCH_FEES });
  expect(mutations).toBe(0);
  expect(actions).toBe(0);
});
