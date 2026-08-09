import { z } from "zod";

export const ROBINHOOD_CHAIN_ID = 4663;
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const ownerReference = z.string().regex(/^x:\d{1,30}$/);
const amount = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).max(80)
  .refine((value) => Number(value) > 0, "amount must be positive");
const token = z.string().min(1).max(50);
const amountUnit = z.enum(["eth", "usd", "token", "percent"]);

const transferOperation = z.object({
  type: z.literal("eth_transfer"), recipient: address, amount, unit: z.enum(["eth", "usd"]),
}).strict();
const erc20TransferOperation = z.object({
  type: z.literal("erc20_transfer"), recipient: address, amount, unit: amountUnit, token,
}).strict();
const burnOperation = z.object({
  type: z.literal("erc20_burn_to_dead"), deadAddress: address, amount, unit: z.enum(["usd", "token", "percent"]), token,
}).strict();
const swapOperation = z.object({
  type: z.enum(["uniswap_v3_buy", "uniswap_v3_sell"]), token, amount,
  unit: amountUnit, slippageBps: z.number().int().min(10).max(2_000),
  routerAddress: address, quoterAddress: address, wethAddress: address, fee: z.literal(10_000),
}).strict();
const launchOperation = z.object({
  type: z.enum(["pons_v2_launch", "pons_v2_launch_and_buy"]), launchMode: z.literal("pons"),
  factoryAddress: address, launchAndBuyRouter: address, name: z.string().min(1).max(48),
  symbol: z.string().regex(/^[A-Z0-9]{1,12}$/), imageUri: z.string().max(2_048),
  description: z.string().max(280),
  devBuy: z.object({ amount, unit: z.enum(["eth", "usd", "pair"]) }).strict().nullable(),
  socials: z.object({ website: z.string().max(2_048), twitter: z.string().max(2_048), telegram: z.string().max(2_048) }).strict(),
  feeWalletSource: z.literal("reply_wallet"), launchConfigId: z.string().regex(/^\d+$/),
  pairToken: address, method: z.enum(["launchAndBuy", "launchToken"]),
}).strict();

export const signerOperationSchema = z.discriminatedUnion("type", [
  transferOperation, erc20TransferOperation, burnOperation, swapOperation, launchOperation,
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

const transactionRequest = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), ownerReference, walletRef: address, expectedFrom: address,
  expectedTo: address,
  transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/), operationType: z.string().min(1).max(80),
  expectedValueWei: z.string().regex(/^\d+$/),
}).strict();

export const transactionStatusRequestSchema = transactionRequest;
export const broadcastRequestSchema = transactionRequest.extend({ signedTransaction: z.string().regex(/^0x[a-fA-F0-9]+$/).max(50_000) });
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export type TransactionStatusRequest = z.infer<typeof transactionStatusRequestSchema>;
export type BroadcastRequest = z.infer<typeof broadcastRequestSchema>;
