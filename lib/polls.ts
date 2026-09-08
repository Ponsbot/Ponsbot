export type PollSpec = { token: string; question: string; options: string[]; durationMinutes: number; minimumHoldingPercent: number };
export const POLL_EXAMPLE = '🗳️ Create a vote for $TOKEN or CONTRACT\nQuestion: Your question?\nOptions: Yes, No\nTime: 1 day\n\nYou can supply both ticker and contract. Use 2–8 options and a duration of 1 hour to 7 days. Minimum holding defaults to 0.1% of total supply. Add “Minimum holding: 0.05%” to set your own.';
export function validatePollSpec(value: PollSpec): PollSpec {
  const token = value.token.trim(), question = value.question.trim();
  const options = value.options.map(x => x.trim());
  if (!token || token.length > 160 || !question || question.length > 400 || /[\u0000-\u001f]/.test(question)
    || options.length < 2 || options.length > 8 || options.some(x => !x || x.length > 80 || /[\u0000-\u001f]/.test(x))
    || new Set(options.map(x => x.normalize('NFKC').toLowerCase())).size !== options.length
    || !Number.isInteger(value.durationMinutes) || value.durationMinutes < 60 || value.durationMinutes > 10080
    || !Number.isFinite(value.minimumHoldingPercent) || value.minimumHoldingPercent < 0 || value.minimumHoldingPercent > 100)
    throw new Error(POLL_EXAMPLE);
  return { ...value, token, question, options };
}
export function isPollCommand(text: string) {
  return /^\s*(?:create|start|make)\s+(?:a\s+)?(?:poll|vote)\b|^\s*(?:vote|cast\s+(?:my\s+)?vote)\b|^\s*(?:make|upgrade|endorse)\s+(?:poll\s+)?POLL-[a-f0-9]+\s+(?:as\s+)?official\b/iu.test(text);
}
export function parsePollCreate(text: string): PollSpec | null {
  if (!/^\s*(?:create|start|make)\s+(?:a\s+)?(?:poll|vote)\b/iu.test(text)) return null;
  const threshold = text.match(/(?:[,;\n]\s*|\s+)(?:minimum\s+holding|min\s+holding)\s*:\s*(\d+(?:\.\d+)?)\s*%\s*[.!]?$/iu);
  const minimumHoldingPercent = threshold ? Number(threshold[1]) : 0.1;
  if (threshold) text = text.slice(0, threshold.index).trim();
  const match = text.trim().match(/^(?:create|start|make)\s+(?:a\s+)?(?:poll|vote)\s+for\s+([\s\S]+?)\s*[,;\n]?\s*Question\s*:\s*([\s\S]+?)\s*[,;\n]?\s*Options\s*:\s*([\s\S]+?)\s*[,;\n]?\s*(?:Time|Duration)\s*:\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|days?|d)\s*[.!]?$/iu);
  if (!match) throw new Error(POLL_EXAMPLE);
  const durationMinutes = Number(match[4]) * (/^d/i.test(match[5]) ? 1440 : 60);
  return validatePollSpec({ token: match[1].trim().replace(/[,;]$/, ''), question: match[2].trim().replace(/[,;]$/, ''),
    options: match[3].split(/[,;\n|]/).map(x => x.trim()).filter(Boolean), durationMinutes, minimumHoldingPercent });
}
export function pollTokenIdentity(text: string) {
  const addresses = text.match(/0x[0-9a-f]{40}/gi) ?? [];
  if (addresses.length > 1) throw new Error('⚠️ Specify one token contract for this poll.');
  const remainder = text.replace(/0x[0-9a-f]{40}/gi, '').replace(/\b(?:ca|contract|address)\b\s*:?/gi, '').replace(/[(),:]/g, ' ').trim();
  const ticker = remainder.replace(/^\$/, '').trim();
  if (ticker && !/^[\p{L}\p{N}_.$-]{1,64}$/u.test(ticker)) throw new Error('⚠️ Provide a ticker, a contract, or both for the same token.');
  if (!ticker && !addresses.length) throw new Error('⚠️ Provide a token contract address.');
  return { address: addresses[0]?.toLowerCase(), ticker: ticker || undefined };
}
export function pollChoice(text: string, options: string[]) {
  const choice = text.trim().replace(/^(?:vote|cast\s+(?:my\s+)?vote)\s*/i, '').replace(/^POLL-[a-f0-9]+\s*/i, '').replace(/^(?:for\s+|option\s*)/i, '').replace(/[.!]+$/, '').trim();
  if (/^[1-8]$/.test(choice) && Number(choice) <= options.length) return Number(choice) - 1;
  return options.findIndex(x => x.normalize('NFKC').toLowerCase() === choice.normalize('NFKC').toLowerCase());
}
export function pollPercent(part: string, whole: string) {
  return BigInt(whole) > 0n ? Number(BigInt(part) * 1_000_000n / BigInt(whole)) / 10_000 : 0;
}
export function updatePollTotals(totals: string[], old: { option: number; weight: string } | null, option: number, weight: string) {
  const result = totals.map(BigInt);
  if (!Number.isInteger(option) || option < 0 || option >= result.length || BigInt(weight) <= 0n) throw new Error('Invalid vote');
  if (old) result[old.option] -= BigInt(old.weight);
  result[option] += BigInt(weight);
  if (result.some(x => x < 0n)) throw new Error('Invalid tally');
  return result.map(String);
}
export const pollUrl = (code: string) => `${(process.env.NEXT_PUBLIC_SITE_URL || 'https://www.ponsbot.family').replace(/\/$/, '')}/votes/${code}`;
export function pollCreatedText(p: { code: string; symbol: string; question: string; options: string[]; official: boolean; endsAt: number; minimumHoldingPercent: number }) {
  return `🗳️ Vote created: ${p.code}\n${p.official ? 'Official' : 'Community'} $${p.symbol} poll\n\n${p.question}\n\n${p.options.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nMinimum holding: ${p.minimumHoldingPercent}% of total supply at the snapshot.\nCloses: ${new Date(p.endsAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}\nReply “vote 1” to this post, or vote on the website. Voting power uses your token balance at the snapshot.\n${pollUrl(p.code)}`;
}
