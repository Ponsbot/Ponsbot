import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TELEGRAM_CONSENT_COOKIE = "pons_tg_consent";
export const TELEGRAM_CONSENT_PATH = "/api/auth/x/telegram-confirm";
export function createTelegramConsent(nonce: string, ownerXUserId: string, username: string, secret: string) {
  const data = Buffer.from(JSON.stringify({ nonce, ownerXUserId, username, csrf: randomBytes(32).toString("hex"), expiresAt: Date.now() + 600_000 })).toString("base64url");
  return `${data}.${createHmac("sha256", secret).update(`telegram-consent:${data}`).digest("hex")}`;
}
export function readTelegramConsent(value: string, secret: string) {
  try {
    const [data, signature, extra] = value.split(".");
    const expected = createHmac("sha256", secret).update(`telegram-consent:${data}`).digest("hex");
    if (extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const result = JSON.parse(Buffer.from(data, "base64url").toString()) as { nonce: string; ownerXUserId: string; username: string; csrf: string; expiresAt: number };
    return result.expiresAt > Date.now() ? result : null;
  } catch { return null; }
}
