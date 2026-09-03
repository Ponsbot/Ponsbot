import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { boundedJson, RequestBodyError } from "@/lib/bounded-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!secret || !convexUrl || process.env.TELEGRAM_ENABLED !== "true") return new NextResponse(null, { status: 404 });
  if (request.headers.get("x-telegram-bot-api-secret-token") !== secret) return new NextResponse(null, { status: 401 });
  try {
    const update = await boundedJson(request, 64_000);
    await new ConvexHttpClient(convexUrl).action(api.telegram.acceptUpdate, { secret, updateJson: JSON.stringify(update) });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false }, { status: error instanceof RequestBodyError ? error.status : 400 });
  }
}
