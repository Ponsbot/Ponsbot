import { createHash, timingSafeEqual } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { getWalletHoldings } from "@/lib/site-data";
import { readWebWalletSession, terminalReauthAt, TERMINAL_RECENT_AUTH_SECONDS, webWalletCsrfToken, WEB_WALLET_SESSION_COOKIE } from "@/lib/web-wallet-session";
import { boundedJson, RequestBodyError } from "@/lib/bounded-json";
import { readTerminalCatalog } from "@/lib/public-display-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authenticated(request: NextRequest) {
  const secret = process.env.WEB_AUTH_SECRET;
  const session = secret ? readWebWalletSession(request.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value, secret) : null;
  return secret && session ? { secret, session } : null;
}

async function activeSession(secret: string, session: NonNullable<ReturnType<typeof readWebWalletSession>>) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return false;
  return new ConvexHttpClient(convexUrl).action(api.wallets.verifyWebSession, { secret, sessionId: session.sessionId, ownerXUserId: session.xUserId });
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
  if (!await activeSession(auth.secret, auth.session)) return NextResponse.json({ authenticated: false }, { status: 401, headers: { "cache-control": "no-store" } });
  const client = new ConvexHttpClient(convexUrl);
  const scope = request.nextUrl.searchParams.get("scope");
  const includeCatalog = scope === null || scope === "catalog";
  const includeHoldings = scope === null || scope === "holdings";
  const requestedAfter = Number(request.nextUrl.searchParams.get("updatedAfter") || 0);
  const updatedAfter = Number.isSafeInteger(requestedAfter) && requestedAfter > 0
    ? requestedAfter
    : undefined;
  const requestedFeesAfter = Number(request.nextUrl.searchParams.get("feesUpdatedAfter") || 0);
  const feesUpdatedAfter = Number.isSafeInteger(requestedFeesAfter) && requestedFeesAfter > 0 ? requestedFeesAfter : undefined;
  const holdingsOnly = scope === "holdings";
  const emptyHistory = {
    messages: [], actions: [], launches: [], tokenCatalog: [], catalogIncluded: false,
    feeReceipts: [], feesDelta: true, feesUpdatedThrough: feesUpdatedAfter || 0,
    delta: true, updatedThrough: updatedAfter || 0,
  };
  const [historyResult, houdiniResult, walletResult, catalogResult] = await Promise.allSettled([
    holdingsOnly ? Promise.resolve(emptyHistory) : client.action(api.wallets.terminalHistory, { secret: auth.secret, ownerXUserId: auth.session.xUserId, sessionId: auth.session.sessionId, includeCatalog, includePublicCatalog: false, ...(includeCatalog || !updatedAfter ? {} : { updatedAfter }), ...(includeCatalog || !feesUpdatedAfter ? {} : { feesUpdatedAfter }) }),
    holdingsOnly ? Promise.resolve([]) : client.query(api.site.listHoudiniSwapHistory, { secret: auth.secret, ownerXUserId: auth.session.xUserId, sessionIdHash: createHash("sha256").update(auth.session.sessionId).digest("hex"), ...(includeCatalog || !updatedAfter ? {} : { updatedAfter }) }),
    // Holdings load independently from chat history, so the terminal can give
    // token pricing enough time to finish without delaying messages/actions.
    includeHoldings ? getWalletHoldings(auth.session.walletAddress, undefined, { pricingWaitMs: 5_000 }) : Promise.resolve(null),
    includeCatalog ? readTerminalCatalog(convexUrl) : Promise.resolve([]),
  ]);
  const history = historyResult.status === "fulfilled" ? historyResult.value : {
    messages: [], actions: [], launches: [], tokenCatalog: [], catalogIncluded: false,
    feeReceipts: [], feesDelta: true, feesUpdatedThrough: feesUpdatedAfter || 0,
    // A failed history read must never move the browser cursor past an LP
    // completion that was committed while this request was failing.
    delta: Boolean(updatedAfter), updatedThrough: updatedAfter || 0,
  };
  const houdiniSwaps = houdiniResult.status === "fulfilled" ? houdiniResult.value : [];
  const wallet = walletResult.status === "fulfilled" ? walletResult.value : null;
  if (includeCatalog && catalogResult.status === "fulfilled") {
    history.tokenCatalog = [...new Map([...catalogResult.value, ...history.tokenCatalog]
      .map(token => [token.tokenAddress.toLowerCase(), token])).values()]
      .sort((a, b) => {
        const rank = (symbol: string) => symbol.toUpperCase() === "PONSBOT" ? 0 : symbol.toUpperCase() === "PONS" ? 1 : 2;
        return rank(a.symbol) - rank(b.symbol);
      });
  }
  return NextResponse.json({
    authenticated: true,
    username: auth.session.username,
    walletAddress: auth.session.walletAddress,
    expiresAt: auth.session.expiresAt,
    reauthAt: terminalReauthAt(auth.session.authenticatedAt),
    houdiniPreviewEnabled: true,
    history: { ...history, houdiniSwaps },
    ...(wallet ? { holdings: wallet.holdings } : {}),
    availability: {
      history: historyResult.status === "fulfilled",
      houdini: houdiniResult.status === "fulfilled",
      holdings: !includeHoldings || walletResult.status === "fulfilled",
    },
  }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const auth = authenticated(request);
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!auth) return NextResponse.json({ error: "Connect X to use the terminal" }, { status: 401 });
  if (!convexUrl || !siteUrl) return NextResponse.json({ error: "Terminal execution is not configured" }, { status: 503 });
  if (!await activeSession(auth.secret, auth.session)) return NextResponse.json({ error: "Connect X to use the terminal" }, { status: 401 });
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(siteUrl).origin) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  const suppliedCsrf = request.headers.get("x-pons-csrf") || "";
  if (!sameValue(suppliedCsrf, webWalletCsrfToken(auth.session.sessionId, auth.secret))) return NextResponse.json({ error: "Invalid terminal session token" }, { status: 403 });
  if (Math.floor(Date.now() / 1000) - auth.session.authenticatedAt >= TERMINAL_RECENT_AUTH_SECONDS) {
    return NextResponse.json({ error: "Reconnect X before moving funds", reauthRequired: true }, { status: 401 });
  }
  let body: null | { channel?: string; eventId?: string; text?: string; command?: unknown } = null;
  try { body = await boundedJson(request, 8_192); }
  catch (error) { return NextResponse.json({ error: error instanceof RequestBodyError ? error.message : "Invalid terminal request" }, { status: error instanceof RequestBodyError ? error.status : 400 }); }
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
