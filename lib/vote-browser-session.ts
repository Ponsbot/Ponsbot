import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { readWebWalletSession, WEB_WALLET_SESSION_COOKIE } from './web-wallet-session';
import { WEBSITE_VOTING_PUBLIC } from './voting-access';

export const VOTE_BROWSER_COOKIE = 'pons_vote_browser';
export const VOTE_BROWSER_TTL = 86400;
const mac = (payload: string, secret: string) => createHmac('sha256', secret).update(`voting-browser:${payload}`).digest('hex');
export function createVoteBrowserSession(secret: string) {
  const sessionId = randomBytes(32).toString('hex');
  const payload = `${sessionId}.${Date.now() + VOTE_BROWSER_TTL * 1000}`;
  return { sessionId, cookie: `${payload}.${mac(payload, secret)}` };
}
export function readVoteBrowserSession(cookie: string | undefined, secret: string): string | null {
  if (!cookie || cookie.length > 200) return null;
  const [id, expires, signature, extra] = cookie.split('.');
  if (extra || !/^[a-f0-9]{64}$/.test(id ?? '') || !/^\d+$/.test(expires ?? '') || !/^[a-f0-9]{64}$/.test(signature ?? '') || Number(expires) <= Date.now()) return null;
  const expected = Buffer.from(mac(`${id}.${expires}`, secret));
  return timingSafeEqual(Buffer.from(signature), expected) ? id : null;
}
// Anonymous cookies identify only the browser challenge binding, never a wallet.
// Every external-wallet write still requires its separately signed wallet session.
export function voteRequestSession(req: NextRequest, secret: string) {
  const x = readWebWalletSession(req.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value, secret);
  if (x) return { ...x, anonymous: false };
  const sessionId = WEBSITE_VOTING_PUBLIC ? readVoteBrowserSession(req.cookies.get(VOTE_BROWSER_COOKIE)?.value, secret) : null;
  return sessionId ? { xUserId: 'guest', sessionId, anonymous: true } : null;
}
