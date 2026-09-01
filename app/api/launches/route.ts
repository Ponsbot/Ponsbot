import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return NextResponse.json({ error: "Launch data is not configured" }, { status: 503 });
  const cursor = request.nextUrl.searchParams.get("cursor");
  const requestedSort = request.nextUrl.searchParams.get("sort");
  const sort = ["newest", "oldest", "mcap", "volume"].includes(requestedSort || "")
    ? requestedSort as "newest" | "oldest" | "mcap" | "volume"
    : "newest";
  const count = Math.min(Math.max(Number(request.nextUrl.searchParams.get("count") || 40), 1), 40);
  const requestedPage = Math.floor(Number(request.nextUrl.searchParams.get("page") || 1));
  const pageNumber = Number.isFinite(requestedPage) ? Math.min(Math.max(requestedPage, 1), 500) : 1;
  const search = request.nextUrl.searchParams.get("search")?.trim().slice(0, 64) || "";
  try {
    const client = new ConvexHttpClient(url);
    if (search) {
      const page = await client.query(api.site.searchLaunches, { search, limit: count, sort });
      return NextResponse.json({ page, continueCursor: "", isDone: true }, { headers: { "cache-control": "no-store" } });
    }
    let currentCursor = cursor;
    let result;
    // Convex pagination cursors are opaque. For direct numbered navigation,
    // walk only the cursor chain on the server and return the selected page;
    // earlier launch records are never sent to or retained by the browser.
    for (let currentPage = 1; currentPage <= pageNumber; currentPage += 1) {
      result = await client.query(api.site.listLaunchesPage, { paginationOpts: { cursor: currentCursor, numItems: count }, sort });
      if (currentPage === pageNumber || result.isDone) break;
      currentCursor = result.continueCursor || null;
    }
    if (!result) throw new Error("launch page was not resolved");
    return NextResponse.json(result, { headers: { "cache-control": "public, max-age=5, stale-while-revalidate=20" } });
  } catch {
    return NextResponse.json({ error: "Launch data is temporarily unavailable" }, { status: 503 });
  }
}
