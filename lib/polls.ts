import { parsePollMinimum, validatePollMinimum, type PollMinimum } from './poll-minimum';
export type PollSpec = { token: string; question: string; options: string[]; durationMinutes: number; minimumHoldingPercent: number; minimumHolding?: PollMinimum };
export type PollDraft = Partial<PollSpec>;
// User-authored question/option text must not create mentions, hashtags, or
// cashtags in the bot's posts. Keep raw metadata separate from display text.
export const pollDisplayText = (text: string) => text.normalize('NFKC').replace(/[$#@]/g, '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
export const pollInputText = (text: string) => text.trim().replace(/^(?:@ponsbotfamily\b[\s,!:]*)+/i, '').replace(/\s+@ponsbotfamily[.!?]*$/i, '').trim();
const createPrefix = /^(?:(?:hey|hi)[,!]?[\s]+)?(?:(?:please|can you|could you|would you|i want to|i would like to|i'd like to|let's)\s+)?(?:create|start|make|open|set\s+up)\s+(?:me\s+)?(?:(?:a|an|new)\s+)?(?:poll|vote)\b[\s,:]*/iu;
export const isPollCreate = (text: string) => createPrefix.test(pollInputText(text));
export const isPollCancel = (text: string) => /^(?:please\s+)?cancel(?:\s+(?:(?:this|the|my)\s+)?(?:poll|vote|votes|voting))?(?:\s+please)?[.!?]*$/i.test(pollInputText(text));
export function pollDuration(text: string) {
  const m = text.trim().match(/^(?:for\s+)?(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven)\s*(hours?|hrs?|h|days?|d)[.!]?$/i);
  if (!m) throw new Error('Reply with a duration in hours or days, such as 12 hours or 2 days.');
  const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
  const minutes = (words[m[1].toLowerCase()] ?? Number(m[1])) * (/^d/i.test(m[2]) ? 1440 : 60);
  if (!Number.isInteger(minutes) || minutes < 60 || minutes > 10080) throw new Error('Choose a duration from 1 hour to 7 days.');
  return minutes;
}
const durationTail = /(?:[,;\n]\s*|\s+)(?:(?:time|duration|for|lasting)\s*[:=]?\s*)?(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven)\s*(hours?|hrs?|h|days?|d)[.!]?\s*$/i;
// A bare label needs a plausible list after it. This avoids treating the word
// "options" in the question itself as the beginning of the answer list.
function optionsMarker(input: string) {
  return [...input.matchAll(/\b(?:options|choices|answers)(?:\s*[:=]\s*|\s+)/gi)].reverse().find(match => {
    const rest = input.slice(match.index! + match[0].length);
    return !rest.includes('?') && /[,;\n|]/.test(rest);
  });
}
const splitPollOptions = (input: string) => input.split(/[,;\n|]/).map(x => x.trim()).filter(Boolean);
export function parsePollDraft(text: string): PollDraft | null {
  text = pollInputText(text);
  if (!createPrefix.test(text)) return null;
  let input = text.replace(createPrefix, '');
  // Positional form: question, comma-separated options, duration, holder %.
  // Existing Question: commands retain their labeled parsing unchanged.
  if (input && !/\b(?:question|ask)\s*[:=]/i.test(input)
    && (!/^(?:for|on|about)\s+/i.test(input) || /[?\n]|\b(?:options|choices|answers)\b/i.test(input))) {
    let token = '';
    if (/^(?:for|on|about)\s+/i.test(input)) {
      input = input.replace(/^(?:for|on|about)\s+/i, '');
      // An explicit token prefix remains supported. Find the longest valid
      // ticker/CA prefix, without consuming the words of the question.
      const spans = [...input.matchAll(/\S+/g)];
      const words = spans.map(x => x[0]);
      for (let n = Math.min(8, words.length); n >= 1; n--) {
        const candidate = words.slice(0, n).join(' ').replace(/[,;:]$/, '');
        try { pollTokenIdentity(candidate); token = candidate; input = input.slice(spans[n - 1].index! + spans[n - 1][0].length).trim(); break; } catch { /* Try a shorter identifier. */ }
      }
      if (!token) throw new Error('⚠️ Provide a ticker, a contract, or both for the same token.');
    }
    const draft: PollDraft = { ...(token ? { token } : {}), minimumHoldingPercent: 0.1 };
    // Accept value-first settings after a duration, without interpreting
    // minimum-related wording inside the question or an option as a setting.
    const valueFirstHolder = input.match(/(?:[,;\n]\s*|\s+)(\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[km]?\s*(?:%|tokens?|usd|dollars?)?)\s+(?:minimum(?:\s+(?:token\s+)?holdings?)?|min\s+holdings?)[.!]?\s*$/i);
    if (valueFirstHolder && durationTail.test(input.slice(0, valueFirstHolder.index).trim())) {
      Object.assign(draft, parsePollMinimum(valueFirstHolder[1]));
      input = input.slice(0, valueFirstHolder.index).trim();
    }
    const customHolder = input.match(/(?:[,;\n]\s*|\s+)(?:minimum(?:\s+(?:token\s+)?holdings?)?|min\s+holding|holders?)\s*[:=]?\s*(\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[km]?\s*(?:%|tokens?|usd|dollars?)?)[.!]?\s*$/i);
    if (customHolder) { Object.assign(draft, parsePollMinimum(customHolder[1])); input = input.slice(0, customHolder.index).trim(); }
    const amountTail = !customHolder && input.match(/(?:[,;\n]\s*|\s+)(\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[km]?\s*(?:tokens?|usd|dollars?)?)[.!]?\s*$/i);
    if (amountTail && durationTail.test(input.slice(0, amountTail.index).trim())) { Object.assign(draft, parsePollMinimum(amountTail[1])); input = input.slice(0, amountTail.index).trim(); }
    const holder = input.match(/(?:[,;\n]\s*|\s+)((?:(?:minimum\s+holding|min\s+holding|holder\s*%|holders?|minimum)\s*[:=]?\s*)?)(\d+(?:\.\d+)?)\s*%[.!]?\s*$/i);
    if (holder && (holder[1].trim() || durationTail.test(input.slice(0, holder.index).trim()))) {
      draft.minimumHoldingPercent = Number(holder[2]); input = input.slice(0, holder.index).trim();
    }
    const duration = input.match(durationTail);
    if (duration && /[,;\n|]|\b(?:options|choices|answers)\s*[:=]/i.test(input.slice(0, duration.index))) {
      draft.durationMinutes = pollDuration(`${duration[1]} ${duration[2]}`); input = input.slice(0, duration.index).trim();
    }
    input = input.replace(/[,;]+$/, '').trim();
    const marker = optionsMarker(input);
    if (marker) {
      draft.question = input.slice(0, marker.index).replace(/[,;\s]+$/, '').trim();
      draft.options = splitPollOptions(input.slice(marker.index! + marker[0].length));
    } else {
      // A question mark or line break preserves commas inside the question.
      const boundary = input.search(/\?\s*[^\s]|\n/);
      const split = boundary >= 0 ? boundary + (input[boundary] === '?' ? 1 : 0)
        : /\?$/.test(input) && draft.durationMinutes === undefined ? -1 : input.indexOf(',');
      if (split >= 0) {
        draft.question = input.slice(0, split).trim();
        draft.options = splitPollOptions(input.slice(split).replace(/^[,;\s]+/, ''));
      } else draft.question = input.trim();
    }
    if (draft.question) draft.question = draft.question.replace(/\s+/g, ' ').trim();
    if (!draft.question) delete draft.question;
    if (!draft.options?.length) delete draft.options;
    validatePollSpec({ token: 'TOKEN', question: 'Question', options: ['Yes', 'No'], durationMinutes: 60, ...draft } as PollSpec);
    return draft;
  }
  const body = input.replace(/^(?:for|on|about)\s+/i, '');
  const fields = [...body.matchAll(/\b(question|ask|options|choices|answers|time|duration|minimum\s+holding|min\s+holding)\s*[:=]\s*/gi)];
  const draft: PollDraft = { minimumHoldingPercent: 0.1 };
  let target = body.slice(0, fields[0]?.index ?? body.length).replace(/[\s,;]+$/, '');
  const duration = target.match(/\s+(?:for|lasting)\s+([\w.]+\s*(?:hours?|hrs?|h|days?|d))[.!]?$/i);
  if (duration) { draft.durationMinutes = pollDuration(duration[1]); target = target.slice(0, duration.index).trim(); }
  if (target) { pollTokenIdentity(target); draft.token = target; }
  const seen = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const name = fields[i][1].toLowerCase();
    const key = /question|ask/.test(name) ? 'question' : /options|choices|answers/.test(name) ? 'options' : /time|duration/.test(name) ? 'durationMinutes' : 'minimumHoldingPercent';
    if (seen.has(key)) throw new Error('Provide only one value for each poll setting.'); seen.add(key);
    const value = body.slice(fields[i].index! + fields[i][0].length, fields[i + 1]?.index ?? body.length).trim().replace(/[,;]$/, '').trim();
    if (key === 'question') draft.question = value;
    else if (key === 'options') {
      const ending = value.match(/\s+(?:for|lasting)\s+([\w.]+\s*(?:hours?|hrs?|h|days?|d))[.!]?$/i);
      if (ending) {
        if (draft.durationMinutes !== undefined) throw new Error('Provide only one duration.');
        draft.durationMinutes = pollDuration(ending[1]);
      }
      draft.options = (ending ? value.slice(0, ending.index) : value).split(/[,;\n|]/).map(x => x.trim()).filter(Boolean);
    }
    else if (key === 'durationMinutes') { if (draft.durationMinutes !== undefined) throw new Error('Provide only one duration.'); draft.durationMinutes = pollDuration(value); }
    else Object.assign(draft, parsePollMinimum(value));
  }
  // Validate supplied values even when the rest will be collected interactively.
  validatePollSpec({ token: 'TOKEN', question: 'Question', options: ['Yes', 'No'], durationMinutes: 60, ...draft } as PollSpec);
  return draft;
}
export const POLL_EXAMPLE = '🗳️ Create a vote for $TOKEN Your question? Options: Yes, No, 1 day\n\nUse one line or several. “Options” is optional; separate choices with commas. You can supply a ticker, contract, or both. Use 2–8 options and a duration of 1 hour to 7 days. Minimum holding defaults to 0.1% of total supply. Add “Minimum holding: 0.05%”, “Minimum holding: $100”, or “Minimum holding: 10,000 tokens”. Dollar amounts are converted to a fixed token amount when the poll is created.';
export function validatePollSpec(value: PollSpec): PollSpec {
  validatePollMinimum(value.minimumHolding);
  const token = value.token.trim(), question = value.question.trim();
  const options = value.options.map(x => x.trim());
  if (!token || token.length > 160 || !question || question.length > 400 || /[\u0000-\u001f]/.test(question)
    || options.length < 2 || options.length > 8 || options.some(x => !x || x.length > 80 || /[\u0000-\u001f]/.test(x))
    || !pollDisplayText(question) || options.some(x => !pollDisplayText(x))
    || new Set(options.map(x => pollDisplayText(x).toLowerCase())).size !== options.length
    || !Number.isInteger(value.durationMinutes) || value.durationMinutes < 60 || value.durationMinutes > 10080
    || !Number.isFinite(value.minimumHoldingPercent) || value.minimumHoldingPercent < 0 || value.minimumHoldingPercent > 100)
    throw new Error(POLL_EXAMPLE);
  return { ...value, token, question, options };
}
export function isPollCommand(text: string) {
  return isPollCreate(text) || /^(?:vote|cast\s+(?:my\s+)?vote)\b|^(?:make|upgrade|endorse)\s+(?:poll\s+)?POLL-[a-f0-9]+\s+(?:as\s+)?official\b/iu.test(pollInputText(text));
}
export function parsePollCreate(text: string): PollSpec | null {
  const draft = parsePollDraft(text);
  if (!draft) return null;
  if (!draft.token || !draft.question || !draft.options || !draft.durationMinutes) throw new Error(POLL_EXAMPLE);
  return validatePollSpec(draft as PollSpec);
}
export function pollTokenIdentity(text: string) {
  if ((text.match(/0x[0-9a-f]+/gi) ?? []).some(x => x.length !== 42)) throw new Error('⚠️ Provide a full token contract address.');
  const addresses = text.match(/0x[0-9a-f]{40}/gi) ?? [];
  if (addresses.length > 1) throw new Error('⚠️ Specify one token contract for this poll.');
  const remainder = text.replace(/0x[0-9a-f]{40}/gi, '').replace(/\b(?:ca|contract|address|ticker|symbol)\b\s*:?/gi, '').replace(/[(),:/]/g, ' ').replace(addresses.length ? /\band\b/gi : /$^/, '').trim();
  const ticker = remainder.replace(/^\$/, '').trim();
  if (ticker && (!/^[\p{L}\p{N}_.$-]{1,64}$/u.test(ticker) || !/[\p{L}\p{N}]/u.test(ticker))) throw new Error('⚠️ Provide a ticker, a contract, or both for the same token.');
  if (!ticker && !addresses.length) throw new Error('⚠️ Provide a token contract address.');
  return { address: addresses[0]?.toLowerCase(), ticker: ticker || undefined };
}
export function pollChoice(text: string, options: string[]) {
  const input = pollInputText(text);
  if (/^[1-8][.!]*$/.test(input) && Number(input.replace(/[.!]/g, '')) <= options.length) return Number(input.replace(/[.!]/g, '')) - 1;
  const normalized = pollDisplayText(input).toLowerCase();
  const exact = options.findIndex(x => pollDisplayText(x).toLowerCase() === normalized);
  if (exact >= 0) return exact;
  const punctuated = options.findIndex(x => pollDisplayText(x).toLowerCase().replace(/[.!?]+$/, '') === normalized.replace(/[.!?]+$/, ''));
  if (punctuated >= 0) return punctuated;
  const choice = text.trim().replace(/^(?:vote|cast\s+(?:my\s+)?vote)\s*/i, '').replace(/^POLL-[a-f0-9]+\s*/i, '').replace(/^(?:for\s+|option\s*)/i, '').replace(/[.!]+$/, '').trim();
  if (/^[1-8]$/.test(choice) && Number(choice) <= options.length) return Number(choice) - 1;
  return options.findIndex(x => pollDisplayText(x).toLowerCase() === pollDisplayText(choice).toLowerCase());
}
export function pollCorrectionAddress(text: string): string {
  const value = pollInputText(text).replace(/^(?:(?:ca|contract(?:\s+address)?|address)\s*:?\s*)+/i, '').replace(/[.!?,;]+$/, '').trim();
  if (!/^0x[0-9a-f]{40}$/i.test(value)) throw new Error('Please supply a full contract address.');
  return value;
}
export function pollPercent(part: string, whole: string) {
  return BigInt(whole) > 0n ? Number(BigInt(part) * 1_000_000n / BigInt(whole)) / 10_000 : 0;
}
export function pollLeadingOptions(options: string[], totals: string[], votedWeight: string) {
  return options.map((text, index) => ({ text, index, weight: BigInt(totals[index] ?? '0') }))
    .sort((a, b) => a.weight === b.weight ? a.index - b.index : a.weight > b.weight ? -1 : 1)
    .slice(0, 3)
    .map(({ text, index, weight }) => ({ text, index, percent: pollPercent(weight.toString(), votedWeight) }));
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
export function pollTokenLabel(symbol: string, address?: string) {
  const suffix = address && /^0x[0-9a-f]{40}$/i.test(address) ? ` (${address.slice(0, 6)}...${address.slice(-4)})` : '';
  return `$${pollDisplayText(symbol)}${suffix}`;
}
export function pollCreatedText(p: { code: string; symbol: string; tokenAddress?: string; question: string; options: string[]; official: boolean; endsAt: number; minimumHoldingPercent: number; minimumHoldingText?: string }) {
  return `🗳️ Vote created: ${p.code}\n${p.official ? 'Official' : 'Community'} ${pollTokenLabel(p.symbol, p.tokenAddress)} poll\n\n${pollDisplayText(p.question)}\n\n${p.options.map((x, i) => `${i + 1}. ${pollDisplayText(x)}`).join('\n')}\n\nMinimum holding: ${p.minimumHoldingText ?? `${p.minimumHoldingPercent}% of total supply at the snapshot`}.\nCloses: ${new Date(p.endsAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}\n\nReply to this post with the option number or option text to vote using your Pons Bot wallet, or vote using an external wallet on the website.\n\nCheck results or vote on the website here:\n${pollUrl(p.code)}`;
}
