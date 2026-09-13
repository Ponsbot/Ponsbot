import { describe, expect, it } from "vitest";
import { botNameKey, formatBotStatus, parseCheckBotPost } from "../lib/trading-agents/status";

describe("bot identity and status", () => {
  it("normalizes case, whitespace and compatibility characters", () => {
    expect(botNameKey(" ＭＯＳＳ ")).toBe("moss");
    expect(botNameKey("Captain   Moss")).toBe("captain moss");
  });
  it.each(["@ponsbotfamily check on Moss", "@Ponsbotfamily CHECK ON moss!", '@ponsbotfamily check on "Moss"?', "@ponsbotfamily check on “Moss”."])("recognizes %s", text => {
    expect(parseCheckBotPost(text)).toBe("moss");
  });
  it("does not capture unrelated wallet commands", () => {
    expect(parseCheckBotPost("@ponsbotfamily check my wallet")).toBeNull();
    expect(parseCheckBotPost("someone said @ponsbotfamily check on Moss")).toBeNull();
  });
  it("handles multiword names", () => expect(parseCheckBotPost("@ponsbotfamily check on Captain Moss")).toBe("captain moss"));
  it("renders holdings with their correct decimals and no invented history", () => {
    const text = formatBotStatus({ name: "Moss", cashWei: "100000000000000000", updatedAt: 0,
      holdings: [{ token: `0x${"1".repeat(40)}`, symbol: "TEST", decimals: 6, amount: "1250000" }] });
    expect(text).toContain("0.1 ETH"); expect(text).toContain("1.25 TEST");
    expect(text).toContain("No thoughts yet."); expect(text).toContain("No completed trades yet."); expect(text).toContain("paper trading");
  });
  it("does not turn personality output into tags or invent token decimals", () => {
    const text = formatBotStatus({ name: "Moss", cashWei: "0", updatedAt: 0, holdings: [], thought: { text: "@victim #tag $TEST", at: 0 },
      trade: { side: "sell", asset: { token: `0x${"1".repeat(40)}`, amount: "123" }, reason: "Taking a break", at: 0 } });
    expect(text).not.toMatch(/[@#$]/); expect(text).toContain("123 base units"); expect(text).toContain("Paper sold");
  });
  it("shows dollar balances and signed combined 24h PNL at the bottom without timestamps", () => {
    const text = formatBotStatus({ name: "Moss", mode: "live", cashWei: "100000000000000000", cashUsd: 250,
      updatedAt: 1700000000000, dayPnlUsd: -10.2844,
      holdings: [{ token: `0x${"1".repeat(40)}`, symbol: "TEST", decimals: 6, amount: "1250000", usdValue: 3.125 }],
      thought: { text: "A new idea", at: 1700000000000 },
      trade: { side: "sell", asset: { token: `0x${"1".repeat(40)}`, symbol: "TEST", decimals: 6, amount: "250000" }, reason: "Reducing concentration", at: 1700000000000 } });
    expect(text).toContain("0.1 ETH ($250.00)");
    expect(text).toContain("1.25 TEST ($3.13)");
    expect(text).toContain("sold 0.25 TEST");
    expect(text).not.toMatch(/UTC|2023-|checked /);
    expect(text.endsWith("24h P&L: -$10.28")).toBe(true);
  });
  it("does not turn missing or invalid prices and PNL into zero", () => {
    const text = formatBotStatus({ name: "Moss", cashWei: "0", updatedAt: 0, cashUsd: NaN, dayPnlUsd: null,
      holdings: [{ token: `0x${"1".repeat(40)}`, symbol: "TEST", decimals: 6, amount: "1250000", usdValue: Infinity }] });
    expect(text).not.toMatch(/NaN|Infinity|\$0\.00/);
    expect(text.endsWith("24h P&L: Unavailable")).toBe(true);
    expect(formatBotStatus({name:"Moss",cashWei:"0",updatedAt:0,holdings:[],dayPnlUsd:0})).toContain("24h P&L: $0.00");
  });
});
