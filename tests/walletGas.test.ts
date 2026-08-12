import { describe, expect, it } from "vitest";
import { sendAllGasReserve, transactionGasEnvelope } from "../lib/wallet-signer/gas";

describe("wallet gas envelope", () => {
  it("uses the signed gas envelope plus a cushion for send-all", () => {
    const envelope = transactionGasEnvelope(21_000n, 100n);

    expect(envelope).toEqual({ gas: 25_200n, maxFeePerGas: 200n });
    expect(sendAllGasReserve(21_000n, 100n)).toBe(5_292_000n);
    expect(sendAllGasReserve(21_000n, 100n)).toBeGreaterThan(envelope.gas * envelope.maxFeePerGas);
  });
});
