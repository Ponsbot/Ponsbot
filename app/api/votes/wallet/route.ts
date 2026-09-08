import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@/convex/_generated/api';
import { boundedJson } from '@/lib/bounded-json';
import { readWebWalletSession, WEB_WALLET_SESSION_COOKIE, webWalletCsrfToken } from '@/lib/web-wallet-session';
import { votingPreviewAllowed } from '@/lib/voting-access';
import { VOTE_WALLET_COOKIE, VOTE_WALLET_TTL } from '@/lib/vote-wallet-auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'cache-control': 'no-store' } });
async function handle(req: NextRequest, write: boolean) {
  const secret = process.env.WEB_AUTH_SECRET, url = process.env.NEXT_PUBLIC_CONVEX_URL, site = process.env.NEXT_PUBLIC_SITE_URL;
  const session = secret ? readWebWalletSession(req.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value, secret) : null;
  if (!secret || !session || !votingPreviewAllowed(session.xUserId)) return json({ error: 'Not found.' }, 404);
  if (!url || !site) return json({ error: 'Voting sign-in is not configured.' }, 503);
  const origin = new URL(site).origin;
  if (write) {
    if (req.headers.get('origin') !== origin) return json({ error: 'Invalid request origin.' }, 403);
    const supplied = Buffer.from(req.headers.get('x-pons-csrf') ?? ''), expected = Buffer.from(webWalletCsrfToken(session.sessionId, secret));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json({ error: 'Invalid session token.' }, 403);
  }
  try {
    const body = write ? await boundedJson(req, 20000) as { operation?: string; address?: string; nonce?: string; signature?: string } : { operation: 'status' };
    if (!body || !['challenge', 'verify', 'disconnect', 'status'].includes(body.operation ?? '') || (write && body.operation === 'status')
      || (body.address !== undefined && (typeof body.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(body.address)))
      || (body.nonce !== undefined && (typeof body.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(body.nonce)))
      || (body.signature !== undefined && (typeof body.signature !== 'string' || body.signature.length > 16386))) return json({ error: 'Invalid wallet sign-in request.' }, 400);
    const client = new ConvexHttpClient(url);
    const common = { secret, owner: session.xUserId, sessionId: session.sessionId, origin };
    const oldToken = req.cookies.get(VOTE_WALLET_COOKIE)?.value;
    const token = body.operation === 'verify' ? randomBytes(32).toString('hex') : oldToken;
    const result = await client.action(api.pollWalletAuth.web, { ...common, operation: body.operation as 'challenge' | 'verify' | 'status' | 'disconnect',
      ...(token ? { token } : {}), ...(body.address ? { address: body.address } : {}), ...(body.nonce ? { nonce: body.nonce } : {}), ...(body.signature ? { signature: body.signature } : {}) });
    const response = json(result);
    const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/api/votes' };
    if (body.operation === 'verify' && result.address && token) {
      if (oldToken) await client.action(api.pollWalletAuth.web, { ...common, operation: 'disconnect', token: oldToken });
      response.cookies.set(VOTE_WALLET_COOKIE, token, { ...cookieOptions, maxAge: VOTE_WALLET_TTL / 1000 });
    }
    if (body.operation === 'disconnect') response.cookies.set(VOTE_WALLET_COOKIE, '', { ...cookieOptions, maxAge: 0 });
    return response;
  } catch { return json({ error: 'Wallet sign-in could not be verified. Reconnect and sign a new message. If requests were too frequent, wait a minute.' }, 400); }
}
export const GET = (req: NextRequest) => handle(req, false);
export const POST = (req: NextRequest) => handle(req, true);
