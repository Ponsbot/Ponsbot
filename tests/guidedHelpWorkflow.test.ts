import { describe, expect, it } from "vitest";
import {
  GENERAL_GUIDED_HELP_MESSAGE,
  X_GENERAL_GUIDED_HELP_MESSAGE,
  GUIDED_HELP_COMPLETION_PROMPT,
  guidedHelpCancelled,
  guidedHelpClaimLpOfferSelection,
  guidedHelpClaimSelection,
  guidedHelpCommandKind,
  guidedHelpCommandText,
  guidedHelpImmediateCommand,
  guidedHelpPendingCommandKind,
  isGuidedHelpCompletion,
  isGuidedHelpPendingCommandKind,
  guidedHelpOperationFromCommandKind,
  guidedHelpOperationFromHelp,
  guidedHelpOperationFromPrompt,
  guidedHelpPrivacySelection,
  guidedHelpPrompt,
  guidedHelpQuestion,
  guidedHelpQuestionResponse,
  decodeGuidedReassignState,
  guidedReassignRecipientSelection,
  guidedReassignTokenSelection,
  GUIDED_REASSIGN_TOKEN_PROMPT,
  guidedHelpSelection,
  CLAIM_LP_FEE_OFFER,
  withClaimLpFeeOffer,
  withGuidedHelpCompletion,
} from "../lib/guided-help-workflow";
import { walletHelpMessage } from "../convex/xWalletIntent";
import { replyQueuePriority } from "../lib/x-reply-queue-policy";

