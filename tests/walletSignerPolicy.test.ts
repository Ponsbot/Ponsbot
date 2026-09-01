import { describe, expect, it } from "vitest";
import { automatedFeeControllerStatusRequestSchema, automatedFeeControllerSweepRequestSchema, automatedFeeControllerSweepStatusRequestSchema, automatedFeeControllerTransactionRequestSchema, automatedFeeDeliveryTransactionRequestSchema, automatedFeePairRouteRequestSchema, automatedFeeSweepTransactionRequestSchema, automatedFeeTransactionStatusRequestSchema, automatedFeeVaultDeploymentRequestSchema, executionRequestSchema, feeClaimPlanRequestSchema, freeLaunchDevBuyEligibilityRequestSchema, freeLaunchSponsorshipRequestSchema, transactionStatusRequestSchema } from "../lib/wallet-signer/policy";

const base = {
  idempotencyKey: "x:123456789:buy", chainId: 4663, ownerReference: "x:123456789",
  walletRef: "0x1111111111111111111111111111111111111111",
  expectedFrom: "0x1111111111111111111111111111111111111111", requireSimulation: true,
};
const address = (digit: string) => `0x${digit.repeat(40)}`;

describe("wallet signer operation policy", () => {
  it("accepts an exact supported operation", () => {
    expect(executionRequestSchema.parse({ ...base, operation: {
      type: "eth_transfer", recipient: "0x2222222222222222222222222222222222222222",
      amount: "0.01", unit: "eth",
    } }).operation.type).toBe("eth_transfer");
    expect(executionRequestSchema.parse({ ...base, operation: {
      type: "eth_transfer", recipient: "0x2222222222222222222222222222222222222222",
      amount: "100", unit: "percent",
    } }).operation.type).toBe("eth_transfer");
  });

  it("accepts only a safe confirmed-child nonce floor", () => {
    const operation = {
      type: "eth_transfer", recipient: "0x2222222222222222222222222222222222222222",
      amount: "0.01", unit: "eth",
    };
    expect(executionRequestSchema.parse({ ...base, minimumNonce: 129, operation }).minimumNonce).toBe(129);
    expect(() => executionRequestSchema.parse({ ...base, minimumNonce: -1, operation })).toThrow();
    expect(() => executionRequestSchema.parse({ ...base, minimumNonce: 1.5, operation })).toThrow();
  });

  it("rejects arbitrary calls and extra fields", () => {
    expect(() => executionRequestSchema.parse({ ...base, operation: { type: "arbitrary_call", to: base.walletRef } })).toThrow();
    expect(() => executionRequestSchema.parse({ ...base, operation: {
      type: "eth_transfer", recipient: "0x2222222222222222222222222222222222222222",
      amount: "0.01", unit: "eth", data: "0xdeadbeef",
    } })).toThrow();
  });

  it("allows only a zero-minimum verified Pons fee sweep shape", () => {
    const operation = {
      type: "pons_v2_sweep_fees", token: "0x7777777777777777777777777777777777777777",
      factoryAddress: "0x6666666666666666666666666666666666666666", minBuybackTokensOut: "0",
    };
    expect(executionRequestSchema.parse({ ...base, operation }).operation.type).toBe("pons_v2_sweep_fees");
    expect(() => executionRequestSchema.parse({ ...base, operation: { ...operation, minBuybackTokensOut: "1" } })).toThrow();
    expect(() => executionRequestSchema.parse({ ...base, operation: { ...operation, curveAddress: base.walletRef } })).toThrow();
  });

  it("strictly bounds bulk fee-claim preflight requests", () => {
    const request = {
      chainId: 4663, ownerReference: base.ownerReference,
      walletRef: base.walletRef, expectedAddress: base.expectedFrom,
      factoryAddress: "0x6666666666666666666666666666666666666666",
      tokenAddresses: ["0x7777777777777777777777777777777777777777"],
    };
    expect(feeClaimPlanRequestSchema.parse(request).tokenAddresses).toHaveLength(1);
    expect(() => feeClaimPlanRequestSchema.parse({ ...request, extra: true })).toThrow();
    expect(() => feeClaimPlanRequestSchema.parse({
      ...request,
      tokenAddresses: Array.from({ length: 251 }, () => request.tokenAddresses[0]),
    })).toThrow();
  });

  it("restricts dynamic free-launch sponsorship grants and binds the wallet", () => {
    const request = {
      idempotencyKey: "x:123456789:launch",
      ownerReference: base.ownerReference,
      walletRef: base.walletRef,
      recipient: base.expectedFrom,
      amountWei: "1500000000000000",
    };
    expect(freeLaunchSponsorshipRequestSchema.parse(request)).toEqual(request);
    expect(() => freeLaunchSponsorshipRequestSchema.parse({ ...request, amountWei: "20000000000000001" })).toThrow();
    expect(() => freeLaunchSponsorshipRequestSchema.parse({ ...request, recipient: "not-an-address" })).toThrow();
    expect(() => freeLaunchSponsorshipRequestSchema.parse({ ...request, arbitraryRecipient: true })).toThrow();
  });

  it("binds developer-buy eligibility checks to the user's wallet and launch pair", () => {
    const request = {
      ownerReference: base.ownerReference,
      walletRef: base.walletRef,
      expectedAddress: base.expectedFrom,
      amount: "100",
      unit: "usd" as const,
      pairToken: "0x0000000000000000000000000000000000000000",
    };
    expect(freeLaunchDevBuyEligibilityRequestSchema.parse(request)).toEqual(request);
    expect(() => freeLaunchDevBuyEligibilityRequestSchema.parse({ ...request, amount: "0" })).toThrow();
    expect(() => freeLaunchDevBuyEligibilityRequestSchema.parse({ ...request, pairToken: "ETH" })).toThrow();
  });

  it("rejects zero and negative-equivalent amounts", () => {
    expect(() => executionRequestSchema.parse({ ...base, operation: {
      type: "eth_transfer", recipient: "0x2222222222222222222222222222222222222222",
      amount: "0", unit: "eth",
    } })).toThrow();
  });

  it("rejects invalid units and percentages at the signer boundary", () => {
    const contracts = {
      routerAddress: "0x3333333333333333333333333333333333333333",
      quoterAddress: "0x4444444444444444444444444444444444444444",
      wethAddress: "0x5555555555555555555555555555555555555555",
      ponsFactoryAddress: "0x6666666666666666666666666666666666666666",
      fee: 10_000,
    };
    expect(() => executionRequestSchema.parse({ ...base, operation: {
      type: "eth_transfer", recipient: "0x2222222222222222222222222222222222222222",
      amount: "101", unit: "percent",
    } })).toThrow();
    expect(() => executionRequestSchema.parse({ ...base, operation: {
      type: "uniswap_v3_buy", token: "0x7777777777777777777777777777777777777777",
      amount: "50", unit: "percent", slippageBps: 100, ...contracts,
    } })).toThrow();
    expect(() => executionRequestSchema.parse({ ...base, operation: {
      type: "uniswap_v3_sell", token: "0x7777777777777777777777777777777777777777",
      amount: "101", unit: "percent", slippageBps: 100, ...contracts,
    } })).toThrow();
  });

  it("accepts ETH-denominated token sells", () => {
    const operation = {
      type: "uniswap_v3_sell", token: "0x7777777777777777777777777777777777777777",
      amount: "0.001", unit: "eth", slippageBps: 250,
      routerAddress: "0x3333333333333333333333333333333333333333",
      quoterAddress: "0x4444444444444444444444444444444444444444",
      wethAddress: "0x5555555555555555555555555555555555555555",
      ponsFactoryAddress: "0x6666666666666666666666666666666666666666",
      v4QuoterAddress: "0x8888888888888888888888888888888888888888",
      universalRouterAddress: "0x9999999999999999999999999999999999999999",
      permit2Address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", fee: 10_000,
    };
    expect(executionRequestSchema.parse({ ...base, operation }).operation).toMatchObject({ unit: "eth", amount: "0.001" });
  });

  it("binds launch receipt verification to the expected creator fee recipient", () => {
    const status = {
      chainId: 4663, ownerReference: base.ownerReference, walletRef: base.walletRef,
      expectedFrom: base.expectedFrom, expectedTo: "0x2222222222222222222222222222222222222222",
      expectedFactory: "0x3333333333333333333333333333333333333333",
      expectedCreatorFeeRecipient: "0x4444444444444444444444444444444444444444",
      transactionHash: `0x${"1".repeat(64)}`, operationType: "pons_v2_launch", expectedValueWei: "0",
    };
    expect(transactionStatusRequestSchema.parse(status).expectedCreatorFeeRecipient).toBe(status.expectedCreatorFeeRecipient);
    expect(() => transactionStatusRequestSchema.parse({ ...status, expectedCreatorFeeRecipient: "not-an-address" })).toThrow();
  });

  it("binds fee reassignment receipts to the requested token and recipient", () => {
    const status = {
      chainId: 4663, ownerReference: base.ownerReference, walletRef: base.walletRef,
      expectedFrom: base.expectedFrom, expectedTo: "0x2222222222222222222222222222222222222222",
      expectedFeeReassignmentToken: "0x3333333333333333333333333333333333333333",
      expectedFeeReassignmentRecipient: "0x4444444444444444444444444444444444444444",
      transactionHash: `0x${"2".repeat(64)}`, operationType: "pons_v2_transfer_creator_fee_recipient", expectedValueWei: "0",
    };
    expect(transactionStatusRequestSchema.parse(status)).toMatchObject({
      expectedFeeReassignmentToken: status.expectedFeeReassignmentToken,
      expectedFeeReassignmentRecipient: status.expectedFeeReassignmentRecipient,
    });
    expect(() => transactionStatusRequestSchema.parse({ ...status, expectedFeeReassignmentRecipient: "bad" })).toThrow();
  });

  it("keeps holder sharing outside immutable automated-fee vault deployment", () => {
    const request = {
      idempotencyKey: "automated:test-vault", chainId: 4663,
      vaultFactoryAddress: address("1"), salt: `0x${"1".repeat(64)}`,
      token: address("2"), curve: address("3"), pairAsset: address("0"), ponsFactory: address("4"),
      feeEscrow: address("5"), ponsbot: address("6"), controller: address("7"), beneficiary: address("7"),
      feeControl: address("8"), distributionMode: "wallet" as const,
    };
    expect(automatedFeeVaultDeploymentRequestSchema.parse(request).distributionMode).toBe("wallet");
    expect(() => automatedFeeVaultDeploymentRequestSchema.parse({ ...request, distributionMode: "holders" })).toThrow();
  });

  it("strictly distinguishes curve and graduated automated fee sweeps", () => {
    const request = { idempotencyKey: "automated:sweep", chainId: 4663, vaultAddress: address("1"),
      sweepKind: "graduated" as const, minConversionQuoteOut: "1" as const, minBuybackTokensOut: "1" as const };
    expect(automatedFeeSweepTransactionRequestSchema.parse(request).sweepKind).toBe("graduated");
    expect(() => automatedFeeSweepTransactionRequestSchema.parse({ ...request, minConversionQuoteOut: "0" })).toThrow();
    expect(() => automatedFeeSweepTransactionRequestSchema.parse({ ...request, sweepKind: "curve", minConversionQuoteOut: "1" })).toThrow();
    expect(automatedFeeSweepTransactionRequestSchema.parse({ ...request, sweepKind: "curve", minConversionQuoteOut: "0" }).sweepKind).toBe("curve");
  });

  it("requires a positive, fixed beneficiary-delivery amount", () => {
    const request = {
      idempotencyKey: "automated-fee-delivery:test", chainId: 4663,
      vaultAddress: address("1"), beneficiary: address("2"), asset: address("0"), amount: "9500", processingBlockNumber: "123",
    };
    expect(automatedFeeDeliveryTransactionRequestSchema.parse(request).amount).toBe("9500");
    expect(() => automatedFeeDeliveryTransactionRequestSchema.parse({ ...request, amount: "0" })).toThrow();
    expect(() => automatedFeeDeliveryTransactionRequestSchema.parse({ ...request, recipient: address("3") })).toThrow();
  });

  it("limits automated fee receipt inspection to known workflow stages", () => {
    const request = { chainId: 4663, vaultAddress: address("1"), transactionHash: `0x${"2".repeat(64)}`, stage: "processing" };
    expect(automatedFeeTransactionStatusRequestSchema.parse(request).stage).toBe("processing");
    expect(() => automatedFeeTransactionStatusRequestSchema.parse({ ...request, stage: "admin" })).toThrow();
  });

  it("accepts only structurally constrained automated pair routes", () => {
    const baseRoute = { idempotencyKey: "automated:pair-route", chainId: 4663,
      pairedExecutorAddress: address("1"), pairAsset: address("2") };
    expect(automatedFeePairRouteRequestSchema.parse({ ...baseRoute, routeKind: "v3", fee: 500,
      tickSpacing: 0, hook: address("0") }).routeKind).toBe("v3");
    expect(() => automatedFeePairRouteRequestSchema.parse({ ...baseRoute, routeKind: "v3", fee: 500,
      tickSpacing: 10, hook: address("0") })).toThrow();
    expect(automatedFeePairRouteRequestSchema.parse({ ...baseRoute, routeKind: "v4", fee: 2_500,
      tickSpacing: 25, hook: address("0") }).routeKind).toBe("v4");
  });

  it("binds controller lifecycle requests to one Pons Bot wallet", () => {
    const request = { idempotencyKey: "automated:controller", chainId: 4663, ownerReference: base.ownerReference,
      walletRef: base.walletRef, expectedAddress: base.expectedFrom, vaultAddress: address("2"),
      operation: { type: "exit" as const, recipient: address("3") } };
    expect(automatedFeeControllerTransactionRequestSchema.parse(request).operation.type).toBe("exit");
    expect(() => automatedFeeControllerTransactionRequestSchema.parse({ ...request, operation: {
      type: "reassign", newController: address("3"), newBeneficiary: address("4"), execution: {},
    } })).toThrow();
    const status = { chainId: 4663, vaultAddress: address("2"), expectedAddress: base.expectedFrom,
      transactionHash: `0x${"5".repeat(64)}`, transactionNonce: 4, broadcastAt: Date.now(),
      operation: { type: "reassign" as const, newController: address("3"), newBeneficiary: address("3") } };
    expect(automatedFeeControllerStatusRequestSchema.parse(status).operation.type).toBe("reassign");
    expect(() => automatedFeeControllerStatusRequestSchema.parse({ ...status, operation: {
      type: "reassign", newController: address("3"), newBeneficiary: address("4"),
    } })).not.toThrow();
    const sweep = { idempotencyKey: "automated:controller-sweep", chainId: 4663, vaultAddress: address("2") };
    expect(automatedFeeControllerSweepRequestSchema.parse(sweep).vaultAddress).toBe(address("2"));
    expect(automatedFeeControllerSweepStatusRequestSchema.parse({
      chainId: 4663, vaultAddress: address("2"), transactionHash: `0x${"6".repeat(64)}`,
      transactionNonce: 5, broadcastAt: Date.now(),
    }).chainId).toBe(4663);
  });
});
