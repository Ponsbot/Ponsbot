import "server-only";
import { NextRequest } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { createHash, randomUUID } from "node:crypto";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { x402HTTPClient } from "@x402/core/client";
import { HoudiniPrePaymentError, validateHoudiniPaymentResource } from "./houdini-payment-policy";
import { houdiniFailureDiagnostic, houdiniResponseDiagnostic } from "./houdini-diagnostics";
import {
  readWebWalletSession,
  webWalletCsrfToken,
  WEB_WALLET_SESSION_COOKIE,
} from "@/lib/web-wallet-session";

export async function houdiniPreviewAuth(
  request: NextRequest,
  requireCsrf = false,
) {
  const secret = process.env.WEB_AUTH_SECRET;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!secret || !convexUrl) return null;
  const session = readWebWalletSession(
    request.cookies.get(WEB_WALLET_SESSION_COOKIE)?.value,
    secret,
  );
  if (!session) return null;
  if (
    requireCsrf &&
    request.headers.get("x-pons-csrf") !==
      webWalletCsrfToken(session.sessionId, secret)
  )
    return null;
  const active = await new ConvexHttpClient(convexUrl)
    .action(api.wallets.verifyWebSession, {
      secret,
      sessionId: session.sessionId,
      ownerXUserId: session.xUserId,
    })
    .catch(() => false);
  return active ? session : null;
}

export function houdiniHeaders(): Record<string, string> | null {
  const partnerId = process.env.HOUDINI_PARTNER_ID?.trim();
  const apiSecret = process.env.HOUDINI_API_SECRET?.trim();
  if (!partnerId) return null;
  return apiSecret
    ? { Authorization: `${partnerId}:${apiSecret}`, accept: "application/json" }
    : { "partner-id": partnerId, accept: "application/json" };
}

const HOUDINI_ORIGIN = "https://api-partner.houdiniswap.com";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_NETWORK = "eip155:8453";
type HoudiniOperation = "read" | "quote" | "exchange" | "status";
const OPERATION_MAX_ATOMIC: Record<HoudiniOperation, number> = {
  read: 100,
  quote: 1_000,
  exchange: 10_000,
  status: 100,
};
let cdpPaymentClient: CdpX402Client | undefined;
let cdpPaymentAddress: string | undefined;

function x402Enabled() {
  return process.env.HOUDINI_X402_ENABLED === "true";
}

function operationFor(pathname: string, method: string): HoudiniOperation {
  if (pathname === "/v2/quotes" || pathname === "/v2/quotes/byChainAddress")
    return "quote";
  if (
    method === "POST" &&
    (pathname === "/v2/exchanges" || pathname === "/v2/exchanges/multi")
  )
    return "exchange";
  if (
    pathname.startsWith("/v2/orders") ||
    (method === "GET" && pathname.startsWith("/v2/exchanges/multi/"))
  )
    return "status";
  return "read";
}

function sessionLimitAtomic() {
  // Keep the former variable as a deployment-safe fallback while operators
  // migrate. Enforcement is session scoped regardless of which value supplies
  // the limit.
  const usd = Number(
    process.env.HOUDINI_X402_SESSION_LIMIT_USD ||
      process.env.HOUDINI_X402_DAILY_LIMIT_USD ||
      "1",
  );
  if (!Number.isFinite(usd) || usd <= 0 || usd > 1_000)
    throw new Error("HOUDINI_X402_SESSION_LIMIT_USD is invalid");
  return Math.floor(usd * 1_000_000);
}

function globalDailyLimitAtomic() {
  const usd = Number(process.env.HOUDINI_X402_GLOBAL_DAILY_LIMIT_USD || "10");
  if (!Number.isFinite(usd) || usd <= 0 || usd > 10_000)
    throw new Error("HOUDINI_X402_GLOBAL_DAILY_LIMIT_USD is invalid");
  return Math.floor(usd * 1_000_000);
}

function paymentClient() {
  if (!cdpPaymentClient)
    cdpPaymentClient = new CdpX402Client({
      apiKeyId: process.env.CDP_API_KEY_ID,
      apiKeySecret: process.env.CDP_API_KEY_SECRET,
      walletSecret: process.env.CDP_WALLET_SECRET,
      walletConfig: {
        type: "eoa",
        accountName:
          process.env.HOUDINI_X402_CDP_ACCOUNT_NAME || "ponsbot-houdini-x402",
      },
      environment: "production",
      spendControls: {
        maxAmountPerPayment: { atomic: 10_000n, asset: BASE_USDC },
        allowedNetworks: [BASE_NETWORK],
        allowedAssets: [BASE_USDC],
      },
    });
  return cdpPaymentClient;
}