describe("guided general help", () => {
  it("uses the requested invitation and stays within X's ordinary reply size", () => {
    expect(walletHelpMessage("capabilities")).toBe(GENERAL_GUIDED_HELP_MESSAGE);
    expect(GENERAL_GUIDED_HELP_MESSAGE).toContain("Reply telling me what you would like to do!");
    expect(GENERAL_GUIDED_HELP_MESSAGE).not.toContain("reassign creator fees");
    expect(GENERAL_GUIDED_HELP_MESSAGE.length).toBeLessThanOrEqual(280);
    expect(X_GENERAL_GUIDED_HELP_MESSAGE).toContain("launch on Pons");
    expect(X_GENERAL_GUIDED_HELP_MESSAGE).toContain("reassign creator fees");
    expect(X_GENERAL_GUIDED_HELP_MESSAGE.length).toBeLessThanOrEqual(280);
  });

  it("answers pairing questions with both meaning and supported assets", () => {
    expect(walletHelpMessage("pairs")).toContain("asset used for trades");
    expect(walletHelpMessage("pairs")).toContain("ETH");
  });

  it.each([
    ["buy", "buy"], ["purchase", "buy"], ["sell", "sell"], ["swap", "swap"],
    ["send", "send"], ["transfer", "send"], ["burn", "burn"], ["claim", "claim"],
    ["cross-chain", "cross_chain"], ["I want a cross-chain swap", "cross_chain"],
    ["private", "private_swap"], ["I would like a private swap", "private_swap"],
    ["reassign fees", "reassign_fees"], ["I want to reassign fees", "reassign_fees"],
    ["wallet", "wallet"], ["wallet balance", "balance"],
  ] as const)("selects %s as %s", (text, operation) => {
    expect(guidedHelpSelection(text)).toBe(operation);
    const prompt = guidedHelpPrompt(operation);
    expect(guidedHelpOperationFromPrompt(prompt)).toBe(operation);
    expect(replyQueuePriority(prompt, guidedHelpCommandKind(operation), true)).toBe("B");
  });

  it("does not intercept complete commands as menu selections", () => {
    for (const text of ["buy $5 of PONSBOT", "sell all PONS", "send 10 PONS to @user", "burn 5 PONS"])
      expect(guidedHelpSelection(text)).toBeNull();
  });

  it("grounds a follow-up in only the operation selected by that user", () => {
    expect(guidedHelpCommandText("$5 of PONSBOT", "buy")).toBe("buy $5 of PONSBOT");
    expect(guidedHelpCommandText("all PONS", "sell")).toBe("sell all PONS");
    expect(guidedHelpCommandText("10 PONS to @user", "send")).toBe("send 10 PONS to @user");
    expect(guidedHelpCommandText("PONSBOT", "claim_fees")).toBe("claim my fees for PONSBOT");
    expect(guidedHelpCommandText("everything", "claim_fees")).toBe("claim my fees");
    expect(guidedHelpCommandText("$25 to 0x1111111111111111111111111111111111111111 as ETH on Base", "cross_chain"))
      .toBe("send $25 to 0x1111111111111111111111111111111111111111 as ETH on Base");
    expect(guidedHelpCommandText("$25 to 0x1111111111111111111111111111111111111111 as ETH on Base", "private_swap"))
      .toBe("private send $25 to 0x1111111111111111111111111111111111111111 as ETH on Base");
    expect(guidedHelpCommandText("$PONS fees to @alice", "reassign_fees")).toBe("reassign $PONS fees to @alice");
    expect(guidedHelpCommandText("sell 10 PONS", "buy")).toBe("sell 10 PONS");
  });

  it("executes wallet and balance selections immediately", () => {
    expect(guidedHelpImmediateCommand("wallet")).toBe("show my wallet");
    expect(guidedHelpImmediateCommand("balance")).toBe("show all my wallet holdings");
    expect(guidedHelpImmediateCommand("buy")).toBeNull();
    expect(guidedHelpCommandText("everything", "balance")).toBe("show all my wallet holdings");
    expect(guidedHelpCommandText("PONSBOT", "balance")).toBe("what is my PONSBOT balance");
  });

  it("answers questions without losing the active guided step", () => {
    expect(guidedHelpQuestion("What does that mean?")).toBe(true);
    expect(guidedHelpQuestion("$5 of PONSBOT")).toBe(false);
    const response = guidedHelpQuestionResponse("buy");
    expect(response).toContain("What would you like to buy?");
    expect(guidedHelpOperationFromPrompt(response)).toBe("buy");
  });

  it("recognizes help questions and explicit cancellation", () => {
    expect(guidedHelpOperationFromHelp("how do I buy?", "buy_sell")).toBeNull();
    expect(guidedHelpOperationFromHelp("how can I check holdings?", "balance")).toBeNull();
    expect(guidedHelpOperationFromHelp("I want to reassign creator fees", "fees")).toBe("reassign_fees");
    expect(guidedHelpClaimSelection("creator fees")).toBe("creator");
    expect(guidedHelpClaimSelection("LP fees")).toBe("lp");
    expect(guidedHelpPrivacySelection("make it private")).toBe("private");
    expect(guidedHelpPrivacySelection("no")).toBe("public");
    expect(guidedHelpCancelled("never mind")).toBe(true);
    expect(guidedHelpOperationFromCommandKind("guided_help:buy")).toBe("buy");
    expect(guidedHelpOperationFromCommandKind("buy")).toBeNull();
  });

  it("accepts polite punctuated controls without treating questions as actions", () => {
    expect(guidedHelpSelection("Please buy, thanks!")).toBe("buy");
    expect(guidedHelpClaimSelection("claim my creator fees, please.")).toBe("creator");
    expect(guidedHelpPrivacySelection("Yes please!")).toBe("private");
    expect(guidedHelpQuestion("How do I buy?")).toBe(true);
    expect(guidedHelpOperationFromHelp("Which assets can I pair with?", "pairs")).toBeNull();
  });

  it("collects reassign token and recipient in separate owner-bound steps", () => {
    expect(guidedHelpOperationFromPrompt(GUIDED_REASSIGN_TOKEN_PROMPT)).toBe("reassign_fees");
    expect(guidedReassignTokenSelection("$PONSBOT, please")).toBe("PONSBOT");
    expect(guidedReassignRecipientSelection("Reassign fees to alice, please")).toBe("@alice");
    expect(guidedReassignRecipientSelection("Reassign fees to holders.")).toBe("holders");
    expect(decodeGuidedReassignState(JSON.stringify({ version: 1, type: "reassign_fees", token: "PONSBOT" })))
      .toMatchObject({ token: "PONSBOT" });
  });

  it("turns a no-creator-fees result into an owner-bound LP-fee continuation", () => {
    const message = withClaimLpFeeOffer("ℹ️ There aren't any creator fees available to claim right now.");
    expect(message).toContain(CLAIM_LP_FEE_OFFER);
    expect(guidedHelpOperationFromPrompt(message)).toBe("claim_lp_offer");
    expect(guidedHelpOperationFromCommandKind("guided_help:claim_lp_offer")).toBe("claim_lp_offer");
    expect(guidedHelpClaimLpOfferSelection("yes")).toBe("lp");
    expect(guidedHelpClaimLpOfferSelection("claim LP fees")).toBe("lp");
    expect(guidedHelpClaimLpOfferSelection("no thanks")).toBe("cancel");
  });

  it("turns a successful chain completion into a fresh guided-help root", () => {
    const message = withGuidedHelpCompletion("✅ Bought 10 PONSBOT.");
    expect(message).toBe(`✅ Bought 10 PONSBOT.\n\n${GUIDED_HELP_COMPLETION_PROMPT}`);
    expect(withGuidedHelpCompletion(message)).toBe(message);
    expect(isGuidedHelpCompletion(message)).toBe(true);
    expect(guidedHelpOperationFromCommandKind(guidedHelpCommandKind("root"))).toBe("root");
  });

  it("keeps an asynchronous guided action closed until its success is published", () => {
    const kind = guidedHelpPendingCommandKind("houdini");
    expect(isGuidedHelpPendingCommandKind(kind)).toBe(true);
    expect(guidedHelpOperationFromCommandKind(kind)).toBeNull();
  });

  it("formats the expanded pair list without triggering X's multi-cashtag rejection", () => {
    const message = walletHelpMessage("pairs");
    expect(message).toContain("NVDA  •  SPCX");
    expect(message).toContain("cbBTC  •  USDG  •  ETH");
    expect(message.match(/\$[A-Za-z]/g)).toBeNull();
    expect(message).toContain("\n\n");
  });
});
