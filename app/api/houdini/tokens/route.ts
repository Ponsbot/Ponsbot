import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { houdiniFetch, houdiniJson, houdiniPreviewAuth } from "@/lib/houdini-preview-auth";
import { ethUsdPrice } from "@/lib/wallet-signer/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RawToken = { id?: unknown; symbol?: unknown; name?: unknown; chain?: unknown; address?: unknown; icon?: unknown; hasCex?: unknown; enabled?: unknown; chainData?: { addressValidation?: unknown; memoNeeded?: unknown; kind?: unknown } };

function publicToken(token: { tokenId: string; symbol: string; name: string; chain: string; icon?: string; hasCex: boolean; enabled: boolean }) {
  return { id: token.tokenId, symbol: token.symbol, name: token.name, chain: token.chain, ...(token.icon ? { icon: token.icon } : {}), hasCex: token.hasCex, enabled: token.enabled };
}

export async function GET(request: NextRequest) {
  const session = await houdiniPreviewAuth(request);
  if (!session) return NextResponse.json({ error: "Not available" }, { status: 404 });
  const ethOnly = request.nextUrl.searchParams.get("ethOnly") === "true";
  const ethUsd = ethOnly ? await ethUsdPrice().catch(() => undefined) : undefined;
  const term = ethOnly ? "ETH" : (request.nextUrl.searchParams.get("term") || "").trim().slice(0, 80);
  const mode = request.nextUrl.searchParams.get("mode") === "private" ? "private" : "standard";
  if (!ethOnly && term.length < 2) return NextResponse.json({ tokens: [] }, { headers: { "cache-control": "private, max-age=60" } });
  const cacheKey = ethOnly ? "cex:eth:robinhood:v2" : `cex:${createHash("sha256").update(term.toLowerCase()).digest("hex")}`;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const client = convexUrl ? new ConvexHttpClient(convexUrl) : null;
  if (client) {
    const cached = await client.query(api.site.getHoudiniTokenSearch, { key: cacheKey }).catch(() => null);
    if (cached) return NextResponse.json({ tokens: cached.flatMap((token) => token ? [publicToken(token)] : []), mode, ...(ethUsd ? { ethUsd } : {}) }, { headers: { "cache-control": "private, max-age=300" } });
  }
  const params = new URLSearchParams({ hasCex: "true", pageSize: "30", page: "1" });
  if (term) params.set("term", term);
  // The unscoped ETH catalog is large enough that Robinhood's native asset
  // may not occur on the first page. Pons Bot always funds from Robinhood.
  if (ethOnly) params.set("chain", "Robinhood");
  try {
    const response = await houdiniFetch(`/v2/tokens?${params}`, {
      cache: "no-store", signal: AbortSignal.timeout(12_000),
    }, { sessionId: session.sessionId, expiresAt: session.expiresAt });
    const payload = await houdiniJson(response);
    if (!response.ok) return NextResponse.json({ error: typeof payload.message === "string" ? payload.message : "Houdini assets are temporarily unavailable." }, { status: response.status });
    const tokens = (Array.isArray(payload.tokens) ? payload.tokens : []).flatMap((item) => {
      const token = item as RawToken;
      if (typeof token.id !== "string" || !/^[a-fA-F0-9]{24}$/.test(token.id)
        || typeof token.symbol !== "string" || typeof token.name !== "string" || typeof token.chain !== "string") return [];
      const addressValidation = typeof token.chainData?.addressValidation === "string" && token.chainData.addressValidation.length <= 300 ? token.chainData.addressValidation : undefined;
      return [{ tokenId: token.id, symbol: token.symbol.slice(0, 20), name: token.name.slice(0, 80), chain: token.chain.slice(0, 50),
        ...(typeof token.address === "string" && token.address.length <= 150 ? { tokenAddress: token.address } : {}),
        ...(typeof token.icon === "string" && /^https:\/\//.test(token.icon) ? { icon: token.icon } : {}),
        hasCex: token.hasCex === true, enabled: token.enabled !== false,
        ...(addressValidation ? { addressValidation } : {}),
        ...(typeof token.chainData?.memoNeeded === "boolean" ? { memoNeeded: token.chainData.memoNeeded } : {}),
        ...(typeof token.chainData?.kind === "string" ? { chainKind: token.chainData.kind.slice(0, 30) } : {}) }];
    }).filter((token) => token.hasCex && token.enabled && (!ethOnly || (token.symbol.toUpperCase() === "ETH" && /robinhood/i.test(token.chain))));
    const secret = process.env.WEB_AUTH_SECRET;
    if (client && secret) await client.mutation(api.site.cacheHoudiniTokenSearch, { secret, key: cacheKey, tokens }).catch((error) => console.error("houdini_catalog_cache_failed", error));
    return NextResponse.json({ tokens: tokens.map(publicToken), mode, ...(ethUsd ? { ethUsd } : {}) }, { headers: { "cache-control": "private, max-age=300" } });
  } catch {
    return NextResponse.json({ error: "Houdini assets are temporarily unavailable." }, { status: 502 });
  }
}
