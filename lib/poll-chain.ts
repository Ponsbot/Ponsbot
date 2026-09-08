import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createPublicClient, http, parseAbi, type Address, zeroAddress } from 'viem';
import { geckoSharedFetch } from './gecko-shared';
import { PollPreparationError } from './poll-diagnostics';
import { DEFAULT_PONS_V2_FACTORY } from './pons-runtime-defaults';
import { PONS_V2_LAUNCH_LOCKER } from './holder-tags';
import { pollTokenIdentity } from './polls';
export const pollTokenAbi = parseAbi(['function symbol() view returns(string)', 'function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)', 'function balanceOf(address) view returns(uint256)']);
const factoryAbi = parseAbi(['function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))', 'function poolManager() view returns(address)']);
const rightsAbi = parseAbi(['function token() view returns(address)', 'function controller() view returns(address)', 'function owner() view returns(address)']);
const v3PoolAbi = parseAbi(['function token0() view returns(address)', 'function token1() view returns(address)', 'function fee() view returns(uint24)']);
const v3FactoryAbi = parseAbi(['function getPool(address token0,address token1,uint24 fee) view returns(address)']);
const v3Factory = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as Address;
export type PollAnchor = { block: string; blockHash: string; timestamp: number };
export type PollRightsHints = { vault?: string; layer?: string };
export function pollRpc() {
  if (!process.env.ROBINHOOD_RPC_URL) throw new Error('Historical RPC is not configured');
  return createPublicClient({ transport: http(process.env.ROBINHOOD_RPC_URL, { timeout: 12000, retryCount: 1 }) });
}
export async function pollAnchor(): Promise<PollAnchor> {
  const rpc = pollRpc();
  if (await rpc.getChainId() !== 4663) throw new Error('Wrong snapshot chain');
  const tip = await rpc.getBlockNumber();
  const b = await rpc.getBlock({ blockNumber: tip > 20n ? tip - 20n : tip });
  if (!b.hash) throw new Error('Snapshot block unavailable');
  return { block: b.number.toString(), blockHash: b.hash, timestamp: Number(b.timestamp) * 1000 };
}
export async function assertPollBlock(a: PollAnchor) {
  const b = await pollRpc().getBlock({ blockNumber: BigInt(a.block) });
  if (b.hash?.toLowerCase() !== a.blockHash.toLowerCase()) throw new Error('Snapshot block changed; voting is unavailable');
}
export async function pollMetadata(address: string, suppliedToken: string, a: PollAnchor) {
  const rpc = pollRpc(), blockNumber = BigInt(a.block), token = address as Address;
  const [symbol, decimals, supply] = await Promise.all([
    rpc.readContract({ address: token, abi: pollTokenAbi, functionName: 'symbol', blockNumber }),
    rpc.readContract({ address: token, abi: pollTokenAbi, functionName: 'decimals', blockNumber }),
    rpc.readContract({ address: token, abi: pollTokenAbi, functionName: 'totalSupply', blockNumber }),
  ]);
  const expected = pollTokenIdentity(suppliedToken).ticker;
  if (expected && expected.normalize('NFKC').toLowerCase() !== symbol.normalize('NFKC').toLowerCase()) throw new Error('TOKEN_MISMATCH');
  if (!symbol || symbol.length > 64 || /[\s\u0000-\u001f]/.test(symbol) || decimals > 36 || supply <= 0n) throw new Error('Unsupported token metadata');
  return { symbol, decimals, supply };
}
export async function pollOfficial(token: string, wallet: string, hints: PollRightsHints, a: PollAnchor) {
  const rpc = pollRpc(), blockNumber = BigInt(a.block);
  const p = await rpc.readContract({ address: (process.env.PONS_V2_FACTORY_ADDRESS || DEFAULT_PONS_V2_FACTORY) as Address, abi: factoryAbi, functionName: 'getLaunchedToken', args: [token as Address], blockNumber });
  const actor = wallet.toLowerCase();
  if (actor === zeroAddress) return false;
  if (!p.exists) {
    // Non-Pons tokens may expose a verifiable Ownable controller. No registry
    // listing or token balance is accepted as ownership evidence.
    try {
      const owner = await rpc.readContract({ address: token as Address, abi: rightsAbi, functionName: 'owner', blockNumber });
      return owner.toLowerCase() !== zeroAddress && owner.toLowerCase() === actor;
    } catch (error) {
      const cause = error instanceof BaseError ? error.walk(e => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) : error;
      if (cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError) return false;
      throw error; // Provider failures are not evidence of missing ownership.
    }
  }
  if (p.token.toLowerCase() !== token.toLowerCase()) return false;
  if (p.deployer.toLowerCase() === actor || p.creatorFeeRecipient.toLowerCase() === actor) return true;
  if (!hints.vault || p.creatorFeeRecipient.toLowerCase() !== hints.vault.toLowerCase()) return false;
  const vault = hints.vault as Address;
  const [vaultToken, controller] = await Promise.all([
    rpc.readContract({ address: vault, abi: rightsAbi, functionName: 'token', blockNumber }),
    rpc.readContract({ address: vault, abi: rightsAbi, functionName: 'controller', blockNumber }),
  ]);
  if (vaultToken.toLowerCase() !== token.toLowerCase()) return false;
  if (controller.toLowerCase() === actor) return true;
  if (!hints.layer || controller.toLowerCase() !== hints.layer.toLowerCase()) return false;
  const layer = hints.layer as Address;
  const [layerToken, owner] = await Promise.all([
    rpc.readContract({ address: layer, abi: rightsAbi, functionName: 'token', blockNumber }),
    rpc.readContract({ address: layer, abi: rightsAbi, functionName: 'owner', blockNumber }),
  ]);
  return layerToken.toLowerCase() === token.toLowerCase() && owner.toLowerCase() === actor;
}
export async function buildPollSnapshot(token: string, suppliedToken: string, a: PollAnchor) {
  const rpc = pollRpc(), blockNumber = BigInt(a.block), address = token as Address;
  const meta = await pollMetadata(token, suppliedToken, a).catch(error => {
    if (error instanceof Error && error.message === 'TOKEN_MISMATCH') throw error;
    throw new PollPreparationError('metadata', error);
  });
  const f = (process.env.PONS_V2_FACTORY_ADDRESS || DEFAULT_PONS_V2_FACTORY) as Address;
  const [launch, poolManager] = await Promise.all([
    rpc.readContract({ address: f, abi: factoryAbi, functionName: 'getLaunchedToken', args: [address], blockNumber }),
    rpc.readContract({ address: f, abi: factoryAbi, functionName: 'poolManager', blockNumber }),
  ]);
  const excluded = new Map<string, string>([
    ['0x000000000000000000000000000000000000dead', 'Burn address'],
    [PONS_V2_LAUNCH_LOCKER.toLowerCase(), 'Pons launch locker'],
    ['0x8366a39cc670b4001a1121b8f6a443a643e40951', 'Uniswap V4 PoolManager'],
    [poolManager.toLowerCase(), 'Pons PoolManager'],
  ]);
  if (launch.exists && launch.curve !== zeroAddress) excluded.set(launch.curve.toLowerCase(), 'Pons bonding curve');
  // Curve inventory is directly known. Graduated/external tokens use one
  // bounded discovery request, never a scan of trading/pool event history.
  if (!launch.exists || launch.phase !== 0) {
    try {
      const main = await mainPollV3Pool(token, a);
      if (main) excluded.set(main, 'Main discovered Uniswap V3 pool');
    } catch (error) { throw new PollPreparationError('main-pool', error); }
  }
  excluded.delete(zeroAddress);
  const exclusions: Array<{ address: string; balance: string; label: string }> = [];
  for (const [wallet, label] of excluded) {
    const balance = await rpc.readContract({ address, abi: pollTokenAbi, functionName: 'balanceOf', args: [wallet as Address], blockNumber })
      .catch(error => { throw new PollPreparationError('exclusion-balances', error); });
    exclusions.push({ address: wallet, label, balance: balance.toString() });
  }
  const active = meta.supply - exclusions.reduce((s, x) => s + BigInt(x.balance), 0n);
  if (active <= 0n) throw new Error('No active voting supply');
  await assertPollBlock(a);
  return { ...a, symbol: meta.symbol, decimals: meta.decimals, supply: meta.supply.toString(), activeSupply: active.toString(), exclusions,
    policy: 'Direct holdings at a fixed block. Excludes the burn address, Pons launch locker/curve, supported V4 PoolManager inventories, and the main verified V3 pool found by bounded market discovery. Secondary V3 pools and other protocols may remain in active supply; LP beneficial ownership is not attributed. Snapshot uses 20-block confirmation depth.' };
}
export async function mainPollV3Pool(token: string, a: PollAnchor): Promise<string | null> {
  const response = await geckoSharedFetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${token.toLowerCase()}/pools?page=1`, 300000, 8000, true, false, undefined, 'interactive');
  if (!response.ok) throw new Error(`Pool discovery provider status ${response.status}`);
  const payload = await response.json() as { data?: Array<{ attributes?: { address?: string; reserve_in_usd?: string } }> };
  if (!Array.isArray(payload.data)) throw new Error('Invalid pool discovery response');
  const candidates = payload.data.slice(0, 20).filter(p => /^0x[0-9a-f]{40}$/i.test(p.attributes?.address ?? ''))
    .sort((a, b) => (Number(b.attributes?.reserve_in_usd) || 0) - (Number(a.attributes?.reserve_in_usd) || 0)).slice(0, 3);
  const rpc = pollRpc(), blockNumber = BigInt(a.block);
  for (const p of candidates) {
    const address = p.attributes!.address! as Address;
    try {
      const [token0, token1, fee] = await Promise.all([
        rpc.readContract({ address, abi: v3PoolAbi, functionName: 'token0', blockNumber }),
        rpc.readContract({ address, abi: v3PoolAbi, functionName: 'token1', blockNumber }),
        rpc.readContract({ address, abi: v3PoolAbi, functionName: 'fee', blockNumber }),
      ]);
      if (![token0.toLowerCase(), token1.toLowerCase()].includes(token.toLowerCase())) continue;
      const canonical = await rpc.readContract({ address: v3Factory, abi: v3FactoryAbi, functionName: 'getPool', args: [token0, token1, fee], blockNumber });
      if (canonical.toLowerCase() === address.toLowerCase()) return address.toLowerCase();
    } catch (error) {
      const cause = error instanceof BaseError ? error.walk(e => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) : error;
      if (!(cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError)) throw error;
    }
  }
  return null;
}
export async function pollVotingBalance(token: string, wallet: string, a: PollAnchor) {
  await assertPollBlock(a);
  const balance = await pollRpc().readContract({ address: token as Address, abi: pollTokenAbi, functionName: 'balanceOf', args: [wallet as Address], blockNumber: BigInt(a.block) });
  return balance.toString();
}
