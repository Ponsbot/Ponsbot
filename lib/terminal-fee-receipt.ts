/** Display-only receipts: never submitted as wallet commands or X replies. */
export type TerminalFeeReceipt = {
  id: string;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenPageAvailable: boolean;
  assetAddress: string;
  assetSymbol?: string;
  amount?: string;
  rawAmount: string;
  transactionHash: string;
  createdAt: number;
  updatedAt: number;
};

export function mergeTerminalFeeReceipts(current: TerminalFeeReceipt[], incoming: TerminalFeeReceipt[]) {
  const receipts = new Map(current.map(receipt => [receipt.id, receipt]));
  for (const receipt of incoming) {
    const existing = receipts.get(receipt.id);
    if (!existing || receipt.updatedAt >= existing.updatedAt) receipts.set(receipt.id, receipt);
  }
  return [...receipts.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
}

export function formatCreatorFeeAmount(receipt: TerminalFeeReceipt) {
  // Never guess an ERC-20's decimals if its metadata is unavailable.
  if (receipt.amount === undefined) return `${receipt.rawAmount} base units`;
  const number = Number(receipt.amount);
  const amount = Number.isFinite(number) && number > 0
    ? new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6, notation: number >= 1_000_000 ? "compact" : "standard" }).format(number)
    : receipt.amount;
  return `${amount}${receipt.assetSymbol ? ` ${receipt.assetSymbol}` : ""}`;
}
