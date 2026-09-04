import { expect, it } from "vitest";
import { transactionMessage } from "../convex/wallets";

const command = { kind: "launch" as const, launchMode: "pons" as const, name: "Example", symbol: "EXAMPLE", devBuy: { amount: "20", unit: "usd" as const } };
const hash = `0x${"1".repeat(64)}`;
const token = `0x${"2".repeat(40)}`;

it("reports actual confirmed dev-buy output in the launch sentence", async () => {
  const message = await transactionMessage(command, hash, token, undefined, "12345 EXAMPLE");
  expect(message).toMatch(/and bought 12345 EXAMPLE \(≈\$20(?:\.00)?\)! 🚀/);
  expect(message).toContain("View Token:");
  expect(message).not.toContain("bought $20");
});

it("does not claim a requested dev buy succeeded without confirmed output", async () => {
  expect(await transactionMessage(command, hash, token)).not.toContain("and bought");
});

it("keeps ordinary launches unchanged", async () => {
  expect(await transactionMessage({ kind: "launch", launchMode: "pons", name: "Example", symbol: "EXAMPLE" }, hash, token))
    .toContain("Launched Example (EXAMPLE) on Pons V2! 🚀");
});
