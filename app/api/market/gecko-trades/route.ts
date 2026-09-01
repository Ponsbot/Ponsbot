import { tokenActivityResponse } from "@/lib/token-activity-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = (request: Request) => tokenActivityResponse(request, "trades");
