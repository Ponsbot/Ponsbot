import { expect, it } from 'vitest';
import { X_VOTING_ENABLED, WEBSITE_VOTING_PUBLIC, votingPreviewAllowed, anonymousVotingSession } from '../lib/voting-access';
it('enables X and website voting for the public', () => {
  expect(X_VOTING_ENABLED).toBe(true);
  expect(WEBSITE_VOTING_PUBLIC).toBe(true);
  expect(votingPreviewAllowed(undefined)).toBe(true);
  expect(votingPreviewAllowed('another-account')).toBe(true);
});
it('still requires a valid anonymous session identity', () => {
  expect(anonymousVotingSession('guest', 'a'.repeat(64))).toBe(true);
  expect(anonymousVotingSession('guest', '')).toBe(false);
  expect(anonymousVotingSession('another-account', 'a'.repeat(64))).toBe(false);
});
