import { createHmac, timingSafeEqual } from "node:crypto";

export const WEB_WALLET_SESSION_COOKIE = "pons_web_wallet_session";
export const WEB_WALLET_SESSION_SECONDS = 12 * 60 * 60;

type WebWalletSession = {
  walletAddress: string;
  xUserId: string;
  expiresAt: number;
};

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(`pons-web-wallet:${payload}`).digest("base64url");
}

export function createWebWalletSession(walletAddress: string, xUserId: string, secret: string) {
  const session: WebWalletSession = {
    walletAddress,
    xUserId,
    expiresAt: Math.floor(Date.now() / 1000) + WEB_WALLET_SESSION_SECONDS,
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
    if (!Number.isSafeInteger(session.expiresAt) || (session.expiresAt ?? 0) <= Math.floor(Date.now() / 1000)) return null;
    return session as WebWalletSession;
  } catch {
    return null;
  }
}
