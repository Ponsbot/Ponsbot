import { pollDisplayText, pollDuration, pollInputText, pollTokenIdentity, validatePollSpec, type PollDraft, type PollSpec } from './polls';
import { parsePollMinimum, pollMinimumText } from './poll-minimum';
import { pollHelpKind, POLL_CREATE_HELP, POLL_VOTE_HELP } from './polls';
export type PollStep = 'token' | 'question' | 'options' | 'duration' | 'minimum' | 'confirm';
export const nextPollStep = (d: PollDraft): PollStep => !d.token ? 'token' : !d.question ? 'question' : !d.options ? 'options' : !d.durationMinutes ? 'duration' : 'minimum';
export function pollPrompt(step: PollStep, d: PollDraft): string {
  if (step === 'token') return '🗳️ Which token is this vote for? Reply with a ticker or contract address.\nExample: $PONSBOT';
  if (step === 'question') return '🗳️ What question would you like holders to vote on?';
  if (step === 'options') return '🗳️ What are the choices? Provide 2–8 options separated by commas or on separate lines.\nExample: Yes, No';
  if (step === 'duration') return '⏱️ How long should voting stay open? Choose 1 hour to 7 days.\nExample: 12 hours or 2 days';
  if (step === 'minimum') return `🗳️ Default minimum token holdings to vote is ${pollMinimumText(d.minimumHoldingPercent ?? 0.1, d.minimumHolding)}. Reply yes to proceed or provide a percentage, dollar amount, or number of tokens.\nExample: 0.1%, $100, or 10,000 tokens.`;
  return `🗳️ Review your poll\nToken: ${pollDisplayText(d.token!)}\n\n${pollDisplayText(d.question!)}\n\n${d.options!.map((x, i) => `${i + 1}. ${pollDisplayText(x)}`).join('\n')}\n\nDuration: ${d.durationMinutes! % 1440 === 0 ? `${d.durationMinutes! / 1440} days` : `${d.durationMinutes! / 60} hours`}\nMinimum holding: ${d.minimumHoldingPercent ?? 0.1}% of total supply.\n\nReply confirm to create it, back to change a setting, or cancel.`;
}
export function advancePollDraft(draft: PollDraft, step: PollStep, input: string): { draft: PollDraft; step: PollStep; message: string; state: 'active' | 'cancelled' | 'ready' } {
  const text = pollInputText(input), control = text.toLowerCase().replace(/[.!?,]+$/g, '').trim();
  const d = { ...draft };
  const help = pollHelpKind(text);
  if (help) return { draft: d, step, state: 'active', message: `${help === 'create' ? POLL_CREATE_HELP : POLL_VOTE_HELP}\n\n${pollPrompt(step, d)}` };
  if (/^(?:cancel|stop|never mind|nevermind)(?: please)?$/.test(control)) return { draft: d, step, state: 'cancelled', message: 'Poll setup cancelled.' };
  if (/^(?:back|go back)(?: please)?$/.test(control)) {
    const steps: PollStep[] = ['token', 'question', 'options', 'duration', 'minimum', 'confirm'];
    const previous = steps[Math.max(0, steps.indexOf(step) - 1)];
    return { draft: d, step: previous, state: 'active', message: pollPrompt(previous, d) };
  }
  if (/^(?:help|what does (?:this|that|it) mean|explain(?: this| that)?|how does (?:this|that|it) work)[?!.]*$/i.test(text)) {
    const explanation = step === 'minimum' ? 'Set the minimum as a percentage, a dollar value, or a token amount. Dollar values are converted using the market cap when the poll is created. That token requirement stays fixed; eligibility and voting weight use snapshot balances.'
      : step === 'duration' ? 'Voting opens after the snapshot is verified and closes when this amount of time has passed.'
      : step === 'token' ? 'You can use a token ticker, its Robinhood Chain contract, or both. If a ticker is ambiguous, I will ask for the contract.'
      : step === 'options' ? 'Holders choose one option. Give each option a different, short label.'
      : 'This is an advisory holder poll. It does not move funds or execute transactions.';
    return { draft: d, step, state: 'active', message: `ℹ️ ${explanation}\n\n${pollPrompt(step, d)}` };
  }
  try {
    if (step === 'confirm') {
      if (!/^(?:confirm|yes|approve|create it|go ahead)(?: please)?$/.test(control)) throw new Error('Reply confirm, back, or cancel.');
      validatePollSpec(d as PollSpec);
      return { draft: d, step, state: 'ready', message: 'Preparing the holder snapshot.' };
    }
    if (step === 'token') { pollTokenIdentity(text); d.token = text; }
    if (step === 'question') d.question = text;
    if (step === 'options') d.options = text.replace(/^(?:options|choices)\s*:\s*/i, '').split(/[,;\n|]/).map(x => x.trim().replace(/^\d+[.)]\s*/, '')).filter(Boolean);
    if (step === 'duration') d.durationMinutes = pollDuration(text);
    if (step === 'minimum') {
      if (/^(?:default|keep default)(?: please)?$/.test(control)) { d.minimumHoldingPercent = 0.1; delete d.minimumHolding; }
      else if (/^(?:yes|keep|keep it)(?: please)?$/.test(control)) d.minimumHoldingPercent ??= 0.1;
      else { delete d.minimumHolding; Object.assign(d, parsePollMinimum(text)); }
    }
    validatePollSpec({ token: 'TOKEN', question: 'Question', options: ['Yes', 'No'], durationMinutes: 60, minimumHoldingPercent: 0.1, ...d });
    if (step === 'minimum') return { draft: d, step, state: 'ready', message: 'Preparing the holder snapshot.' };
    const next = nextPollStep(d);
    return { draft: d, step: next, state: 'active', message: pollPrompt(next, d) };
  } catch {
    return { draft, step, state: 'active', message: `⚠️ That setting wasn't valid.\n\n${pollPrompt(step, draft)}` };
  }
}
