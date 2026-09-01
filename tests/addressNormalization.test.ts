import { describe, expect, it } from "vitest";
import { addNormalizedAddressMatch, isAddressLiteral, normalizedRpcAddress } from "../lib/address-normalization";

describe("RPC address normalization", () => {
  it("lowercases a valid but incorrectly checksummed mixed-case address", () => {
    const supplied = "0x75074C8ca03CC2afB855A4DAbCa33f15031B9B07";
    expect(isAddressLiteral(supplied)).toBe(true);
    expect(normalizedRpcAddress(supplied)).toBe("0x75074c8ca03cc2afb855a4dabca33f15031b9b07");
  });

  it("does not transform malformed input into an address", () => {
    expect(isAddressLiteral("0x1234")).toBe(false);
    expect(normalizedRpcAddress("$PDOG")).toBe("$PDOG");
  });

  it("deduplicates the same address received with different casing", () => {
    const matches = new Set<string>();
    addNormalizedAddressMatch(matches, "0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07");
    addNormalizedAddressMatch(matches, "0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07");
    expect(matches).toEqual(new Set(["0xb1e9b822b81bbbdab375f7f4d86e44fa04d12b07"]));
  });
});
