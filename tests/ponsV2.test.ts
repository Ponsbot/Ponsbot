import { describe, expect, it } from "vitest";
import { formatPonsPairReply, parsePairCandidates } from "../convex/ponsV2";

describe("Pons V2 pair discovery", () => {
  it("accepts only candidate addresses", () => {
    expect(parsePairCandidates("ETH, nope, 0x1111111111111111111111111111111111111111")).toEqual([
      "0x1111111111111111111111111111111111111111",
    ]);
  });

  it("keeps the dynamic pair reply within X's limit", () => {
    const reply = formatPonsPairReply([{ address: "0x0000000000000000000000000000000000000000", symbol: "ETH", name: "Ether", decimals: 18, native: true, verifiedAt: 1 }]);
    expect(reply).toContain("ETH");
    expect(reply.length).toBeLessThanOrEqual(280);
  });
});
