import { describe, expect, it } from "vitest";
import { fundingMessage } from "../convex/wallets";

describe("funding message wallet links", () => {
  const address = "0x1111111111111111111111111111111111111111";
  it.each([
    "Simulated gas and Pons launch fee for this transaction is 0.001 ETH. Fund your wallet, then reply “resume”.",
    "Simulated gas for this transaction is 0.001 ETH. You'll also need the Pons launch fee. Fund your wallet, then reply “resume”.",
    "Simulated gas for this transaction is 0.001 ETH. Fund your wallet to buy, then reply “resume”.",
    "You'll need to fund your wallet with ETH for gas to send. Fund it, then reply “resume”.",
  ])("includes a wallet link for %s", message => {
    const result = fundingMessage("⛽ " + message, address);
    expect(result).toContain("Your wallet: https://");
    expect(result).toContain(address);
    expect(result).toMatch(/\/(?:wallet|address)\/0x/);
    expect(fundingMessage(result, address)).toBe(result);
  });
  it("leaves unrelated replies alone", () => {
    expect(fundingMessage("Transaction completed.", address)).toBe("Transaction completed.");
  });
});
