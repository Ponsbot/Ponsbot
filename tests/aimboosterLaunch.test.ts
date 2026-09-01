import { describe, expect, it } from "vitest";
import { groundedCanonicalCommand } from "../convex/xWalletIntent";

export const aimboosterPost = "@Ponsbotfamily hey @Ponsbotfamily launch token name aimbooster ticker is booster. this token create for boosting every project with aim to get 100% boost. use assign fees to @mengdelet";
describe("AIMBOOSTER launch investigation", () => {
  it("retains the explicitly requested launch and fee recipient", () => {
    expect(groundedCanonicalCommand(aimboosterPost)).toMatchObject({ kind: "launch", name: "aimbooster", symbol: "BOOSTER", feeRecipient: "@mengdelet" });
  });
});
