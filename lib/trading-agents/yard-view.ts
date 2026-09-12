import type { BotSprite } from "./sprite";

export type BotYardLog = {
  id: string; at: number; kind: "thought" | "trade"; outcome: "thought" | "paper_filled" | "live_filled" | "executing" | "held" | "failed";
  transactionHashes?: string[];
  summary: string; token?: string; amountIn?: string; amountOut?: string; side?: "buy" | "sell";
};
export type BotYardBot = {
  id: string; name: string; description: string; sprite: BotSprite;
  status: "draft" | "running" | "paused"; mode: "paper" | "live";
  nextThoughtAt?: number; nextTradeAt?: number;
  walletAddress?: string;
  creatorUsername?: string;
  paperHoldings?: { cashWei: string; tokens: Array<{ token: string; amount: string }>; updatedAt: number };
  liveHoldings?: { cashWei: string; tokens: Array<{ token: string; amount: string }>; observedAt: number; complete: boolean };
  logs: BotYardLog[];
};
export function botWalletLinks(address: string | undefined) {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) return null;
  const normalized = address.toLowerCase();
  return { wallet: `/bot-yard/wallet/${normalized}`, transactions: `https://robinhoodchain.blockscout.com/address/${normalized}?tab=txs` };
}
