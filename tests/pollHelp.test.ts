import { expect, it, vi } from 'vitest';
import { pollHelpKind, isPollCommand, POLL_CREATE_HELP, POLL_VOTE_HELP } from '../lib/polls';
import { advancePollDraft } from '../lib/poll-workflow';
import { handleX } from '../convex/polls';
it.each(['How do I vote?', '@Ponsbotfamily how can I vote?', 'How to vote', 'How does voting work?', 'Voting help', 'How do I vote in this poll?'])('recognizes voting help: %s', text => {
  expect(pollHelpKind(text)).toBe('vote'); expect(isPollCommand(text)).toBe(true);
});
it.each(['How do I create a vote?', 'How can I create a poll?', 'How to start a vote', 'Help me create a poll', 'Can you explain how to make a poll?'])('recognizes creation help: %s', text => {
  expect(pollHelpKind(text)).toBe('create'); expect(isPollCommand(text)).toBe(true);
});
it.each(['create a vote', 'vote 1', 'How do I launch?', 'buy $10 of VOTE', 'launch Vote $VOTE', 'Should we vote to burn?', 'How do I create a vote? Options: Yes, No'])('does not mistake commands or poll content for help: %s', text => {
  expect(pollHelpKind(text)).toBeNull();
});
it.each(['How do I vote?', 'How do I create a poll?'])('answers without wallet lookup or transaction: %s', async text => {
  const ctx = { runQuery: vi.fn(async () => null), runMutation: vi.fn(), runAction: vi.fn() };
  const result = await (handleX as any)._handler(ctx, { postId: '123', owner: '123456', text });
  expect(result.result.message).toBe(text.includes('create') ? POLL_CREATE_HELP : POLL_VOTE_HELP);
  expect(ctx.runQuery).toHaveBeenCalledOnce(); expect(ctx.runMutation).not.toHaveBeenCalled(); expect(ctx.runAction).not.toHaveBeenCalled();
});
it('preserves a guided draft and re-prompts the current step after help', () => {
  const draft = { token: '$PONSBOT', question: 'Proceed?' };
  const result = advancePollDraft(draft, 'options', 'How do I vote?');
  expect(result).toMatchObject({ draft, step: 'options', state: 'active' });
  expect(result.message).toContain('What are the choices?');
});
it('does not let another user interrupt a guided poll through a help question', async () => {
  const ctx = { runQuery: vi.fn(async () => ({ draftPostId: 'draft', owner: 'creator' })), runMutation: vi.fn() };
  expect(await (handleX as any)._handler(ctx, { postId: '123', owner: 'outsider', text: 'How do I vote?' })).toEqual({ handled: true });
  expect(ctx.runMutation).not.toHaveBeenCalled();
});
