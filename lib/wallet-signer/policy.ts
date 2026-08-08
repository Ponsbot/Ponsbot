import { z } from "zod";

export const ROBINHOOD_CHAIN_ID = 4663;
const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const ownerReference = z.string().regex(/^x:\d{1,30}$/);

export const walletRequestSchema = z.object({
  idempotencyKey: z.string().min(4).max(180), ownerReference, chainId: z.literal(ROBINHOOD_CHAIN_ID),
}).strict();

export const balanceRequestSchema = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), walletRef: address, expectedAddress: address, ownerReference,
  token: z.string().min(1).max(50).optional(),
}).strict();

export const executionRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(180), chainId: z.literal(ROBINHOOD_CHAIN_ID), ownerReference,
  walletRef: address, expectedFrom: address, requireSimulation: z.literal(true),
  operation: z.record(z.string(), z.unknown()).and(z.object({ type: z.string().min(1).max(80) })),
}).strict();

const transactionRequest = z.object({
  chainId: z.literal(ROBINHOOD_CHAIN_ID), ownerReference, walletRef: address, expectedFrom: address,
  transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/), operationType: z.string().min(1).max(80),
  expectedValueWei: z.string().regex(/^\d+$/),
}).strict();

export const transactionStatusRequestSchema = transactionRequest;
export const broadcastRequestSchema = transactionRequest.extend({ signedTransaction: z.string().regex(/^0x[a-fA-F0-9]+$/).max(50_000) });
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export type TransactionStatusRequest = z.infer<typeof transactionStatusRequestSchema>;
export type BroadcastRequest = z.infer<typeof broadcastRequestSchema>;
