import type { WalletCommand } from "../convex/walletCommands";

export const PROTECTED_LAUNCH_X_USER_ID = "2085516993315188736";

export function launchTickerAllowed(xUserId: string, command: WalletCommand) {
  if (command.kind !== "launch") return true;
  const symbol = command.symbol.trim().replace(/^\$/, "").toUpperCase();
  if (symbol === "PONS") return false;
  if (symbol === "PONSBOT") return xUserId === PROTECTED_LAUNCH_X_USER_ID;
  return true;
}

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
  xUserId: string,
  command: WalletCommand,
  mediaUrl: string | undefined,
): WalletCommand {
  if (xUserId !== PROTECTED_LAUNCH_X_USER_ID || command.kind !== "launch") {
    return command;
  }

  // Artwork is intentionally supplied with the X post; every other launch
  // field is replaced with the fixed profile before salt/address preparation.
  if (!mediaUrl?.trim()) throw new Error("protected launch image missing");
  return { ...PROTECTED_LAUNCH };
}
