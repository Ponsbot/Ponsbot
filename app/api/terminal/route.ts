import { timingSafeEqual } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { getWalletHoldings } from "@/lib/site-data";
import { readWebWalletSession, webWalletCsrfToken, WEB_WALLET_SESSION_COOKIE } from "@/lib/web-wallet-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const RECENT_AUTH_SECONDS = 30 * 60;

function authenticated(request: NextRequest) {
  const secret = process.env.WEB_AUTH_SECRET;
  const session = secret ? readWebWalletSession(request.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value, secret) : null;
  return secret && session ? { secret, session } : null;
}

function sameValue(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  const auth = authenticated(request);
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!auth) return NextResponse.json({ authenticated: false }, { status: 401, headers: { "cache-control": "no-store" } });
  if (!convexUrl) return NextResponse.json({ error: "Terminal data is not configured" }, { status: 503 });
  const client = new ConvexHttpClient(convexUrl);
  const [history, wallet] = await Promise.all([
    client.action(api.wallets.terminalHistory, { secret: auth.secret, ownerXUserId: auth.session.xUserId, sessionId: auth.session.sessionId }),
    getWalletHoldings(auth.session.walletAddress),
  ]);
  return NextResponse.json({ authenticated: true, username: auth.session.username, walletAddress: auth.session.walletAddress, expiresAt: auth.session.expiresAt, history, holdings: wallet.holdings }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = authenticated(request);
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!auth) return NextResponse.json({ error: "Connect X to use the terminal" }, { status: 401 });
  if (!convexUrl || !siteUrl) return NextResponse.json({ error: "Terminal execution is not configured" }, { status: 503 });
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(siteUrl).origin) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  const suppliedCsrf = request.headers.get("x-pons-csrf") || "";
  if (!sameValue(suppliedCsrf, webWalletCsrfToken(auth.session.sessionId, auth.secret))) return NextResponse.json({ error: "Invalid terminal session token" }, { status: 403 });
  if (Math.floor(Date.now() / 1000) - auth.session.authenticatedAt > RECENT_AUTH_SECONDS) {
    return NextResponse.json({ error: "Reconnect X before moving funds", reauthRequired: true }, { status: 401 });
  }
  const body = await request.json().catch(() => null) as null | { channel?: string; eventId?: string; text?: string; command?: unknown };
  if (!body || !/^[a-zA-Z0-9_-]{12,100}$/.test(body.eventId || "") || !["terminal_chat", "terminal_form"].includes(body.channel || "")) {
    return NextResponse.json({ error: "Invalid terminal request" }, { status: 400 });
  }
  const result = await new ConvexHttpClient(convexUrl).action(api.wallets.executeTerminalCommand, {
    secret: auth.secret, ownerXUserId: auth.session.xUserId, sessionId: auth.session.sessionId, eventId: body.eventId!,
    channel: body.channel as "terminal_chat" | "terminal_form",
    ...(typeof body.text === "string" ? { text: body.text } : {}),
    ...(body.command !== undefined ? { commandJson: JSON.stringify(body.command) } : {}),
  });
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
