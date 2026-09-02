import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { mapLiquidityBounded } from "../lib/liquidity-concurrency";
import { canBackLiquidityDraft, liquidityDraftSchema, liquidityFieldsSchema, newLiquidityDraft } from "../lib/liquidity-workflow";
import type { LiquidityLeg } from "../lib/liquidity-contracts";
import type { LiquidityQuotePlan } from "../lib/liquidity-quote";
import type { LiquidityPositionStatus } from "../lib/liquidity-status";
import { mergeLiquidityClaimedFees, parseLiquidityClaimedFee, type LiquidityClaimedFee } from "../lib/liquidity-claimed-fees";
import { geckoSharedFetch } from "../lib/gecko-shared";
import { geckoLiquidityTotalSupplyMarketCap } from "../lib/market-index-policy";

type SignedStep = { received?: string[] };
type TerminalPositionResult = {
  id: string; status: "active" | "closed"; token: string; symbol: string; version: 3 | 4; poolId: string;
  pair?: "ETH" | "USDG"; shape?: "flat" | "bell" | "bid_ask"; feePercent?: number; bands?: number;
  lowerMarketCapUsd?: number; upperMarketCapUsd?: number; createdAt: number; updatedAt: number; nftIds: string[];
  feesClaimed: LiquidityClaimedFee[]; lastClaim?: { items: LiquidityClaimedFee[]; claimedAt: number }; live: LiquidityPositionStatus | null;
};

async function signer<T>(path: string, body: unknown, timeout = 120_000): Promise<T> {
  const base = process.env.WALLET_SIGNER_URL?.trim() || `${process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "")}/api/wallet-signer`;
  if (!base.startsWith("https://") || !process.env.WALLET_SIGNER_TOKEN) throw new Error("Signer not configured");
  const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${process.env.WALLET_SIGNER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`LP status failed (${response.status})`);
  return response.json() as Promise<T>;
}

function executionClaimedFees(positionId: string, executions: Array<{ status: string; planJson: string; stepsJson: string; updatedAt: number }>) {
  let totals: LiquidityClaimedFee[] = [];
  let lastClaim: { items: LiquidityClaimedFee[]; claimedAt: number } | undefined;
  for (const execution of executions) {
    if (execution.status !== "confirmed") continue;
    let plan: LiquidityQuotePlan;
    let steps: SignedStep[];
    try { plan = JSON.parse(execution.planJson) as LiquidityQuotePlan; steps = JSON.parse(execution.stepsJson) as SignedStep[]; }
    catch { continue; }
    for (let index = 0; index < steps.length; index++) {
      if (plan.calls[index]?.purpose !== "claim" || plan.claimPositions?.[index]?.positionId !== positionId) continue;
      const items = (steps[index]?.received ?? []).map(parseLiquidityClaimedFee).filter((fee): fee is LiquidityClaimedFee => Boolean(fee));
      totals = mergeLiquidityClaimedFees(totals, items);
      if (items.length && (!lastClaim || execution.updatedAt > lastClaim.claimedAt)) lastClaim = { items, claimedAt: execution.updatedAt };
    }
  }
  return { totals, lastClaim };
}

