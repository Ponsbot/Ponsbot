import { NextRequest, NextResponse } from "next/server";
import { boundedJson, RequestBodyError } from "@/lib/bounded-json";
import { houdiniFetch, houdiniJson } from "@/lib/houdini-preview-auth";
import { HoudiniPrePaymentError } from "@/lib/houdini-payment-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RelayBody = {
  path?: unknown;
  method?: unknown;
  body?: unknown;
  xUserId?: unknown;
};

export async function POST(request: NextRequest) {
  const expected = process.env.HOUDINI_X_RELAY_SECRET;
  if (!expected || request.headers.get("x-pons-internal-secret") !== expected)
    return NextResponse.json({ message: "Not available" }, { status: 404 });
  let input: RelayBody;
  try {
    input = (await boundedJson(request, 16_384)) as RelayBody;
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof RequestBodyError ? error.message : "Invalid request",
      },
      { status: 400 },
    );
  }
  const path = typeof input.path === "string" ? input.path : "";
  const method =
    input.method === "POST" ? "POST" : input.method === "GET" ? "GET" : "";
  const body =
    typeof input.body === "string" && input.body.length <= 10_000
      ? input.body
      : undefined;
  const xUserId =
    typeof input.xUserId === "string" && /^\d{1,24}$/.test(input.xUserId)
      ? input.xUserId
      : "";
  if (
    !method ||
    !xUserId ||
    path.length > 2_500 ||
    !/^\/v2\/(?:tokens|quotes|exchanges|orders)(?:[/?]|$)/.test(path) ||
    (method === "POST") !== Boolean(body)
  ) {
    return NextResponse.json(
      { message: "Invalid Houdini relay request" },
      { status: 400 },
    );
  }
  try {
    const now = new Date();
    const endOfUtcDay = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    const response = await houdiniFetch(
      path,
      {
        method,
        cache: "no-store",
        ...(body
          ? { body, headers: { "content-type": "application/json" } }
          : {}),
      },
      {
        sessionId: `x-houdini-${xUserId}-${now.toISOString().slice(0, 10)}`,
        expiresAt: Math.floor(endOfUtcDay / 1_000),
      },
    );
    const payload = await houdiniJson(response).catch(() => ({
      message: "Houdini returned an invalid response",
    }));
    return NextResponse.json(payload, {
      status: response.status,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ...(error instanceof HoudiniPrePaymentError ? { code: error.code } : {}),
        message:
          error instanceof Error
            ? error.message.slice(0, 240)
            : "Houdini x402 fallback failed",
      },
      { status: 502, headers: {
        "cache-control": "no-store",
        ...(error instanceof HoudiniPrePaymentError ? { "x-pons-houdini-pre-payment": "rejected" } : {}),
      } },
    );
  }
}
