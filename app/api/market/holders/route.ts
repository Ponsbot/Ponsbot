import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { formatUnits, isAddress } from "viem";
import { api } from "@/convex/_generated/api";

export const dynamic = "force-dynamic";

type HolderItem = { address: { hash: string; name?: string | null; is_contract?: boolean }; value: string };
type HolderTag = "Creator" | "Liquidity" | "Uniswap V3 Liquidity" | "Uniswap V4 Liquidity";

function safeUnsignedInteger(value: unknown, fallback = 0n) {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : fallback;
}

async function safeJson<T>(response: Response): Promise<T | undefined> {
  try { return await response.json() as T; } catch { return undefined; }
}

function liquidityTag(name: string, isKnownLiquidityAddress: boolean): HolderTag | undefined {
  // Blockscout supplies verified contract names where available. V4 liquidity
  // is held by the singleton PoolManager rather than a token-specific pool
  // address, while V3 positions use individual pool contracts.
  if (/uniswap\s*v?4|v4\s*(?:pool|liquidity)|poolmanager/i.test(name)) return "Uniswap V4 Liquidity";
  if (/uniswap\s*v?3|v3\s*(?:pool|liquidity)/i.test(name)) return "Uniswap V3 Liquidity";
  if (isKnownLiquidityAddress || /pool|liquidity|locker|hook|curve/i.test(name)) return "Liquidity";
  return undefined;
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") || "";
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl || !isAddress(token)) return NextResponse.json({ holders: [] }, { status: 400 });
  const launch = await new ConvexHttpClient(convexUrl).query(api.site.getLaunch, { tokenAddress: token });
  if (!launch) return NextResponse.json({ holders: [] }, { status: 404 });
  const base = process.env.ROBINHOOD_EXPLORER_API || "https://robinhoodchain.blockscout.com/api/v2";
  const [holdersResult, tokenResult] = await Promise.allSettled([
    fetch(`${base}/tokens/${token}/holders`, { cache: "no-store", signal: AbortSignal.timeout(8_000) }),
    fetch(`${base}/tokens/${token}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) }),
  ]);
  if (holdersResult.status !== "fulfilled" || !holdersResult.value.ok) return NextResponse.json({ holders: [] }, { status: 502 });
  const holdersResponse = holdersResult.value;
  const tokenResponse = tokenResult.status === "fulfilled" ? tokenResult.value : undefined;
  const payload = await safeJson<{ items?: HolderItem[] }>(holdersResponse);
  if (!Array.isArray(payload?.items)) return NextResponse.json({ holders: [] }, { status: 502 });
  const tokenData = tokenResponse?.ok ? await safeJson<{ decimals?: string; total_supply?: string }>(tokenResponse) : undefined;
  const parsedDecimals = Number(tokenData?.decimals ?? 18);
  const decimals = Number.isInteger(parsedDecimals) && parsedDecimals >= 0 && parsedDecimals <= 255 ? parsedDecimals : 18;
  const supply = safeUnsignedInteger(tokenData?.total_supply);
  const creator = launch.creatorAddress?.toLowerCase();
  const liquidity = launch.poolAddress?.toLowerCase();
  const holders = payload.items.slice(0, 20).flatMap((item) => {
    if (!item?.address || !isAddress(item.address.hash)) return [];
    const address = item.address.hash;
    const normalized = address.toLowerCase();
    const name = item.address.name || "";
    const tag: HolderTag | undefined = normalized === creator ? "Creator" : liquidityTag(name, normalized === liquidity);
    const raw = safeUnsignedInteger(item.value, -1n);
    if (raw < 0n) return [];
    return [{ address, amount: formatUnits(raw, decimals), percentage: supply > 0n ? Number(raw * 1_000_000n / supply) / 10_000 : 0, tag }];
  });
  return NextResponse.json({ holders }, { headers: { "cache-control": "public, max-age=60, stale-while-revalidate=120" } });
}
