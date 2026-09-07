import { describe, expect, it } from "vitest";
import { launchFeeOptionsFromText, parseWalletCommand, normalizeLaunchFeeOptions } from "../convex/walletCommands";
import { groundedCanonicalCommand, parameterExtractorPrompt } from "../convex/xWalletIntent";

describe("assign fees to holders at launch", () => {
  it("accepts the exact Japanese launch and preserves its dev buy", () => {
    const text = "@ponsbotfamily launch パペットスンスン $スンスン assign fees to holders buy $5";
    for (const command of [parseWalletCommand(text), groundedCanonicalCommand(text)]) {
      expect(command).toMatchObject({ kind: "launch", name: "パペットスンスン", symbol: "スンスン",
        holderFeeSharing: true, devBuy: { amount: "5", unit: "usd" } });
      expect(command && "feeRecipient" in command ? command.feeRecipient : undefined).toBeUndefined();
    }
  });
  it.each(["assign fees to holders", "ASSIGN FEES TO HOLDERS!", "assign  fees\n to holders"])("accepts casing and whitespace: %s", phrase => {
    expect(launchFeeOptionsFromText(`launch Cat $CAT ${phrase}`)).toEqual({ holderFeeSharing: true });
  });
  it("does not treat quoted metadata or a longer word as an instruction", () => {
    expect(launchFeeOptionsFromText('launch Cat $CAT description "assign fees to holders"')).toEqual({});
    expect(launchFeeOptionsFromText("launch Cat $CAT assign fees to holdersXYZ")).toEqual({});
  });
  it("still rejects simultaneous wallet and holder assignments", () => {
    expect(() => launchFeeOptionsFromText("assign fees to @alice assign fees to holders")).toThrow("Choose only one fee setting");
  });
  it("grounds AI extraction in the same phrase", () => {
    expect(normalizeLaunchFeeOptions({ kind: "launch", launchMode: "pons", name: "Cat", symbol: "CAT" },
      "launch Cat $CAT assign fees to holders")).toMatchObject({ holderFeeSharing: true });
    expect(parameterExtractorPrompt("launch", false)).toContain('"assign fees to holders"');
  });
});
