import { formatEther } from "viem";
import type { WalletCommand } from "../convex/walletCommands";
import { ethUsdPrice } from "./wallet-signer/pricing";

export const SEND_VALUE_PRICE_TIMEOUT_MS = 3_000;

/** Display only: valueWei must come from the confirmed transaction, not a balance. */
export async function confirmedAllEthDisplay(command: WalletCommand, valueWei?: string) {
  if (command.kind !== "send" || command.unit !== "percent" || Number(command.amount) !== 100
    || (command.token && !/^eth$/i.test(command.token))) return undefined;

  // A legacy/incomplete record must not invent a transferred amount or say 100 ETH.
  if (!valueWei || !/^\d{1,78}$/.test(valueWei) || BigInt(valueWei) <= 0n) return "ETH";
  const amount = Number(formatEther(BigInt(valueWei)));
  const eth = `${new Intl.NumberFormat("en-US", { useGrouping: false, maximumSignificantDigits: 6 }).format(amount)} ETH`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The pricing helper reuses the existing shared ETH/USD cache. Bound the
    // whole lookup, including the cache read, so a confirmed reply cannot hang.
    const price = await Promise.race([
      ethUsdPrice(controller.signal).catch(() => undefined),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(undefined); }, SEND_VALUE_PRICE_TIMEOUT_MS);
      }),
    ]);
    if (price === undefined || !Number.isFinite(price) || price <= 0) return eth;
    const value = amount * price;
    if (!Number.isFinite(value) || value <= 0) return eth;
    const usd = new Intl.NumberFormat("en-US", value >= 0.01
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { maximumSignificantDigits: 3 }).format(value);
    return `${eth} (≈$${usd})`;
  } catch {
    return eth;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
