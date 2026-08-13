import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const WEB_WALLET_SESSION_COOKIE = "pons_web_wallet_session";
export const WEB_WALLET_SESSION_SECONDS = 2 * 60 * 60;

export type WebWalletSession = {
  walletAddress: string;
  xUserId: string;
  username: string;
  sessionId: string;
  authenticatedAt: number;
  expiresAt: number;
};

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(`pons-web-wallet:${payload}`).digest("base64url");
}

export function webWalletCsrfToken(sessionId: string, secret: string) {
  return createHmac("sha256", secret).update(`pons-terminal-csrf:${sessionId}`).digest("base64url");
}

export function createWebWalletSession(walletAddress: string, xUserId: string, username: string, secret: string) {
  const now = Math.floor(Date.now() / 1000);
  const session: WebWalletSession = {
    walletAddress,
    xUserId,
    username,
    sessionId: `web_${randomBytes(18).toString("base64url")}`,
    authenticatedAt: now,
    expiresAt: now + WEB_WALLET_SESSION_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function readWebWalletSession(value: string | undefined, secret: string): WebWalletSession | null {
  if (!value) return null;
  const [payload, suppliedSignature, extra] = value.split(".");
  if (!payload || !suppliedSignature || extra) return null;
  const expectedSignature = signature(payload, secret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<WebWalletSession>;
    if (!/^0x[a-fA-F0-9]{40}$/.test(session.walletAddress ?? "")) return null;
    if (!/^\d{1,30}$/.test(session.xUserId ?? "")) return null;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(session.username ?? "")) return null;
    if (!/^web_[a-zA-Z0-9_-]{16,80}$/.test(session.sessionId ?? "")) return null;
    if (!Number.isSafeInteger(session.authenticatedAt) || (session.authenticatedAt ?? 0) > Math.floor(Date.now() / 1000) + 60) return null;
    if (!Number.isSafeInteger(session.expiresAt) || (session.expiresAt ?? 0) <= Math.floor(Date.now() / 1000)) return null;
    return session as WebWalletSession;
  } catch {
    return null;
  }
}
