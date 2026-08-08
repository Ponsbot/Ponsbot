import { timingSafeEqual } from "node:crypto";
import type { BroadcastRequest, ExecutionRequest, TransactionStatusRequest } from "./policy";

const disabled = () => {
  throw new Error("The local signer is disabled until the Pons adapter and new credentials are configured.");
};

export function authorizeSigner(header: string | null) {
  const expected = process.env.WALLET_SIGNER_TOKEN;
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected); const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function provisionWallet(_ownerReference: string): Promise<{ walletRef: string; address: string }> { return disabled(); }
export async function walletBalance(_address: `0x${string}`, _token?: string): Promise<{ display: string }> { return disabled(); }
export async function executeTransaction(_request: ExecutionRequest): Promise<never> { return disabled(); }
export async function broadcastTransaction(_request: BroadcastRequest): Promise<never> { return disabled(); }
export async function transactionStatus(_request: TransactionStatusRequest): Promise<never> { return disabled(); }
