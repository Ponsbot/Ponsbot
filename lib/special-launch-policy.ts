import type { WalletCommand } from "../convex/walletCommands";

const PROTECTED_LAUNCH_USERNAME = "ponsboyfamily";

const PROTECTED_LAUNCH = {
  kind: "launch",
  launchMode: "pons",
  name: "Pons Bot",
  symbol: "PONSBOT",
  description: "Swap, send, and launch on Pons V2 with just one X post.",
  website: "https://www.ponsbot.family",
  twitter: "https://x.com/ponsbotfamily",
  pairToken: "ETH",
  devBuy: { amount: "100", unit: "usd" },
} as const satisfies Extract<WalletCommand, { kind: "launch" }>;

export function applyProtectedLaunchProfile(
  username: string | undefined,
  command: WalletCommand,
  mediaUrl: string | undefined,
): WalletCommand {
  if (username?.replace(/^@/, "").toLowerCase() !== PROTECTED_LAUNCH_USERNAME || command.kind !== "launch") {
    return command;
  }

  // Artwork is intentionally supplied with the X post; every other launch
  // field is replaced with the fixed profile before salt/address preparation.
  if (!mediaUrl?.trim()) throw new Error("protected launch image missing");
  return { ...PROTECTED_LAUNCH };
}

