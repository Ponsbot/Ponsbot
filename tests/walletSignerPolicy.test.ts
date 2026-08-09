import { describe, expect, it } from "vitest";
import { executionRequestSchema } from "../lib/wallet-signer/policy";

const base = {
  idempotencyKey: "x:123456789:buy", chainId: 4663, ownerReference: "x:123456789",
  walletRef: "0x1111111111111111111111111111111111111111",
  expectedFrom: "0x1111111111111111111111111111111111111111", requireSimulation: true,
};

describe("wallet signer operation policy", () => {
  it("accepts an exact supported operation", () => {
    expect(executionRequestSchema.parse({ ...base, operation: {
      type: "eth_transfer", recipient: "0x2222222222222222222222222222222222222222",
      amount: "0.01", unit: "eth",
    } }).operation.type).toBe("eth_transfer");
  });

  it("rejects arbitrary calls and extra fields", () => {
    expect(() => executionRequestSchema.parse({ ...base, operation: { type: "arbitrary_call", to: base.walletRef } })).toThrow();
    expect(() => executionRequestSchema.parse({ ...base, operation: {
      type: "eth_transfer", recipient: "0x2222222222222222222222222222222222222222",
      amount: "0.01", unit: "eth", data: "0xdeadbeef",
    } })).toThrow();
  });

  it("rejects zero and negative-equivalent amounts", () => {
    expect(() => executionRequestSchema.parse({ ...base, operation: {
      type: "eth_transfer", recipient: "0x2222222222222222222222222222222222222222",
      amount: "0", unit: "eth",
    } })).toThrow();
  });

  it("rejects invalid units and percentages at the signer boundary", () => {
    const contracts = {
      routerAddress: "0x3333333333333333333333333333333333333333",
      quoterAddress: "0x4444444444444444444444444444444444444444",
      wethAddress: "0x5555555555555555555555555555555555555555",
      ponsFactoryAddress: "0x6666666666666666666666666666666666666666",
      fee: 10_000,
    };
    expect(() => executionRequestSchema.parse({ ...base, operation: {
      type: "uniswap_v3_buy", token: "0x7777777777777777777777777777777777777777",
      amount: "50", unit: "percent", slippageBps: 100, ...contracts,
    } })).toThrow();
    expect(() => executionRequestSchema.parse({ ...base, operation: {
      type: "uniswap_v3_sell", token: "0x7777777777777777777777777777777777777777",
      amount: "101", unit: "percent", slippageBps: 100, ...contracts,
    } })).toThrow();
  });
});
