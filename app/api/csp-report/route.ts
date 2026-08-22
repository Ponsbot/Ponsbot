import { NextResponse } from "next/server";
import { boundedJson, RequestBodyError } from "@/lib/bounded-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reportWindows = new Map<string, { startedAt: number; count: number }>();

function permitReport(request: Request) {
  const now = Date.now();
  const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  const prior = reportWindows.get(key);
  const current = prior && now - prior.startedAt < 60_000 ? prior : { startedAt: now, count: 0 };
  current.count += 1;
  reportWindows.set(key, current);
  if (reportWindows.size > 1_000) {
    for (const [candidate, window] of reportWindows) if (now - window.startedAt >= 60_000) reportWindows.delete(candidate);
    if (reportWindows.size > 1_000) reportWindows.clear();
  }
  return current.count <= 30;
}

export async function POST(request: Request) {
  if (!permitReport(request)) return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  try {
    // Browsers use both legacy {"csp-report": ...} and Reporting API shapes.
    // Validate only size and JSON syntax; never echo or persist attacker input.
    await boundedJson(request, 16_384);
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 400;
    return NextResponse.json({ error: "Invalid CSP report" }, { status, headers: { "cache-control": "no-store" } });
  }
}
