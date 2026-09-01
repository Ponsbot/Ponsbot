import { after, NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { refreshTokenActivity } from "./token-activity-refresh";
import type { Address } from "viem";
import type { ActivityKind } from "./token-activity-policy";

export async function tokenActivityResponse(request: Request, kind: ActivityKind) {
  const params = new URL(request.url).searchParams;
  const token = (params.get("token") || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) return NextResponse.json({ [kind]: [] }, { status: 400 });
  const url = process.env.NEXT_PUBLIC_CONVEX_URL, secret = process.env.MARKET_INDEX_SECRET;
  if (!url || !secret) return NextResponse.json({ available: false }, { status: 503 });
  const client = new ConvexHttpClient(url);
  try {
    const snapshot = await client.query(api.marketData.activitySnapshot, { secret, token, kind });
    if (!snapshot) return NextResponse.json({ [kind]: [] }, { status: 404 });
    const shouldRefresh = params.get("cacheOnly") !== "1" && snapshot.due;
    if (shouldRefresh) {
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
      const viewerKey = createHash("sha256").update(`${ip}:${secret}`).digest("hex");
      after(async () => {
        const leaseId = randomUUID();
        const owned = await client.mutation(api.marketData.acquireActivity, { secret, token, kind, leaseId, viewerKey }).catch(() => null);
        if (!owned) return;
        const result = await refreshTokenActivity(client, secret, token as Address, kind, leaseId, owned)
          .catch(() => ({ diagnostic: "activity_provider_unavailable" }));
        await client.mutation(api.marketData.completeActivity, { secret, token, kind, leaseId, ...result }).catch(() => undefined);
      });
    }
    return NextResponse.json({ ...(snapshot.json ? JSON.parse(snapshot.json) : { [kind]: [] }),
      available: snapshot.json !== undefined, observedAt: snapshot.observedAt,
      refreshing: snapshot.refreshing || shouldRefresh,
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    // Preserve browser rows on failure; do not return replacement empty rows.
    return NextResponse.json({ available: false }, { status: 503 });
  }
}
