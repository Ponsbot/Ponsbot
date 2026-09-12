import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { tradingAgentCapabilities } from "@/lib/trading-agents/config";
import type { BotYardBot } from "@/lib/trading-agents/yard-view";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  if (!tradingAgentCapabilities().website) return NextResponse.json({ error: "not found" }, { status: 404 });
  const selected = request.nextUrl.searchParams.get("selected") || undefined;
  const cursor = request.nextUrl.searchParams.get("cursor") || undefined;
  if (selected && !/^[a-zA-Z0-9]{10,64}$/.test(selected) || cursor && cursor.length > 4096) return NextResponse.json({ error: "invalid selection" }, { status: 400 });
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  try {
    const result = await new ConvexHttpClient(url).query(makeFunctionReference<"query", { selected?: string; cursor?: string }, { bots: BotYardBot[]; nextCursor: string | null }>("tradingAgents:publicYard"), { ...(selected ? { selected } : {}), ...(cursor ? { cursor } : {}) });
    return NextResponse.json(result, { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=30" } });
  } catch { return NextResponse.json({ error: "The yard could not be refreshed. Try again shortly." }, { status: 503 }); }
}
