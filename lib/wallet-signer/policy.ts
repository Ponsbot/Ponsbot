import { z } from "zod";

export const ROBINHOOD_CHAIN_ID = 4663;
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const ownerReference = z.string().regex(/^x:\d{1,30}$/);
const amount = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).max(80)
  .refine((value) => Number(value) > 0, "amount must be positive");
const token = z.string().min(1).max(50);
const percentageAmount = amount.refine((value) => Number(value) <= 100, "percentage cannot exceed 100");

const transferOperation = z.object({
  type: z.literal("eth_transfer"), recipient: address, amount, unit: z.enum(["eth", "usd", "percent"]),
}).strict().superRefine((operation, ctx) => {
  if (operation.unit === "percent" && !percentageAmount.safeParse(operation.amount).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "percentage cannot exceed 100", path: ["amount"] });
});
const erc20TransferOperation = z.object({
  type: z.literal("erc20_transfer"), recipient: address, amount, unit: z.enum(["usd", "token", "percent"]), token,
  quoterAddress: address, wethAddress: address, fee: z.literal(10_000),
}).strict().superRefine((operation, ctx) => {
  if (operation.unit === "percent" && !percentageAmount.safeParse(operation.amount).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "percentage cannot exceed 100", path: ["amount"] });
});
const burnOperation = z.object({
  type: z.literal("erc20_burn_to_dead"), deadAddress: address, amount, unit: z.enum(["usd", "token", "percent"]), token,
  quoterAddress: address, wethAddress: address, fee: z.literal(10_000),
}).strict().superRefine((operation, ctx) => {
  if (operation.unit === "percent" && !percentageAmount.safeParse(operation.amount).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "percentage cannot exceed 100", path: ["amount"] });
});
const buyOperation = z.object({
  type: z.literal("uniswap_v3_buy"), token, amount, unit: z.enum(["eth", "usd", "pair"]),
  pairAsset: address.optional(),
  slippageBps: z.number().int().min(10).max(2_000),
  routerAddress: address, quoterAddress: address, wethAddress: address, ponsFactoryAddress: address,
  v4QuoterAddress: address, universalRouterAddress: address, permit2Address: address, fee: z.literal(10_000),
}).strict().superRefine((operation, ctx) => {
  if (operation.unit === "pair" && !operation.pairAsset) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "paired asset is required", path: ["pairAsset"] });
  if (operation.unit !== "pair" && operation.pairAsset) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "paired asset is only valid for pair amounts", path: ["pairAsset"] });
});
const sellOperation = z.object({
  type: z.literal("uniswap_v3_sell"), token, amount, unit: z.enum(["usd", "token", "percent"]),
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
  symbol: z.string().regex(/^[A-Z0-9]{1,12}$/), imageUri: z.string().max(2_048),
  description: z.string().max(280),
  devBuy: z.object({ amount, unit: z.enum(["eth", "usd", "pair"]) }).strict().nullable(),
  socials: z.object({ website: z.string().max(2_048), twitter: z.string().max(2_048), telegram: z.string().max(2_048) }).strict(),
  feeWalletSource: z.literal("reply_wallet"), launchConfigId: z.string().regex(/^\d+$/),
  pairToken: address, quoterAddress: address, wethAddress: address, method: z.enum(["launchAndBuy", "launchToken"]),
  preparedSalt: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  predictedTokenAddress: address.optional(), predictedCurveAddress: address.optional(),
}).strict();

export const signerOperationSchema = z.union([
  transferOperation, erc20TransferOperation, burnOperation, buyOperation, sellOperation, claimFeesOperation, sweepFeesOperation, launchOperation,
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
  operation: signerOperationSchema,
}).strict();

export const launchPreparationRequestSchema = executionRequestSchema.superRefine((request, ctx) => {
  if (request.operation.type !== "pons_v2_launch" && request.operation.type !== "pons_v2_launch_and_buy") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "launch operation required", path: ["operation", "type"] });
  }
});

export const ponsPairRequestSchema = z.object({
  token: address, factoryAddress: address,
}).strict();

const transactionRequest = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), ownerReference, walletRef: address, expectedFrom: address,
  expectedTo: address,
  expectedFactory: address.optional(),
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
