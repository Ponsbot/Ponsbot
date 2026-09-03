export function formatBalanceUsd(value: number) {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const formatted = value === 0 || value >= 0.01
    ? new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
    : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 12 }).format(value);
  return `≈$${formatted}`;
}

export function balanceWithUsd(display: string, usdValue: number | undefined) {
  const usd = usdValue === undefined ? undefined : formatBalanceUsd(usdValue);
  return usd ? `${display} (${usd})` : display;
}
