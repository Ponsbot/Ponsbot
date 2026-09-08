import { describe, expect, it, vi } from 'vitest';
vi.mock('../lib/voting-access', async original => ({ ...await original<typeof import('../lib/voting-access')>(), X_VOTING_ENABLED: true }));
import { isPollCommand, parsePollCreate, parsePollDraft, pollDisplayText, pollCreatedText, pollTokenIdentity } from '../lib/polls';
import { advancePollDraft, nextPollStep } from '../lib/poll-workflow';
import { draftTurn } from '../convex/polls';
const ca = '0x1111111111111111111111111111111111111111';
describe('flexible vote creation', () => {
  it.each([
    'create a vote Which options should we offer? Options Yes, No, 24 hours, 0.2%',
    'create a vote Which options should we offer? Yes, No 24 hours 0.2%',
    'create a vote Which options should we offer?\nOptions: Yes, No; Duration: 24 hours; holders: 0.2%',
  ])('accepts mixed formatting without eating question words: %s', text => {
    expect(parsePollDraft(text)).toMatchObject({ question: 'Which options should we offer?', options: ['Yes', 'No'], durationMinutes: 1440, minimumHoldingPercent: 0.2 });
  });
  it('keeps percentages as options when no duration precedes them', () => {
    expect(parsePollDraft('create a vote How much should we burn? Options: 25%, 50%')).toMatchObject({ question: 'How much should we burn?', options: ['25%', '50%'], minimumHoldingPercent: 0.1 });
  });
  it('does not turn the end of a question into its duration', () => {
    const draft = parsePollDraft('create a vote Should we wait 2 days');
    expect(draft?.question).toBe('Should we wait 2 days');
    expect(draft?.durationMinutes).toBeUndefined();
  });
  it('preserves a question containing commas when choices have not been supplied', () => {
    expect(parsePollDraft('create a vote Which options are better, red or blue?')).toMatchObject({ question: 'Which options are better, red or blue?' });
    expect(parsePollDraft('create a vote Which options are better, red or blue?')?.options).toBeUndefined();
  });
  it('allows the question to wrap across lines before a labeled option list', () => {
    expect(parsePollDraft('create a vote Should we\nproceed? Options: Yes, No 1 day')?.question).toBe('Should we proceed?');
  });
  it('accepts a token and CA before a single-line question', () => {
    expect(parsePollCreate(`create a poll for $TOKEN CA: ${ca} Proceed? Yes, No, 2h`)).toMatchObject({ token: `$TOKEN CA: ${ca}`, question: 'Proceed?', options: ['Yes', 'No'], durationMinutes: 120 });
  });
  it('prefers the actual options label over options within the question', () => {
    expect(parsePollDraft('create a vote Which options should we offer Options: Yes, No, 1 day')?.question).toBe('Which options should we offer');
  });
  it.each([
    'Create a vote Should we proceed? Yes, No, 1 day',
    'Create a vote Should we proceed? Options Yes, No, 1 day',
    'Create a vote Should we proceed? Options: Yes, No Time: 1 day',
    'Create a vote Should we proceed, Yes, No, 1 day',
    'Create a vote Should we proceed\nYes, No\n1 day',
  ])('reads question, options and duration in order: %s', text => {
    expect(parsePollDraft(text)).toMatchObject({ question: expect.stringMatching(/^Should we proceed\??$/), options: ['Yes', 'No'], durationMinutes: 1440, minimumHoldingPercent: 0.1 });
    expect(parsePollDraft(text)?.token).toBeUndefined();
  });
  it.each(['0.05%', 'holder 0.05%', 'Minimum holding: 0.05%'])('reads an optional final threshold %s', ending => {
    expect(parsePollDraft(`create a vote Proceed? options Yes, No, 2 hours, ${ending}`)).toMatchObject({ question: 'Proceed?', options: ['Yes', 'No'], durationMinutes: 120, minimumHoldingPercent: 0.05 });
  });
  it('retains an explicit token prefix and unlabeled multiline settings', () => {
    expect(parsePollCreate('create a vote for $TOKEN\nShould we proceed\nYes, No\n2 days')).toMatchObject({ token: '$TOKEN', question: 'Should we proceed', options: ['Yes', 'No'], durationMinutes: 2880 });
  });
  it('keeps a question-only request and asks for missing details', () => {
    expect(parsePollDraft('create a vote Should we proceed?')).toMatchObject({ question: 'Should we proceed?', minimumHoldingPercent: 0.1 });
  });
  it.each(['Create a vote', 'please create a poll', 'Hey, can you start a vote', 'I want to make a poll', "I'd like to open a vote", 'set up a poll', '@Ponsbotfamily create a vote'])('recognizes %s', prefix => {
    const result = parsePollCreate(`${prefix} for $TOKEN\nQuestion: Proceed?\nOptions: Yes, No, Abstain\nTime: 2 days`);
    expect(result).toMatchObject({ options: ['Yes', 'No', 'Abstain'], durationMinutes: 2880, minimumHoldingPercent: 0.1 });
  });
  it.each(['$TOKEN', ca, `$TOKEN ${ca}`, `${ca} $TOKEN`, `ticker: $TOKEN CA: ${ca}`])('accepts token identifier %s', token => {
    expect(parsePollDraft(`create a poll for ${token}`)?.token).toBe(token);
    expect(pollTokenIdentity(token)).toBeTruthy();
  });
  it.each(['12 hours', '12 hrs', '12h', 'two days', '2d'])('accepts %s durations', time => {
    expect(parsePollCreate(`create a poll for TOKEN\nDuration: ${time}\nChoices: Yes, No\nQuestion: Proceed?`)?.durationMinutes).toBe(/two|2/.test(time) && !time.startsWith('12') ? 2880 : 720);
  });
  it('accepts a natural duration at the end', () => {
    expect(parsePollCreate('please create a poll for TOKEN Question: Proceed? Options: Yes, No for 2 days')?.durationMinutes).toBe(2880);
  });
  it('does not trigger on promotional or unrelated action language', () => {
    for (const text of ['This lets you create a poll', 'buy $20 of VOTE', 'launch Vote $VOTE', 'send POLL to wallet']) expect(isPollCommand(text)).toBe(false);
  });
  it('rejects conflicting durations and invalid holder minima', () => {
    expect(() => parsePollDraft('create a poll for TOKEN for 2 days Duration: 1 hour')).toThrow();
    expect(() => parsePollDraft('create a poll for TOKEN Minimum holding: 101%')).toThrow();
  });
  it('neutralizes mentions, hashtags, and cashtags in user text', () => {
    const output = pollCreatedText({ code: 'POLL-test', official: false, symbol: '@BAD#$TOKEN', question: 'Should @someone buy $TOKEN #now?', options: ['@Yes', '#No'], endsAt: Date.now(), minimumHoldingPercent: 0.1 });
    expect(output).not.toMatch(/[@#]/); expect(output.match(/\$/g)).toHaveLength(1); // Only the deliberate token label.
    expect(pollDisplayText('＠someone ＃tag ＄TOKEN')).toBe('someone tag TOKEN');
    expect(() => parsePollCreate('create a poll for TOKEN Question: Proceed? Options: @yes, #yes Time: 1 day')).toThrow();
  });
});
describe('guided creation', () => {
  it('collects each setting and confirms with the default threshold', () => {
    let draft = parsePollDraft('create a vote')!;
    let step = nextPollStep(draft);
    for (const input of [`$TOKEN ${ca}`, 'What should we do?', 'Yes, No, Abstain', '2 days', 'default']) {
      const next = advancePollDraft(draft, step, input); expect(next.state).toBe('active'); draft = next.draft; step = next.step;
    }
    expect(step).toBe('confirm');
    const result = advancePollDraft(draft, step, '@Ponsbotfamily confirm!');
    expect(result.state).toBe('ready'); expect(result.draft).toMatchObject({ minimumHoldingPercent: 0.1, options: ['Yes', 'No', 'Abstain'], durationMinutes: 2880 });
  });
  it('preserves prefilled fields and validates a custom threshold', () => {
    const d = parsePollDraft('create a poll for TOKEN Time: 2 days')!;
    expect(nextPollStep(d)).toBe('question');
    d.question = 'Proceed?'; d.options = ['Yes', 'No'];
    expect(advancePollDraft(d, 'minimum', '0.05%').draft.minimumHoldingPercent).toBe(0.05);
    expect(advancePollDraft(d, 'minimum', '101%').draft).toEqual(d);
  });
  it('allows help, back, and cancellation without creating a poll', () => {
    const d = { token: 'TOKEN', minimumHoldingPercent: 0.1 };
    expect(advancePollDraft(d, 'options', 'what does this mean?')).toMatchObject({ draft: d, step: 'options', state: 'active' });
    expect(advancePollDraft(d, 'options', 'back!').step).toBe('question');
    expect(advancePollDraft(d, 'options', 'cancel please').state).toBe('cancelled');
  });
});
type Row = Record<string, any>;
const invoke = (ctx: any, a: any) => (draftTurn as any)._handler(ctx, a);
function fixture() {
  const rows: Row[] = [];
  const ctx = { db: {
    query: () => { let postId = ''; const q: any = { withIndex: (_name: any, cb: any) => { cb({ eq: (_k: any, value: string) => { postId = value; } }); return q; }, unique: async () => rows.find(x => x.postId === postId) ?? null }; return q; },
    insert: async (_table: any, row: any) => { rows.push({ _id: row.postId, ...row }); },
    patch: async (id: any, fields: any) => Object.assign(rows.find(x => x._id === id)!, fields),
  } };
  return { ctx, rows };
}
describe('persisted reply safety', () => {
  it('retries frozen confirmation settings with the same creation identity', async () => {
    const { ctx, rows } = fixture();
    rows.push({ _id: 'confirm', postId: 'confirm', owner: 'owner', expiresAt: Date.now() + 600000, state: 'ready', step: 'confirm', creationPostId: 'confirm',
      draft: { token: 'TOKEN', question: 'Proceed?', options: ['Yes', 'No'], durationMinutes: 60, minimumHoldingPercent: 0.1 } });
    const retry = await invoke(ctx, { postId: 'retry', owner: 'owner', text: 'retry!', parentDraftPostId: 'confirm' });
    expect(retry).toMatchObject({ state: 'ready', creationPostId: 'confirm', draft: rows[0].draft });
    expect(await invoke(ctx, { postId: 'sibling', owner: 'owner', text: 'retry', parentDraftPostId: 'confirm' })).toBeNull();
    expect(await invoke(ctx, { postId: 'retry2', owner: 'owner', text: 'resume', parentDraftPostId: 'retry' })).toMatchObject({ state: 'ready', creationPostId: 'confirm' });
  });
  it('blocks another author and sibling replies; retries reuse the saved turn', async () => {
    const { ctx, rows } = fixture();
    await invoke(ctx, { postId: 'root', owner: 'owner', text: 'create a vote' });
    expect(await invoke(ctx, { postId: 'foreign', owner: 'outsider', text: 'TOKEN', parentDraftPostId: 'root' })).toBeNull();
    const first = await invoke(ctx, { postId: 'reply', owner: 'owner', text: 'TOKEN', parentDraftPostId: 'root' });
    expect(await invoke(ctx, { postId: 'sibling', owner: 'owner', text: 'OTHER', parentDraftPostId: 'root' })).toBeNull();
    expect(await invoke(ctx, { postId: 'reply', owner: 'owner', text: 'TOKEN', parentDraftPostId: 'root' })).toMatchObject(first);
    expect(rows).toHaveLength(2);
  });
  it('expires after ten minutes and cannot proceed after cancellation', async () => {
    const { ctx, rows } = fixture();
    await invoke(ctx, { postId: 'root', owner: 'owner', text: 'create a vote' }); rows[0].expiresAt = 0;
    const expired = await invoke(ctx, { postId: 'expired', owner: 'owner', text: 'TOKEN', parentDraftPostId: 'root' });
    expect(expired.state).toBe('cancelled'); expect(expired.message).toContain('expired');
    expect((await invoke(ctx, { postId: 'later', owner: 'owner', text: 'confirm', parentDraftPostId: 'expired' })).state).toBe('cancelled');
  });
});
