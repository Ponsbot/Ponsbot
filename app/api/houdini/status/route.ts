import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { houdiniFetch, houdiniJson, houdiniPreviewAuth } from "@/lib/houdini-preview-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeText(value: unknown, max = 80) { return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined; }

export async function GET(request: NextRequest) {
  const session = await houdiniPreviewAuth(request, true);
  if (!session) return NextResponse.json({ error: "Not available" }, { status: 404 });
  const reviewId = request.nextUrl.searchParams.get("reviewId") || "";
  if (!/^hqr_[A-Za-z0-9_-]{20,80}$/.test(reviewId)) return NextResponse.json({ error: "Invalid swap reference" }, { status: 400 });
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.WEB_AUTH_SECRET;
  if (!convexUrl || !secret) return NextResponse.json({ error: "Houdini status is not configured." }, { status: 503 });
  const client = new ConvexHttpClient(convexUrl);
  const sessionIdHash = createHash("sha256").update(session.sessionId).digest("hex");
  const stored = await client.query(api.site.getHoudiniQuoteExecution, { secret, reviewId, sessionIdHash, ownerXUserId: session.xUserId });
  if (!stored) return NextResponse.json({ error: "Swap not found" }, { status: 404 });
  if (stored.status === "funding" && stored.fundingRequestId && stored.fundingStatus === "confirmed") {
    await client.mutation(api.site.finishHoudiniFunding, { secret, reviewId, sessionIdHash, fundingRequestId: stored.fundingRequestId, outcome: "funded", ...(stored.fundingTransactionHash ? { transactionHash: stored.fundingTransactionHash } : {}) });
    stored.status = "funded";
  } else if (stored.status === "funding" && stored.fundingRequestId && ["failed", "rejected"].includes(stored.fundingStatus || "")) {
    await client.mutation(api.site.finishHoudiniFunding, { secret, reviewId, sessionIdHash, fundingRequestId: stored.fundingRequestId, outcome: "failed", safeError: stored.fundingError || "Wallet funding did not complete." });
    stored.status = "awaiting_funding";
  }
  if (!stored.houdiniId || stored.status === "quoted" || stored.status === "submitting" || stored.status === "uncertain") {
    return NextResponse.json({ execution: stored }, { headers: { "cache-control": "no-store" } });
  }
  try {
    const response = await houdiniFetch(`/v2/orders/${encodeURIComponent(stored.houdiniId)}`, {
      cache: "no-store", signal: AbortSignal.timeout(12_000),
    }, { sessionId: session.sessionId, expiresAt: session.expiresAt });
    const payload = await houdiniJson(response);
    if (!response.ok) return NextResponse.json({ execution: stored, warning: safeText(payload.message, 160) || "Live status is temporarily unavailable." }, { headers: { "cache-control": "no-store" } });
    const displayStatus = safeText(payload.displayStatus);
    const statusLabel = safeText(payload.statusLabel);
    await client.mutation(api.site.updateHoudiniOrderStatus, { secret, reviewId, sessionIdHash, ownerXUserId: session.xUserId, ...(displayStatus ? { displayStatus } : {}), ...(statusLabel ? { statusLabel } : {}) });
    const label = (statusLabel || "").toUpperCase();
    const status = ["FINISHED", "COMPLETED"].includes(label) ? "completed" : ["FAILED", "EXPIRED", "REFUNDED", "DELETED"].includes(label) ? "failed" : stored.status;
    return NextResponse.json({ execution: { ...stored, status, displayStatus, statusLabel } }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ execution: stored, warning: "Live status is temporarily unavailable." }, { headers: { "cache-control": "no-store" } });
  }
}
