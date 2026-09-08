import { NextRequest, NextResponse } from 'next/server';
import { createVoteBrowserSession, voteRequestSession, VOTE_BROWSER_COOKIE, VOTE_BROWSER_TTL } from '@/lib/vote-browser-session';
import { votingPreviewAllowed, WEBSITE_VOTING_PUBLIC } from '@/lib/voting-access';
import { webWalletCsrfToken } from '@/lib/web-wallet-session';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
  const secret = process.env.WEB_AUTH_SECRET;
  if (!secret || req.headers.get('sec-fetch-site') === 'cross-site') return NextResponse.json({ error: 'Not available.' }, { status: 403 });
  let session = voteRequestSession(req, secret);
  if (!votingPreviewAllowed(session?.xUserId)) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const fresh = !session && WEBSITE_VOTING_PUBLIC ? createVoteBrowserSession(secret) : null;
  if (fresh) session = { xUserId: 'guest', sessionId: fresh.sessionId, anonymous: true };
  if (!session) return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  const response = NextResponse.json({ csrfToken: webWalletCsrfToken(session.sessionId, secret) }, { headers: { 'cache-control': 'no-store' } });
  if (fresh) response.cookies.set(VOTE_BROWSER_COOKIE, fresh.cookie, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/api/votes', maxAge: VOTE_BROWSER_TTL });
  return response;
}
