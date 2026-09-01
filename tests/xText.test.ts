import { describe, expect, it } from "vitest";
import { fitXReply, xWeightedLength } from "../convex/xText";

describe("X reply length handling", () => {
  it("counts rendered usernames, tickers, numbers and emoji", () => {
    const text = `✅ Sent 123456789.123456789 VERYLONGTICKER to @fifteen_char_usr!`;
    expect(xWeightedLength(text)).toBe(text.length);
  });

  it("uses X's fixed URL weight", () => {
    expect(xWeightedLength("Your TXN: https://example.com/a/very/long/transaction/hash")).toBe("Your TXN: ".length + 23);
  });

  it("shortens dynamic copy but preserves explorer links", () => {
    const token = "Your token: https://robinhoodchain.blockscout.com/address/0x1111111111111111111111111111111111111111";
    const txn = "Your TXN: https://robinhoodchain.blockscout.com/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = fitXReply(`✅ Success! Launched ${"Very Long Token Name ".repeat(20)} (VERYLONGTICKER)!\n${token}\n${txn}`);
    expect(xWeightedLength(result)).toBeLessThanOrEqual(280);
    expect(result).toContain(token);
    expect(result).toContain(txn);
  });
});
