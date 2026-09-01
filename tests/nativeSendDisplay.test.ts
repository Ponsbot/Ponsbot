import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { parseEther } from "viem";
import { confirmedAllEthDisplay, SEND_VALUE_PRICE_TIMEOUT_MS } from "../lib/native-send-display";
import { ethUsdPrice } from "../lib/wallet-signer/pricing";
import { executeCommand } from "../convex/wallets";
import type { WalletCommand } from "../convex/walletCommands";
import { fitXReply, xWeightedLength } from "../convex/xText";

vi.mock("../lib/wallet-signer/pricing", () => ({ ethUsdPrice: vi.fn() }));
const price = vi.mocked(ethUsdPrice);
const recipient = "0x2222222222222222222222222222222222222222";
const walletAddress = "0x1111111111111111111111111111111111111111";
const hash = `0x${"a".repeat(64)}`;
const command: WalletCommand = { kind: "send", amount: "100", unit: "percent", token: "ETH", recipient };
const sentWei = "432509833368560";
beforeEach(() => {
  price.mockReset().mockResolvedValue(2500);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.ponsbot.family");
  vi.stubEnv("X_BOT_USER_ID", "999");
  vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "true");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No real network allowed in this test"); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("confirmed send-all ETH amount", () => {
  it("uses the confirmed net transfer amount rather than the requested 100 percent", async () => {
    expect(await confirmedAllEthDisplay(command, sentWei)).toBe("0.00043251 ETH (≈$1.08)");
    expect(price).toHaveBeenCalledTimes(1);
  });
  it("calculates USD before rounding the ETH display", async () => {
    price.mockResolvedValue(1234.56);
    expect(await confirmedAllEthDisplay(command, parseEther("1.0000049").toString()))
      .toBe("1 ETH (≈$1,234.57)");
  });
  it("keeps very small transfers nonzero and avoids scientific notation", async () => {
    expect(await confirmedAllEthDisplay(command, "1"))
      .toBe("0.000000000000000001 ETH (≈$0.0000000000000025)");
  });
  it("supports omitted ETH and lowercase ETH", async () => {
    expect(await confirmedAllEthDisplay({ ...command, token: undefined }, sentWei)).toContain("ETH (≈$");
    expect(await confirmedAllEthDisplay({ ...command, token: "eth" }, sentWei)).toContain("ETH (≈$");
  });
  it.each([
    { ...command, token: "PONSBOT" }, { ...command, amount: "50" },
    { ...command, amount: "0.1", unit: "eth" }, { ...command, amount: "10", unit: "usd" },
    { kind: "burn", amount: "100", unit: "percent", token: "PONSBOT" },
  ] as WalletCommand[])("leaves other command types and denominations unchanged: %j", async other => {
    expect(await confirmedAllEthDisplay(other, sentWei)).toBeUndefined();
    expect(price).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "0", "-1", "1.5", "not-a-number"])("does not invent amounts for missing/bad confirmed values: %s", async value => {
    expect(await confirmedAllEthDisplay(command, value)).toBe("ETH");
    expect(price).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, 0, -2500])("omits invalid dollar estimates: %s", async value => {
    price.mockResolvedValue(value);
    expect(await confirmedAllEthDisplay(command, sentWei)).toBe("0.00043251 ETH");
  });
  it("does not fail a confirmed send if pricing fails", async () => {
    price.mockRejectedValue(new Error("price source unavailable"));
    expect(await confirmedAllEthDisplay(command, sentWei)).toBe("0.00043251 ETH");
  });
  it("bounds even a stalled cache lookup and aborts outstanding pricing", async () => {
    vi.useFakeTimers();
    price.mockImplementation(() => new Promise(() => {}));
    const result = confirmedAllEthDisplay(command, sentWei);
    await vi.advanceTimersByTimeAsync(SEND_VALUE_PRICE_TIMEOUT_MS);
    expect(await result).toBe("0.00043251 ETH");
    expect(price.mock.calls[0][0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("real confirmation reconstruction with mocked Convex records", () => {
  it.each(["x", "terminal"] as const)("recovers actual ETH and USD for %s without rerunning the wallet action", async source => {
    const prior = { requestId: "original", ownerXUserId: "123", status: "confirmed", transactionHash: hash,
      normalizedJson: JSON.stringify(command) };
    const calls: { name: string; args: any }[] = [];
    const invoke = vi.fn(async (ref: any, args: any) => {
      const name = getFunctionName(ref); calls.push({ name, args });
      if (name === "wallets:getXUserAndWallet") return {
        user: { xUserId: "123", username: "sender", verified: true },
        wallet: { _id: "wallet", address: walletAddress, status: "active", signerWalletRef: walletAddress },
      };
      if (name === "wallets:reserveWalletRequest") return { inserted: false, request: prior };
      if (name === "wallets:getReconciliationContext") return { request: prior,
        transaction: { status: "confirmed", valueWei: sentWei, callKind: "eth_transfer" } };
      if (name === "registry:runtimeConfig") return { contracts: {}, pairs: [] };
      if (name === "registry:ensureInitialized" || name === "wallets:updateWalletRequest") return;
      throw new Error(`Unexpected wallet work: ${name}`);
    });
    const ctx = { runQuery: invoke, runMutation: invoke, runAction: invoke, scheduler: { runAfter: vi.fn() } };
    const result = await (executeCommand as any)._handler(ctx, {
      sourcePostId: "123456", xUserId: "123", source, channel: source === "x" ? "x_reply" : "terminal_chat",
      text: `send all ETH to ${recipient}`, parsedCommandJson: JSON.stringify(command),
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Sent 0.00043251 ETH (≈$1.08) to");
    expect(result.message).toContain(`Your TXN: https://robinhoodchain.blockscout.com/tx/${hash}`);
    expect(result.message).not.toContain("100%");
    expect(fitXReply(result.message)).toBe(result.message);
    expect(xWeightedLength(result.message)).toBeLessThanOrEqual(280);
    expect(calls.find(c => c.name === "wallets:updateWalletRequest")?.args.finalMessage).toBe(result.message);
    expect(calls.some(c => /consumeWalletLimit|reconcileTransaction|recordPreparedExecution/.test(c.name))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
});
