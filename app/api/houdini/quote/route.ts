import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { formatEther } from "viem";
import { api } from "@/convex/_generated/api";
import { boundedJson, RequestBodyError } from "@/lib/bounded-json";
import {
  houdiniFetch,
  houdiniJson,
  houdiniPreviewAuth,
} from "@/lib/houdini-preview-auth";
import { ethUsdPrice, usdToEthWei } from "@/lib/wallet-signer/pricing";
import { isEmptyNativeGasBalanceError, noNativeGasMessage, requireWalletNativeGas } from "@/lib/wallet-native-gas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Display every quote that Houdini still considers live. The exchange path
// checks the same upstream expiration again before submission.
const QUOTE_SUBMISSION_MARGIN_MS = 0;
const FLOATING_QUOTE_REVIEW_MS = 2 * 60_000;

type QuoteRequest = {
  from?: unknown;
  to?: unknown;
  amount?: unknown;
  unit?: unknown;
  destination?: unknown;
  private?: unknown;
  previousReviewId?: unknown;
};
type CachedToken = {
  tokenId: string;
  symbol: string;
  chain: string;
  tokenAddress?: string;
  hasCex: boolean;
  enabled: boolean;
  addressValidation?: string;
  memoNeeded?: boolean;
  chainKind?: string;
};

function validDestination(token: CachedToken, destination: string) {
  if (token.memoNeeded)
    return {
      valid: false,
      message:
        "That destination network requires a memo or tag, which this preview does not support yet.",
    };
  if (token.tokenAddress?.toLowerCase() === destination.toLowerCase())
    return {
      valid: false,
      message: "Enter your receiving wallet, not the token contract address.",
    };
  if (token.chainKind?.toLowerCase() === "evm")
    return {
      valid: /^0x[a-fA-F0-9]{40}$/.test(destination),
      message: "Enter a valid wallet address for the receiving network.",
    };
  if (!token.addressValidation)
    return {
      valid: false,
      message: "Address validation is not available for that network yet.",
    };
  try {
    const match = destination.match(new RegExp(token.addressValidation));
    return {
      valid: Boolean(match && match[0] === destination),
      message: "Enter a valid wallet address for the receiving network.",
    };
  } catch {
    return {
      valid: false,
      message: "Address validation is not available for that network yet.",
    };
  }
}

function displayScalar(value: unknown) {
  return typeof value === "string" && value.length <= 100
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
}

function displayChain(value: string) {
  const normalized = value.trim().toLowerCase();
  const names: Record<string, string> = {
    robinhood: "Robinhood Chain",
    ethereum: "Ethereum",
    base: "Base",
    arbitrum: "Arbitrum",
    optimism: "Optimism",
    solana: "Solana",
    bitcoin: "Bitcoin",
    tron: "Tron",
    trx: "Tron",
    bsc: "BNB Chain",
    polygon: "Polygon",
    avalanche: "Avalanche",
  };
  return (
    names[normalized] ||
    value.replace(/\b\w/g, (character) => character.toUpperCase())
  );
}

