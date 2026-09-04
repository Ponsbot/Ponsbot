import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { createTelegramConsent, TELEGRAM_CONSENT_COOKIE, TELEGRAM_CONSENT_PATH } from "@/lib/telegram-link-consent";
import { createWebWalletSession, readWebWalletSession, WEB_WALLET_SESSION_COOKIE, WEB_WALLET_SESSION_SECONDS } from "@/lib/web-wallet-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type XToken = { access_token?: string };
type XIdentity = { data?: { id?: string; username?: string; verified?: boolean; verified_type?: string } };

function errorRedirect(request: NextRequest, reason: string) {
  const target = new URL("/wallet/sign-in-error", request.url);
  target.searchParams.set("reason", reason);
  const response = NextResponse.redirect(target);
  response.cookies.delete("pons_x_oauth_state");
  response.cookies.delete("pons_x_oauth_verifier");
  response.cookies.delete("pons_telegram_link");
  return response;
}

export async function GET(request: NextRequest) {
  const clientId = process.env.X_OAUTH_CLIENT_ID;
  const clientSecret = process.env.X_OAUTH_CLIENT_SECRET;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const webSecret = process.env.WEB_AUTH_SECRET;
  if (!clientId || !clientSecret || !siteUrl || !convexUrl || !webSecret) return errorRedirect(request, "configuration");

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expectedState = request.cookies.get("pons_x_oauth_state")?.value;
  const verifier = request.cookies.get("pons_x_oauth_verifier")?.value;
  if (!code || !state || !expectedState || !verifier || state !== expectedState) return errorRedirect(request, "invalid_state");

  try {
    const callback = `${siteUrl.replace(/\/$/, "")}/api/auth/x/callback`;
    const tokenResponse = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: callback,
        code_verifier: verifier,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) return errorRedirect(request, "token_exchange");
    const token = await tokenResponse.json() as XToken;
    if (!token.access_token) return errorRedirect(request, "token_exchange");

    const identityResponse = await fetch("https://api.x.com/2/users/me?user.fields=verified,verified_type", {
      headers: { authorization: `Bearer ${token.access_token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!identityResponse.ok) return errorRedirect(request, "identity");
    const identity = (await identityResponse.json() as XIdentity).data;
    if (!identity?.id || !identity.username) return errorRedirect(request, "identity");

    const wallet = await new ConvexHttpClient(convexUrl).action(api.wallets.provisionWebWallet, {
      secret: webSecret,
      xUserId: identity.id,
      username: identity.username,
      verified: Boolean(identity.verified),
      ...(identity.verified_type ? { verifiedType: identity.verified_type } : {}),
    });
    const telegramLink = request.cookies.get("pons_telegram_link")?.value;
    if (telegramLink && /^[a-f0-9]{64}$/.test(telegramLink)) {
      const response = NextResponse.redirect(new URL(TELEGRAM_CONSENT_PATH, siteUrl));
      response.cookies.set(TELEGRAM_CONSENT_COOKIE, createTelegramConsent(telegramLink, identity.id, identity.username, webSecret), {
        httpOnly: true, secure: siteUrl.startsWith("https://"), sameSite: "lax", path: TELEGRAM_CONSENT_PATH, maxAge: 600,
      });
      response.cookies.delete("pons_x_oauth_state");
      response.cookies.delete("pons_x_oauth_verifier");
      response.cookies.delete("pons_x_oauth_return");
      response.cookies.delete("pons_telegram_link");
      // Telegram linking authorizes access inside Telegram; it must not leave
      // an unrelated website wallet session behind in the OAuth browser.
      response.cookies.set(WEB_WALLET_SESSION_COOKIE, "", {
        httpOnly: true, secure: siteUrl.startsWith("https://"), sameSite: "lax", path: "/", maxAge: 0,
      });
      return response;
    }
    const returnTo = request.cookies.get("pons_x_oauth_return")?.value === "/terminal" ? "/terminal" : `/wallet/${wallet.address}`;
    const sessionCookie = createWebWalletSession(wallet.address, identity.id, identity.username, webSecret);
    const session = readWebWalletSession(sessionCookie, webSecret);
    if (!session) return errorRedirect(request, "session");
    await new ConvexHttpClient(convexUrl).action(api.wallets.registerWebSession, {
      secret: webSecret, sessionId: session.sessionId, ownerXUserId: session.xUserId, expiresAt: session.expiresAt,
    });
    const response = NextResponse.redirect(new URL(returnTo, siteUrl));
    response.cookies.delete("pons_x_oauth_state");
    response.cookies.delete("pons_x_oauth_verifier");
    response.cookies.delete("pons_x_oauth_return");
    response.cookies.delete("pons_telegram_link");
    response.cookies.set(WEB_WALLET_SESSION_COOKIE, sessionCookie, {
      httpOnly: true,
      secure: siteUrl.startsWith("https://"),
      sameSite: "lax",
      path: "/",
      maxAge: WEB_WALLET_SESSION_SECONDS,
    });
    return response;
  } catch (error) {
    console.error("x_wallet_sign_in_failed", error instanceof Error ? error.message : "unknown");
    return errorRedirect(request, "wallet");
  }
}
