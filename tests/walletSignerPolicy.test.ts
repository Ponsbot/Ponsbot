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
});
