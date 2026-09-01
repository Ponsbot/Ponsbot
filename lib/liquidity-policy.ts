/**
 * Legacy schema deployment pins. The active liquidity workflow uses the
 * separately verified runtime configuration; these constants remain so the
 * historical Convex tables can continue to decode safely.
 */
export const LIQUIDITY_DEPLOYMENT = Object.freeze({
  chainId: 4663,
  protocol: "uniswap_v3",
  factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  positionManager: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
  ladderBuilder: "0x6235cf6bd8419b34942f4eddb39c880bd96dd700",
  weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
} as const);

export const LIQUIDITY_FEE_TICK_SPACING = Object.freeze({
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
} as const);

export { LIQUIDITY_MAX_BANDS } from "./liquidity-limits";
export const LIQUIDITY_MIN_TICK = -887272;
export const LIQUIDITY_MAX_TICK = 887272;
export type LiquidityFeeTier = keyof typeof LIQUIDITY_FEE_TICK_SPACING;
export type LiquidityShape = "flat" | "bell" | "bid_ask";

export function liquidityCapabilities(environment: { LIQUIDITY_ENABLED?: string } = {}) {
  return {
    requested: environment.LIQUIDITY_ENABLED?.trim().toLowerCase() === "true",
    enabled: false as const,
    executionAvailable: false as const,
    commandsAvailable: false as const,
    automaticManagementAvailable: false as const,
    reason: "legacy_schema_only" as const,
  };
}

export function requireLiquidityExecution(): never {
  throw new Error("Legacy liquidity execution is unavailable.");
}
