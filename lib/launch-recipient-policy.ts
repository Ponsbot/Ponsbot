import type { WalletCommand } from "../convex/walletCommands";

export const GROK_EXTERNAL_LAUNCH_FEES = "⚠️ Launches from @grok cannot assign creator fees to another account or wallet. No token was launched.";

/** Use the authenticated author's stored X username, never mentions/display names. */
export function grokLaunchFeeRejection(
  command: WalletCommand,
  authorUsername: string,
  ownerWalletAddress?: string,
) {
  if (authorUsername.replace(/^@/, "").toLowerCase() !== "grok"
    || command.kind !== "launch" || !command.feeRecipient) return undefined;
  const recipient = command.feeRecipient.trim().toLowerCase();
  if (recipient === "@grok") return undefined;
  if (/^0x[a-f0-9]{40}$/.test(recipient)
    && recipient === ownerWalletAddress?.toLowerCase()) return undefined;
  return GROK_EXTERNAL_LAUNCH_FEES;
}
