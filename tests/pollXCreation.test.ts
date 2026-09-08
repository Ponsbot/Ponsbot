import { expect, it, vi } from 'vitest';
vi.mock('../lib/voting-access', async original => ({ ...await original<typeof import('../lib/voting-access')>(), X_VOTING_ENABLED: true }));
import { handleX, request } from '../convex/polls';
import { pollCreatedText } from '../lib/polls';
import { advancePollDraft, pollPrompt } from '../lib/poll-workflow';
import { safePollError } from '../lib/poll-errors';

const wallet = { address: '0x1111111111111111111111111111111111111111', status: 'active', chainId: 4663 };
it.each(['Create a vote', 'Create a poll for $TOKEN', 'Create a vote for $TOKEN Proceed? Options: Yes, No, 1 day'])('rejects unverified creation: %s', async text => {
  const ctx = { runQuery: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ user: { verified: false }, wallet }), runMutation: vi.fn() };
  const result = await (handleX as any)._handler(ctx, { postId: '1', owner: 'owner', text });
  expect(result.result.message).toBe('⚠️ Only verified X accounts can create polls.');
  expect(ctx.runMutation).not.toHaveBeenCalled();
});
it('starts a verified partial request and asks for missing details', async () => {
  const ctx = { runQuery: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ user: { verified: true }, wallet }), runMutation: vi.fn().mockResolvedValue({ message: pollPrompt('token', {}), state: 'active' }) };
  const result = await (handleX as any)._handler(ctx, { postId: '1', owner: 'owner', text: 'Create a vote' });
  expect(result.result.message).toContain('Reply with a ticker or contract address.');
  expect(ctx.runMutation.mock.calls[0][1]).toMatchObject({ text: 'Create a vote' });
});
it('does not apply verification restriction to a voter without a wallet', async () => {
  const ctx = { runQuery: vi.fn().mockResolvedValueOnce({ code: 'POLL-X', owner: 'creator' }).mockResolvedValueOnce({ spec: { options: ['Yes', 'No'] } }).mockResolvedValueOnce({ user: { verified: false }, wallet: null }) };
  const result = await (handleX as any)._handler(ctx, { postId: '1', owner: 'voter', text: '1', parentPostId: 'poll' });
  expect(result.result.message).toContain('don’t have enough tokens in your Pons Bot wallet');
  expect(result.result.message).toContain('Buying more now will not change eligibility for this poll.');
});
it('enforces verification inside the creation mutation too', async () => {
  const q: any = { withIndex: () => q, unique: async () => ({ verified: false }) };
  await expect((request as any)._handler({ db: { query: () => q } }, { source: 'x', ownerXUserId: 'other' })).rejects.toThrow('Only verified');
});
it.each(['yes', 'yes!', '0.05%'])('minimum answer %s creates without a review prompt', input => {
  const d = { token: 'TOKEN', question: 'Proceed?', options: ['Yes', 'No'], durationMinutes: 60, minimumHoldingPercent: 0.1 };
  expect(advancePollDraft(d, 'minimum', input)).toMatchObject({ state: 'ready', message: 'Preparing the holder snapshot.' });
});
it('formats the creation instructions and website link', () => {
  const text = pollCreatedText({ code: 'POLL-X', symbol: 'TOKEN', question: 'Proceed?', options: ['Yes', 'No'], official: false, endsAt: 0, minimumHoldingPercent: 0.1 });
  expect(text).toContain('\n\nReply to this post');
  expect(text).toContain('or vote using an external wallet on the website.');
  expect(text).toContain('Check results or vote on the website here:\n');
  expect(text).not.toContain('Votes cannot be changed');
});
it.each(['No tokens held at the poll snapshot', 'This wallet has no eligible voting balance.', 'Your snapshot balance is below the minimum holding requirement.'])('explains snapshot eligibility for %s', message => {
  expect(safePollError(new Error(message))).toContain('Buying more now will not change eligibility for this poll.');
});
