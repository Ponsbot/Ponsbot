import { createHash, randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { NextRequest, NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { boundedJson, RequestBodyError } from "@/lib/bounded-json";
import { houdiniFetch, houdiniJson, houdiniPreviewAuth } from "@/lib/houdini-preview-auth";
import { TERMINAL_RECENT_AUTH_SECONDS } from "@/lib/web-wallet-session";
import { houdiniSubmissionFailureOutcome } from "@/lib/houdini-payment-policy";
import { isEmptyNativeGasBalanceError, noNativeGasMessage, requireWalletNativeGas } from "@/lib/wallet-native-gas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExecuteRequest = { reviewId?: unknown };
type Submission = { state: string; quoteId?: string; destination?: string; sourceAmount?: string; status?: string; houdiniId?: string; depositAddress?: string; fundingTransactionHash?: string; displayStatus?: string; statusLabel?: string; safeError?: string; startedAt?: number };

function safeText(value: unknown, max = 240) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function publicState(value: Submission) {
  return {
    status: value.status || value.state,
    ...(value.houdiniId ? { orderId: value.houdiniId } : {}),
    ...(value.fundingTransactionHash ? { fundingTransactionHash: value.fundingTransactionHash } : {}),
    ...(value.displayStatus ? { displayStatus: value.displayStatus } : {}),
    ...(value.statusLabel ? { statusLabel: value.statusLabel } : {}),
    ...(value.safeError ? { error: value.safeError } : {}),
    ...(value.startedAt ? { startedAt: value.startedAt } : {}),
  };
}

export async function POST(request: NextRequest) {
  const session = await houdiniPreviewAuth(request, true);
  if (!session) return NextResponse.json({ error: "Not available" }, { status: 404 });
  if (Math.floor(Date.now() / 1000) - session.authenticatedAt >= TERMINAL_RECENT_AUTH_SECONDS) {
    return NextResponse.json({ error: "Reconnect X before moving funds", reauthRequired: true }, { status: 401 });
  }
  let body: ExecuteRequest;
  try { body = await boundedJson(request, 1_024) as ExecuteRequest; }
  catch (error) { return NextResponse.json({ error: error instanceof RequestBodyError ? error.message : "Invalid swap request" }, { status: error instanceof RequestBodyError ? error.status : 400 }); }
  const reviewId = typeof body.reviewId === "string" ? body.reviewId : "";
  if (!/^hqr_[A-Za-z0-9_-]{20,80}$/.test(reviewId)) return NextResponse.json({ error: "That quote is invalid. Request a new quote." }, { status: 400 });
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.WEB_AUTH_SECRET;
  if (!convexUrl || !secret) return NextResponse.json({ error: "Houdini execution is not configured." }, { status: 503 });
  const client = new ConvexHttpClient(convexUrl);
  const sessionIdHash = createHash("sha256").update(session.sessionId).digest("hex");
  const attemptId = `hqe_${randomBytes(18).toString("base64url")}`;
  const reserved = await client.mutation(api.site.reserveHoudiniQuoteExecution, { secret, reviewId, sessionIdHash, attemptId }) as Submission;
  if (reserved.state === "missing") return NextResponse.json({ error: "That quote is not available in this session." }, { status: 404 });
  if (reserved.state === "expired") return NextResponse.json({ error: "That quote is expired or too close to expiration. Refresh it before confirming." }, { status: 409 });
  if (reserved.state === "existing" && reserved.status !== "awaiting_funding") return NextResponse.json({ execution: publicState(reserved) }, { status: reserved.status === "failed" || reserved.status === "uncertain" ? 409 : 200, headers: { "cache-control": "no-store" } });

  let houdiniId = reserved.houdiniId || "";
  let depositAddress = reserved.depositAddress || "";
  // Only a new order needs this gate. Existing orders/funding must reconcile.
  if (reserved.state === "submit") {
    try { await requireWalletNativeGas(session.walletAddress); }
    catch (error) {
      const message = isEmptyNativeGasBalanceError(error) ? noNativeGasMessage(session.walletAddress)
        : "⚠️ I couldn't check your ETH balance right now. Please try again shortly.";
      await client.mutation(api.site.finishHoudiniExchangeSubmission, { secret, reviewId, sessionIdHash, attemptId, outcome: "failed", safeError: message });
      return NextResponse.json({ error: message }, { status: 422 });
    }
  }
  if (reserved.state === "submit") try {
    if (!reserved.quoteId || !reserved.destination || !reserved.sourceAmount) return NextResponse.json({ error: "That quote could not be recovered safely." }, { status: 409 });
    const response = await houdiniFetch("/v2/exchanges", {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteId: reserved.quoteId, addressTo: reserved.destination, addressFrom: session.walletAddress, refundAddress: session.walletAddress }),
    }, { sessionId: session.sessionId, expiresAt: session.expiresAt });
    const payload = await houdiniJson(response);
    if (!response.ok) {
      const message = safeText(payload.message) || "Houdini could not create that exchange.";
      await client.mutation(api.site.finishHoudiniExchangeSubmission, { secret, reviewId, sessionIdHash, attemptId, outcome: "failed", safeError: message });
      return NextResponse.json({ error: message }, { status: response.status });
    }
    const order = payload.order && typeof payload.order === "object" ? payload.order as Record<string, unknown> : payload;
    houdiniId = safeText(order.houdiniId, 64) || safeText(order.id, 64) || "";
    depositAddress = safeText(order.depositAddress, 150) || "";
    const orderExpiresAt = Date.parse(typeof order.expires === "string" ? order.expires : "");
    if (!houdiniId || !/^0x[a-fA-F0-9]{40}$/.test(depositAddress)) throw new Error("Houdini returned an invalid Robinhood Chain deposit destination");
    if (!Number.isFinite(orderExpiresAt) || orderExpiresAt <= Date.now() + 60_000) throw new Error("Houdini returned an invalid or insufficient deposit window");
    await client.mutation(api.site.finishHoudiniExchangeSubmission, { secret, reviewId, sessionIdHash, attemptId, outcome: "created", houdiniId, depositAddress, orderExpiresAt });
  } catch (error) {
    // A transport failure after POST is ambiguous: never submit the quote a
    // second time automatically. This must be reconciled before any retry.
    const message = error instanceof Error ? error.message.slice(0, 240) : "Houdini exchange submission was interrupted";
    const outcome = houdiniSubmissionFailureOutcome(error);
    await client.mutation(api.site.finishHoudiniExchangeSubmission, { secret, reviewId, sessionIdHash, attemptId, outcome, safeError: message }).catch(() => undefined);
    return NextResponse.json({ error: outcome === "failed"
      ? "Houdini API payment validation failed before submission. No swap funds were sent. Please request a new quote."
      : "The exchange submission could not be confirmed. No automatic retry was made." }, { status: 502 });
  }
  if (!houdiniId || !depositAddress || !reserved.sourceAmount) return NextResponse.json({ error: "That exchange could not be recovered safely." }, { status: 409 });

  const funding = await client.mutation(api.site.reserveHoudiniFunding, { secret, reviewId, sessionIdHash, terminalSessionId: session.sessionId });
  if (!funding.allowed || !funding.depositAddress || !funding.sourceAmount) {
    if (funding.reason === "expired") return NextResponse.json({ error: "The Houdini deposit window expired. No funds were sent; create a new quote." }, { status: 409 });
    return NextResponse.json({ execution: { status: funding.status || "awaiting_funding", orderId: houdiniId, startedAt: reserved.startedAt } }, { headers: { "cache-control": "no-store" } });
  }
  const fundingRequestId = funding.fundingRequestId;
  try {
    const result = await client.action(api.wallets.executeTerminalCommand, {
      secret, ownerXUserId: session.xUserId, sessionId: session.sessionId, eventId: fundingRequestId,
      channel: "terminal_form", text: `Fund Houdini order ${houdiniId}`,
      commandJson: JSON.stringify({ kind: "send", amount: funding.sourceAmount, unit: "eth", recipient: funding.depositAddress }),
    }) as { ok?: boolean; deferred?: boolean; transactionHash?: string; message?: string };
    const accepted = result.ok === true || result.deferred === true;
    await client.mutation(api.site.finishHoudiniFunding, {
      secret, reviewId, sessionIdHash, fundingRequestId, outcome: result.deferred ? "pending" : accepted ? "funded" : "failed",
      ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
      ...(!accepted ? { safeError: safeText(result.message) || "The wallet could not fund the exchange." } : {}),
    });
    if (!accepted) return NextResponse.json({ error: safeText(result.message) || "The wallet could not fund the exchange.", execution: { status: "awaiting_funding", orderId: houdiniId, startedAt: reserved.startedAt } }, { status: 422 });
    return NextResponse.json({ execution: { status: result.deferred ? "funding" : "funded", orderId: houdiniId, startedAt: reserved.startedAt, ...(result.transactionHash ? { fundingTransactionHash: result.transactionHash } : {}) } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : "The wallet could not fund the exchange.";
    await client.mutation(api.site.finishHoudiniFunding, { secret, reviewId, sessionIdHash, fundingRequestId, outcome: "failed", safeError: message }).catch(() => undefined);
    return NextResponse.json({ error: message, execution: { status: "awaiting_funding", orderId: houdiniId, startedAt: reserved.startedAt } }, { status: 502 });
  }
}
