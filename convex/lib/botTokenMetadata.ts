import type { QueryCtx } from "../_generated/server";

/** Display only. Does not expand the trading universe or grant authorization. */
export async function botTokenMetadata(ctx: Pick<QueryCtx, "db">, address: string) {
  const normalized = address.toLowerCase();
  const registered = await ctx.db.query("tokenRegistry").withIndex("by_normalized_address", q => q.eq("normalizedAddress", normalized)).first();
  if (registered) return { symbol: registered.symbol, decimals: registered.decimals };
  const launch = await ctx.db.query("tokenLaunches").withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", normalized)).first();
  // Pons launch tokens use 18 decimals, matching registry.ensureInitialized.
  if (launch?.tokenAddress?.toLowerCase() === normalized && launch.symbol) return { symbol: launch.symbol, decimals: 18 };
  return null;
}
