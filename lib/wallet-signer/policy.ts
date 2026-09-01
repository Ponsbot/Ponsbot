import { z } from "zod";

export const ROBINHOOD_CHAIN_ID = 4663;
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const transactionHash = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const ownerReference = z.string().regex(/^x:\d{1,30}$/);
const amount = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).max(80)
  .refine((value) => Number(value) > 0, "amount must be positive");
const token = z.string().min(1).max(50);
const percentageAmount = amount.refine((value) => Number(value) <= 100, "percentage cannot exceed 100");
const freeLaunchGrantAmount = amount.refine(
  (value) => BigInt(value) <= 20_000_000_000_000_000n,
  "free launch grant exceeds safety cap",
);

const transferOperation = z.object({
  type: z.literal("eth_transfer"), recipient: address, amount, unit: z.enum(["eth", "usd", "percent"]),
}).strict().superRefine((operation, ctx) => {
  if (operation.unit === "percent" && !percentageAmount.safeParse(operation.amount).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "percentage cannot exceed 100", path: ["amount"] });
});
const erc20TransferOperation = z.object({
  type: z.literal("erc20_transfer"), recipient: address, amount, unit: z.enum(["eth", "usd", "token", "percent"]), token,
  quoterAddress: address, wethAddress: address, fee: z.literal(10_000),
  ponsFactoryAddress: address.optional(), v4QuoterAddress: address.optional(),
}).strict().superRefine((operation, ctx) => {
  if (operation.unit === "percent" && !percentageAmount.safeParse(operation.amount).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "percentage cannot exceed 100", path: ["amount"] });
});
const burnOperation = z.object({
  type: z.literal("erc20_burn_to_dead"), deadAddress: address, amount, unit: z.enum(["eth", "usd", "token", "percent"]), token,
  quoterAddress: address, wethAddress: address, fee: z.literal(10_000),
  ponsFactoryAddress: address.optional(), v4QuoterAddress: address.optional(),
}).strict().superRefine((operation, ctx) => {
  if (operation.unit === "percent" && !percentageAmount.safeParse(operation.amount).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "percentage cannot exceed 100", path: ["amount"] });
});
const buyOperation = z.object({
  type: z.literal("uniswap_v3_buy"), token, amount, unit: z.enum(["eth", "usd", "pair", "token"]),
  pairAsset: address.optional(),
  slippageBps: z.number().int().min(10).max(2_000),
  routerAddress: address, quoterAddress: address, wethAddress: address, ponsFactoryAddress: address,
  v4QuoterAddress: address, universalRouterAddress: address, permit2Address: address, fee: z.literal(10_000),
}).strict().superRefine((operation, ctx) => {
  if (operation.unit === "pair" && !operation.pairAsset) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "paired asset is required", path: ["pairAsset"] });
  if (operation.unit !== "pair" && operation.pairAsset) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "paired asset is only valid for pair amounts", path: ["pairAsset"] });
});
const sellOperation = z.object({
  type: z.literal("uniswap_v3_sell"), token, amount, unit: z.enum(["eth", "usd", "token", "percent"]),
  slippageBps: z.number().int().min(10).max(2_000),
  routerAddress: address, quoterAddress: address, wethAddress: address, ponsFactoryAddress: address,
  v4QuoterAddress: address, universalRouterAddress: address, permit2Address: address, fee: z.literal(10_000),
}).strict().superRefine((operation, ctx) => {
  if (operation.unit === "percent" && !percentageAmount.safeParse(operation.amount).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "percentage cannot exceed 100", path: ["amount"] });
});
const claimFeesOperation = z.object({
  type: z.literal("pons_v2_claim_fees"), token: token.optional(), factoryAddress: address,
}).strict();
const sweepFeesOperation = z.object({
  type: z.literal("pons_v2_sweep_fees"), token, factoryAddress: address, minBuybackTokensOut: z.literal("0"),
}).strict();
const launchOperation = z.object({
  type: z.enum(["pons_v2_launch", "pons_v2_launch_and_buy"]), launchMode: z.literal("pons"),
  factoryAddress: address, launchAndBuyRouter: address, name: z.string().min(1).max(48),
  symbol: z.string().regex(/^[A-Z0-9]{1,16}$/), imageUri: z.string().max(2_048),
  description: z.string().max(280),
  devBuy: z.object({ amount, unit: z.enum(["eth", "usd", "pair"]) }).strict().nullable(),
  socials: z.object({ website: z.string().max(2_048), twitter: z.string().max(2_048), telegram: z.string().max(2_048) }).strict(),
  feeWalletSource: z.literal("reply_wallet"), launchConfigId: z.string().regex(/^\d+$/),
  creatorFeeRecipient: address,
  pairToken: address, quoterAddress: address, wethAddress: address, method: z.enum(["launchAndBuy", "launchToken"]),
  preparedSalt: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  predictedTokenAddress: address.optional(), predictedCurveAddress: address.optional(),
}).strict();
const holderDistributorOperation = z.object({
  type: z.literal("pons_v2_create_holder_distributor"), token: address, distributorFactoryAddress: address,
}).strict();
const transferFeeRecipientOperation = z.object({
  type: z.literal("pons_v2_transfer_creator_fee_recipient"), token: address, newRecipient: address, factoryAddress: address,
}).strict();

