import { expect, it, vi } from 'vitest';
import { request } from '../convex/polls';
import { VOTING_PREVIEW_X_ID as owner } from '../lib/voting-access';
const wallet = '0x1111111111111111111111111111111111111111';
const spec = { token: 'TOKEN', question: 'Proceed?', options: ['Yes', 'No'], durationMinutes: 60, minimumHoldingPercent: 0.1 };
const args = { requestKey: 'new', ownerXUserId: owner, creatorWallet: wallet, source: 'web', spec, anchor: { block: '1', blockHash: '0xabc', timestamp: 0 } };
function fixture(rows: any[]) {
  const db = {
    query: () => {
      const filters: Array<(r: any) => boolean> = [];
      const ix: any = { eq: (k: string, v: unknown) => { filters.push(r => r[k] === v); return ix; }, gte: (k: string, v: number) => { filters.push(r => r[k] >= v); return ix; } };
      const q: any = { withIndex: (_: string, cb: any) => { cb(ix); return q; }, unique: async () => rows.find(r => filters.every(f => f(r))) ?? null, take: async (n: number) => rows.filter(r => filters.every(f => f(r))).slice(0, n) }; return q;
    }, insert: vi.fn(async (_: string, row: any) => { rows.push(row); }),
  };
  return { db, scheduler: { runAfter: vi.fn() } };
}
it.each(['account', 'wallet'])('blocks the sixth poll for the %s independently', async scope => {
  const ctx = fixture(Array.from({ length: 5 }, (_, i) => ({ requestKey: `old-${i}`, ownerXUserId: scope === 'account' ? owner : `other-${i}`, creatorWallet: scope === 'wallet' ? wallet : `wallet-${i}`, createdAt: Date.now() })));
  await expect((request as any)._handler(ctx, args)).rejects.toThrow('5 polls'); expect(ctx.db.insert).not.toHaveBeenCalled();
});
it('allows the fifth poll and does not charge its retry again', async () => {
  const ctx = fixture(Array.from({ length: 4 }, (_, i) => ({ requestKey: `old-${i}`, ownerXUserId: owner, creatorWallet: wallet, createdAt: Date.now() })));
  const code = await (request as any)._handler(ctx, args);
  expect(await (request as any)._handler(ctx, args)).toBe(code); expect(ctx.db.insert).toHaveBeenCalledOnce();
});
it('excludes polls older than the rolling day', async () => {
  const ctx = fixture(Array.from({ length: 5 }, (_, i) => ({ requestKey: `old-${i}`, ownerXUserId: owner, creatorWallet: wallet, createdAt: Date.now() - 86400001 })));
  await expect((request as any)._handler(ctx, args)).resolves.toMatch(/^POLL-/);
});
