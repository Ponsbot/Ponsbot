import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { tradingAgentCapabilities } from "@/lib/trading-agents/config";
import { readWebWalletSession, WEB_WALLET_SESSION_COOKIE, webWalletCsrfToken, TERMINAL_RECENT_AUTH_SECONDS } from "@/lib/web-wallet-session";
import { ownerBotExecutionEnabled, ownerBotIntent } from "@/lib/trading-agents/execution";
import { agentWalletHoldings } from "@/lib/wallet-signer/agents";
import { boundedJson } from "@/lib/bounded-json";
import { z } from "zod";
import type { OwnedBot } from "@/lib/trading-agents/owner-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "cache-control": "private, no-store", Vary: "Cookie" };
export async function GET(request: NextRequest) {
  if (!tradingAgentCapabilities().website) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  const secret = process.env.WEB_AUTH_SECRET;
  const session = secret ? readWebWalletSession(request.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value, secret) : null;
  if (!session) return NextResponse.json({ error: "Sign in with the X account that owns your bot." }, { status: 401, headers });
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return NextResponse.json({ error: "Bot management is unavailable." }, { status: 503, headers });
  try {
    const bots = await new ConvexHttpClient(url).action(makeFunctionReference<"action", { secret: string; sessionId: string; ownerXUserId: string }, OwnedBot[]>("tradingAgentOwners:webList"), {
      secret: secret!, sessionId: session.sessionId, ownerXUserId: session.xUserId,
    });
    if (request.nextUrl.searchParams.get("balances") === "true") await Promise.all(bots.map(async bot => {
      if (bot.walletAddress) bot.live = await agentWalletHoldings(bot.walletAddress, bot.holdings.map(t => t.token)).catch(() => undefined);
    }));
    return NextResponse.json({ bots, destination: session.walletAddress, executionEnabled: ownerBotExecutionEnabled(), csrfToken: webWalletCsrfToken(session.sessionId, secret!) }, { headers });
  } catch {
    return NextResponse.json({ error: "Could not verify bot access. Sign in again or try later." }, { status: 503, headers });
  }
}

const submitSchema = z.object({ agentId: z.string().regex(/^[a-zA-Z0-9]{10,64}$/), requestKey: z.string().regex(/^[a-zA-Z0-9-]{16,80}$/), intent: ownerBotIntent }).strict();
export async function POST(request: NextRequest) {
  if (!tradingAgentCapabilities().website || !ownerBotExecutionEnabled()) return NextResponse.json({ error: "Bot-wallet transactions are not enabled yet." }, { status: 503, headers });
  const secret = process.env.WEB_AUTH_SECRET, url = process.env.NEXT_PUBLIC_CONVEX_URL;
  const session = secret ? readWebWalletSession(request.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value, secret) : null;
  if (!session || !secret || !url) return NextResponse.json({ error: "Sign in again to manage your bot." }, { status: 401, headers });
  if (Math.floor(Date.now() / 1000) - session.authenticatedAt > TERMINAL_RECENT_AUTH_SECONDS) return NextResponse.json({ error: "Sign in again before submitting a transaction." }, { status: 401, headers });
  if (request.headers.get("origin") !== new URL(process.env.NEXT_PUBLIC_SITE_URL || request.url).origin || request.headers.get("x-csrf-token") !== webWalletCsrfToken(session.sessionId, secret)) return NextResponse.json({ error: "Request verification failed." }, { status: 403, headers });
  try {
    const input = submitSchema.parse(await boundedJson(request, 4096));
    const args = { secret, sessionId: session.sessionId, ownerXUserId: session.xUserId, agentId: input.agentId, requestKey: input.requestKey, intentJson: JSON.stringify(input.intent) };
    const id = await new ConvexHttpClient(url).action(makeFunctionReference<"action", typeof args, string>("tradingAgentExecution:submit"), args);
    return NextResponse.json({ id, status: "processing" }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const safe = message.includes("BOT_TRANSACTION_PENDING") ? "This bot already has a transaction in progress. Wait for its result."
      : message.includes("BOT_WALLET_NOT_READY") ? "Your bot's wallet is still being prepared. Try again shortly."
      : "The request could not be accepted or its status could not be verified. Refresh to check before trying again.";
    return NextResponse.json({ error: safe }, { status: 400, headers });
  }
}
