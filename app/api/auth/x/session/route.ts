import { NextRequest, NextResponse } from "next/server";
import { readWebWalletSession, webWalletCsrfToken, WEB_WALLET_SESSION_COOKIE } from "@/lib/web-wallet-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secret = process.env.WEB_AUTH_SECRET;
  const session = secret ? readWebWalletSession(request.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value, secret) : null;
  return NextResponse.json(session ? {
    authenticated: true,
    username: session.username,
    walletAddress: session.walletAddress,
    expiresAt: session.expiresAt,
    csrfToken: webWalletCsrfToken(session.sessionId, secret!),
  } : { authenticated: false }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE() {
  const response = NextResponse.json({ authenticated: false }, { headers: { "cache-control": "no-store" } });
  response.cookies.set(WEB_WALLET_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NEXT_PUBLIC_SITE_URL?.startsWith("https://") ?? false,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
