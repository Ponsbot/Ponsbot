import { expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
vi.mock('../lib/voting-access', async original => ({ ...await original<typeof import('../lib/voting-access')>(), X_VOTING_ENABLED: true }));
vi.mock('../lib/poll-chain', async original => ({ ...await original<typeof import('../lib/poll-chain')>(), pollVotingBalance: vi.fn(async () => '1000'), assertPollBlock: vi.fn(async () => {}) }));
import { pollChoice, pollCorrectionAddress } from '../lib/polls';
import { advancePollDraft } from '../lib/poll-workflow';
import { handleX } from '../convex/polls';
const ca = '0x1111111111111111111111111111111111111111';
it('allows punctuation on option text while retaining numbered-option precedence', () => {
  expect(pollChoice('Vote!', ['Vote', 'Other'])).toBe(0);
  expect(pollChoice('2', ['2', '3'])).toBe(1);
});
it.each(['Vote', 'Vote now', 'Option A', 'Cancel poll', 'Create a vote', 'Make it official'])('matches option text before commands: %s', option => {
  expect(pollChoice(option, [option, 'Other'])).toBe(0);
});
it.each(['Vote', 'Option A', 'Cancel poll', 'Create a vote', 'Make it official'])('records %s as a vote, not a command', async option => {
  const p = { code: 'POLL-X', tokenAddress: ca, status: 'open', endsAt: Date.now() + 60000, spec: { options: [option, 'Other'] }, snapshot: { symbol: 'TOKEN', decimals: 0, supply: '100000', exclusions: [] } };
  const ctx = { runQuery: vi.fn(async (ref: any) => {
    const name = getFunctionName(ref);
    if (name === 'polls:context') return { code: p.code, owner: 'owner' };
    if (name === 'polls:record') return p;
    if (name === 'wallets:getXUserAndWallet') return { user: { verified: false }, wallet: { status: 'active', chainId: 4663, address: ca } };
    if (name === 'polls:ballot') return { poll: p };
    throw Error(name);
  }), runMutation: vi.fn(async (ref: any, _args: any) => getFunctionName(ref) === 'polls:saveVote' ? { weight: '1000' } : true) };
  const result = await (handleX as any)._handler(ctx, { postId: '1234567890', owner: 'owner', text: option, parentPostId: 'bot' });
  expect(result.result.message).toContain('Vote recorded');
  expect(ctx.runMutation.mock.calls.map(c => getFunctionName(c[0]))).toEqual(['polls:gate', 'polls:saveVote']);
});
it.each(['no', 'No!', 'none', 'no please'])('does not create on minimum answer %s', text => {
  expect(advancePollDraft({ token: 'TOKEN', question: 'Proceed?', options: ['Yes', 'No'], durationMinutes: 60 }, 'minimum', text).state).toBe('active');
});
it.each([ca, `CA: ${ca}`, `contract address: ${ca}.`, `@Ponsbotfamily Address ${ca}!`])('accepts contract correction %s', text => expect(pollCorrectionAddress(text)).toBe(ca));
it.each([`${ca} ${ca}`, `buy ${ca}`, 'CA: 0x123', `${ca} unrelated`])('rejects ambiguous or unrelated correction %s', text => expect(() => pollCorrectionAddress(text)).toThrow());
