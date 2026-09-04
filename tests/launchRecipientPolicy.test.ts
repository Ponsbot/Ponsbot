import { expect, it } from "vitest";
import { grokLaunchFeeRejection, GROK_EXTERNAL_LAUNCH_FEES } from "../lib/launch-recipient-policy";
import { executeCommand } from "../convex/wallets";
import type { WalletCommand } from "../convex/walletCommands";

const wallet = `0x${"1".repeat(40)}`;
const other = `0x${"2".repeat(40)}`;
const launch: WalletCommand = { kind: "launch", launchMode: "pons", name: "Example", symbol: "EXAMPLE" };

it.each(["@someone", other, "@GrokFan"])("blocks Grok assigning fees to %s", recipient => {
  expect(grokLaunchFeeRejection({ ...launch, feeRecipient: recipient }, "GrOk", wallet)).toBe(GROK_EXTERNAL_LAUNCH_FEES);
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
