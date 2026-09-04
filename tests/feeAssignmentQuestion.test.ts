import { describe, expect, it } from "vitest";
import { feeAssignmentMessage, feeQuestionToken, isFeeAssignmentQuestion } from "../lib/fee-assignment-question";

describe("fee assignment questions", () => {
  it("requires who and fee/claim language", () => {
    for (const text of ["who can claim for this coin?", "WHO are fees assinged to?", "who receives fees for $BOLD?"])
      expect(isFeeAssignmentQuestion(text)).toBe(true);
    for (const text of ["claim my fees", "reassign fees to @someone", "who made this?", "fees assigned to BOLD"])
      expect(isFeeAssignmentQuestion(text)).toBe(false);
  });
  it("deduplicates repeated address links regardless of case", () => {
    const address = "0x984904E18C1798848351d193724cACBFF5b20b07";
    expect(feeQuestionToken(`https://www.ponsbot.family/launch/${address} https://www.ponsfamily.com/launchpad/${address.toLowerCase()} who can claim fees on this coin?`)).toBe(address.toLowerCase());
  });
  it("finds tickers and refuses ambiguous identifiers", () => {
    expect(feeQuestionToken("Who can claim fees for $BOLD?")).toBe("BOLD");
    expect(feeQuestionToken("Who can claim for BOLD?")).toBe("BOLD");
    expect(feeQuestionToken("Who can claim for this coin?")).toBeUndefined();
    expect(feeQuestionToken("Who gets fees for $BOLD and $PONS?")).toBeNull();
  });
  it("uses beneficiary usernames without mentions", () => {
    expect(feeAssignmentMessage({ feeRecipientUsername: "@Ponsboyfamily", creatorFeeRecipient: "0xbeneficiary" })).toBe("Fees are assigned to Ponsboyfamily");
    expect(feeAssignmentMessage({ holderFeeSharing: true, feeRecipientUsername: "oldOwner" })).toBe("Fees are assigned to holders");
    expect(feeAssignmentMessage({ creatorFeeRecipient: "0xother", creatorAddress: "0xcreator", launcherUsername: "Creator" })).toBe("Fees are assigned to 0xother");
    expect(feeAssignmentMessage({ creatorFeeRecipient: "0xcreator", creatorAddress: "0xCreator", launcherUsername: "Creator" })).toBe("Fees are assigned to Creator");
  });
});
