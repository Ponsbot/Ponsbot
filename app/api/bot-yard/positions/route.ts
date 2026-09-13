import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { tradingAgentCapabilities } from "@/lib/trading-agents/config";
import type { YardZone, ZoneCounts } from "@/lib/trading-agents/yard-zones";
export async function GET(request: NextRequest) {
  if (!tradingAgentCapabilities().website) return NextResponse.json([], { status: 404 });
  const ids = (request.nextUrl.searchParams.get("ids") ?? "").split(",").filter(Boolean);
  if (ids.length > 24 || ids.some(id => !/^[a-zA-Z0-9]{10,64}$/.test(id))) return NextResponse.json([], { status: 400 });
  if (!process.env.NEXT_PUBLIC_CONVEX_URL) return NextResponse.json([], { status: 503 });
  try {
    const positions = await new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL).query(makeFunctionReference<"query", { ids: string[] }, { positions: Array<{ id: string; x: number; y: number; at: number; zone: YardZone }>; counts: ZoneCounts }>("tradingAgents:publicYardPositions"), { ids });
    return NextResponse.json(positions, { headers: { "cache-control": "no-store" } });
  } catch { return NextResponse.json([], { status: 503 }); }
}
