import { after, NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import type { Address } from "viem";
import { api } from "@/convex/_generated/api";
import { boundedJson, RequestBodyError } from "@/lib/bounded-json";
import { refreshWebsiteMarkets, type WebsiteSnapshot } from "@/lib/website-market";
import { refreshWebsiteCatalog } from "@/lib/website-market-catalog";
import { readPublicMarketStates } from "@/lib/public-display-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL, secret = process.env.MARKET_INDEX_SECRET;
  if (!url || !secret) return NextResponse.json({ ok: false }, { status: 503 });
  let body: { tokenAddresses?: unknown; surface?: unknown };
  try { body = await boundedJson(request, 4_096); }
  catch (error) { return NextResponse.json({ ok: false }, { status: error instanceof RequestBodyError ? error.status : 400 }); }
  if (!Array.isArray(body?.tokenAddresses) || body.tokenAddresses.length > 20
    || body.tokenAddresses.some(t => typeof t !== "string" || !/^0x[a-f0-9]{40}$/i.test(t))) return NextResponse.json({ ok: false }, { status: 400 });
  const tokens = [...new Set((body.tokenAddresses as string[]).map(t => t.toLowerCase()))];
  const client = new ConvexHttpClient(url), leaseId = randomUUID();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  const viewerKey = createHash("sha256").update(`${ip}:${secret}`).digest("hex");
  let owned: string[] = [];
  let snapshots: WebsiteSnapshot[] = [];
  try {
    const targets = await client.mutation(api.marketData.acquire, { secret, tokens, leaseId, viewerKey });
    owned = targets.map(t => t.tokenAddress);
    if (targets.length) {
      const config = await client.query(api.site.marketRuntimeConfig, {});
      if (!config.factory || !config.stateView) throw new Error("market configuration unavailable");
      snapshots = await refreshWebsiteMarkets(client, secret, targets, { factory: config.factory as Address, stateView: config.stateView as Address });
      await client.mutation(api.marketData.complete, { secret, leaseId, tokens: owned, snapshots });
      owned = [];
    }
    if (body.surface === "launches") after(() => refreshWebsiteCatalog(client, secret).catch(() => undefined));
    return NextResponse.json({ ok: true, market: await readPublicMarketStates(url, tokens, snapshots.length > 0), nextRefreshMs: 60_000 }, { headers: { "cache-control": "no-store" } });
  } catch {
    // Do not convert provider failures into a full-page error or a zero price.
    const market = await readPublicMarketStates(url, tokens).catch(() => []);
    return NextResponse.json({ ok: false, market, nextRefreshMs: 60_000 });
  } finally {
    if (owned.length) await client.mutation(api.marketData.complete, { secret, leaseId, tokens: owned, snapshots }).catch(() => undefined);
  }
}