export const terminalPositions = action({
  args: { secret: v.string(), ownerXUserId: v.string(), sessionIdHash: v.string() },
  handler: async (ctx, args): Promise<{ positions: TerminalPositionResult[] }> => {
    if (!process.env.WEB_AUTH_SECRET || args.secret !== process.env.WEB_AUTH_SECRET) throw new Error("LP terminal authorization failed");
    const context: { wallet: Doc<"cryptoWallets">; positions: Doc<"liquidityManagedPositions">[]; executions: Doc<"liquidityExecutions">[] } = await ctx.runQuery(internal.liquidity.terminalPositionRecords, { ownerXUserId: args.ownerXUserId, sessionIdHash: args.sessionIdHash });
    const deadline = Date.now() + 35_000;
    const positions: TerminalPositionResult[] = await mapLiquidityBounded(context.positions, async position => {
      const fields = liquidityFieldsSchema.parse(JSON.parse(position.fieldsJson));
      let live: LiquidityPositionStatus | undefined;
      if (position.status === "active" && Date.now() < deadline) {
        try {
          const draft = newLiquidityDraft("status", fields);
          draft.tokenAddress = position.token; draft.symbol = position.symbol;
          live = await signer<LiquidityPositionStatus>("/v1/liquidity/status", {
            ownerXUserId: args.ownerXUserId, source: "terminal", walletRef: context.wallet.signerWalletRef,
            expectedFrom: context.wallet.address, draft, legs: JSON.parse(position.legsJson),
          }, Math.max(1, Math.min(15_000, deadline - Date.now())));
        } catch { live = undefined; }
        if (live) {
          try {
            await ctx.runMutation(internal.liquidity.cacheTerminalPositionStatus, {
              ownerXUserId: args.ownerXUserId, positionId: position.publicId,
              liveStatusJson: JSON.stringify(live), observedAt: Date.now(),
            });
          } catch {
            // A cache write must never hide a fresh signer result from this request.
          }
        }
      }
      if (position.status === "active" && !live && position.liveStatusJson) {
        try { live = JSON.parse(position.liveStatusJson) as LiquidityPositionStatus; }
        catch { live = undefined; }
      }
      const historical = executionClaimedFees(position.publicId, context.executions);
      let persisted: LiquidityClaimedFee[] = [], persistedLast: { items: LiquidityClaimedFee[]; claimedAt: number } | undefined;
      try { if (position.feesClaimedJson) persisted = JSON.parse(position.feesClaimedJson) as LiquidityClaimedFee[]; } catch { persisted = []; }
      try { if (position.lastClaimedJson && position.lastClaimedAt) persistedLast = { items: JSON.parse(position.lastClaimedJson) as LiquidityClaimedFee[], claimedAt: position.lastClaimedAt }; } catch { persistedLast = undefined; }
      return {
        id: position.publicId, status: position.status, token: position.token, symbol: position.symbol,
        version: position.version, poolId: position.poolId, pair: fields.pair, shape: fields.shape,
        feePercent: fields.feePips === undefined ? undefined : fields.feePips / 10_000, bands: fields.bands,
        lowerMarketCapUsd: fields.lowerMarketCapUsd, upperMarketCapUsd: fields.upperMarketCapUsd,
        createdAt: position.createdAt, updatedAt: position.updatedAt,
        nftIds: (JSON.parse(position.legsJson) as LiquidityLeg[]).map(leg => leg.tokenId),
        feesClaimed: persisted.length ? persisted : historical.totals,
        lastClaim: persistedLast ?? historical.lastClaim, live: live ?? null,
      };
    }, 4);
    return { positions };
  },
});

export const terminalWorkflowState = action({
  args: { secret: v.string(), ownerXUserId: v.string(), sessionIdHash: v.string(), sessionId: v.string() },
  handler: async (ctx, args): Promise<{ active: boolean; workflowId?: string; phase?: string; canGoBack: boolean; revision?: number; currentMarketCapUsd?: number }> => {
    if (!process.env.WEB_AUTH_SECRET || args.secret !== process.env.WEB_AUTH_SECRET) throw new Error("LP terminal authorization failed");
    const record: { stateJson: string; revision: number; publicId: string } | null = await ctx.runQuery(internal.liquidity.terminalWorkflowRecord, {
      ownerXUserId: args.ownerXUserId, sessionIdHash: args.sessionIdHash, sessionId: args.sessionId,
    });
    if (!record) return { active: false, canGoBack: false };
    const draft = liquidityDraftSchema.parse(JSON.parse(record.stateJson));
    let currentMarketCapUsd = draft.currentMarketCapUsd;
    if ((draft.phase === "range" || draft.diagnosticCode?.includes("LP_SELECTED_POOL_RANGE_OUTSIDE_CURRENT_MCAP")) && draft.tokenAddress) {
      const startedAt = Date.now();
      try {
        const response = await geckoSharedFetch(
          `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${draft.tokenAddress}`,
          60_000, 8_000, true, false, startedAt, "interactive",
        );
        if (response.ok) {
          const payload = await response.json() as { data?: { attributes?: {
            price_usd?: string | null; normalized_total_supply?: string | null;
            market_cap_usd?: string | null; fdv_usd?: string | null;
          } } };
          const attributes = payload.data?.attributes;
          const live = geckoLiquidityTotalSupplyMarketCap(
            attributes?.price_usd, attributes?.normalized_total_supply,
            attributes?.market_cap_usd, attributes?.fdv_usd,
          );
          if (live !== undefined) currentMarketCapUsd = live;
        }
      } catch { /* Retain the workflow's last validated MCap if Gecko is unavailable. */ }
    }
    return {
      active: true,
      workflowId: record.publicId,
      phase: draft.phase,
      canGoBack: canBackLiquidityDraft(draft),
      revision: record.revision,
      ...(currentMarketCapUsd ? { currentMarketCapUsd } : {}),
    };
  },
});
