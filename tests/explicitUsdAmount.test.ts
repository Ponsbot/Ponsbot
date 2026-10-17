import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasDirectUsdAmount, walletAmountUnitsMatchText } from "../lib/explicit-usd-amount";
import { parseWalletCommand, type WalletCommand } from "../convex/walletCommands";
import { parseXWalletIntent } from "../convex/xWalletIntent";
import { openRouter } from "../convex/llm";

vi.mock("../convex/llm", () => ({ openRouter: vi.fn(), isStructuredOutputAvailabilityError: () => false }));
beforeEach(() => vi.mocked(openRouter).mockReset());

describe("hard-coded dollar denomination", () => {
  it.each(["$666", "$666.00", "$000666", "$666."])("recognizes a direct currency prefix: %s", text => {
    expect(hasDirectUsdAmount(text, "666")).toBe(true);
  });
  it.each(["666 $BEE6", "666 BEE6", "$ 666", "666 USD", "666 dollars", "$BEE6 666", "$666BEE6", "$666.1", "https://example.com/$666"])("does not infer USD: %s", text => {
    expect(hasDirectUsdAmount(text, "666")).toBe(false);
  });
  it("normalizes exact decimals without floating-point comparison", () => {
    expect(hasDirectUsdAmount("$.50", "0.500")).toBe(true);
    expect(hasDirectUsdAmount("$9007199254740993", "9007199254740992")).toBe(false);
  });
  it.each(["send", "sell", "burn", "buy"])("preserves %s token quantities", verb => {
    const suffix = verb === "send" ? " to @KhalidAlNumi8" : "";
    expect(parseWalletCommand(`${verb} 666 $BEE6${suffix}`)).toMatchObject({ kind: verb, unit: "token", amount: "666", token: "BEE6" });
    expect(parseWalletCommand(`${verb} $666 of $BEE6${suffix}`)).toMatchObject({ kind: verb, unit: "usd", amount: "666", token: "BEE6" });
  });
  it("preserves the exact incident post", () => {
    expect(parseWalletCommand("@KhalidAlNumi8 @Ponsbotfamily send 666 $BEE6 to @KhalidAlNumi8")).toMatchObject({ kind: "send", unit: "token", amount: "666", token: "BEE6" });
  });
  it.each(["666 USD", "666 dollars", "$ 666"])("rejects unsupported currency wording instead of guessing: %s", value => {
    expect(parseWalletCommand(`send ${value} of $BEE6 to @alice`).kind).toBe("unknown");
  });
  it("blocks wrong units even when an unrelated matching dollar value appears", () => {
    const command: WalletCommand = { kind: "send", amount: "666", unit: "usd", token: "BEE6", recipient: "@alice" };
    expect(walletAmountUnitsMatchText("send 666 $BEE6 to @alice, not $666", command)).toBe(false);
    expect(walletAmountUnitsMatchText("send 666 $BEE6 to @alice", { ...command, unit: "token" })).toBe(true);
  });
  it("rejects malicious/model USD extraction twice and falls back to token quantity", async () => {
    vi.mocked(openRouter).mockResolvedValueOnce('{"kind":"command","operation":"send"}')
      .mockResolvedValue('{"kind":"send","amount":"666","unit":"usd","token":"BEE6","recipient":"@KhalidAlNumi8"}');
    expect(await parseXWalletIntent("@KhalidAlNumi8 @Ponsbotfamily send 666 $BEE6 to @KhalidAlNumi8", false))
      .toMatchObject({ kind: "command", command: { kind: "send", amount: "666", unit: "token", token: "BEE6" } });
  });
  it("does not reinterpret ETH or percentage amounts", () => {
    expect(parseWalletCommand("send 0.01 ETH to @alice")).toMatchObject({ kind: "send", unit: "eth" });
    expect(parseWalletCommand("send all $BEE6 to @alice")).toMatchObject({ kind: "send", unit: "percent" });
    expect(parseWalletCommand("send 0.001 ETH of BEE6 to @alice")).toMatchObject({ kind: "send", unit: "eth", token: "BEE6" });
  });
});