export const signerOperationSchema = z.union([
  transferOperation, erc20TransferOperation, burnOperation, buyOperation, sellOperation, claimFeesOperation, sweepFeesOperation, launchOperation,
  holderDistributorOperation, transferFeeRecipientOperation,
]);

export const walletRequestSchema = z.object({
  idempotencyKey: z.string().min(4).max(180), ownerReference, chainId: z.literal(ROBINHOOD_CHAIN_ID),
}).strict();

export const balanceRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), walletRef: address, expectedAddress: address, ownerReference,
  token: z.string().min(1).max(50).optional(), knownTokens: z.array(address).max(100).optional(),
}).strict();

export const executionRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(180), chainId: z.literal(ROBINHOOD_CHAIN_ID), ownerReference,
  walletRef: address, expectedFrom: address, requireSimulation: z.literal(true),
  // Multi-transaction workflows carry the confirmed child nonce forward so
  // an RPC node that is briefly behind cannot prepare the next transaction
  // with the already-consumed nonce.
  minimumNonce: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  operation: signerOperationSchema,
}).strict();

export const freeLaunchSponsorshipRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(180),
  ownerReference,
  walletRef: address,
  recipient: address,
  amountWei: freeLaunchGrantAmount,
}).strict();

export const freeLaunchSponsorshipStatusRequestSchema = z.object({
  transactionHash,
  recipient: address,
  amountWei: freeLaunchGrantAmount,
}).strict();

export const freeLaunchFundingEstimateRequestSchema = executionRequestSchema;

export const freeLaunchDevBuyEligibilityRequestSchema = z.object({
  ownerReference,
  walletRef: address,
  expectedAddress: address,
  amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).max(80)
    .refine((value) => Number(value) > 0, "amount must be positive"),
  unit: z.enum(["eth", "usd", "pair"]),
  pairToken: address,
}).strict();

export const spendableEthRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), walletRef: address,
  expectedAddress: address, ownerReference,
  reservedGasUnits: z.number().int().min(21_000).max(3_000_000),
  requestedEth: amount.optional(),
}).strict();

export const launchPreparationRequestSchema = executionRequestSchema.superRefine((request, ctx) => {
  if (request.operation.type !== "pons_v2_launch" && request.operation.type !== "pons_v2_launch_and_buy") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "launch operation required", path: ["operation", "type"] });
  }
});

export const ponsPairRequestSchema = z.object({
  token: address, factoryAddress: address,
}).strict();
export const holderDistributorRequestSchema = z.object({
  token: address, distributorFactoryAddress: address, ponsFactoryAddress: address,
}).strict();

