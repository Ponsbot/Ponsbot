import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createWebWalletSession, readWebWalletSession, WEB_WALLET_SESSION_COOKIE, webWalletCsrfToken } from '../lib/web-wallet-session';
import { VOTE_WALLET_COOKIE } from '../lib/vote-wallet-auth';
import { VOTING_PREVIEW_X_ID } from '../lib/voting-access';
const action = vi.hoisted(() => vi.fn());
vi.mock('convex/browser', () => ({ ConvexHttpClient: class { action = action; } }));
import { GET, POST } from '../app/api/votes/wallet/route';
import { POST as vote } from '../app/api/votes/route';
const secret = 'test-secret', address = '0x1111111111111111111111111111111111111111';
const cookie = createWebWalletSession(address, VOTING_PREVIEW_X_ID, 'Ponsboyfamily', secret);
const session = readWebWalletSession(cookie, secret)!;
const csrf = webWalletCsrfToken(session.sessionId, secret);
const headers = { cookie: `${WEB_WALLET_SESSION_COOKIE}=${cookie}`, origin: 'https://example.com', 'x-pons-csrf': csrf, 'content-type': 'application/json' };
const request = (body: object, overrides: Record<string, string> = {}) => new NextRequest('https://example.com/api/votes/wallet', { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
beforeEach(() => { vi.stubEnv('WEB_AUTH_SECRET', secret); vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://test.convex.cloud'); vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://example.com'); action.mockReset().mockResolvedValue({}); });
afterEach(() => vi.unstubAllEnvs());
it('rejects unsigned visitors and another account using the wrong CSRF token', async () => {
  expect((await GET(new NextRequest('https://example.com/api/votes/wallet'))).status).toBe(404);
  const outsider = createWebWalletSession(address, '1234567890123456789', 'OtherUser', secret);
  expect((await POST(request({ operation: 'challenge', address }, { cookie: `${WEB_WALLET_SESSION_COOKIE}=${outsider}` }))).status).toBe(403);
  expect(action).not.toHaveBeenCalled();
});
it.each<Record<string, string>>([{ origin: 'https://evil.example' }, { 'x-pons-csrf': 'forged' }])('rejects cross-site or invalid-CSRF writes', async extra => {
  expect((await POST(request({ operation: 'challenge', address }, extra))).status).toBe(403); expect(action).not.toHaveBeenCalled();
});
it('only passes server identity and canonical origin when requesting a challenge', async () => {
  action.mockResolvedValue({ nonce: 'a'.repeat(32), message: 'server message' });
  const response = await POST(request({ operation: 'challenge', address, owner: 'outsider', origin: 'https://evil.example', message: 'Approve tokens' }));
  expect(response.status).toBe(200);
  expect(action.mock.calls[0][1]).toMatchObject({ owner: VOTING_PREVIEW_X_ID, origin: 'https://example.com', sessionId: session.sessionId, address });
  expect(action.mock.calls[0][1]).not.toHaveProperty('message');
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('issues an opaque HttpOnly voting-only cookie only after successful verification', async () => {
  action.mockResolvedValue({ address, expiresAt: Date.now() + 1000 });
  const response = await POST(request({ operation: 'verify', nonce: 'a'.repeat(32), signature: '0x1234' }));
  const setCookie = response.headers.get('set-cookie')!;
  expect(setCookie).toContain(VOTE_WALLET_COOKIE); expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('Path=/api/votes'); expect(setCookie).toMatch(/SameSite=strict/i);
  expect(action.mock.calls[0][1].token).toMatch(/^[a-f0-9]{64}$/);
  expect(await response.text()).not.toContain(action.mock.calls[0][1].token);
});
it('does not issue a cookie after invalid or replayed signatures', async () => {
  action.mockRejectedValue(new Error('Already used'));
  const response = await POST(request({ operation: 'verify', nonce: 'a'.repeat(32), signature: '0x1234' }));
  expect(response.status).toBe(400); expect(response.headers.get('set-cookie')).toBeNull();
});
it('revokes the server token and clears the cookie on disconnect', async () => {
  const token = 'c'.repeat(64);
  const response = await POST(request({ operation: 'disconnect' }, { cookie: `${headers.cookie}; ${VOTE_WALLET_COOKIE}=${token}` }));
  expect(action.mock.calls[0][1]).toMatchObject({ operation: 'disconnect', token }); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
});
it('does not allow voting with just an X session', async () => {
  const response = await vote(request({ operation: 'vote', eventId: 'valid-event-123', expectedWallet: address, choice: '1' }));
  expect(response.status).toBe(401); expect(action).not.toHaveBeenCalled();
});
it('passes the cookie proof, not a caller-provided token, to voting', async () => {
  action.mockResolvedValue({ ok: true, message: 'Vote recorded' });
  const token = 'c'.repeat(64);
  const response = await vote(request({ operation: 'vote', eventId: 'valid-event-123', expectedWallet: address, choice: '1', walletToken: 'forged' }, { cookie: `${headers.cookie}; ${VOTE_WALLET_COOKIE}=${token}` }));
  expect(response.status).toBe(200); expect(action.mock.calls[0][1]).toMatchObject({ walletToken: token, expectedWallet: address });
});
it('permits an explicit Pons wallet selection through the authenticated server session', async () => {
  action.mockResolvedValue({ ok: true });
  const response = await vote(request({ operation: 'vote', eventId: 'valid-event-123', expectedWallet: address, choice: '1', walletSource: 'pons' }));
  expect(response.status).toBe(200);
  expect(action.mock.calls[0][1]).toMatchObject({ owner: VOTING_PREVIEW_X_ID, sessionId: session.sessionId, walletSource: 'pons' });
  expect(action.mock.calls[0][1].walletToken).toBeUndefined();
});
it('passes token-rights previews through the same authenticated wallet path', async () => {
  action.mockResolvedValue({ ok: true, official: true, message: 'Official' });
  const response = await vote(request({ operation: 'preview', eventId: 'preview-event-123', expectedWallet: address, choice: '$PONSBOT', walletSource: 'pons' }));
  expect(response.status).toBe(200);
  expect(action.mock.calls[0][1]).toMatchObject({ operation: 'preview', choice: '$PONSBOT', owner: VOTING_PREVIEW_X_ID, walletSource: 'pons', expectedWallet: address });
  expect(action.mock.calls[0][1].spec).toBeUndefined();
});
it('requires wallet verification for external-wallet rights previews', async () => {
  const response = await vote(request({ operation: 'preview', eventId: 'preview-event-123', expectedWallet: address, choice: '$PONSBOT', walletSource: 'external' }));
  expect(response.status).toBe(401); expect(action).not.toHaveBeenCalled();
});
it('uses the verified wallet for a read-only snapshot balance lookup', async () => {
  action.mockResolvedValue({ ok: true, snapshotBalance: '0', message: '' });
  const response = await vote(request({ operation: 'snapshotBalance', code: 'POLL-1234567890ABCDEF', eventId: 'balance-event-123', expectedWallet: address, walletSource: 'pons' }));
  expect(response.status).toBe(200);
  expect(action.mock.calls[0][1]).toMatchObject({ operation: 'snapshotBalance', code: 'POLL-1234567890ABCDEF', expectedWallet: address, walletSource: 'pons', owner: VOTING_PREVIEW_X_ID });
  expect(await response.json()).toMatchObject({ snapshotBalance: '0' });
});
it('does not permit unauthenticated external snapshot balance lookup', async () => {
  const response = await vote(request({ operation: 'snapshotBalance', code: 'POLL-1234567890ABCDEF', eventId: 'balance-event-123', expectedWallet: address, walletSource: 'external' }));
  expect(response.status).toBe(401); expect(action).not.toHaveBeenCalled();
});
