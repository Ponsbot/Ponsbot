import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { readWebWalletSession, WEB_WALLET_SESSION_COOKIE } from "@/lib/web-wallet-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function base64url(value: Buffer) {
  return value.toString("base64url");
}

export async function GET(request: NextRequest) {
  const clientId = process.env.X_OAUTH_CLIENT_ID;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const webSecret = process.env.WEB_AUTH_SECRET;
  if (!clientId || !siteUrl || !webSecret) return NextResponse.json({ error: "X wallet sign-in is not configured" }, { status: 503 });

  const session = readWebWalletSession(request.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value, webSecret);
  if (session) return NextResponse.redirect(new URL(`/wallet/${session.walletAddress}`, siteUrl));

  const state = base64url(randomBytes(32));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const callback = `${siteUrl.replace(/\/$/, "")}/api/auth/x/callback`;
  const authorize = new URL("https://x.com/i/oauth2/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    scope: "users.read tweet.read",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const response = NextResponse.redirect(authorize);
  const secure = callback.startsWith("https://");
  const cookie = { httpOnly: true, secure, sameSite: "lax" as const, path: "/api/auth/x", maxAge: 10 * 60 };
  response.cookies.set("pons_x_oauth_state", state, cookie);
  response.cookies.set("pons_x_oauth_verifier", verifier, cookie);
  return response;
}
