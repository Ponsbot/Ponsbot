import { createPublicClient, http, parseAbi, parseAbiItem, type Address, zeroAddress } from 'viem';
import { DEFAULT_PONS_V2_FACTORY } from './pons-runtime-defaults';
import { PONS_V2_LAUNCH_LOCKER } from './holder-tags';
import { pollTokenIdentity } from './polls';
export const pollTokenAbi = parseAbi(['function symbol() view returns(string)', 'function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)', 'function balanceOf(address) view returns(uint256)']);
const factoryAbi = parseAbi(['function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))', 'function poolManager() view returns(address)']);
const rightsAbi = parseAbi(['function token() view returns(address)', 'function controller() view returns(address)', 'function owner() view returns(address)']);
const poolCreated = parseAbiItem('event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)');
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
  if (!p.exists || p.token.toLowerCase() !== token.toLowerCase()) return false;
  const actor = wallet.toLowerCase();
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
  const meta = await pollMetadata(token, suppliedToken, a);
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
  // Enumerate every pool for this token in the supported V3 factory, not a
  // market-data provider's top-N ranking. V4 pools share a holding address.
  for (const side of ['token0', 'token1'] as const) {
    let from = 0n, span = 2_000_000n, reads = 0;
    while (from <= blockNumber) {
      if (++reads > 200) throw new Error('Pool discovery budget reached');
      const to = from + span - 1n < blockNumber ? from + span - 1n : blockNumber;
      try {
        const logs = await rpc.getLogs({ address: v3Factory, event: poolCreated, args: { [side]: address }, fromBlock: from, toBlock: to, strict: true });
        if (logs.length >= 1000) throw new Error('Pool response truncated');
        for (const l of logs) excluded.set(l.args.pool.toLowerCase(), 'Uniswap V3 pool');
        if (excluded.size > 200) throw new Error('Too many pools for a bounded snapshot');
        from = to + 1n;
      } catch (error) { if (span <= 5000n) throw error; span /= 2n; }
    }
  }
  excluded.delete(zeroAddress);
  const exclusions: Array<{ address: string; balance: string; label: string }> = [];
  for (const [wallet, label] of excluded) {
    const balance = await rpc.readContract({ address, abi: pollTokenAbi, functionName: 'balanceOf', args: [wallet as Address], blockNumber });
    exclusions.push({ address: wallet, label, balance: balance.toString() });
  }
  const active = meta.supply - exclusions.reduce((s, x) => s + BigInt(x.balance), 0n);
  if (active <= 0n) throw new Error('No active voting supply');
  await assertPollBlock(a);
  return { ...a, symbol: meta.symbol, decimals: meta.decimals, supply: meta.supply.toString(), activeSupply: active.toString(), exclusions,
    policy: 'Direct holdings. Excludes the recorded burn address, Pons launch locker/curve, and supported Uniswap V3/V4 pool inventories. Other protocols and LP beneficial ownership are not attributed. Snapshot uses 20-block confirmation depth.' };
}
export async function pollVotingBalance(token: string, wallet: string, a: PollAnchor) {
  await assertPollBlock(a);
  const balance = await pollRpc().readContract({ address: token as Address, abi: pollTokenAbi, functionName: 'balanceOf', args: [wallet as Address], blockNumber: BigInt(a.block) });
  return balance.toString();
}
