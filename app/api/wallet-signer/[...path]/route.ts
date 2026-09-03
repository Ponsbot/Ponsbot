import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { redactSignerDiagnostic } from "@/lib/signer-diagnostics";
import { automatedFeeBroadcastRequestSchema, automatedFeeControllerBroadcastRequestSchema, automatedFeeControllerTransactionRequestSchema, automatedFeeDeliveryTransactionRequestSchema, automatedFeeKeeperTransactionRequestSchema, automatedFeePairRouteBroadcastRequestSchema, automatedFeePairRouteRequestSchema, automatedFeeQuoteRequestSchema, automatedFeeSweepTransactionRequestSchema, automatedFeeTransactionStatusRequestSchema, automatedFeeVaultDeploymentStatusRequestSchema, automatedFeeVaultPredictionRequestSchema, balanceRequestSchema, broadcastRequestSchema, executionRequestSchema, feeClaimPlanRequestSchema, freeLaunchDevBuyEligibilityRequestSchema, freeLaunchFundingEstimateRequestSchema, freeLaunchSponsorshipRequestSchema, freeLaunchSponsorshipStatusRequestSchema, holderDistributorRequestSchema, launchPreparationRequestSchema, ponsPairRequestSchema, spendableEthRequestSchema, tokenValueAtBlockRequestSchema, transactionStatusRequestSchema, usdTokenAmountRequestSchema, walletRequestSchema } from "@/lib/wallet-signer/policy";
import { automatedFeeVaultDeploymentRequestSchema } from "@/lib/wallet-signer/policy";
import { automatedFeeClaimableRequestSchema, automatedFeeEnrollmentVerificationRequestSchema, automatedFeeInspectionRequestSchema } from "@/lib/wallet-signer/policy";
import { automatedFeeControllerStatusRequestSchema } from "@/lib/wallet-signer/policy";
import { automatedFeeControllerSweepRequestSchema, automatedFeeControllerSweepStatusRequestSchema } from "@/lib/wallet-signer/policy";
import { assertAutomatedFeeDeliveryAccess } from "@/lib/wallet-signer/service";
import { assertAutomatedFeeControllerAccess, assertAutomatedFeeEnrollmentAccess, assertAutomatedFeeExecutionAccess, automatedFeeTransactionStatus, authorizeAutomatedFeeQuote, authorizeSigner, broadcastAutomatedFeeControllerTransaction, broadcastAutomatedFeeDeliveryTransaction, broadcastAutomatedFeePairRoute, broadcastAutomatedFeeSweepTransaction, broadcastAutomatedFeeTransaction, broadcastTransaction, executeTransaction, feeClaimPlan, freeLaunchDevBuyEligibility, freeLaunchFundingEstimate, freeLaunchSponsorshipStatus, freeLaunchSponsorWallet, holderDistributorInfo, ponsPairInfo, prepareAutomatedFeeControllerTransaction, prepareAutomatedFeeDeliveryTransaction, prepareAutomatedFeePairRoute, prepareAutomatedFeeSweepTransaction, prepareAutomatedFeeTransaction, prepareLaunchAddresses, provisionWallet, sponsorFreeLaunch, spendableEthBalance, tokenValueAtBlock, transactionStatus, usdTokenAmount, walletBalance } from "@/lib/wallet-signer/service";
import { prepareAutomatedFeeVaultDeployment } from "@/lib/wallet-signer/service";
import { broadcastAutomatedFeeAdminTransaction } from "@/lib/wallet-signer/service";
import { automatedFeeClaimableBalance, automatedFeeVaultDeploymentStatus, inspectAutomatedFeeVault, predictAutomatedFeeVault, verifyAutomatedFeeEnrollment } from "@/lib/wallet-signer/service";
import { assertAutomatedFeeEnrollmentProof } from "@/lib/wallet-signer/service";
import { automatedFeeInfrastructureStatus } from "@/lib/wallet-signer/service";
import { automatedFeeControllerTransactionStatus } from "@/lib/wallet-signer/service";
import { automatedFeeControllerSweepStatus, broadcastAutomatedFeeControllerSweep, prepareAutomatedFeeControllerSweep } from "@/lib/wallet-signer/service";
import { boundedJson, RequestBodyError } from "@/lib/bounded-json";
import { checkLiquidityFunding, quoteLiquidity, prepareLiquidityStep, inspectLiquidityReceipt, inspectLiquidityLegs, liquiditySignerRequest, refreshLiquidityOpen } from "@/lib/wallet-signer/liquidity";
import { inspectLiquidityPosition } from "@/lib/wallet-signer/liquidity-status";
import type { LiquidityQuotePlan } from "@/lib/wallet-signer/liquidity";
import { prepareLiquidityEnvelope, signLiquidityEnvelope } from "@/lib/wallet-signer/liquidity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function errorResponse(error: unknown) {
  if (error instanceof ZodError) {
    const diagnosticDetail = redactSignerDiagnostic(error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "));
    console.error("wallet_signer_zod_error", { diagnosticCode: "INVALID_SIGNER_REQUEST", diagnosticDetail });

    return NextResponse.json({
      error: "invalid signer request",
      diagnosticCode: "INVALID_SIGNER_REQUEST",
      diagnosticDetail,
    }, { status: 400 });
  }

  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const diagnosticCode = message === "nothing to sweep" ? "EMPTY_CURVE_SWEEP" : /^(?:LP_|LIQUIDITY_|DELTA_|V3_ROUTE_)[A-Z0-9_]+/.exec(message)?.[0] || (/insufficient|exceeds the balance/i.test(message) ? "INSUFFICIENT_FUNDS"
    : /no claimable creator fees/i.test(message) ? "NO_CLAIMABLE_CREATOR_FEES"
      : /creator fee recipient|fee beneficiary/i.test(message) ? "CREATOR_FEE_AUTHORIZATION_FAILED"
        : /simulation|revert/i.test(message) ? "SIMULATION_OR_REVERT"
          : /RPC rejected|broadcast/i.test(message) ? "RPC_BROADCAST_REJECTED"
            : /quote|liquidity|route/i.test(message) ? "ROUTE_OR_QUOTE_FAILED"
              : "SIGNER_INTERNAL_FAILURE");
  const diagnosticDetail = redactSignerDiagnostic(message);

  console.error("wallet_signer_failed", {
    diagnosticCode,
    diagnosticDetail,
  });

  const safe = diagnosticCode === "V3_ROUTE_NO_QUOTE" ? "quote returned no output"
    : message === "nothing to sweep" || /LP_INSUFFICIENT_FUNDING|LP_INSUFFICIENT_GAS|DELTA_PARTIAL_WITHDRAWAL_UNVERIFIED|DELTA_COMPOUNDING_UNVERIFIED|DELTA_NATIVE_ADD_UNVERIFIED|insufficient|slippage|revert|allowance|balance|gas|limit|mismatch|not found|no completed Pons launch|not the launch creator|creator fee|claimable|paired asset|confirmation|unsupported token|quote returned no output/i.test(message)
    ? redactSignerDiagnostic(message, 240)
    : "wallet signer request failed";
  return NextResponse.json({ error: safe, diagnosticCode, diagnosticDetail }, { status: 400 });
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  if (!authorizeSigner(request.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const path = (await context.params).path.join("/");
    const body = await boundedJson(request, path.startsWith("v1/liquidity/") ? 131_072 : 16_384);
    if (path === "v1/liquidity/funding-check") return NextResponse.json(await checkLiquidityFunding(body), { headers: { "cache-control": "no-store" } });
    if (path === "v1/liquidity/quote") return NextResponse.json(await quoteLiquidity(body));
    if (path === "v1/liquidity/refresh-open") return NextResponse.json(await refreshLiquidityOpen(body), { headers: { "cache-control": "no-store" } });
    if (path === "v1/liquidity/prepare") return NextResponse.json(await prepareLiquidityStep(body));
    if (path === "v1/liquidity/prepare-envelope") return NextResponse.json(await prepareLiquidityEnvelope(body));
    if (path === "v1/liquidity/sign-envelope") return NextResponse.json(await signLiquidityEnvelope(body));
    if (path === "v1/liquidity/inspect") {
      const input = liquiditySignerRequest.parse(body);
      return NextResponse.json(await inspectLiquidityLegs(input.expectedFrom as `0x${string}`, input.draft.fields.version!, input.legs), { headers: { "cache-control": "no-store" } });
    }
    if (path === "v1/liquidity/status") return NextResponse.json(await inspectLiquidityPosition(body), { headers: { "cache-control": "no-store" } });
    if (path === "v1/liquidity/receipt") {
      const input = body as { transactionHash: `0x${string}`; plan: LiquidityQuotePlan; step?: number };
      return NextResponse.json(await inspectLiquidityReceipt(input.transactionHash, input.plan, input.step));
    }
    if (path === "v1/automated-fees/infrastructure-status") {
      return NextResponse.json(await automatedFeeInfrastructureStatus());
    }
    const productionAutomatedFeePaths = new Set([
      "v1/automated-fees/inspect", "v1/automated-fees/claimable", "v1/automated-fees/authorize", "v1/automated-fees/status",
      "v1/automated-fees/prepare", "v1/automated-fees/prepare-sweep", "v1/automated-fees/prepare-delivery",
      "v1/automated-fees/broadcast", "v1/automated-fees/broadcast-sweep", "v1/automated-fees/broadcast-delivery",
      "v1/automated-fees/prepare-vault", "v1/automated-fees/broadcast-vault",
      "v1/automated-fees/predict-vault",
      "v1/automated-fees/vault-deployment-status",
      "v1/automated-fees/prepare-controller", "v1/automated-fees/broadcast-controller",
      "v1/automated-fees/controller-status",
      "v1/automated-fees/prepare-controller-sweep", "v1/automated-fees/broadcast-controller-sweep",
      "v1/automated-fees/controller-sweep-status",
      "v1/automated-fees/verify-enrollment",
    ]);
    if (productionAutomatedFeePaths.has(path)) {
      const proofIdentity = typeof body === "object" && body !== null
        ? String("vaultAddress" in body ? body.vaultAddress
          : "token" in body ? body.token
            : "tokenAddress" in body ? body.tokenAddress : "")
        : "";
      assertAutomatedFeeEnrollmentProof(request.headers, path, proofIdentity, body);
    }
    if (path === "v1/automated-fees/inspect") {
      const input = automatedFeeInspectionRequestSchema.parse(body);
      await assertAutomatedFeeExecutionAccess({ vaultAddress: input.vaultAddress });
      return NextResponse.json(await inspectAutomatedFeeVault(input));
    }
    if (path === "v1/automated-fees/claimable") {
      const input = automatedFeeClaimableRequestSchema.parse(body);
      return NextResponse.json(await automatedFeeClaimableBalance(input));
    }
    if (path === "v1/automated-fees/verify-enrollment") {
      const input = automatedFeeEnrollmentVerificationRequestSchema.parse(body);
      return NextResponse.json(await verifyAutomatedFeeEnrollment(input));
    }
    if (path === "v1/automated-fees/predict-vault") {
      const input = automatedFeeVaultPredictionRequestSchema.parse(body);
      return NextResponse.json(await predictAutomatedFeeVault(input));
    }
    if (path === "v1/automated-fees/vault-deployment-status") {
      const input = automatedFeeVaultDeploymentStatusRequestSchema.parse(body);
      return NextResponse.json(await automatedFeeVaultDeploymentStatus(input));
    }
    if (path === "v1/automated-fees/authorize") {
      const input = automatedFeeQuoteRequestSchema.parse(body);
      await assertAutomatedFeeExecutionAccess({ vaultAddress: input.vaultAddress });
      return NextResponse.json(await authorizeAutomatedFeeQuote(input));
    }
    if (path === "v1/automated-fees/status") {
      const input = automatedFeeTransactionStatusRequestSchema.parse(body);
      return NextResponse.json(await automatedFeeTransactionStatus(input));
    }
    if (path === "v1/automated-fees/prepare") {
      const input = automatedFeeKeeperTransactionRequestSchema.parse(body);
      await assertAutomatedFeeExecutionAccess({ vaultAddress: input.vaultAddress });
      return NextResponse.json(await prepareAutomatedFeeTransaction(input));
    }
    if (path === "v1/automated-fees/prepare-sweep") {
      const input = automatedFeeSweepTransactionRequestSchema.parse(body);
      await assertAutomatedFeeExecutionAccess({ vaultAddress: input.vaultAddress });
      return NextResponse.json(await prepareAutomatedFeeSweepTransaction(input));
    }
    if (path === "v1/automated-fees/prepare-delivery") {
      const input = automatedFeeDeliveryTransactionRequestSchema.parse(body);
      await assertAutomatedFeeDeliveryAccess({ vaultAddress: input.vaultAddress });
      return NextResponse.json(await prepareAutomatedFeeDeliveryTransaction(input));
    }
    if (path === "v1/automated-fees/prepare-vault") {
      const input = automatedFeeVaultDeploymentRequestSchema.parse(body);
      await assertAutomatedFeeEnrollmentAccess({ tokenAddress: input.token, source: input.enrollmentSource });
      return NextResponse.json(await prepareAutomatedFeeVaultDeployment(input));
    }
    if (path === "v1/automated-fees/prepare-pair-route") {
      const input = automatedFeePairRouteRequestSchema.parse(body);
      return NextResponse.json(await prepareAutomatedFeePairRoute(input));
    }
    if (path === "v1/automated-fees/prepare-controller") {
      const input = automatedFeeControllerTransactionRequestSchema.parse(body);
      await assertAutomatedFeeControllerAccess({ vaultAddress: input.vaultAddress });
      return NextResponse.json(await prepareAutomatedFeeControllerTransaction(input));
    }
    if (path === "v1/automated-fees/controller-status") {
      const input = automatedFeeControllerStatusRequestSchema.parse(body);
      return NextResponse.json(await automatedFeeControllerTransactionStatus(input));
    }
    if (path === "v1/automated-fees/prepare-controller-sweep") {
      const input = automatedFeeControllerSweepRequestSchema.parse(body);
      return NextResponse.json(await prepareAutomatedFeeControllerSweep(input));
    }
    if (path === "v1/automated-fees/broadcast-controller-sweep") {
      const input = automatedFeeBroadcastRequestSchema.parse(body);
      return NextResponse.json(await broadcastAutomatedFeeControllerSweep(input));
    }
    if (path === "v1/automated-fees/controller-sweep-status") {
      const input = automatedFeeControllerSweepStatusRequestSchema.parse(body);
      return NextResponse.json(await automatedFeeControllerSweepStatus(input));
    }
    if (path === "v1/automated-fees/broadcast") {
      const input = automatedFeeBroadcastRequestSchema.parse(body);
      await assertAutomatedFeeExecutionAccess({ vaultAddress: input.vaultAddress });
      return NextResponse.json(await broadcastAutomatedFeeTransaction(input));
    }
    if (path === "v1/automated-fees/broadcast-sweep") {
      const input = automatedFeeBroadcastRequestSchema.parse(body);
      await assertAutomatedFeeExecutionAccess({ vaultAddress: input.vaultAddress });
      return NextResponse.json(await broadcastAutomatedFeeSweepTransaction(input));
    }
    if (path === "v1/automated-fees/broadcast-delivery") {
      const input = automatedFeeBroadcastRequestSchema.parse(body);
      await assertAutomatedFeeDeliveryAccess({ vaultAddress: input.vaultAddress });
      return NextResponse.json(await broadcastAutomatedFeeDeliveryTransaction(input));
    }
    if (path === "v1/automated-fees/broadcast-vault") {
      const input = automatedFeeBroadcastRequestSchema.parse(body);
      if (!input.tokenAddress) throw new Error("manual vault broadcast requires its allowlisted token address");
      await assertAutomatedFeeEnrollmentAccess({ tokenAddress: input.tokenAddress, source: input.enrollmentSource ?? "upgrade" });
      return NextResponse.json(await broadcastAutomatedFeeAdminTransaction(input));
    }
    if (path === "v1/automated-fees/broadcast-pair-route") {
      const input = automatedFeePairRouteBroadcastRequestSchema.parse(body);
      return NextResponse.json(await broadcastAutomatedFeePairRoute(input));
    }
    if (path === "v1/automated-fees/broadcast-controller") {
      const input = automatedFeeControllerBroadcastRequestSchema.parse(body);
      await assertAutomatedFeeControllerAccess({ vaultAddress: input.vaultAddress });
      return NextResponse.json(await broadcastAutomatedFeeControllerTransaction(input));
    }
    if (path === "v1/wallets") {
      const input = walletRequestSchema.parse(body);
      return NextResponse.json(await provisionWallet(input.ownerReference));
    }
    if (path === "v1/sponsorships/free-launch/wallet") {
      return NextResponse.json(await freeLaunchSponsorWallet());
    }
    if (path === "v1/sponsorships/free-launch/estimate") {
      const input = freeLaunchFundingEstimateRequestSchema.parse(body);
      await assertWalletOwner(input.ownerReference, input.walletRef, input.expectedFrom);
      return NextResponse.json(await freeLaunchFundingEstimate(input));
    }
    if (path === "v1/sponsorships/free-launch") {
      const input = freeLaunchSponsorshipRequestSchema.parse(body);
      await assertWalletOwner(input.ownerReference, input.walletRef, input.recipient);
      return NextResponse.json(await sponsorFreeLaunch({
        idempotencyKey: input.idempotencyKey,
        amountWei: input.amountWei,
        recipient: input.recipient as `0x${string}`,
      }));
    }
    if (path === "v1/sponsorships/free-launch/status") {
      const input = freeLaunchSponsorshipStatusRequestSchema.parse(body);
      return NextResponse.json(await freeLaunchSponsorshipStatus({
        ...input,
        recipient: input.recipient as `0x${string}`,
      }));
    }
    if (path === "v1/sponsorships/free-launch/dev-buy-eligibility") {
      const input = freeLaunchDevBuyEligibilityRequestSchema.parse(body);
      await assertWalletOwner(input.ownerReference, input.walletRef, input.expectedAddress);
      return NextResponse.json(await freeLaunchDevBuyEligibility({
        address: input.expectedAddress as `0x${string}`,
        amount: input.amount,
        unit: input.unit,
        pairToken: input.pairToken as `0x${string}`,
      }));
    }
    if (path === "v1/wallets/balance") {
      const input = balanceRequestSchema.parse(body);
      if (input.walletRef.toLowerCase() !== input.expectedAddress.toLowerCase()) throw new Error("wallet reference mismatch");
      const expected = await provisionWallet(input.ownerReference);
      if (expected.address.toLowerCase() !== input.expectedAddress.toLowerCase()) throw new Error("wallet owner mismatch");
      return NextResponse.json(await walletBalance(input.expectedAddress as `0x${string}`, input.token, input.knownTokens as `0x${string}`[] | undefined));
    }
    if (path === "v1/wallets/spendable-eth") {
      const input = spendableEthRequestSchema.parse(body);
      await assertWalletOwner(input.ownerReference, input.walletRef, input.expectedAddress);
      return NextResponse.json(await spendableEthBalance(
        input.expectedAddress as `0x${string}`,
        input.reservedGasUnits,
        input.requestedEth,
      ));
    }
    if (path === "v1/tokens/pons-pair") {
      const input = ponsPairRequestSchema.parse(body);
      return NextResponse.json(await ponsPairInfo(input.token as `0x${string}`, input.factoryAddress as `0x${string}`));
    }
    if (path === "v1/tokens/holder-distributor") {
      const input = holderDistributorRequestSchema.parse(body);
      return NextResponse.json(await holderDistributorInfo(input.token as `0x${string}`, input.distributorFactoryAddress as `0x${string}`, input.ponsFactoryAddress as `0x${string}`));
    }
    if (path === "v1/fees/claim-plan") {
      const input = feeClaimPlanRequestSchema.parse(body);
      await assertWalletOwner(input.ownerReference, input.walletRef, input.expectedAddress);
      return NextResponse.json(await feeClaimPlan(
        input.tokenAddresses as `0x${string}`[],
        input.expectedAddress as `0x${string}`,
        input.factoryAddress as `0x${string}`,
        input.specificTokenAddress as `0x${string}` | undefined,
        true,
      ));
    }
    if (path === "v1/tokens/usd-amount") {
      const input = usdTokenAmountRequestSchema.parse(body);
      return NextResponse.json(await usdTokenAmount(input.token as `0x${string}`, input.amount, input.wethAddress as `0x${string}`, input.quoterAddress as `0x${string}`));
    }
    if (path === "v1/tokens/value-at-block") {
      const input = tokenValueAtBlockRequestSchema.parse(body);
      return NextResponse.json(await tokenValueAtBlock(input.token as `0x${string}`, input.amount, input.blockNumber));
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
    if (error instanceof RequestBodyError) return NextResponse.json({ error: error.message }, { status: error.status });
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
