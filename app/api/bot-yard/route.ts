import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { tradingAgentCapabilities } from "@/lib/trading-agents/config";
import type { BotYardBot } from "@/lib/trading-agents/yard-view";
import { yardZones, type YardZone } from "@/lib/trading-agents/yard-zones";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  if (!tradingAgentCapabilities().website) return NextResponse.json({ error: "not found" }, { status: 404 });
  const selected = request.nextUrl.searchParams.get("selected") || undefined;
  const cursor = request.nextUrl.searchParams.get("cursor") || undefined;
  const zone = request.nextUrl.searchParams.get("zone") as YardZone | null;
  if (zone && !Object.hasOwn(yardZones, zone)) return NextResponse.json({ error: "invalid area" }, { status: 400 });
  if (selected && !/^[a-zA-Z0-9]{10,64}$/.test(selected) || cursor && cursor.length > 4096) return NextResponse.json({ error: "invalid selection" }, { status: 400 });
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return NextResponse.json({ error: "unavailable" }, { status: 503 });
  try {
    const result = await new ConvexHttpClient(url).query(makeFunctionReference<"query", { selected?: string; cursor?: string; zone?: YardZone }, { bots: BotYardBot[]; nextCursor: string | null }>("tradingAgents:publicYard"), { ...(selected ? { selected } : {}), ...(cursor ? { cursor } : {}), ...(zone ? { zone } : {}) });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch { return NextResponse.json({ error: "The yard could not be refreshed. Try again shortly." }, { status: 503 }); }
}
