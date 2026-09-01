import type { WalletCommand } from "../convex/walletCommands";

export function reservedLaunchTickerMessage(command: WalletCommand): string | undefined {
  if (command.kind !== "launch") return undefined;
  const symbol = command.symbol.trim().replace(/^\$/, "").toUpperCase();
  if (symbol === "PONS" || symbol === "PONSBOT") return `Sorry, there's only one $${symbol}`;
  return undefined;
}

export function launchTickerAllowed(_xUserId: string, command: WalletCommand) {
  return reservedLaunchTickerMessage(command) === undefined;
}
