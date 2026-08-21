import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return NextResponse.json({ error: "Launch data is not configured" }, { status: 503 });
  const cursor = request.nextUrl.searchParams.get("cursor");
  const requestedSort = request.nextUrl.searchParams.get("sort");
  const sort = ["newest", "oldest", "mcap", "volume", "lastBuy"].includes(requestedSort || "")
    ? requestedSort as "newest" | "oldest" | "mcap" | "volume" | "lastBuy"
    : "newest";
  const count = Math.min(Math.max(Number(request.nextUrl.searchParams.get("count") || 40), 1), 40);
  try {
    const result = await new ConvexHttpClient(url).query(api.site.listLaunchesPage, { paginationOpts: { cursor, numItems: count }, sort });
    return NextResponse.json(result, { headers: { "cache-control": "public, max-age=5, stale-while-revalidate=20" } });
  } catch {
    return NextResponse.json({ error: "Launch data is temporarily unavailable" }, { status: 503 });
  }
}
