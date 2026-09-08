import { describe, expect, it, vi } from 'vitest';
vi.mock('../lib/voting-access', async original => ({ ...await original<typeof import('../lib/voting-access')>(), X_VOTING_ENABLED: true }));
import { parsePollCreate, pollTokenIdentity, pollChoice, updatePollTotals, validatePollSpec, pollPercent, isPollCancel } from '../lib/polls';
import { saveVote, correctToken, close, cancel, list } from '../convex/polls';

const ca = '0x1111111111111111111111111111111111111111';
const command = 'Create a vote for $PONSBOT\nQuestion: Make a change?\nOptions: Yes, No\nTime: 1 day';
describe('poll commands and immutable settings', () => {
  it('defaults to a 0.1% minimum holding', () => expect(parsePollCreate(command)).toMatchObject({ durationMinutes: 1440, minimumHoldingPercent: 0.1, options: ['Yes', 'No'] }));
  it.each([0, 0.05, 1, 100])('allows a custom %s percent threshold', n => expect(parsePollCreate(`${command}\nMinimum holding: ${n}%`)?.minimumHoldingPercent).toBe(n));
  it('accepts ticker and CA together', () => expect(pollTokenIdentity(`$PONSBOT CA: ${ca}`)).toEqual({ ticker: 'PONSBOT', address: ca }));
  it('accepts Unicode tickers', () => expect(pollTokenIdentity(`$日本 ${ca}`)).toMatchObject({ ticker: '日本' }));
  it('accepts contract-only requests', () => expect(pollTokenIdentity(ca)).toEqual({ ticker: undefined, address: ca }));
  it('rejects two contracts', () => expect(() => pollTokenIdentity(`${ca} ${ca}`)).toThrow());
  it('accepts comma-separated labeled commands', () => expect(parsePollCreate('Create a vote for $ABC, Question: Proceed?, Options: Yes, No, Time: 1 hr')?.options).toEqual(['Yes', 'No']));
  it.each(['Time: 0.5 hr', 'Time: 8 days', 'Time: tomorrow'])('rejects invalid duration %s', t => expect(() => parsePollCreate(command.replace('Time: 1 day', t))).toThrow());
  it('rejects duplicate normalized options', () => expect(() => parsePollCreate(command.replace('Yes, No', 'YES, yes'))).toThrow());
  it('rejects an excessive custom threshold', () => expect(() => parsePollCreate(`${command}\nMinimum holding: 101%`)).toThrow());
  it('rejects control characters in questions', () => expect(() => validatePollSpec({ ...parsePollCreate(command)!, question: 'Hello\u0000' })).toThrow());
  it.each(['1', 'vote 1', '1!', 'Yes', 'yes', 'YES', 'Yes.', 'vote POLL-1234567890ABCDEF option 1'])('recognizes %s', text => expect(pollChoice(text, ['Yes', 'No'])).toBe(0));
  it('accepts the full text of a custom option', () => expect(pollChoice('Increase the rewards', ['Keep rewards', 'Increase the rewards'])).toBe(1));
  it('does not mistake a transaction for a vote', () => expect(pollChoice('buy $20 of YES', ['Yes', 'No'])).toBe(-1));
  it('retallies choice changes without doubling weight', () => expect(updatePollTotals(['100', '50'], { option: 0, weight: '100' }, 1, '100')).toEqual(['0', '150']));
  it('uses bigint arithmetic for large holdings', () => expect(pollPercent('1000000000000000000000000', '1000000000000000000000000000')).toBe(0.1));
});

// Exercise the actual mutation handlers with a deterministic in-memory DB.
type Row = Record<string, any>;
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
function fixture() {
  const p: Row = { _id: 'poll', code: 'POLL-1234567890ABCDEF', ownerXUserId: 'owner', status: 'open', createdAt: Date.now(), endsAt: Date.now() + 60000,
    spec: parsePollCreate(command), totals: ['0', '0'], votedWeight: '0', voterCount: 0,
    snapshot: { supply: '1000000', activeSupply: '900000', exclusions: [{ address: ca, balance: '100000' }] } };
  const tables: Record<string, Row[]> = { polls: [p], pollVotes: [], pollVoteEvents: [], pollDuplicateNotices: [] };
  const db = {
    query(name: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const index = { eq(k: string, v: unknown) { filters.push(r => r[k] === v); return index; }, lt(k: string, v: number) { filters.push(r => r[k] < v); return index; } };
      const q = { withIndex(_name: string, f: any) { f(index); return q; }, order: () => q, take: async (n: number) => tables[name].filter(r => filters.every(f => f(r))).sort((a, b) => b.createdAt - a.createdAt).slice(0, n), unique: async () => tables[name].find(r => filters.every(f => f(r))) ?? null };
      return q;
    },
    async insert(name: string, data: Row) { const id = `${name}-${tables[name].length}`; tables[name].push({ ...data, _id: id }); return id; },
    async patch(id: string, data: Row) { Object.assign(Object.values(tables).flat().find(r => r._id === id)!, data); },
  };
  const ctx = { db, scheduler: { runAfter: vi.fn() }, runMutation: vi.fn(async (_ref: unknown, _args: unknown) => ({ status: 'queued' })) };
  const cast = (overrides: Row = {}) => invoke(saveVote, ctx, { code: p.code, wallet: '0xAbCd', xOwner: 'owner', option: 0, weight: '1000', event: 'x:first', source: 'x', eventOrder: '100', ...overrides });
  return { p, tables, ctx, cast };
}

