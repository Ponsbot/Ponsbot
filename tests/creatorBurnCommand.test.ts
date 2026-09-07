import { describe, it, expect } from "vitest";
import {
  parseWalletCommand,
  normalizeLaunchFeeOptions,
} from "../convex/walletCommands";
import { launchCreatorBurnOption } from "../lib/creator-burn-command";
import { parseXWalletIntent } from "../convex/xWalletIntent";
describe("creator self-burn commands", () => {
  it("routes an X percentage command as configuration rather than a wallet purchase", async () => {
    expect(
      await parseXWalletIntent(
        "@Ponsbotfamily Reassign 50% of $PONSBOT fees to buyback and burn",
        false,
      ),
    ).toMatchObject({
      kind: "command",
      command: { kind: "reassign_fees", selfBurnBps: 5000 },
    });
  });
  it.each([
    "Reassign 50% of $PONSBOT fees to buyback and burn",
    "@Ponsbotfamily assign 50% of fees for PONSBOT to buy back and burn!",
    "Set 50% self-burn for PONSBOT.",
  ])("parses explicit percentage: %s", (text) =>
    expect(parseWalletCommand(text)).toMatchObject({
      kind: "reassign_fees",
      token: "PONSBOT",
      recipient: "self",
      selfBurnBps: 5000,
    }),
  );
  it.each(["0", "100", "50.25"])("supports %s percent", (n) =>
    expect(
      parseWalletCommand(`Assign ${n}% of $ABC fees to buyback and burn`),
    ).toMatchObject({ selfBurnBps: Number(n) * 100 }),
  );
  it.each(["101", "1.234"])("rejects %s", (n) =>
    expect(
      parseWalletCommand(`Assign ${n}% of $ABC fees to buyback and burn`).kind,
    ).toBe("unknown"),
  );
  it("does not turn ordinary fee reassignment into a burn", () =>
    expect(parseWalletCommand("Reassign $ABC fees to @person")).toEqual({
      kind: "reassign_fees",
      token: "ABC",
      recipient: "@person",
    }));
  it("does not treat questions as percentage commands", () =>
    expect(
      parseWalletCommand("Can I assign 50% of $ABC fees to buyback and burn?"),
    ).not.toMatchObject({ recipient: "self" }));
  it("keeps a launch fee option out of its name, ticker and dev buy", () =>
    expect(
      parseWalletCommand(
        "@Ponsbotfamily launch Test $TEST assign 50% of fees to buyback and burn",
      ),
    ).toMatchObject({
      kind: "launch",
      name: "Test",
      symbol: "TEST",
      selfBurnBps: 5000,
    }));
  it("still accepts a separate dev buy", () =>
    expect(
      parseWalletCommand(
        "@Ponsbotfamily launch Test $TEST assign 50% of fees to buyback and burn buy $20",
      ),
    ).toMatchObject({
      kind: "launch",
      selfBurnBps: 5000,
      devBuy: { amount: "20", unit: "usd" },
    }));
  it("rejects conflicting holder sharing", () =>
    expect(
      parseWalletCommand(
        "launch Test $TEST assign 50% of fees to buyback and burn share with holders",
      ).kind,
    ).toBe("unknown"));
  it("rejects another recipient alongside self burn", () =>
    expect(
      parseWalletCommand(
        "launch Test $TEST assign 50% of fees to buyback and burn assign fees to @person",
      ).kind,
    ).toBe("unknown"));
  it("does not trust an invented AI percentage", () =>
    expect(
      normalizeLaunchFeeOptions(
        {
          kind: "launch",
          launchMode: "pons",
          name: "Test",
          symbol: "TEST",
          selfBurnBps: 10000,
        },
        "launch Test $TEST",
      ),
    ).toMatchObject({ selfBurnBps: undefined }));
  it("rejects multiple percentage clauses", () =>
    expect(() =>
      launchCreatorBurnOption(
        "assign 50% of fees to buyback and burn assign 60% of fees to buyback and burn",
      ),
    ).toThrow());
});
