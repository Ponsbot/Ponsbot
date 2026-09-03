export type LiquidityClaimedFee = { symbol: string; amount: string; usd?: number };

export function liquidityClaimTotalLine(received: string[]) {
  const totals = new Map<string, { amount: number; usd: number; priced: boolean }>();
  const unparsed: string[] = [];
  for (const raw of received) {
    const value = raw.replace(/^(?:LP-[A-Za-z0-9]+|LP fees):\s*/, "")
      .replace(/^([0-9]+(?:\.[0-9]+)?e[+-]?[0-9]+)(?=\s)/i, amount => Number(amount).toLocaleString("en-US", { maximumSignificantDigits: 12, useGrouping: false }));
    // A sub-cent valuation cannot be summed as an exact dollar amount.
    const fee = parseLiquidityClaimedFee(value.replace(/\s+\(\$<0\.01\)$/, ""));
    if (!fee) { unparsed.push(value); continue; }
    const key = fee.symbol.toUpperCase();
    const total = totals.get(key) ?? { amount: 0, usd: 0, priced: true };
    total.amount += Number(fee.amount);
    total.usd += fee.usd ?? 0;
    total.priced &&= fee.usd !== undefined;
    totals.set(key, total);
  }
  const rank = (symbol: string) => symbol === "ETH" ? 0 : symbol === "USDG" ? 1 : 2;
  const values = [...totals].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([symbol, total]) =>
    `${total.amount.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${symbol}${total.priced ? ` ($${total.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })})` : ""}`);
  return [...values, ...unparsed].length ? `Total: ${[...values, ...unparsed].join(", ")}` : "";
}

export function parseLiquidityClaimedFee(value: string): LiquidityClaimedFee | undefined {
  const match = /^\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s+([A-Za-z0-9_.-]{1,32})(?:\s+\(\$([0-9][0-9,]*(?:\.[0-9]+)?)\))?\s*$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1].replaceAll(",", ""));
  const usd = match[3] === undefined ? undefined : Number(match[3].replaceAll(",", ""));
  if (!Number.isFinite(amount) || amount < 0 || usd !== undefined && (!Number.isFinite(usd) || usd < 0)) return undefined;
  return { symbol: match[2], amount: String(amount), ...(usd === undefined ? {} : { usd }) };
}

export function mergeLiquidityClaimedFees(current: LiquidityClaimedFee[], added: LiquidityClaimedFee[]) {
  const totals = new Map<string, { amount: number; usd?: number }>();
  for (const fee of [...current, ...added]) {
    const value = Number(fee.amount);
    if (!Number.isFinite(value) || value < 0) continue;
    const symbol = fee.symbol.toUpperCase(), previous = totals.get(symbol);
    const usd = fee.usd !== undefined && Number.isFinite(fee.usd) ? (previous?.usd ?? 0) + fee.usd : previous?.usd;
    totals.set(symbol, { amount: (previous?.amount ?? 0) + value, ...(usd === undefined ? {} : { usd }) });
  }
  return [...totals].map(([symbol, total]) => ({ symbol,
    amount: total.amount.toLocaleString("en-US", { maximumSignificantDigits: 12, useGrouping: false }),
    ...(total.usd === undefined ? {} : { usd: total.usd }) }));
}
