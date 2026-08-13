import { describe, expect, it } from "vitest";
import { isTerminalCommand, validateStructuredWalletCommand } from "../convex/walletCommands";
import { createWebWalletSession, readWebWalletSession, WEB_WALLET_SESSION_SECONDS } from "../lib/web-wallet-session";

describe("terminal security boundaries", () => {
  it("allows only the intended terminal operations", () => {
    for (const kind of ["show_wallet", "show_balance", "buy", "buy_and_burn", "sell", "send", "burn"] as const) {
      const examples = {
        show_wallet: { kind }, show_balance: { kind },
        buy: { kind, amount: "10", unit: "usd", token: "PONSBOT", slippageBps: 250 },
        buy_and_burn: { kind, amount: "10", unit: "usd", token: "PONSBOT", slippageBps: 250 },
        sell: { kind, amount: "10", unit: "token", token: "PONSBOT", slippageBps: 250 },
        send: { kind, amount: "10", unit: "token", token: "PONSBOT", recipient: "0x1111111111111111111111111111111111111111" },
        burn: { kind, amount: "10", unit: "token", token: "PONSBOT" },
      };
      const command = validateStructuredWalletCommand(examples[kind]);
      expect(command && isTerminalCommand(command)).toBe(true);
    }
    const launch = validateStructuredWalletCommand({ kind: "launch", launchMode: "pons", name: "Blocked", symbol: "NOPE" });
    const claim = validateStructuredWalletCommand({ kind: "claim_fees" });
    expect(launch && isTerminalCommand(launch)).toBe(false);
    expect(claim && isTerminalCommand(claim)).toBe(true);
  });

  it("issues short-lived signed sessions and rejects tampering", () => {
    expect(WEB_WALLET_SESSION_SECONDS).toBe(2 * 60 * 60);
    const token = createWebWalletSession("0x1111111111111111111111111111111111111111", "12345", "ponsuser", "test-secret");
    const session = readWebWalletSession(token, "test-secret");
    expect(session).toMatchObject({ walletAddress: "0x1111111111111111111111111111111111111111", xUserId: "12345", username: "ponsuser" });
    expect(session?.sessionId).toMatch(/^web_/);
    expect(readWebWalletSession(`${token.slice(0, -1)}x`, "test-secret")).toBeNull();
    expect(readWebWalletSession(token, "wrong-secret")).toBeNull();
  });
});
