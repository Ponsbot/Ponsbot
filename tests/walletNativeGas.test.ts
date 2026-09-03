import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { executeCommand, safeFailure } from "../convex/wallets";
import { createQuote, executeConfirmed } from "../convex/xHoudini";
import { EmptyNativeGasBalanceError, isEmptyNativeGasBalanceError, NO_NATIVE_GAS_MESSAGE, requireNativeGasBalance, requireWalletNativeGas } from "../lib/wallet-native-gas";
import { parseWalletCommand } from "../convex/walletCommands";
import { executeTransaction, prepareLaunchAddresses, prepareUnsigned, prepareAutomatedFeeControllerTransaction, spendableEthBalance } from "../lib/wallet-signer/service";

vi.mock("../lib/token-market-cap", () => ({ tokenMarketCapUsd: vi.fn(() => { throw new Error("Pricing must not run for an empty wallet"); }) }));

const address = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const handler = (f: any) => f._handler;
let balance: string;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  balance = "0x0";
  vi.stubEnv("ROBINHOOD_RPC_URL", "https://rpc.test");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.ponsbot.family");
  vi.stubEnv("X_BOT_USER_ID", "999");
  vi.stubEnv("X_CRYPTO_EXECUTION_ENABLED", "true");
  vi.stubEnv("WALLET_SIGNER_URL", "https://signer.test");
  vi.stubEnv("WALLET_SIGNER_TOKEN", "test-only");
  fetcher = vi.fn(async (url: string, options: any) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith("/wallets/balance")) return new Response(JSON.stringify({ display: "0 ETH" }));
    expect(new URL(String(url)).origin).toBe("https://rpc.test");
    expect(body.method).toBe("eth_getBalance");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: balance }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture(reserved: any = { inserted: true, retried: false }) {
  const calls: { name: string; args: any }[] = [];
  const invoke = vi.fn(async (ref: any, args: any) => {
    const name = getFunctionName(ref); calls.push({ name, args });
    if (name === "wallets:getXUserAndWallet") return {
      user: { xUserId: "123", verified: true, username: "gascheck", subscriptionType: "premium" },
      wallet: { _id: "wallet", address, signerWalletRef: address, status: "active", launchEnabled: true },
    };
    if (name === "wallets:reserveWalletRequest") return reserved;
    if (name === "wallets:updateWalletRequest" || name === "registry:ensureInitialized") return;
    if (name === "wallets:listWalletTokenAddresses") return [];
    // Stop the funded test at this boundary, before any real execution.
    if (name === "wallets:consumeWalletLimit") return { allowed: false };
    throw new Error(`Unexpected downstream work: ${name}`);
  });
  return { calls, ctx: { runQuery: invoke, runMutation: invoke, runAction: invoke, scheduler: { runAfter: vi.fn() } } };
}
const args = (text: string, source: "x" | "terminal" = "x") => ({ sourcePostId: "123456", xUserId: "123", text, source,
  channel: source === "x" ? "x_reply" : "terminal_chat" });

