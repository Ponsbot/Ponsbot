import type { HolderTag } from "./holder-tags";

export const ACTIVITY_REFRESH_MS = 60_000;
export const ACTIVITY_LEASE_MS = 50_000;
export const ACTIVITY_HISTORY_MS = 86_400_000;
export const RECENT_ACTIVITY_MS = 300_000;
export const HOLDER_BASELINE_MS = 600_000;
export function activityHeadFresh(timestamp: bigint, now = Date.now()) {
  const age = now - Number(timestamp) * 1000;
  return Number.isFinite(age) && age >= -30_000 && age <= 120_000;
}
export type ActivityKind = "trades" | "holders";
export type PageTrade = {
  id: string; transactionHash: string; logIndex?: number; pool?: string;
  kind: "buy" | "sell"; walletAddress: string; tokenAmount: string;
  marketCapUsd?: number; usdAmount?: number; timestamp: number;
  source: "gecko" | "rpc" | "index";
};
export type PageHolder = { address: string; amount: string; percentage?: number; tag?: HolderTag };
export type ActivityPayload = { trades?: PageTrade[]; holders?: PageHolder[]; partial?: boolean };

export function activityDue(observedAt: number | undefined, retryAt: number, leaseUntil: number, now: number) {
  return leaseUntil <= now && retryAt <= now && (!observedAt || now - observedAt >= ACTIVITY_REFRESH_MS);
}
export function activityNextRefreshDelay(observedAt: number | undefined, now = Date.now()) {
  // Schedule from completion, rather than skipping an entire interval when a job took a few seconds.
  return observedAt && observedAt + ACTIVITY_REFRESH_MS > now ? observedAt + ACTIVITY_REFRESH_MS - now + 250 : ACTIVITY_REFRESH_MS;
}
export function activityCacheOnly(automaticAllowed: boolean, explicitFirstLoad: boolean, visible: boolean) {
  return !visible || (!automaticAllowed && !explicitFirstLoad);
}
export function positiveNumber(value: unknown) {
  if ((typeof value !== "string" && typeof value !== "number") || value === "") return undefined;
  const n = Number(value); return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Keep exact event identities. Approximate cross-provider matching must be unique on both sides. */
export function mergePageTrades(groups: PageTrade[][], now = Date.now()) {
  const exact = new Map<string, PageTrade>();
  for (const trade of groups.flat()) {
    if (!Number.isFinite(trade.timestamp) || trade.timestamp < now - ACTIVITY_HISTORY_MS || trade.timestamp > now + 30_000) continue;
    const key = trade.logIndex === undefined ? `${trade.source}:${trade.id}` : `${trade.transactionHash.toLowerCase()}:${trade.logIndex}`;
    const old = exact.get(key);
    exact.set(key, { ...old, ...trade, usdAmount: trade.usdAmount ?? old?.usdAmount, marketCapUsd: trade.marketCapUsd ?? old?.marketCapUsd });
  }
  const rows = [...exact.values()];
  const matches = (a: PageTrade, b: PageTrade) => a.source !== b.source
    && (a.logIndex === undefined || b.logIndex === undefined)
    && a.transactionHash.toLowerCase() === b.transactionHash.toLowerCase() && a.kind === b.kind
    && Math.abs(Number(a.tokenAmount) - Number(b.tokenAmount)) <= Math.max(Number(a.tokenAmount), Number(b.tokenAmount)) * 1e-7;
  const used = new Set<PageTrade>(); const result: PageTrade[] = [];
  for (const row of rows) {
    if (used.has(row)) continue;
    const candidates = rows.filter(other => other !== row && !used.has(other) && matches(row, other));
    const match = candidates.length === 1 && rows.filter(other => other !== candidates[0] && matches(candidates[0], other)).length === 1 ? candidates[0] : undefined;
    used.add(row);
    if (match) {
      used.add(match);
      const chain = row.logIndex !== undefined ? row : match;
      const gecko = row.source === "gecko" ? row : match.source === "gecko" ? match : undefined;
      result.push({ ...chain, usdAmount: gecko?.usdAmount ?? row.usdAmount ?? match.usdAmount,
        marketCapUsd: gecko?.marketCapUsd ?? row.marketCapUsd ?? match.marketCapUsd });
    } else result.push(row);
  }
  return result.sort((a, b) => b.timestamp - a.timestamp || (b.logIndex ?? 0) - (a.logIndex ?? 0)).slice(0, 100);
}

/** Head sampling adapts to Robinhood block time; bounded even if timestamps are anomalous. */
export function recentFromBlock(head: bigint, headTime: bigint, sample: bigint, sampleTime: bigint) {
  const elapsed = Number(headTime - sampleTime);
  const blocks = elapsed > 0 ? Math.ceil(300 * Number(head - sample) / elapsed) + 32 : 3_200;
  const span = BigInt(Math.max(32, Math.min(10_000, blocks)));
  return head > span ? head - span : 0n;
}

export function transferDeltas(logs: Array<{ args: { from?: string; to?: string; value?: bigint } }>) {
  const deltas = new Map<string, bigint>();
  for (const { args } of logs) {
    if (!args.from || !args.to || args.value === undefined) throw new Error("incomplete transfer event");
    for (const [address, value] of [[args.from, -args.value], [args.to, args.value]] as const) {
      const key = address.toLowerCase();
      if (/^0x0{40}$/.test(key)) continue;
      deltas.set(key, (deltas.get(key) ?? 0n) + value);
    }
  }
  return [...deltas].filter(([, value]) => value !== 0n).map(([address, value]) => ({ address, delta: value.toString() }));
}
