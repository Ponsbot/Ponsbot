import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getFunctionName } from 'convex/server';
vi.mock('../lib/voting-access', async original => ({ ...await original<typeof import('../lib/voting-access')>(), WEBSITE_VOTING_PUBLIC: true, votingPreviewAllowed: () => true, anonymousVotingSession: (owner: string, id: string) => owner === 'guest' && /^[a-f0-9]{64}$/.test(id) }));
const action = vi.hoisted(() => vi.fn());
vi.mock('convex/browser', () => ({ ConvexHttpClient: class { action = action; } }));
vi.mock('../lib/poll-chain', async original => ({ ...await original<typeof import('../lib/poll-chain')>(), pollVotingBalance: vi.fn(async () => '1000'), assertPollBlock: vi.fn(async () => {}), pollAnchor: vi.fn(async () => ({ block: '1', blockHash: '0x1', timestamp: 1 })) }));
import { createVoteBrowserSession, readVoteBrowserSession, VOTE_BROWSER_COOKIE } from '../lib/vote-browser-session';
import { webWalletCsrfToken } from '../lib/web-wallet-session';
import { VOTE_WALLET_COOKIE, voteAuthHash } from '../lib/vote-wallet-auth';
import { GET as sessionGet } from '../app/api/votes/session/route';
import { POST as walletPost } from '../app/api/votes/wallet/route';
import { POST as votePost, GET as browseGet } from '../app/api/votes/route';
import { web as pollWeb } from '../convex/polls';
import { web as authWeb } from '../convex/pollWalletAuth';
const secret = 'test-secret', address = '0x1111111111111111111111111111111111111111', bearer = 'c'.repeat(64);
beforeEach(() => { vi.stubEnv('WEB_AUTH_SECRET', secret); vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://test.convex.cloud'); vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com'); action.mockReset().mockResolvedValue({}); });
afterEach(() => vi.unstubAllEnvs());
function browserRequest(body: object, withWallet = true, extra: Record<string, string> = {}) {
  const s = createVoteBrowserSession(secret);
  return { s, req: new NextRequest('https://example.com/api/votes', { method: 'POST', headers: { origin: 'https://example.com', 'x-pons-csrf': webWalletCsrfToken(s.sessionId, secret), cookie: `${VOTE_BROWSER_COOKIE}=${s.cookie}${withWallet ? `; ${VOTE_WALLET_COOKIE}=${bearer}` : ''}`, ...extra }, body: JSON.stringify(body) }) };
}
it('bootstraps a signed HttpOnly browser session without X', async () => {
  const response = await sessionGet(new NextRequest('https://example.com/api/votes/session'));
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/);
  expect(response.headers.get('set-cookie')).toMatch(/SameSite=strict/i);
  expect((await response.json()).csrfToken).toBeTruthy();
});
it('rejects tampered, expired and cross-site bootstrap sessions', async () => {
  const s = createVoteBrowserSession(secret);
  expect(readVoteBrowserSession(s.cookie, secret)).toBe(s.sessionId);
  expect(readVoteBrowserSession(s.cookie, 'wrong-secret')).toBeNull();
  expect(readVoteBrowserSession(s.cookie.replace(/\.\d+\./, '.1.'), secret)).toBeNull();
  expect((await sessionGet(new NextRequest('https://example.com/api/votes/session', { headers: { 'sec-fetch-site': 'cross-site' } }))).status).toBe(403);
});
it('allows public results without any login', async () => {
  expect((await browseGet(new NextRequest('https://example.com/api/votes'))).status).toBe(200);
  expect(action.mock.calls[0][1].owner).toBe('guest');
});
it('binds wallet challenges to the anonymous browser, not caller identity', async () => {
  const { s, req } = browserRequest({ operation: 'challenge', address, owner: 'attacker' }, false);
  expect((await walletPost(req)).status).toBe(200);
  expect(action.mock.calls[0][1]).toMatchObject({ owner: 'guest', sessionId: s.sessionId, address });
});
it('requires a wallet signature session for anonymous voting', async () => {
  const { req } = browserRequest({ operation: 'vote', expectedWallet: address, walletSource: 'external', eventId: 'valid-event-123', choice: '1' }, false);
  expect((await votePost(req)).status).toBe(401);
  expect(action).not.toHaveBeenCalled();
});
it('forwards authenticated external voting without X login', async () => {
  const { s, req } = browserRequest({ operation: 'vote', expectedWallet: address, walletSource: 'external', eventId: 'valid-event-123', choice: '1' });
  expect((await votePost(req)).status).toBe(200);
  expect(action.mock.calls[0][1]).toMatchObject({ owner: 'guest', sessionId: s.sessionId, walletToken: bearer, walletSource: 'external' });
});
it.each<Record<string, string>>([{ origin: 'https://evil.example' }, { 'x-pons-csrf': 'wrong' }])('rejects anonymous cross-site or forged-CSRF requests', extra => {
  const { req } = browserRequest({ operation: 'vote' }, true, extra);
  return expect(votePost(req).then(r => r.status)).resolves.toBe(403);
});
it('cannot select a Pons Bot wallet with an anonymous cookie', async () => {
  const { req } = browserRequest({ operation: 'vote', walletSource: 'pons', expectedWallet: address, eventId: 'valid-event-123' });
  expect((await votePost(req)).status).toBe(401); expect(action).not.toHaveBeenCalled();
});
const args = { secret, owner: 'guest', sessionId: 'a'.repeat(64), walletSource: 'external', walletToken: bearer, expectedWallet: address, eventId: 'valid-event-123', code: 'POLL-X', operation: 'vote', choice: '1' };
function ctxFixture() {
  const p = { tokenAddress: address, status: 'open', endsAt: Date.now() + 60000, spec: { options: ['Yes', 'No'] }, snapshot: { supply: '1000000', activeSupply: '900000', exclusions: [], decimals: 0, symbol: 'TOKEN' } };
  const ctx = { runAction: vi.fn(), runQuery: vi.fn(async (ref: any, _args: any) => getFunctionName(ref) === 'pollWalletAuth:session' ? { address } : { poll: p }), runMutation: vi.fn(async (ref: any, _args: any) => getFunctionName(ref) === 'polls:saveVote' ? { weight: '1000' } : getFunctionName(ref) === 'polls:request' ? 'POLL-NEW' : true) };
  return ctx;
}
it('resolves the acting wallet from its bound session and records a vote', async () => {
  const ctx = ctxFixture();
  expect((await (pollWeb as any)._handler(ctx, args)).ok).toBe(true);
  expect(ctx.runAction).not.toHaveBeenCalled();
  expect(ctx.runQuery.mock.calls[0][1]).toEqual({ hash: await voteAuthHash(bearer), binding: await voteAuthHash(`guest:${args.sessionId}`) });
  expect(ctx.runMutation.mock.calls.find(c => getFunctionName(c[0]) === 'polls:saveVote')?.[1]).toMatchObject({ wallet: address });
});
it('rejects missing or cross-browser wallet sessions', async () => {
  const ctx = ctxFixture(); ctx.runQuery.mockResolvedValue(null as any);
  await expect((pollWeb as any)._handler(ctx, args)).rejects.toThrow('Connect and verify');
  expect(ctx.runMutation).not.toHaveBeenCalled();
});
it('does not let anonymous callers bypass the Pons wallet guard in Convex', async () => {
  await expect((pollWeb as any)._handler(ctxFixture(), { ...args, walletSource: 'pons' })).rejects.toThrow('Sign in with X');
});
it('uses a stable creator identity across anonymous browser sessions', async () => {
  for (const sessionId of ['a'.repeat(64), 'b'.repeat(64)]) {
    const ctx = ctxFixture();
    await (pollWeb as any)._handler(ctx, { ...args, sessionId, operation: 'create', spec: { token: 'TOKEN', question: 'Proceed?', options: ['Yes', 'No'], durationMinutes: 60, minimumHoldingPercent: 0.1 } });
    expect(ctx.runMutation.mock.calls.find(c => getFunctionName(c[0]) === 'polls:request')?.[1]).toMatchObject({ ownerXUserId: `wallet:${address}`, requestKey: `web:wallet:${address}:${address}:${args.eventId}` });
  }
});
it('separates passive reads from voting budgets', async () => {
  const ctx = ctxFixture();
  await (pollWeb as any)._handler(ctx, { ...args, operation: 'snapshotBalance' });
  expect(ctx.runMutation.mock.calls[0][1]).toMatchObject({ key: `vote-read:${address}` });
  await (pollWeb as any)._handler(ctx, args);
  expect(ctx.runMutation.mock.calls[1][1]).toMatchObject({ key: `vote:${address}` });
});
it('authenticates anonymous sign-in through the same nonce/signature workflow', async () => {
  const ctx = { runAction: vi.fn(), runMutation: vi.fn(async () => true) };
  const result = await (authWeb as any)._handler(ctx, { secret, owner: 'guest', sessionId: args.sessionId, origin: 'https://example.com', operation: 'challenge', address });
  expect(result.message).toContain('Chain ID: 4663'); expect(ctx.runAction).not.toHaveBeenCalled();
});
