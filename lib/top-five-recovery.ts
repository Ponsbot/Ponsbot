export const TOP_FIVE_SLIPPAGE_BPS = 500;
export const TOP_FIVE_GAS_RESERVE_UNITS = 6_000_000;
export const TOP_FIVE_BROADCAST_RETRIES = 6;

export function isTopFiveChild(requestId: string) {
  return /:buy_top_five:top-five:[1-5]:(?:buy|burn|funding:pair-funding)$/.test(requestId);
}

export function confirmedTopFivePurchase(context: {
  request: { status: string; transactionHash?: string };
  transaction?: { status: string; transactionHash: string; blockNumber?: string; tradeOutputDisplay?: string } | null;
} | null | undefined) {
  const tx = context?.transaction;
  if (context?.request.status !== "confirmed" || tx?.status !== "confirmed"
    || context.request.transactionHash !== tx.transactionHash) return null;
  return { transactionHash: tx.transactionHash, blockNumber: tx.blockNumber, tradeOutputDisplay: tx.tradeOutputDisplay };
}
