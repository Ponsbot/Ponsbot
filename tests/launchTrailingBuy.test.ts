import { expect, it } from "vitest";
import { groundedCanonicalCommand, requestedOperations } from "../convex/xWalletIntent";
it.each(["buy $20", "and buy $20", "and buy $20 please!", "purchase $20", "buy $20 worth", "and buy $20 @Ponsbotfamily"])("accepts trailing %s", suffix => {
 const text = `@Ponsbotfamily launch Ryuroobin ticker RRB ${suffix}`;
 expect(requestedOperations(text)).toEqual(["launch"]);
 expect(groundedCanonicalCommand(text)).toMatchObject({ kind: "launch", name: "Ryuroobin", symbol: "RRB", devBuy: { amount: "20", unit: "usd" } });
});
it("supports explicit ETH and name-only launches", () => {
 const text = "launch Ryuroobin and buy 0.01 ETH";
 expect(requestedOperations(text)).toEqual(["launch"]);
 expect(groundedCanonicalCommand(text)).toMatchObject({ name: "Ryuroobin", symbol: "RYUROOBIN", devBuy: { amount: "0.01", unit: "eth" } });
});
it("does not swallow separate buys, quoted text, or sends", () => {
 for (const suffix of ["buy $20 of PONS", "buy $20 worth of PONS"]) expect(requestedOperations(`launch Ryuroobin ticker RRB and ${suffix}`)).toContain("buy");
 expect(requestedOperations("launch Ryuroobin ticker RRB and buy $20 and send to @alice")).not.toEqual(["launch"]);
 expect(requestedOperations("buy $20")).toEqual(["buy"]);
 expect(requestedOperations('launch Ryuroobin ticker RRB description "and buy $20"')).toEqual(["launch"]);
});
