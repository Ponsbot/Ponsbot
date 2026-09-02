import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { readWebWalletSession, WEB_WALLET_SESSION_COOKIE } from "@/lib/web-wallet-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.WEB_AUTH_SECRET;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const session = secret ? readWebWalletSession(request.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value, secret) : null;
  if (!secret || !session) return NextResponse.json({ error: "Connect X to use the terminal" }, { status: 401 });
  if (!convexUrl) return NextResponse.json({ error: "Liquidity positions are not configured" }, { status: 503 });
  try {
    const positions = await new ConvexHttpClient(convexUrl).action(api.liquidityTerminal.terminalPositions, {
      secret, ownerXUserId: session.xUserId,
      sessionIdHash: createHash("sha256").update(session.sessionId).digest("hex"),
    });
    return NextResponse.json(positions, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Liquidity positions are taking a moment to load." }, { status: 503 });
  }
}