async function payerAddress() {
  if (!cdpPaymentAddress)
    cdpPaymentAddress = (await paymentClient().getAddresses()).evmAddress;
  return cdpPaymentAddress;
}

async function responseText(response: Response) {
  return await response
    .clone()
    .text()
    .catch(() => "");
}

async function freeTierExhausted(response: Response) {
  if (response.status === 429) return true;
  // HTTP 402 is itself an explicit request to use the paid transport.
  if (response.status === 402) return true;
  if (response.status !== 403) return false;
  const text = (await responseText(response)).toLowerCase();
  return /(?:rate.?limit|quota|free.?tier|usage.?limit|request.?limit).*(?:exceed|exhaust|reached|limit)|(?:exceed|exhaust|reached).*(?:quota|limit)/i.test(
    text,
  );
}

function requestFingerprint(url: string, method: string, challengeId: string) {
  return createHash("sha256")
    .update(JSON.stringify({ url, method, challengeId }))
    .digest("hex");
}

async function reservePayment(
  fingerprint: string,
  challengeId: string,
  endpoint: string,
  operation: HoudiniOperation,
  atomicAmount: number,
  payer: string,
  sessionId: string,
  sessionExpiresAt: number,
) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.HOUDINI_X402_AUDIT_SECRET;
  if (!convexUrl || !secret)
    throw new Error("Houdini x402 audit storage is not configured");
  const sessionKey = createHash("sha256").update(sessionId).digest("hex");
  return await new ConvexHttpClient(convexUrl).mutation(
    api.site.reserveHoudiniX402Payment,
    {
      secret,
      fingerprint,
      challengeId,
      endpoint,
      operation,
      atomicAmount,
      maxSessionAtomic: sessionLimitAtomic(),
      maxGlobalAtomic: globalDailyLimitAtomic(),
      globalDay: new Date().toISOString().slice(0, 10),
      payerAddress: payer,
      sessionKey,
      sessionExpiresAt,
    },
  );
}

async function finishPayment(
  fingerprint: string,
  status: "settled" | "failed" | "uncertain",
  settlementTransaction?: string,
  error?: string,
) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.HOUDINI_X402_AUDIT_SECRET;
  if (!convexUrl || !secret) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await new ConvexHttpClient(convexUrl).mutation(
        api.site.finishHoudiniX402Payment,
        { secret, fingerprint, status, settlementTransaction, error },
      );
      return true;
    } catch (auditError) {
      if (attempt < 2)
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      else
        console.error("houdini_x402_audit_completion_failed", {
          fingerprint,
          status,
          message: auditError instanceof Error ? auditError.message : "unknown",
        });
    }
  }
  // The durable reserved row is deliberately retained. A Convex reconciliation
  // cron marks stale reservations uncertain instead of silently losing them.
  return false;
}

/** Uses Houdini's free partner allowance first and pays through a dedicated
 * CDP Server Wallet only for explicit quota/rate-limit exhaustion. */
