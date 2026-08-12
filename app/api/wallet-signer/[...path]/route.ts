import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { balanceRequestSchema, broadcastRequestSchema, executionRequestSchema, launchPreparationRequestSchema, ponsPairRequestSchema, transactionStatusRequestSchema, walletRequestSchema } from "@/lib/wallet-signer/policy";
import { authorizeSigner, broadcastTransaction, executeTransaction, ponsPairInfo, prepareLaunchAddresses, provisionWallet, transactionStatus, walletBalance } from "@/lib/wallet-signer/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function errorResponse(error: unknown) {
  if (error instanceof ZodError) {
    console.error("wallet_signer_zod_error", error.issues);

    return NextResponse.json(
      {
        error: "invalid signer request",
        details: error.issues,
      },
      { status: 400 },
    );
  }

  const message =
    error instanceof Error
      ? error.message
      : String(error);

  console.error("wallet_signer_failed", {
    message,
    name: error instanceof Error ? error.name : undefined,
    stack: error instanceof Error ? error.stack : undefined,
    cause: error instanceof Error ? error.cause : undefined,
  });

  return NextResponse.json(
    { error: message },
    { status: 400 },
  );
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  if (!authorizeSigner(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (Number(request.headers.get("content-length") || "0") > 16_384) return NextResponse.json({ error: "request too large" }, { status: 413 });
  try {
    const body = await request.json();
    const path = (await context.params).path.join("/");
    if (path === "v1/wallets") {
      const input = walletRequestSchema.parse(body);
      return NextResponse.json(await provisionWallet(input.ownerReference));
    }
    if (path === "v1/wallets/balance") {
      const input = balanceRequestSchema.parse(body);
      if (input.walletRef.toLowerCase() !== input.expectedAddress.toLowerCase()) throw new Error("wallet reference mismatch");
      const expected = await provisionWallet(input.ownerReference);
      if (expected.address.toLowerCase() !== input.expectedAddress.toLowerCase()) throw new Error("wallet owner mismatch");
      return NextResponse.json(await walletBalance(input.expectedAddress as `0x${string}`, input.token, input.knownTokens as `0x${string}`[] | undefined));
    }
    if (path === "v1/tokens/pons-pair") {
      const input = ponsPairRequestSchema.parse(body);
      return NextResponse.json(await ponsPairInfo(input.token as `0x${string}`, input.factoryAddress as `0x${string}`));
    }
    if (path === "v1/transactions/execute") {
      const input = executionRequestSchema.parse(body);
      await assertWalletOwner(input.ownerReference, input.walletRef, input.expectedFrom);
      return NextResponse.json(await executeTransaction(input));
    }
    if (path === "v1/transactions/prepare-launch") {
      const input = launchPreparationRequestSchema.parse(body);
      await assertWalletOwner(input.ownerReference, input.walletRef, input.expectedFrom);
      return NextResponse.json(await prepareLaunchAddresses(input));
    }
    if (path === "v1/transactions/broadcast") {
      const input = broadcastRequestSchema.parse(body);
      await assertWalletOwner(input.ownerReference, input.walletRef, input.expectedFrom);
      return NextResponse.json(await broadcastTransaction(input));
    }
    if (path === "v1/transactions/status") {
      const input = transactionStatusRequestSchema.parse(body);
      await assertWalletOwner(input.ownerReference, input.walletRef, input.expectedFrom);
      return NextResponse.json(await transactionStatus(input));
    }
    return NextResponse.json({ error: "not found" }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}

async function assertWalletOwner(ownerReference: string, walletRef: string, expectedFrom: string) {
  if (walletRef.toLowerCase() !== expectedFrom.toLowerCase()) throw new Error("wallet reference mismatch");
  const expected = await provisionWallet(ownerReference);
  if (expected.walletRef.toLowerCase() !== walletRef.toLowerCase()
    || expected.address.toLowerCase() !== expectedFrom.toLowerCase()) {
    throw new Error("wallet owner mismatch");
  }
}
