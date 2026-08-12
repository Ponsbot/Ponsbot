import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { isAddress } from "viem";
import { api } from "@/convex/_generated/api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const tokenAddress = request.nextUrl.searchParams.get("token") || "";
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl || !isAddress(tokenAddress)) return NextResponse.json({ activity: [] }, { status: 400 });
  const activity = await new ConvexHttpClient(convexUrl).query(api.site.tokenActivity, { tokenAddress, limit: 50 });
  return NextResponse.json({ activity }, { headers: { "cache-control": "no-store" } });
}
