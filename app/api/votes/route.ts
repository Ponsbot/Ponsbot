import { timingSafeEqual } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { NextRequest, NextResponse } from 'next/server';
import { api } from '@/convex/_generated/api';
import { boundedJson } from '@/lib/bounded-json';
import { readWebWalletSession, WEB_WALLET_SESSION_COOKIE, webWalletCsrfToken } from '@/lib/web-wallet-session';
import { validatePollSpec, type PollSpec } from '@/lib/polls';
import { votingPreviewAllowed } from '@/lib/voting-access';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(req: NextRequest) {
  const secret = process.env.WEB_AUTH_SECRET;
  const session = secret ? readWebWalletSession(req.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value, secret) : null;
  if (!session || !votingPreviewAllowed(session.xUserId)) return json({ error: 'Not found.' }, 404);
  if (!process.env.NEXT_PUBLIC_CONVEX_URL) return json({ error: 'Voting is not configured.' }, 503);
  const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL);
  const code = req.nextUrl.searchParams.get('code');
  if (code && !/^POLL-[A-Fa-f0-9]{16}$/.test(code)) return json({ error: 'Invalid poll identifier.' }, 400);
  try {
    if (code) { const result = await client.action(api.polls.browse, { secret: secret!, owner: session.xUserId, sessionId: session.sessionId, code }); return 'poll' in result && result.poll ? json(result) : json({ error: 'Poll not found.' }, 404); }
    const cursorValue = req.nextUrl.searchParams.get('cursor');
    const cursor = cursorValue ? Number(cursorValue) : undefined;
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) return json({ error: 'Invalid page.' }, 400);
    return json(await client.action(api.polls.browse, { secret: secret!, owner: session.xUserId, sessionId: session.sessionId, closed: req.nextUrl.searchParams.get('closed') === 'true', cursor }));
  } catch { return json({ error: 'Polls could not be loaded. Please retry.' }, 503); }
}
export async function POST(req: NextRequest) {
  const secret = process.env.WEB_AUTH_SECRET, url = process.env.NEXT_PUBLIC_CONVEX_URL, site = process.env.NEXT_PUBLIC_SITE_URL;
  const session = secret ? readWebWalletSession(req.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value, secret) : null;
  if (!secret || !session) return json({ error: 'Sign in with X to use your Pons Bot wallet.' }, 401);
  if (!votingPreviewAllowed(session.xUserId)) return json({ error: 'Not found.' }, 404);
  if (!url || !site) return json({ error: 'Voting is not configured.' }, 503);
  if (req.headers.get('origin') !== new URL(site).origin) return json({ error: 'Invalid request origin.' }, 403);
  const supplied = Buffer.from(req.headers.get('x-pons-csrf') ?? ''), expected = Buffer.from(webWalletCsrfToken(session.sessionId, secret));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json({ error: 'Invalid session token.' }, 403);
  try {
    const body = await boundedJson(req, 8192) as { operation?: string; eventId?: string; code?: string; choice?: string; spec?: PollSpec };
    if (!body || !['create', 'vote', 'endorse', 'correct'].includes(body.operation ?? '') || !/^[a-zA-Z0-9_-]{12,100}$/.test(body.eventId ?? '')
      || (body.code !== undefined && !/^POLL-[a-f0-9]{16}$/i.test(body.code)) || (body.choice !== undefined && (typeof body.choice !== 'string' || body.choice.length > 200))) return json({ error: 'Invalid voting request.' }, 400);
    const spec = body.operation === 'create' ? validatePollSpec(body.spec!) : undefined;
    const result = await new ConvexHttpClient(url).action(api.polls.web, { secret, owner: session.xUserId, sessionId: session.sessionId,
      eventId: body.eventId!, operation: body.operation as 'create' | 'vote' | 'endorse' | 'correct', ...(spec ? { spec } : {}), ...(body.code ? { code: body.code } : {}), ...(body.choice ? { choice: body.choice } : {}) });
    return json(result);
  } catch { return json({ error: 'The request could not be completed. Check your sign-in and poll details, then try again.' }, 400); }
}
