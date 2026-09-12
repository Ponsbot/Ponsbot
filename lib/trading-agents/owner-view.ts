export type OwnedBot = {
  id: string;
  name: string;
  walletAddress?: string;
  mode: "paper" | "live";
  cashWei: string;
  holdings: Array<{ token: string; amount: string }>;
  live?: { cashWei: string; tokens: Array<{ address: string; symbol: string; balance: string; decimals: number; priceUsd?: number }>; observedAt: number; complete: boolean };
  transactions?: Array<{ id: string; requestKey: string; state: "active" | "confirmed" | "failed"; kind: string; hashes: string[]; error?: string }>;
};
export type OwnedBotsResponse = {
  bots: OwnedBot[];
  destination: string;
  executionEnabled: boolean;
  csrfToken?: string;
};
