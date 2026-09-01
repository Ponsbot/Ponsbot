import type { LiquidityLeg, LiquidityTransaction } from "./liquidity-contracts";
import { z } from "zod";
import { liquidityFieldsSchema } from "./liquidity-workflow";

export const liquidityClaimPositionSchema = z.object({
  positionId: z.string().regex(/^LP-[A-F0-9]{8}$/), token: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  symbol: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/), version: z.union([z.literal(3), z.literal(4)]),
  poolId: z.string().regex(/^0x(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/), fields: liquidityFieldsSchema,
  legs: z.array(z.object({ tokenId: z.string().regex(/^[1-9]\d*$/), liquidity: z.string().regex(/^\d+$/), tickLower: z.number().int(), tickUpper: z.number().int() }).strict()).min(1).max(100),
}).strict();
export type LiquidityClaimPosition = z.infer<typeof liquidityClaimPositionSchema>;
export const liquidityMarketCapRangeSchema = z.object({
  lowerUsd: z.number().finite().positive(), upperUsd: z.number().finite().positive(),
  referenceUsd: z.number().finite().positive(), roundedLowerUsd: z.number().finite().positive(), roundedUpperUsd: z.number().finite().positive(),
  tickLower: z.number().int().min(-887272).max(887272), tickUpper: z.number().int().min(-887272).max(887272),
}).strict().refine(r => r.lowerUsd < r.referenceUsd && r.referenceUsd < r.upperUsd && r.tickLower < r.tickUpper
  && r.roundedLowerUsd <= r.lowerUsd * (1 + 1e-10) && r.roundedUpperUsd >= r.upperUsd * (1 - 1e-10));

// Shared wire type only. Keep signer/Next.js implementation dependencies out of
// Convex's separate TypeScript project, including through type-only imports.
export type LiquidityQuotePlan = {
  owner: string; token: string; symbol: string; version: 3 | 4; poolId: string; operation: string;
  quoteId: string; expiresAt: number; executionDeadline: number; calls: LiquidityTransaction[]; summary: string[];
  // Opening metadata is signed with the quote and lets the signer safely
  // rebuild only the final, price-sensitive Delta call after prerequisite
  // funding/approvals confirm. It never authorizes a larger position.
  requestedBudgetUsd?: number;
  minimumFillBps?: number;
  slippageBps?: number;
  bandWeights?: number[];
  expectedDepositUsd?: number;
  expectedFillBps?: number;
  partialReprice?: boolean;
  // Signed by the private signer. Convex can replay exactly this approved plan,
  // but cannot turn a chat field into arbitrary signer calldata.
  proof: string; priorLegs: LiquidityLeg[];
  claimPositions?: LiquidityClaimPosition[];
  marketCapRange?: z.infer<typeof liquidityMarketCapRangeSchema>;
};
