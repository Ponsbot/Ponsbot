import { zeroAddress, type Address } from "viem";

const CBBTC = "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4";
const TSM = "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA";
const RBLX = "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8";

export type IndexedV4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

/**
 * Canonical hookless V4 pools for indexed assets that can be traded directly
 * against Robinhood Chain's native ETH. Values come from the PoolManager's
 * Initialize event, not from mutable off-chain market metadata.
 */
export function indexedNativeV4Pools(token: Address): IndexedV4PoolKey[] {
  if (token.toLowerCase() === TSM.toLowerCase()) {
    return [{ currency0: zeroAddress, currency1: TSM, fee: 100_000, tickSpacing: 200, hooks: zeroAddress }];
  }
  if (token.toLowerCase() === RBLX.toLowerCase()) {
    return [{ currency0: zeroAddress, currency1: RBLX, fee: 920_090, tickSpacing: 200, hooks: zeroAddress }];
  }
  if (token.toLowerCase() !== CBBTC.toLowerCase()) return [];
  return [
    // Current primary cbBTC/WETH pool. Keep alternate initialized pools as
    // fallbacks because liquidity can migrate without the token address changing.
    { currency0: zeroAddress, currency1: CBBTC, fee: 2_500, tickSpacing: 25, hooks: zeroAddress },
    { currency0: zeroAddress, currency1: CBBTC, fee: 375, tickSpacing: 4, hooks: zeroAddress },
  ];
}