export const feeClaimPlanRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), ownerReference,
  walletRef: address, expectedAddress: address, factoryAddress: address,
  tokenAddresses: z.array(address).max(250),
  specificTokenAddress: address.optional(),
}).strict();

export const usdTokenAmountRequestSchema = z.object({
  token: address, amount, wethAddress: address, quoterAddress: address,
}).strict();

export const tokenValueAtBlockRequestSchema = z.object({
  token: address, amount, blockNumber: z.string().regex(/^\d{1,30}$/),
}).strict();

export const automatedFeeQuoteRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID),
  vaultAddress: address,
  deadline: z.number().int().positive(),
  nonce: z.string().regex(/^\d+$/),
}).strict();

export const automatedFeeInspectionRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID),
  vaultAddress: address,
  includeAccumulation: z.optional(z.boolean()),
}).strict();

export const automatedFeeClaimableRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), vaultAddress: address,
  beneficiary: address, asset: address,
}).strict();

export const automatedFeeEnrollmentVerificationRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), vaultAddress: address, tokenAddress: address,
  controllerAddress: address, beneficiaryAddress: address, pairTokenAddress: address,
  deploymentTransactionHash: transactionHash, enrollmentTransactionHash: transactionHash,
  enrollmentSource: z.enum(["new_launch", "upgrade"]),
}).strict();

export const automatedFeeVaultPredictionRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID),
  tokenAddress: address,
  vaultFactoryAddress: address,
  ponsFactoryAddress: address,
  salt: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  enrollmentSource: z.enum(["new_launch", "upgrade"]),
}).strict();

export const automatedFeeVaultDeploymentStatusRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID),
  tokenAddress: address,
  vaultFactoryAddress: address,
  vaultAddress: address,
  transactionHash,
  transactionNonce: z.number().int().nonnegative().optional(),
  broadcastAt: z.number().int().positive().optional(),
  enrollmentSource: z.enum(["new_launch", "upgrade"]),
}).strict();

export const automatedFeeKeeperTransactionRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(180),
  chainId: z.literal(ROBINHOOD_CHAIN_ID),
  vaultAddress: address,
  maxBuybackAmount: z.string().regex(/^\d+$/),
  minPonsbotOut: z.string().regex(/^[1-9]\d*$/),
  minSweepBuybackTokensOut: z.string().regex(/^\d+$/),
  deadline: z.number().int().positive(),
  routeTarget: address,
  routeData: z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/).max(20_000),
  quoteSignature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
}).strict();

export const automatedFeeSweepTransactionRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(180), chainId: z.literal(ROBINHOOD_CHAIN_ID),
  vaultAddress: address,
  sweepKind: z.enum(["curve", "graduated"]),
  minConversionQuoteOut: z.string().regex(/^\d+$/),
  minBuybackTokensOut: z.string().regex(/^\d+$/),
}).strict().superRefine((request, ctx) => {
  if (request.sweepKind === "curve" && request.minConversionQuoteOut !== "0") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "curve sweep cannot specify a conversion minimum", path: ["minConversionQuoteOut"] });
  }
  if (request.sweepKind === "graduated" && BigInt(request.minConversionQuoteOut) === 0n) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "graduated sweep requires a positive conversion minimum", path: ["minConversionQuoteOut"] });
  }
  if (BigInt(request.minBuybackTokensOut) === 0n) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sweep requires a positive buyback minimum", path: ["minBuybackTokensOut"] });
  }
});

export const automatedFeeDeliveryTransactionRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(180), chainId: z.literal(ROBINHOOD_CHAIN_ID),
  vaultAddress: address, beneficiary: address, asset: address,
  amount: z.string().regex(/^[1-9]\d*$/), processingBlockNumber: z.string().regex(/^\d+$/),
}).strict();

export const automatedFeeTransactionStatusRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), vaultAddress: address, transactionHash,
  stage: z.enum(["sweep", "processing", "delivery"]),
  transactionNonce: z.number().int().nonnegative().optional(),
  broadcastAt: z.number().int().positive().optional(),
}).strict();

export const automatedFeeBroadcastRequestSchema = z.object({
  transactionHash,
  signedTransaction: z.string().regex(/^0x[a-fA-F0-9]+$/).max(50_000),
  vaultAddress: address,
  tokenAddress: address.optional(),
  enrollmentSource: z.enum(["new_launch", "upgrade"]).optional(),
}).strict();

export const automatedFeeVaultDeploymentRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(180), chainId: z.literal(ROBINHOOD_CHAIN_ID),
  vaultFactoryAddress: address, salt: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  token: address, curve: address, pairAsset: address, ponsFactory: address, feeEscrow: address,
  ponsbot: address, controller: address, beneficiary: address, feeControl: address,
  distributionMode: z.literal("wallet"),
  enrollmentSource: z.enum(["new_launch", "upgrade"]).default("upgrade"),
}).strict();

export const automatedFeePairRouteRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(180), chainId: z.literal(ROBINHOOD_CHAIN_ID),
  pairedExecutorAddress: address, pairAsset: address,
  routeKind: z.enum(["v3", "v4"]),
  fee: z.number().int().min(0).max(1_000_000),
  tickSpacing: z.number().int().min(-8_388_608).max(8_388_607),
  hook: address,
}).strict().superRefine((request, ctx) => {
  if (request.routeKind === "v3" && (request.fee === 0 || request.tickSpacing !== 0 || !/^0x0{40}$/i.test(request.hook))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid V3 automated pair route" });
  }
  if (request.routeKind === "v4" && request.tickSpacing === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid V4 automated pair route" });
  }
});

export const automatedFeePairRouteBroadcastRequestSchema = automatedFeeBroadcastRequestSchema.extend({
  pairAsset: address,
}).strict();

const automatedFeeExecutionAuthorizationSchema = z.object({
  maxBuybackAmount: z.string().regex(/^\d+$/), minPonsbotOut: z.string().regex(/^\d+$/),
  minSweepBuybackTokensOut: z.string().regex(/^\d+$/), deadline: z.number().int().positive(),
  routeTarget: address, routeData: z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/).max(20_000),
  quoteSignature: z.string().regex(/^0x(?:[a-fA-F0-9]{130})?$/),
}).strict();
const automatedFeeControllerOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pause") }).strict(),
  z.object({ type: z.literal("exit"), recipient: address }).strict(),
  z.object({ type: z.literal("withdraw"), asset: address, recipient: address, amount: z.string().regex(/^[1-9]\d*$/) }).strict(),
  z.object({
    type: z.literal("reassign"), newController: address, newBeneficiary: address,
    execution: automatedFeeExecutionAuthorizationSchema,
  }).strict(),
]);
export const automatedFeeControllerTransactionRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(180), chainId: z.literal(ROBINHOOD_CHAIN_ID),
  ownerReference, walletRef: address, expectedAddress: address, vaultAddress: address,
  operation: automatedFeeControllerOperationSchema,
}).strict();
export const automatedFeeControllerBroadcastRequestSchema = z.object({
  transactionHash, signedTransaction: z.string().regex(/^0x[a-fA-F0-9]+$/).max(50_000),
  ownerReference, walletRef: address, expectedAddress: address, vaultAddress: address,
  operation: automatedFeeControllerOperationSchema,
}).strict();
export const automatedFeeControllerStatusRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), vaultAddress: address, transactionHash,
  expectedAddress: address,
  transactionNonce: z.number().int().nonnegative().optional(),
  broadcastAt: z.number().int().positive().optional(),
  operation: z.discriminatedUnion("type", [
    z.object({ type: z.literal("reassign"), newController: address, newBeneficiary: address }).strict(),
    z.object({ type: z.literal("exit"), recipient: address }).strict(),
    z.object({ type: z.literal("pause") }).strict(),
  ]),
}).strict();
export const automatedFeeControllerSweepRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(180), chainId: z.literal(ROBINHOOD_CHAIN_ID), vaultAddress: address,
}).strict();
export const automatedFeeControllerSweepStatusRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), vaultAddress: address, transactionHash,
  transactionNonce: z.number().int().nonnegative().optional(),
  broadcastAt: z.number().int().positive().optional(),
}).strict();