export async function POST(request: NextRequest) {
  const session = await houdiniPreviewAuth(request, true);
  if (!session)
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  let body: QuoteRequest;
  try {
    body = (await boundedJson(request, 4_096)) as QuoteRequest;
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof RequestBodyError
            ? error.message
            : "Invalid quote request",
      },
      { status: error instanceof RequestBodyError ? error.status : 400 },
    );
  }
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";
  const amount = typeof body.amount === "string" ? body.amount.trim() : "";
  const unit = body.unit === "USD" ? "USD" : body.unit === "ETH" ? "ETH" : "";
  const destination =
    typeof body.destination === "string" ? body.destination.trim() : "";
  if (
    !/^[a-fA-F0-9]{24}$/.test(from) ||
    !/^[a-fA-F0-9]{24}$/.test(to) ||
    !unit ||
    !/^\d+(?:\.\d{1,18})?$/.test(amount) ||
    Number(amount) <= 0 ||
    destination.length < 16 ||
    destination.length > 150
  ) {
    return NextResponse.json(
      { error: "Check the selected assets, amount, and destination address." },
      { status: 400 },
    );
  }
  try {
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    const secret = process.env.WEB_AUTH_SECRET;
    if (!convexUrl || !secret)
      return NextResponse.json(
        { error: "Houdini quote storage is not configured." },
        { status: 503 },
      );
    const client = new ConvexHttpClient(convexUrl);
    await requireWalletNativeGas(session.walletAddress);
    const [source, target] = (await client.query(
      api.site.getHoudiniTokensById,
      { tokenIds: [from, to] },
    )) as [CachedToken | null, CachedToken | null];
    if (!source || !target)
      return NextResponse.json(
        {
          error:
            "Those assets need to be selected again from the refreshed catalog.",
        },
        { status: 409 },
      );
    if (
      source.symbol.toUpperCase() !== "ETH" ||
      !/robinhood/i.test(source.chain) ||
      !source.hasCex ||
      !source.enabled
    )
      return NextResponse.json(
        { error: "The sending asset must be Robinhood Chain ETH." },
        { status: 400 },
      );
    if (!target.hasCex || !target.enabled)
      return NextResponse.json(
        { error: "The receiving asset is not currently available." },
        { status: 400 },
      );
    if (source.tokenId === target.tokenId && body.private !== true)
      return NextResponse.json(
        {
          error:
            "Robinhood Chain ETH to Robinhood Chain ETH requires a private swap.",
        },
        { status: 400 },
      );
    const destinationCheck = validDestination(target, destination);
    if (!destinationCheck.valid)
      return NextResponse.json(
        { error: destinationCheck.message },
        { status: 400 },
      );
    const currentEthUsd = await ethUsdPrice();
    let sourceAmount = amount;
    if (unit === "USD") {
      sourceAmount = formatEther(usdToEthWei(amount, currentEthUsd));
    }
    const params = new URLSearchParams({
      from,
      to,
      amount: sourceAmount,
      types: body.private === true ? "private" : "standard",
      senderAddress: session.walletAddress,
      receiverAddress: destination,
      refundAddress: session.walletAddress,
    });
    const response = await houdiniFetch(
      `/v2/quotes?${params}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      },
      { sessionId: session.sessionId, expiresAt: session.expiresAt },
    );
    const payload = await houdiniJson(response);
    if (!response.ok)
      return NextResponse.json(
        {
          error:
            typeof payload.message === "string"
              ? payload.message
              : "Houdini could not quote that route.",
        },
        { status: response.status },
      );
    const candidates = Array.isArray(payload.quotes) ? payload.quotes : [];
    const raw = candidates
      .flatMap((candidate) =>
        candidate && typeof candidate === "object"
          ? [candidate as Record<string, unknown>]
          : [],
      )
      .find((candidate) => {
        const validUntil = Date.parse(
          typeof candidate.validUntil === "string" ? candidate.validUntil : "",
        );
        const output = Number(candidate.amountOut ?? candidate.netAmountOut);
        return (
          typeof candidate.quoteId === "string" &&
          candidate.quoteId.length <= 160 &&
          candidate.filtered !== true &&
          !(typeof candidate.error === "string" && candidate.error.trim()) &&
          candidate.depositAddressSupported !== false &&
          Number.isFinite(output) &&
          output > 0 &&
          (!Number.isFinite(validUntil) ||
            validUntil > Date.now() + QUOTE_SUBMISSION_MARGIN_MS)
        );
      });
    if (!raw)
      return NextResponse.json(
        {
          error:
            "Houdini did not return a currently valid quote for that route.",
        },
        { status: 422 },
      );
    const quoteId =
      typeof raw.quoteId === "string"
        ? raw.quoteId
        : typeof raw.id === "string"
          ? raw.id
          : "";
    if (!quoteId || quoteId.length > 160)
      return NextResponse.json(
        { error: "Houdini returned an invalid quote reference." },
        { status: 502 },
      );
    // Floating CEX quotes currently omit validUntil. Give those quotes a
    // bounded two-minute review window; if Houdini supplies an earlier
    // upstream deadline, always honor the earlier deadline.
    const upstreamExpiresAt = Date.parse(
      typeof raw.validUntil === "string" ? raw.validUntil : "",
    );
    const reviewExpiresAt = Date.now() + FLOATING_QUOTE_REVIEW_MS;
    const expiresAt = Number.isFinite(upstreamExpiresAt)
      ? Math.min(upstreamExpiresAt, reviewExpiresAt)
      : reviewExpiresAt;
    const reviewId = `hqr_${randomBytes(24).toString("base64url")}`;
    await client.mutation(api.site.storeHoudiniQuoteReview, {
      secret,
      reviewId,
      sessionIdHash: createHash("sha256")
        .update(session.sessionId)
        .digest("hex"),
      ownerXUserId: session.xUserId,
      quoteId,
      fromTokenId: from,
      toTokenId: to,
      sourceAmount,
      sourceLabel: `${source.symbol} on ${displayChain(source.chain)}`,
      targetLabel: `${target.symbol} on ${displayChain(target.chain)}`,
      destination,
      privateMode: body.private === true,
      expiresAt,
      ...(typeof body.previousReviewId === "string" &&
      /^hqr_[A-Za-z0-9_-]{20,80}$/.test(body.previousReviewId)
        ? { previousReviewId: body.previousReviewId }
        : {}),
    });
    // Keep the executable quoteId server-side. The browser receives only a
    // session-bound review handle and a small display-safe projection.
    return NextResponse.json(
      {
        quote: {
          reviewId,
          sourceAmount,
          sourceAmountUsd: Number(sourceAmount) * currentEthUsd,
          destination,
          privateMode: body.private === true,
          targetSymbol: target.symbol,
          targetChain: displayChain(target.chain),
          expiresAt: new Date(expiresAt).toISOString(),
          expiresInMs: Math.max(0, expiresAt - Date.now()),
          submissionMarginMs: QUOTE_SUBMISSION_MARGIN_MS,
          amountOut: displayScalar(
            raw.amountOut ?? raw.toAmount ?? raw.expectedAmount,
          ),
          amountOutUsd: displayScalar(
            raw.amountOutUsd ??
              raw.toAmountUsd ??
              raw.expectedAmountUsd ??
              raw.estimatedAmountOutUsd,
          ),
          fee: displayScalar(raw.fee),
          networkFee: displayScalar(raw.networkFee),
          duration: displayScalar(raw.duration ?? raw.estimatedTime ?? raw.eta),
          type: displayScalar(raw.type),
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (isEmptyNativeGasBalanceError(error)) return NextResponse.json(
      { error: noNativeGasMessage(session.walletAddress) }, { status: 422 },
    );
    return NextResponse.json(
      { error: "Houdini could not quote that route right now." },
      { status: 502 },
    );
  }
}
