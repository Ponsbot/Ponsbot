import { expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
const mocks = vi.hoisted(() => ({ price: vi.fn(async () => '10000') }));
vi.mock('../lib/poll-chain', async original => ({ ...await original<typeof import('../lib/poll-chain')>(),
  buildPollSnapshot: vi.fn(async () => ({ supply: '1000000', decimals: 2 })), pollCurrentMarketCap: mocks.price, pollOfficial: vi.fn(async () => false) }));
import { prepare, pinMinimum, saveVote } from '../convex/polls';
const ca = '0x1111111111111111111111111111111111111111';
it('resolves once and reuses the saved token requirement on retries', async () => {
  const p: any = { code: 'POLL-X', lease: 'lease', tokenAddress: ca, creatorWallet: ca, spec: { token: ca, minimumHolding: { unit: 'usd', amount: '100' } } };
  const ctx = { runQuery: vi.fn(async () => []), runMutation: vi.fn(async (ref: any, args: any) => {
    const name = getFunctionName(ref);
    if (name === 'polls:reserve') return p;
    if (name === 'polls:pinMinimum') p.resolvedMinimum = args.minimum;
  }) };
  await (prepare as any)._handler(ctx, { code: p.code });
  expect(p.resolvedMinimum.balance).toBe('10000');
  await (prepare as any)._handler(ctx, { code: p.code });
  expect(mocks.price).toHaveBeenCalledOnce();
});
function fixture(p: any) {
  return { db: { query: (table: string) => { const q: any = { withIndex: () => q, unique: async () => table === 'polls' ? p : null }; return q; }, patch: vi.fn(), insert: vi.fn() } };
}
it('never overwrites an already pinned minimum', async () => {
  const ctx = fixture({ status: 'preparing', lease: 'lease', resolvedMinimum: { balance: '10000' } });
  await (pinMinimum as any)._handler(ctx, { code: 'POLL-X', lease: 'lease', minimum: { balance: '99999', percent: 1 } });
  expect(ctx.db.patch).not.toHaveBeenCalled();
});
it('checks the exact fixed token threshold instead of the placeholder percent', async () => {
  const p = { _id: 'poll', status: 'open', endsAt: Date.now() + 60000, snapshot: { supply: '1000000', activeSupply: '1000000', exclusions: [] },
    spec: { minimumHoldingPercent: 0.1, minimumHolding: { unit: 'usd', amount: '100' } }, resolvedMinimum: { balance: '10000' }, totals: ['0', '0'], votedWeight: '0', voterCount: 0 };
  const ctx = fixture(p), args = { code: 'POLL-X', wallet: ca, weight: '9999', event: 'event', source: 'web', eventOrder: '1', option: 0 };
  await expect((saveVote as any)._handler(ctx, args)).rejects.toThrow('below the minimum');
  await expect((saveVote as any)._handler(ctx, { ...args, weight: '10000' })).resolves.toMatchObject({ weight: '10000' });
});