describe("zero native ETH gate", () => {
  it.each(["sell", "burn"])("rejects a native ETH %s accurately before any gas check or quota consumption", async kind => {
    const f = fixture();
    const result = await handler(executeCommand)(f.ctx, { ...args(`${kind} 0.0001 ETH`, "terminal"),
      parsedCommandJson: JSON.stringify({ kind, token: "ETH", amount: "0.0001", unit: "usd", slippageBps: 250 }),
    });
    expect(result.ok).toBe(false); expect(result.message).not.toContain(NO_NATIVE_GAS_MESSAGE);
    expect(f.calls.at(-1)?.args).toMatchObject({ status: "rejected", diagnosticCode: `${kind.toUpperCase()}_TARGET_NATIVE_ETH` });
    expect(f.calls.some(c => c.name === "wallets:consumeWalletLimit")).toBe(false);
    expect(fetcher).not.toHaveBeenCalled(); expect(f.ctx.scheduler.runAfter).not.toHaveBeenCalled();
  });
  it("uses only one native balance RPC call and immediately recognizes funding on a later request", async () => {
    await expect(requireWalletNativeGas(address)).rejects.toBeInstanceOf(EmptyNativeGasBalanceError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    balance = "0x1";
    await expect(requireWalletNativeGas(address)).resolves.toBe(1n);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not call a failed or malformed balance zero", async () => {
    await expect(requireNativeGasBalance(async () => { throw new Error("RPC unavailable"); })).rejects.toThrow("RPC unavailable");
    await expect(requireNativeGasBalance(async () => -1n)).rejects.toThrow("Invalid native ETH balance");
    await expect(requireNativeGasBalance(async () => undefined as any)).rejects.toThrow("Invalid native ETH balance");
    expect(isEmptyNativeGasBalanceError(new Error("RPC unavailable"))).toBe(false);
  });
  it("preserves the no-gas response across Convex errors", () => {
    const error = new EmptyNativeGasBalanceError();
    expect(isEmptyNativeGasBalanceError(new Error(`Server Error: ${error.message}`))).toBe(true);
    expect(safeFailure(error, "launch")).toContain("fund your wallet with ~0.0015 ETH for gas and the Pons launch fee");
    expect(safeFailure(error, "buy")).toContain("fund your wallet with ETH for gas to buy");
    expect(safeFailure(error, "buy")).toContain("reply “resume”");
  });
  it("does not stop wallet commands at a zero-balance precheck", async () => {
    const f = fixture();
    const result = await handler(executeCommand)(f.ctx, args("buy $1 of PONS", "terminal"));
    expect(result.message).toContain("wallet action limit");
    expect(f.calls.some(c => c.name === "wallets:consumeWalletLimit")).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["show my wallet", "what's my wallet balance?"])("keeps read-only %s working with zero ETH", async text => {
    const f = fixture();
    const result = await handler(executeCommand)(f.ctx, args(text));
    expect(result.ok).toBe(true);
    expect(f.calls.some(c => c.name === "wallets:reserveWalletRequest")).toBe(false);
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith("/wallets/balance"))).toBe(true);
  });
  it("preserves an already broadcast request even if the wallet is now empty", async () => {
    const f = fixture({ inserted: false, request: { status: "broadcast", transactionHash: `0x${"1".repeat(64)}` } });
    const result = await handler(executeCommand)(f.ctx, args("buy $1 of PONS"));
    expect(result.pending).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.calls.some(c => c.name === "wallets:updateWalletRequest")).toBe(false);
  });
  it("stops cross-chain quoting before contacting Houdini", async () => {
    const f = fixture();
    await expect(handler(createQuote)(f.ctx, { requestPostId: "123", ownerXUserId: "123", walletAddress: address,
      commandJson: JSON.stringify({ amount: "1", unit: "usd", destination: recipient, targetSymbol: "ETH", targetChain: "Base", privateMode: false }) })).rejects.toThrow("zero native ETH");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(0);
  });
  it("does not create a cross-chain order if the wallet emptied after quoting", async () => {
    const calls: any[] = [];
    const ctx = { runMutation: vi.fn(async (ref: any, input: any) => {
      const name = getFunctionName(ref); calls.push({ name, input });
      if (name === "xHoudini:reserveExecution") return { executionStage: "creating_order" };
      if (name === "xHoudini:setFinalOutcome") return false;
      throw new Error(`Unexpected ${name}`);
    }), scheduler: { runAfter: vi.fn() } };
    await handler(executeConfirmed)(ctx, { quoteId: "quote", confirmationPostId: "123", ownerXUserId: "123", walletAddress: address });
    expect(calls.at(-1)).toMatchObject({ name: "xHoudini:setFinalOutcome", input: { status: "failed", ok: false } });
    expect(calls.at(-1).input.text).toContain(NO_NATIVE_GAS_MESSAGE);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["transaction execution", () => executeTransaction({ expectedFrom: address, operation: { type: "eth_transfer" } } as any)],
    ["vault controller preparation", () => prepareAutomatedFeeControllerTransaction({ expectedAddress: address } as any)],
    ["spendable ETH estimation", () => spendableEthBalance(address, 21_000)],
  ] as const)("retains the specialized zero-balance gate for %s", async (_name, run) => {
    await expect(run()).rejects.toThrow("zero native ETH");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not apply the zero-balance shortcut before launch preparation", async () => {
    await expect(prepareLaunchAddresses({ expectedFrom: address } as any)).rejects.toThrow("launch operation required");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
