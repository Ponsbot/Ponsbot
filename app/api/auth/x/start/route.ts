import { createHash, randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { readWebWalletSession, WEB_WALLET_SESSION_COOKIE } from "@/lib/web-wallet-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function base64url(value: Buffer) {
  return value.toString("base64url");
}

export async function GET(request: NextRequest) {
  const clientId = process.env.X_OAUTH_CLIENT_ID;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const webSecret = process.env.WEB_AUTH_SECRET;
  if (!clientId || !siteUrl || !convexUrl || !webSecret) return NextResponse.json({ error: "X wallet sign-in is not configured" }, { status: 503 });

  const session = readWebWalletSession(request.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value, webSecret);
  const requestedReturn = request.nextUrl.searchParams.get("returnTo");
  const telegramLink = request.nextUrl.searchParams.get("telegramLink");
  const validTelegramLink = telegramLink && /^[a-f0-9]{64}$/.test(telegramLink) ? telegramLink : null;
  const returnTo = requestedReturn === "/terminal" ? "/terminal" : `/wallet/${session?.walletAddress || ""}`;
  // Telegram account linking must always pass through X authorization. Reusing
  // a website session here can bind the Telegram nonce to a stale or different
  // X identity, and can make relinking fail before the nonce is consumed.
  if (session && !validTelegramLink) {
    const active = await new ConvexHttpClient(convexUrl).action(api.wallets.verifyWebSession, {
      secret: webSecret, sessionId: session.sessionId, ownerXUserId: session.xUserId,
    }).catch(() => false);
    if (active) {
      if (validTelegramLink) {
        await new ConvexHttpClient(convexUrl).action(api.telegram.completeXLink, {
          secret: webSecret, nonce: validTelegramLink, ownerXUserId: session.xUserId,
        });
      }
      return NextResponse.redirect(new URL(returnTo, siteUrl));
    }
  }

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
  response.cookies.set("pons_x_oauth_return", requestedReturn === "/terminal" ? "/terminal" : "/wallet", cookie);
  if (validTelegramLink) response.cookies.set("pons_telegram_link", validTelegramLink, cookie);
  // A cryptographically valid cookie may refer to a revoked or missing Convex
  // session. Remove it before starting OAuth so it cannot cause a redirect loop.
  if (session) response.cookies.set(WEB_WALLET_SESSION_COOKIE, "", {
    httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 0,
  });
  return response;
}