describe('completed poll listing', () => {
  it('publishes the winning option first without advisory boilerplate', async () => {
    const f = fixture();
    Object.assign(f.p, { xPostId: 'created-post', endsAt: Date.now() - 1, totals: ['100', '900'], votedWeight: '1000', voterCount: 2 });
    f.p.snapshot.symbol = 'TEST';
    await invoke(close, f.ctx, { code: f.p.code });
    const text = (f.ctx.runMutation.mock.calls[0][1] as { text: string }).text;
    expect(text).toContain('Winning option: No');
    expect(text.indexOf('2. No: 90.00%')).toBeLessThan(text.indexOf('1. Yes: 10.00%'));
    expect(text).not.toMatch(/Leading option|Advisory result/);
  });
  it('merges closed and cancelled polls newest first, without ongoing polls', async () => {
    const f = fixture();
    f.tables.polls.push({ ...f.p, code: 'closed', status: 'closed', createdAt: 10 }, { ...f.p, code: 'cancelled', status: 'cancelled', createdAt: 20 });
    const result = await invoke(list, f.ctx, { closed: true });
    expect(result.items.map((p: Row) => [p.code, p.status])).toEqual([['cancelled', 'cancelled'], ['closed', 'closed']]);
    expect((await invoke(list, f.ctx, {})).items.map((p: Row) => p.code)).toEqual([f.p.code]);
  });
  it('paginates the combined completed list', async () => {
    const f = fixture();
    f.tables.polls = Array.from({ length: 45 }, (_, i) => ({ ...f.p, code: String(i), createdAt: i + 1, status: i % 2 ? 'closed' : 'cancelled' }));
    const first = await invoke(list, f.ctx, { closed: true });
    const second = await invoke(list, f.ctx, { closed: true, cursor: first.next });
    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(15);
    expect(new Set([...first.items, ...second.items].map((p: Row) => p.code)).size).toBe(45);
    expect(second.next).toBeNull();
  });
});
describe('atomic wallet voting', () => {
  it.each(['cancel', 'cancel poll', 'Cancel votes!', 'please cancel this poll', '@Ponsbotfamily cancel vote'])('recognizes poll cancellation: %s', text => expect(isPollCancel(text)).toBe(true));
  it('does not interpret a discussion of cancellation as a command', () => expect(isPollCancel('Should we cancel this poll?')).toBe(false));
  it('allows only the original wallet to cancel and stops future votes and closing', async () => {
    const f = fixture(); f.p.creatorWallet = '0xabcd';
    await expect(invoke(cancel, f.ctx, { code: f.p.code, wallet: ca })).rejects.toThrow('Only the poll creator');
    await invoke(cancel, f.ctx, { code: f.p.code, wallet: '0xAbCd' });
    expect(f.p.status).toBe('cancelled');
    await expect(f.cast()).rejects.toThrow('closed');
    f.p.endsAt = Date.now() - 1;
    await invoke(close, f.ctx, { code: f.p.code }); expect(f.ctx.runMutation).not.toHaveBeenCalled();
  });
  it('requires the X creator and a direct reply to the original bot poll post', async () => {
    const f = fixture(); Object.assign(f.p, { creatorWallet: ca, source: 'x', xPostId: 'botpoll' });
    await expect(invoke(cancel, f.ctx, { code: f.p.code, xOwner: 'other', parentPostId: 'botpoll' })).rejects.toThrow('Only');
    await expect(invoke(cancel, f.ctx, { code: f.p.code, xOwner: 'owner', parentPostId: 'other' })).rejects.toThrow('Only');
    await invoke(cancel, f.ctx, { code: f.p.code, xOwner: 'owner', parentPostId: 'botpoll' }); expect(f.p.status).toBe('cancelled');
  });
  it('does not allow cancellation after the deadline', async () => {
    const f = fixture(); f.p.creatorWallet = ca; f.p.endsAt = Date.now() - 1;
    await expect(invoke(cancel, f.ctx, { code: f.p.code, wallet: ca })).rejects.toThrow('already ended');
  });
  it('permits only one duplicate-vote notice per X person and poll', async () => {
    const f = fixture(); await f.cast();
    expect(await f.cast({ event: 'repeat1', eventOrder: '101' })).toMatchObject({ duplicate: true, duplicateNotice: true });
    expect(await f.cast({ event: 'repeat2', eventOrder: '102' })).toMatchObject({ duplicate: true, duplicateNotice: false });
    expect(await f.cast({ event: 'repeat1', eventOrder: '101' })).toMatchObject({ duplicateNotice: true });
    expect(f.tables.pollDuplicateNotices).toHaveLength(1); expect(f.p.voterCount).toBe(1);
    expect(await f.cast({ event: 'change', eventOrder: '103', option: 1 })).toMatchObject({ duplicate: true, duplicateNotice: false });
    expect(f.p.totals).toEqual(['1000', '0']);
  });
  it('closes once and enqueues one results reply to the bot creation post', async () => { const f = fixture(); f.p.xPostId = 'created-post'; f.p.endsAt = Date.now() - 1; f.p.snapshot.symbol = 'TEST'; await invoke(close, f.ctx, { code: f.p.code }); await invoke(close, f.ctx, { code: f.p.code }); expect(f.p.status).toBe('closed'); expect(f.ctx.runMutation).toHaveBeenCalledTimes(1); expect(f.ctx.runMutation.mock.calls[0][1]).toMatchObject({ replyTargetPostId: 'created-post', kind: 'poll_result', allowLong: true }); });
  it('does not close early', async () => { const f = fixture(); await invoke(close, f.ctx, { code: f.p.code }); expect(f.p.status).toBe('open'); expect(f.ctx.runMutation).not.toHaveBeenCalled(); });
  it('deduplicates the same X event', async () => { const f = fixture(); await f.cast(); await f.cast(); expect(f.p.voterCount).toBe(1); expect(f.p.votedWeight).toBe('1000'); });
  it('prevents changing a vote from X through the website', async () => { const f = fixture(); await f.cast(); await expect(f.cast({ wallet: '0xabcd', source: 'web', event: 'web:second', eventOrder: '101', option: 1 })).rejects.toThrow('cannot be changed'); expect(f.p.totals).toEqual(['1000', '0']); expect(f.p.voterCount).toBe(1); expect(f.tables.pollVotes).toHaveLength(1); });
  it('prevents changing a website vote through X', async () => { const f = fixture(); await f.cast({ source: 'web' }); expect(await f.cast({ event: 'x:change', eventOrder: '101', option: 1 })).toMatchObject({ duplicate: true }); expect(f.p.totals).toEqual(['1000', '0']); });
  it('rejects reuse of an event with a different choice', async () => { const f = fixture(); await f.cast(); await expect(f.cast({ option: 1 })).rejects.toThrow('mismatch'); });
  it('rejects an older delayed vote from the other channel', async () => { const f = fixture(); await f.cast(); await expect(f.cast({ source: 'web', event: 'older', eventOrder: '99', option: 1 })).rejects.toThrow('newer vote'); });
  it('rejects a vote at the deadline', async () => { const f = fixture(); f.p.endsAt = Date.now(); await expect(f.cast()).rejects.toThrow('closed'); });
  it('rejects a closed poll', async () => { const f = fixture(); f.p.status = 'closed'; await expect(f.cast()).rejects.toThrow('closed'); });
  it('rejects excluded custody addresses', async () => { const f = fixture(); await expect(f.cast({ wallet: ca })).rejects.toThrow('excluded'); });
  it('rejects holdings below the threshold', async () => { const f = fixture(); await expect(f.cast({ weight: '999' })).rejects.toThrow('minimum'); });
  it('allows exactly the threshold', async () => { const f = fixture(); await f.cast(); expect(f.p.votedWeight).toBe('1000'); });
  it('still requires a positive balance when the custom threshold is zero', async () => { const f = fixture(); f.p.spec.minimumHoldingPercent = 0; await expect(f.cast({ weight: '0' })).rejects.toThrow('balance'); });
  it('rejects changed historical weight', async () => { const f = fixture(); await f.cast(); await expect(f.cast({ event: 'new', weight: '2000' })).rejects.toThrow('weight mismatch'); });
  it('rejects invalid option indexes', async () => { const f = fixture(); await expect(f.cast({ option: 8 })).rejects.toThrow('Invalid vote'); });
  it('does not allow another user to correct a poll token', async () => { const f = fixture(); f.p.status = 'needs_token'; await expect(invoke(correctToken, f.ctx, { code: f.p.code, owner: 'outsider', address: ca })).rejects.toThrow('Only the creating wallet'); });
  it('expires token clarification after ten minutes', async () => { const f = fixture(); f.p.status = 'needs_token'; f.p.createdAt = Date.now() - 600001; await expect(invoke(correctToken, f.ctx, { code: f.p.code, owner: 'owner', address: ca })).rejects.toThrow('expired'); });
});