const transactionRequest = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), ownerReference, walletRef: address, expectedFrom: address,
  expectedTo: address,
  expectedFactory: address.optional(),
  expectedCreatorFeeRecipient: address.optional(),
  expectedFeeReassignmentToken: address.optional(),
  expectedFeeReassignmentRecipient: address.optional(),
  transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/), operationType: z.string().min(1).max(80),
  expectedValueWei: z.string().regex(/^\d+$/),
  tradeOutputTokenAddress: address.optional(), tradeOutputBalanceBefore: z.string().regex(/^\d+$/).optional(),
  involvedPairTokenAddress: address.optional(),
}).strict();

export const transactionStatusRequestSchema = transactionRequest;
export const broadcastRequestSchema = transactionRequest.extend({ signedTransaction: z.string().regex(/^0x[a-fA-F0-9]+$/).max(50_000) });
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export type TransactionStatusRequest = z.infer<typeof transactionStatusRequestSchema>;
export type BroadcastRequest = z.infer<typeof broadcastRequestSchema>;
export type AutomatedFeeQuoteRequest = z.infer<typeof automatedFeeQuoteRequestSchema>;
export type AutomatedFeeInspectionRequest = z.infer<typeof automatedFeeInspectionRequestSchema>;
export type AutomatedFeeClaimableRequest = z.infer<typeof automatedFeeClaimableRequestSchema>;
export type AutomatedFeeEnrollmentVerificationRequest = z.infer<typeof automatedFeeEnrollmentVerificationRequestSchema>;
export type AutomatedFeeVaultPredictionRequest = z.infer<typeof automatedFeeVaultPredictionRequestSchema>;
export type AutomatedFeeVaultDeploymentStatusRequest = z.infer<typeof automatedFeeVaultDeploymentStatusRequestSchema>;
export type AutomatedFeeKeeperTransactionRequest = z.infer<typeof automatedFeeKeeperTransactionRequestSchema>;
export type AutomatedFeeSweepTransactionRequest = z.infer<typeof automatedFeeSweepTransactionRequestSchema>;
export type AutomatedFeeDeliveryTransactionRequest = z.infer<typeof automatedFeeDeliveryTransactionRequestSchema>;
export type AutomatedFeeTransactionStatusRequest = z.infer<typeof automatedFeeTransactionStatusRequestSchema>;
export type AutomatedFeeBroadcastRequest = z.infer<typeof automatedFeeBroadcastRequestSchema>;
export type AutomatedFeeVaultDeploymentRequest = z.infer<typeof automatedFeeVaultDeploymentRequestSchema>;
export type AutomatedFeePairRouteRequest = z.infer<typeof automatedFeePairRouteRequestSchema>;
export type AutomatedFeePairRouteBroadcastRequest = z.infer<typeof automatedFeePairRouteBroadcastRequestSchema>;
export type AutomatedFeeControllerTransactionRequest = z.infer<typeof automatedFeeControllerTransactionRequestSchema>;
export type AutomatedFeeControllerBroadcastRequest = z.infer<typeof automatedFeeControllerBroadcastRequestSchema>;
export type AutomatedFeeControllerStatusRequest = z.infer<typeof automatedFeeControllerStatusRequestSchema>;
export type AutomatedFeeControllerSweepRequest = z.infer<typeof automatedFeeControllerSweepRequestSchema>;
export type AutomatedFeeControllerSweepStatusRequest = z.infer<typeof automatedFeeControllerSweepStatusRequestSchema>;
