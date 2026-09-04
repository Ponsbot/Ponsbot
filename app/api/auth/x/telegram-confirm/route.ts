import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { readTelegramConsent, TELEGRAM_CONSENT_COOKIE, TELEGRAM_CONSENT_PATH } from "@/lib/telegram-link-consent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const escape = (text: string) => text.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
function problem(text: string, status: number) {
  return new NextResponse(text, { status, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
}
function context(request: NextRequest) {
  const secret = process.env.WEB_AUTH_SECRET;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  const consent = secret ? readTelegramConsent(request.cookies.get(TELEGRAM_CONSENT_COOKIE)?.value || "", secret) : null;
  return secret && url && consent ? { secret, client: new ConvexHttpClient(url), consent } : null;
}
export async function GET(request: NextRequest) {
  const ctx = context(request);
  if (!ctx) return problem("Link expired. Start again from Telegram.", 400);
  let target;
  try { target = await ctx.client.action(api.telegram.previewLink, { secret: ctx.secret, nonce: ctx.consent.nonce }); }
  catch { return problem("Unable to check the link right now. Reload this page to retry. No wallet access was granted by this page.", 503); }
  if (!target) return problem("This link expired or was already used. Return to Telegram to check your link or start again.", 410);
  return new NextResponse(`<!doctype html><html><head><title>Confirm Telegram wallet access</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>Confirm Telegram wallet access</h1><p>You signed in as X @${escape(ctx.consent.username)}.</p><p>Telegram account: ${target.telegramUsername ? `@${escape(target.telegramUsername)}` : "No username"}<br>Telegram user ID: ${escape(target.telegramUserId)}</p><p>This Telegram account will be able to send and trade funds from your Pons Bot wallet. Confirm only if this is your Telegram account and you started linking from the bot. Do not approve a link someone sent you.</p><form method="post"><input type="hidden" name="csrf" value="${escape(ctx.consent.csrf)}"><button name="decision" value="confirm">Confirm wallet access</button><button name="decision" value="cancel">Cancel</button></form></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", "referrer-policy": "no-referrer" } });
}
export async function POST(request: NextRequest) {
  const ctx = context(request);
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (!ctx || !site || request.headers.get("origin") !== new URL(site).origin) return new NextResponse("Unauthorized", { status: 403 });
  let form: FormData;
  try { form = await request.formData(); } catch { return problem("Invalid confirmation. Reload this page and try again.", 400); }
  if (form.get("csrf") !== ctx.consent.csrf) return new NextResponse("Unauthorized", { status: 403 });
  if (form.get("decision") === "confirm") {
    try {
      const target = await ctx.client.action(api.telegram.previewLink, { secret: ctx.secret, nonce: ctx.consent.nonce });
      if (!target) return problem("This link expired or was already used. Return to Telegram to check your link or start again.", 410);
      await ctx.client.action(api.telegram.completeXLink, { secret: ctx.secret, nonce: ctx.consent.nonce, ownerXUserId: ctx.consent.ownerXUserId });
    } catch {
      // The mutation may have committed before a network failure. Do not claim
      // it failed or undo a link; the single-use nonce prevents duplicate grants.
      return problem("We couldn't verify the linking result. Check Telegram first. If it isn't linked, reload this page or start linking again from Telegram.", 503);
    }
  } else if (form.get("decision") !== "cancel") return new NextResponse("Invalid choice", { status: 400 });
  const username = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") || "The_Pons_Bot";
  const response = NextResponse.redirect(`https://t.me/${/^[a-zA-Z0-9_]{5,32}$/.test(username) ? username : "The_Pons_Bot"}`, 303);
  response.cookies.set(TELEGRAM_CONSENT_COOKIE, "", { httpOnly: true, path: TELEGRAM_CONSENT_PATH, maxAge: 0 });
  return response;
}
