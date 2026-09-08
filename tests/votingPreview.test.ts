import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { votingPreviewAllowed, VOTING_PREVIEW_X_ID, X_VOTING_ENABLED } from '../lib/voting-access';
import * as polls from '../convex/polls';
import { enqueue } from '../convex/xReplyQueue';
import { getFunctionName } from 'convex/server';
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const auth = { secret: 'local-test', owner: VOTING_PREVIEW_X_ID, sessionId: 'web_test' };
beforeEach(() => vi.stubEnv('WEB_AUTH_SECRET', auth.secret));
afterEach(() => vi.unstubAllEnvs());
describe('private voting rollout', () => {
  it('uses the immutable owner ID, not a display handle', () => {
    expect(votingPreviewAllowed(VOTING_PREVIEW_X_ID)).toBe(true);
    for (const value of ['ponsboyfamily', 'Ponsboyfamily', undefined, '123']) expect(votingPreviewAllowed(value)).toBe(false);
    expect(X_VOTING_ENABLED).toBe(false);
  });
  it('has no public raw poll queries', () => {
    expect((polls.list as any).isInternal).toBe(true);
    expect((polls.get as any).isInternal).toBe(true);
  });
  it('rejects reads by a different account before querying sessions or data', async () => {
    const ctx = { runAction: vi.fn(), runQuery: vi.fn() };
    await expect(invoke(polls.browse, ctx, { ...auth, owner: 'outsider' })).rejects.toThrow('Unauthorized');
    expect(ctx.runAction).not.toHaveBeenCalled(); expect(ctx.runQuery).not.toHaveBeenCalled();
  });
  it('rejects a revoked preview session', async () => {
    const ctx = { runAction: vi.fn(async () => false), runQuery: vi.fn() };
    await expect(invoke(polls.browse, ctx, auth)).rejects.toThrow('Unauthorized');
    expect(ctx.runQuery).not.toHaveBeenCalled();
  });
  it('allows the active preview owner to browse', async () => {
    const ctx = { runAction: vi.fn(async () => true), runQuery: vi.fn(async (_ref: any, _args: any) => ({ items: [], next: null })) };
    expect(await invoke(polls.browse, ctx, auth)).toEqual({ items: [], next: null });
    expect(getFunctionName(ctx.runQuery.mock.calls[0][0])).toBe('polls:list');
  });
  it.each(['create', 'vote', 'endorse', 'correct'])('rejects %s from another account', async operation => {
    const ctx = { runAction: vi.fn(), runMutation: vi.fn() };
    await expect(invoke(polls.web, ctx, { ...auth, owner: 'outsider', operation, eventId: 'valid_event_123' })).rejects.toThrow('Unauthorized');
    expect(ctx.runAction).not.toHaveBeenCalled(); expect(ctx.runMutation).not.toHaveBeenCalled();
  });
  it('does not start a poll or respond to an X poll command, even for the owner', async () => {
    const ctx = { runQuery: vi.fn(async () => null), runMutation: vi.fn(), runAction: vi.fn() };
    expect(await invoke(polls.handleX, ctx, { postId: '123', owner: auth.owner, text: 'Create a vote for $PONSBOT' })).toEqual({ handled: true });
    expect(ctx.runMutation).not.toHaveBeenCalled(); expect(ctx.runAction).not.toHaveBeenCalled();
  });
  it('does not intercept unrelated X commands', async () => {
    expect(await invoke(polls.handleX, { runQuery: vi.fn(async () => null) }, { postId: '123', owner: auth.owner, text: 'buy $10 of PONSBOT' })).toEqual({ handled: false });
  });
  it.each(['poll_created', 'poll_result'])('blocks %s at the publication queue as well', async kind => {
    expect(await invoke(enqueue, {}, { kind, key: 'preview', text: 'test' })).toEqual({ status: 'cancelled' });
  });
  it('closes a website poll without publishing on X', async () => {
    const p = { _id: 'p', status: 'open', endsAt: Date.now() - 1, xPostId: 'old', snapshot: {}, code: 'POLL-123' };
    const q: any = { withIndex: () => q, unique: async () => p };
    const ctx = { db: { query: () => q, patch: vi.fn() }, runMutation: vi.fn() };
    await invoke(polls.close, ctx, { code: p.code });
    expect(ctx.db.patch).toHaveBeenCalled(); expect(ctx.runMutation).not.toHaveBeenCalled();
  });
});
