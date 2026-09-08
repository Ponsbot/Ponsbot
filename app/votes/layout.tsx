import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@/convex/_generated/api';
import { readWebWalletSession, WEB_WALLET_SESSION_COOKIE } from '@/lib/web-wallet-session';
import { votingPreviewAllowed } from '@/lib/voting-access';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };
export default async function VotingLayout({ children }: { children: React.ReactNode }) {
  const secret = process.env.WEB_AUTH_SECRET, url = process.env.NEXT_PUBLIC_CONVEX_URL;
  const jar = await cookies();
  const session = secret ? readWebWalletSession(jar.get(WEB_WALLET_SESSION_COOKIE)?.value, secret) : null;
  if (!secret || !url || !session || !votingPreviewAllowed(session.xUserId)) notFound();
  const active = await new ConvexHttpClient(url).action(api.wallets.verifyWebSession, { secret, ownerXUserId: session.xUserId, sessionId: session.sessionId }).catch(() => false);
  if (!active) notFound();
  return children;
}
