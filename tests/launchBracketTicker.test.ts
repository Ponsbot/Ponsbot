import { expect, it } from "vitest";
import { groundedCanonicalCommand, straightforwardCommandOperation } from "../convex/xWalletIntent";
import { extractGroundedLaunchName } from "../convex/walletCommands";

it.each(["(RRb)", "($RRb)", "[RRb]", "[$RRb]"])("separates bracketed ticker %s from launch name", bracket => {
  for (const prefix of ["launch token Name :", "launch", "launch token named", "launch token called"]) {
    const text = `@Ponsbotfamily @Ponsbotfamily ${prefix} Ryuroobin ${bracket}`;
    expect(groundedCanonicalCommand(text)).toMatchObject({ kind: "launch", name: "Ryuroobin", symbol: "RRB" });
    expect(extractGroundedLaunchName(text)).toBe("Ryuroobin");
  }
});
it("preserves literal quoted names and does not treat lunch as launch", () => {
  expect(groundedCanonicalCommand('launch "Ryuroobin (Original)" ticker RRB')).toMatchObject({ name: "Ryuroobin (Original)", symbol: "RRB" });
  expect(straightforwardCommandOperation("@Ponsbotfamily lunch token Name : Ryuroobin (RRb)")).toBeNull();
});
