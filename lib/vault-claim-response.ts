import { formatUnits } from "viem";

export const VAULT_CLAIM_REMINDER = "Fee claims now happen automatically, there's no need to ask me to claim fees again.";
export type VaultClaimOutcome = {
  tokenSymbol: string; assetSymbol: string; assetDecimals: number;
  assetAddress?: string;
  amount: string; transactionHash?: string;
  ponsbotBurned?: string;
  state: "paid" | "no_fees" | "operator" | "unavailable" | "pending";
};

export function claimUsdDisplay(ethAmount: number, ethUsd?: number) {
  if (!Number.isFinite(ethAmount) || ethAmount < 0 || !Number.isFinite(ethUsd) || !ethUsd || ethUsd <= 0) return "";
  const usd = ethAmount * ethUsd;
  const formatted = usd >= 0.01
    ? usd.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
    : `$${usd.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;
  return ` (${formatted})`;
}

export function vaultClaimResponse(outcomes: VaultClaimOutcome[], onlyV2: boolean, legacyMessage?: string, ethUsd?: number) {
  const lines: string[] = [];
  // Bound response size for claim-all without mixing ETH and paired assets or
  // clipping the payout figures/reminder. Full per-vault receipts stay stored.
  const groups = new Map<string, VaultClaimOutcome[]>();
  for (const o of outcomes) {
    const key = o.state === "paid" ? `paid:${o.assetAddress || o.assetSymbol}:${o.assetDecimals}` : o.state;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  for (const group of groups.values()) {
    const outcome = group[0];
    const firstToken = /^\$?[A-Za-z0-9_]{1,32}$/.test(outcome.tokenSymbol)
      ? `$${outcome.tokenSymbol.replace(/^\$/, "")}` : "this token";
    const token = `${firstToken}${group.length > 1 ? " and other launches" : ""}`;
    if (outcome.state === "paid") {
      const total = group.reduce((sum, o) => sum + BigInt(o.amount), 0n);
      const value = Number(formatUnits(total, outcome.assetDecimals));
      const display = `${value.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${outcome.assetSymbol}${outcome.assetSymbol.toUpperCase() === "ETH" ? claimUsdDisplay(value, ethUsd) : ""}`;
      const burned = group.reduce((sum, o) => sum + BigInt(o.ponsbotBurned ?? "0"), 0n);
      const burnedDisplay = Number(formatUnits(burned, 18)).toLocaleString("en-US", { maximumSignificantDigits: 6 });
      lines.push(`✅ Claimed ${display} from ${token} and burned ${burnedDisplay} $PONSBOT.`);
      const hash = group.at(-1)?.transactionHash;
      if (hash && /^0x[\da-f]{64}$/i.test(hash))
        lines.push(`${group.length > 1 ? "Latest payout TXN" : "Your TXN"}: https://robinhoodchain.blockscout.com/tx/${hash}`);
    } else if (outcome.state === "operator") {
      lines.push(`ℹ️ Fees from ${token} are still waiting for Pons to release them. Nothing was claimed from those fees yet.`);
    } else if (outcome.state === "no_fees") {
      lines.push(`ℹ️ No fees are available to process from ${token} right now, or the amount is too small to buy back and burn.`);
    } else if (outcome.state === "unavailable") {
      lines.push(`⚠️ The fee cycle for ${token} couldn't complete. Any fees already processed remain recorded; no unconfirmed payout is included here.`);
    }
  }
  if (legacyMessage) lines.push(legacyMessage);
  if (onlyV2) {
    // Keep the standing V2 guidance visually separate from the result or
    // no-fees explanation that precedes it, especially in long X posts.
    if (lines.length) lines.push("");
    lines.push(VAULT_CLAIM_REMINDER);
  }
  return lines.join("\n");
}
