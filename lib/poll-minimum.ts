import { formatUnits } from 'viem';
export type PollMinimum = { unit: 'usd' | 'tokens'; amount: string };
export type ResolvedPollMinimum = { balance: string; percent: number; pricedAt?: number; marketCapUsd?: string };
const decimal = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
export function parsePollMinimum(input: string): { minimumHoldingPercent: number; minimumHolding?: PollMinimum } {
  const text = input.trim().replace(/[.!]$/, '').replace(/^(?:minimum(?:\s+(?:token\s+)?holdings?)?|min\s+holding|holders?)\s*[:=]?\s*/i, '')
    .replace(/\s+(?:minimum(?:\s+(?:token\s+)?holdings?)?|min\s+holdings?)$/i, '').trim();
  const match = text.match(/^(\$)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)([km])?\s*(%|tokens?|usd|dollars?)?$/i);
  if (!match || (match[1] && match[4] && !/usd|dollars?/i.test(match[4]))) throw Error('Use a percentage, dollar amount, or token amount.');
  let amount = match[2].replaceAll(',', '');
  if (match[3]) { const [whole, fraction = ''] = amount.split('.'); const places = match[3].toLowerCase() === 'k' ? 3 : 6; amount = `${whole}${fraction.padEnd(places, '0').slice(0, places)}${fraction.length > places ? `.${fraction.slice(places)}` : ''}`; }
  amount = amount.replace(/^0+(?=\d)/, '');
  if (!decimal.test(amount) || amount.length > 80 || !Number.isFinite(Number(amount))) throw Error('Invalid minimum holdings.');
  if (match[4] === '%') {
    const percent = Number(amount);
    if (percent < 0 || percent > 100) throw Error('Minimum percentage must be from 0% to 100%.');
    return { minimumHoldingPercent: percent };
  }
  return { minimumHoldingPercent: 0.1, minimumHolding: { unit: match[1] || /usd|dollar/i.test(match[4] ?? '') ? 'usd' : 'tokens', amount } };
}
export function validatePollMinimum(value: PollMinimum | undefined) {
  if (value && (!['usd', 'tokens'].includes(value.unit) || typeof value.amount !== 'string' || !decimal.test(value.amount) || value.amount.length > 80 || !Number.isFinite(Number(value.amount)))) throw Error('Invalid minimum holdings.');
}
function fraction(value: string): [bigint, bigint] {
  if (!decimal.test(value) || value.length > 100) throw Error('Invalid valuation.');
  const [whole, tail = ''] = value.split('.');
  return [BigInt(whole + tail), 10n ** BigInt(tail.length)];
}
export function resolvePollMinimum(input: PollMinimum, supply: string, decimals: number, marketCapUsd?: string, pricedAt?: number): ResolvedPollMinimum {
  validatePollMinimum(input);
  const [n, d] = fraction(input.amount);
  let numerator = n * 10n ** BigInt(decimals), denominator = d;
  if (input.unit === 'usd') {
    if (!marketCapUsd) throw Error('Current market cap unavailable');
    const [cap, scale] = fraction(marketCapUsd);
    if (cap <= 0n) throw Error('Current market cap unavailable');
    numerator = n * BigInt(supply) * scale; denominator = d * cap;
  }
  const balance = (numerator + denominator - 1n) / denominator;
  if (balance > BigInt(supply)) throw Error('Minimum holdings exceed total supply');
  return { balance: balance.toString(), percent: Number(balance * 100_000_000n / BigInt(supply)) / 1_000_000, ...(input.unit === 'usd' ? { marketCapUsd, pricedAt } : {}) };
}
export function pollMinimumText(percent: number, input?: PollMinimum, resolved?: ResolvedPollMinimum, decimals = 18, symbol = 'tokens') {
  if (!input) return `${percent}% of total supply at the snapshot`;
  const amount = resolved ? formatUnits(BigInt(resolved.balance), decimals) : input.amount;
  const safeSymbol = symbol.normalize('NFKC').replace(/[$#@\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (resolved) return `${amount} ${safeSymbol} at the snapshot`;
  return input.unit === 'usd' ? `$${input.amount} of tokens, converted at the market cap when the poll is created` : `${amount} tokens at the snapshot`;
}
