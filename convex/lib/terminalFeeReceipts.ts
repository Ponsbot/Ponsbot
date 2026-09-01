import { formatUnits, getAddress, zeroAddress } from "viem";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import type { TerminalFeeReceipt } from "../../lib/terminal-fee-receipt";
import { isTokenIndexExcluded } from "../../lib/token-index-exclusions";

/** Read receipts, not current program ownership: reassignment must not move history. */
export async function terminalFeeReceipts(ctx: QueryCtx, ownerXUserId: string, updatedAfter?: number) {
  const wallet = await ctx.db.query("cryptoWallets")
    .withIndex("by_owner_x_user_id", q => q.eq("ownerXUserId", ownerXUserId)).unique();
  const after = updatedAfter !== undefined && Number.isSafeInteger(updatedAfter) && updatedAfter > 0 ? updatedAfter : undefined;
  const empty = { receipts: [] as TerminalFeeReceipt[], updatedThrough: after ?? 0, delta: after !== undefined };
  if (!wallet || wallet.chainId !== 4663 || !/^0x[0-9a-f]{40}$/i.test(wallet.address)) return empty;
  const beneficiary = wallet.address.toLowerCase();
  // Existing records use either normalized or EIP-55 addresses. Index both,
  // plus the stored wallet spelling, without scanning other users' runs.
  const spellings = [...new Set([beneficiary, getAddress(beneficiary), wallet.address])];
  const batches = await Promise.all(spellings.map(address => ctx.db.query("automatedFeeRuns")
    .withIndex("by_beneficiary_status_updated", q => {
      const byRecipient = q.eq("beneficiaryAddress", address).eq("status", "confirmed");
      // Inclusive boundary allows receipts finalized within the same millisecond.
      return after === undefined ? byRecipient : byRecipient.gte("updatedAt", after);
    }).order(after === undefined ? "desc" : "asc").take(40)));
  const rows = [...new Map(batches.flat().map(run => [run._id, run])).values()]
    .sort((a, b) => after === undefined ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt).slice(0, 40);
  const programs = new Map<string, Doc<"automatedFeePrograms"> | null>();
  const launches = new Map<string, Doc<"tokenLaunches"> | null>();
  const assets = new Map<string, Doc<"tokenRegistry"> | null>();
  const receipts = new Map<string, TerminalFeeReceipt>();
  for (const run of rows) {
    if (run.beneficiaryAddress.toLowerCase() !== beneficiary || !run.deliveryBlockNumber || !/^\d+$/.test(run.deliveryBlockNumber)
      || !run.processingBlockNumber || !run.beneficiaryDelivered || !/^\d+$/.test(run.beneficiaryDelivered)
      || BigInt(run.beneficiaryDelivered) <= 0n || run.beneficiaryDelivered !== run.beneficiaryAllocated
      || !/^0x[0-9a-f]{64}$/i.test(run.deliveryTransactionHash ?? "")) continue;
    if (!programs.has(run.programId)) programs.set(run.programId, await ctx.db.get(run.programId));
    const program = programs.get(run.programId);
    if (!program || program.privateTest) continue;
    const token = run.tokenAddress.toLowerCase(), asset = run.pairTokenAddress.toLowerCase();
    if (!launches.has(token)) launches.set(token, await ctx.db.query("tokenLaunches")
      .withIndex("by_normalized_token_address", q => q.eq("normalizedTokenAddress", token)).unique());
    const launch = launches.get(token);
    if (asset !== zeroAddress && !assets.has(asset)) assets.set(asset, await ctx.db.query("tokenRegistry")
      .withIndex("by_normalized_address", q => q.eq("normalizedAddress", asset)).unique());
    const metadata = assets.get(asset);
    const decimals = asset === zeroAddress ? 18 : metadata?.decimals;
    const validDecimals = decimals !== undefined && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255;
    const hash = run.deliveryTransactionHash!.toLowerCase();
    const id = `creator-fees:${hash}:${run.vaultAddress.toLowerCase()}:${beneficiary}:${asset}`;
    receipts.set(id, {
      id, tokenAddress: token, tokenSymbol: launch?.symbol,
      tokenPageAvailable: launch?.publicPublished === true && !isTokenIndexExcluded(token),
      assetAddress: asset, assetSymbol: asset === zeroAddress ? "ETH" : metadata?.symbol,
      amount: validDecimals ? formatUnits(BigInt(run.beneficiaryDelivered), decimals) : undefined,
      rawAmount: run.beneficiaryDelivered, transactionHash: hash,
      // Existing finalized runs record completion time in updatedAt. Never
      // present the earlier reservation/claim time as the receipt time.
      createdAt: run.updatedAt, updatedAt: run.updatedAt,
    });
  }
  return {
    receipts: [...receipts.values()].sort((a, b) => b.createdAt - a.createdAt),
    updatedThrough: Math.max(after ?? 0, ...rows.map(run => run.updatedAt)), delta: after !== undefined,
  };
}