export async function houdiniFetch(
  path: string,
  init: RequestInit = {},
  paymentSession?: { sessionId: string; expiresAt: number },
) {
  const url = new URL(path, HOUDINI_ORIGIN);
  if (url.origin !== HOUDINI_ORIGIN || !url.pathname.startsWith("/v2/"))
    throw new Error("Invalid Houdini API URL");
  const method = (init.method || "GET").toUpperCase();
  const operation = operationFor(url.pathname, method);
  const fallbackTimeoutMs =
    operation === "exchange" ? 30_000 : operation === "quote" ? 20_000 : 12_000;
  const freeHeaders = houdiniHeaders();
  // The partner-id header is read-only. Do not let its expected 403 prevent an
  // enabled x402 exchange fallback when no full API secret is configured.
  const fullPartnerAuth = Boolean(
    process.env.HOUDINI_PARTNER_ID?.trim() &&
    process.env.HOUDINI_API_SECRET?.trim(),
  );
  const freeResponse =
    freeHeaders && (operation !== "exchange" || fullPartnerAuth)
      ? await fetch(url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers)),
            ...freeHeaders,
          },
        })
      : undefined;
  if (
    freeResponse &&
    (!x402Enabled() || !(await freeTierExhausted(freeResponse)))
  ) {
    if (!freeResponse.ok) console.warn("houdini_provider_rejection", { operation, transport: "partner", diagnostic: await houdiniResponseDiagnostic(freeResponse) });
    return freeResponse;
  }
  if (!x402Enabled())
    return (
      freeResponse ||
      new Response(
        JSON.stringify({ message: "Houdini API access is not configured." }),
        { status: 503, headers: { "content-type": "application/json" } },
      )
    );
  const paymentSessionExpiresAt = paymentSession
    ? paymentSession.expiresAt * 1_000
    : 0;
  if (
    !paymentSession ||
    !paymentSession.sessionId ||
    paymentSessionExpiresAt <= Date.now()
  )
    throw new Error("Houdini x402 requires an active web session");

  const unpaid = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(fallbackTimeoutMs),
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      accept: "application/json",
    },
  });
  if (unpaid.status !== 402) {
    if (!unpaid.ok) console.warn("houdini_provider_rejection", { operation, transport: "unpaid", diagnostic: await houdiniResponseDiagnostic(unpaid) });
    return unpaid;
  }
  const unpaidBody = await unpaid
    .clone()
    .json()
    .catch(() => undefined);
  const httpClient = new x402HTTPClient(paymentClient());
  const required = httpClient.getPaymentRequiredResponse(
    (name) => unpaid.headers.get(name),
    unpaidBody,
  );
  validateHoudiniPaymentResource(required.resource?.url, url);
  const validAccepts = required.accepts.filter(
    (item) =>
      item.scheme === "exact" &&
      item.network === BASE_NETWORK &&
      item.asset.toLowerCase() === BASE_USDC &&
      /^0x[a-fA-F0-9]{40}$/.test(item.payTo) &&
      /^\d+$/.test(item.amount) &&
      Number(item.amount) > 0 &&
      Number(item.amount) <= OPERATION_MAX_ATOMIC[operation] &&
      item.maxTimeoutSeconds > 0 &&
      item.maxTimeoutSeconds <= 300,
  );
  if (!validAccepts.length)
    throw new HoudiniPrePaymentError("Houdini requested unsupported x402 payment terms");
  const selectedAmount = Math.min(
    ...validAccepts.map((item) => Number(item.amount)),
  );
  // Reserve exactly what the signing client can select, even if a server
  // advertises several otherwise-valid payment choices.
  const sanitized = {
    ...required,
    accepts: validAccepts.filter(
      (item) => Number(item.amount) === selectedAmount,
    ),
    resource: { ...required.resource, url: url.toString() },
  };
  const challengeId =
    unpaid.headers.get("x-request-id")?.slice(0, 160) || randomUUID();
  const fingerprint = requestFingerprint(url.toString(), method, challengeId);
  const payer = await payerAddress();
  const reservation = await reservePayment(
    fingerprint,
    challengeId,
    url.pathname,
    operation,
    selectedAmount,
    payer,
    paymentSession.sessionId,
    paymentSessionExpiresAt,
  );
  if (!reservation.allowed)
    throw new Error(
      reservation.reason === "session_limit"
        ? "Houdini x402 session spending limit reached"
        : reservation.reason === "global_limit"
          ? "Houdini x402 global daily spending limit reached"
          : "Duplicate Houdini x402 payment blocked",
    );
  try {
    const payload = await httpClient.createPaymentPayload(sanitized);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(payload);
    const paid = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(fallbackTimeoutMs),
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        accept: "application/json",
        ...paymentHeaders,
      },
    });
    const processed = await httpClient.processPaymentResult(
      payload,
      (name) => paid.headers.get(name),
      paid.status,
    );
    const settlement = processed.settleResponse as
      | { success?: boolean; transaction?: string; errorReason?: string }
      | undefined;
    const diagnostic = paid.ok ? undefined : await houdiniResponseDiagnostic(paid);
    if (settlement?.success)
      await finishPayment(fingerprint, "settled", settlement.transaction, diagnostic);
    else
      await finishPayment(
        fingerprint,
        paid.ok ? "uncertain" : "failed",
        settlement?.transaction,
        diagnostic || houdiniFailureDiagnostic(paid.status, settlement?.errorReason),
      );
    return paid;
  } catch (error) {
    await finishPayment(
      fingerprint,
      "uncertain",
      undefined,
      houdiniFailureDiagnostic(502, error instanceof Error ? error.message : undefined),
    );
    throw error;
  }
}

export async function houdiniJson(response: Response) {
  const text = await response.text();
  if (text.length > 512_000)
    throw new Error("Houdini response exceeded the allowed size");
  return JSON.parse(text) as Record<string, unknown>;
}
