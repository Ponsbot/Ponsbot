import { expect, it } from 'vitest';
import { safePollError } from '../lib/poll-errors';
it.each([
  ['No tokens held at the poll snapshot', 'did not hold any'],
  ['This wallet has no eligible voting balance.', 'no eligible directly held'],
  ['Your snapshot balance is below the minimum holding requirement.', 'below this poll'],
  ['You have already voted in this poll.', 'cannot be changed'],
  ['This poll has closed.', 'has closed'],
  ['missing trie node', 'does not mean you were ineligible'],
  ['HTTP 429 at https://secret-provider/key', 'network provider'],
])('explains wrapped %s without exposing internal details', (error, expected) => {
  const message = safePollError(new Error(`[Request ID: private] Server Error\nUncaught Error: ${error}\n at handler secret.ts:99`));
  expect(message).toContain(expected);
  expect(message).not.toMatch(/private|secret|https|handler/);
});
it('does not turn an unknown provider failure into an eligibility rejection', () => {
  expect(safePollError(new Error('Unexpected provider error with secret'))).toContain('could not be completed');
});
