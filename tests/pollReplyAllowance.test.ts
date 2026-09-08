import { expect, it } from 'vitest';
import { reserveUnverifiedReply } from '../convex/lib/xUnverifiedReplyLimit';
function fixture(owner = 'owner', expiresAt = Date.now() + 600000) {
  const day = new Date().toISOString().slice(0, 10);
  const tables: Record<string, any[]> = {
    xUnverifiedReplyDays: [{ _id: 'day', xUserId: 'owner', day, count: 9 }],
    pollDraftTurns: [{ _id: 'draft', postId: 'first', owner, state: 'active', expiresAt }],
    xReplyInteractions: [{ _id: 'first', postId: 'first', responsePostId: 'bot-prompt', authorXUserId: 'owner', commandKind: 'poll' }], polls: [],
  };
  const ctx: any = { db: {
    query: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const index: any = { eq: (key: string, value: unknown) => { filters.push([key, value]); return index; } };
      const q: any = { withIndex: (_name: string, cb: any) => { cb(index); return q; }, unique: async () => tables[table].find(row => filters.every(([k, v]) => row[k] === v)) ?? null };
      return q;
    },
    patch: async (id: string, fields: any) => { const row = Object.values(tables).flat().find(r => r._id === id); Object.assign(row, fields); },
  } };
  return { ctx, tables, first: tables.xReplyInteractions[0] };
}
it('allows the original author to finish a voting guide after the tenth reply', async () => {
  const { ctx, tables, first } = fixture();
  expect((await reserveUnverifiedReply(ctx, 'owner', first, 'Which token?', 'reply')).allowed).toBe(true);
  expect(tables.xUnverifiedReplyDays[0]).toMatchObject({ count: 10, continuationPostId: 'first' });
  tables.pollDraftTurns.push({ postId: 'second', owner: 'owner', state: 'ready', expiresAt: Date.now() + 600000 });
  const second = { ...first, postId: 'second', parentPostId: 'bot-prompt' };
  expect((await reserveUnverifiedReply(ctx, 'owner', second, 'Reply retry.', 'thread_continuation')).allowed).toBe(true);
  expect((await reserveUnverifiedReply(ctx, 'owner', { ...second, postId: 'sibling' }, 'Reply retry.', 'thread_continuation')).allowed).toBe(false);
});
it.each(['outsider', 'expired'])('does not grant continuation for an %s draft', async reason => {
  const { ctx, tables, first } = fixture(reason === 'outsider' ? 'other' : 'owner', reason === 'expired' ? 0 : Date.now() + 600000);
  await reserveUnverifiedReply(ctx, 'owner', first, 'Which token?', 'reply');
  expect(tables.xUnverifiedReplyDays[0].continuationPostId).toBeUndefined();
  expect((await reserveUnverifiedReply(ctx, 'owner', { ...first, postId: 'second', parentPostId: 'bot-prompt' }, 'Next', 'reply')).allowed).toBe(false);
});
