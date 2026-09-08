import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), fetch: vi.fn(), logs: vi.fn() }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => ({ readContract: mocks.read, getLogs: mocks.logs, getBlock: async () => ({ hash: '0xabc' }) }) }));
vi.mock('../lib/gecko-shared', () => ({ geckoSharedFetch: mocks.fetch }));
import { buildPollSnapshot, mainPollV3Pool } from '../lib/poll-chain';
import { pollDiagnostic, PollPreparationError } from '../lib/poll-diagnostics';
const token = '0x1111111111111111111111111111111111111111', pool = '0x2222222222222222222222222222222222222222', pair = '0x3333333333333333333333333333333333333333';
const anchor = { block: '100', blockHash: '0xabc', timestamp: 0 };
beforeEach(() => { vi.stubEnv('ROBINHOOD_RPC_URL', 'https://example.com'); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllEnvs());
it('reads curve, locker and burn balances without pool history or market discovery', async () => {
  mocks.read.mockImplementation(async (a: any) => ({ symbol: 'TOKEN', decimals: 18, totalSupply: 100000n, getLaunchedToken: { exists: true, phase: 0, curve: pool }, poolManager: pair, balanceOf: 10n }[a.functionName as string]));
  const snapshot = await buildPollSnapshot(token, token, anchor);
  expect(snapshot.exclusions.some(x => x.address === pool)).toBe(true);
  expect(mocks.logs).not.toHaveBeenCalled(); expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.read.mock.calls.every(([a]) => a.blockNumber === 100n)).toBe(true);
});
it('verifies the main discovered V3 pool at the fixed block', async () => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ attributes: { address: pool, reserve_in_usd: '10000' } }] })));
  mocks.read.mockImplementation(async (a: any) => ({ token0: token, token1: pair, fee: 3000, getPool: pool }[a.functionName as string]));
  expect(await mainPollV3Pool(token, anchor)).toBe(pool);
  expect(mocks.read).toHaveBeenCalledTimes(4); expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.logs).not.toHaveBeenCalled();
});
it('rejects a suggested pool that does not match the canonical factory', async () => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ attributes: { address: pool, reserve_in_usd: '10000' } }] })));
  mocks.read.mockImplementation(async (a: any) => ({ token0: token, token1: pair, fee: 3000, getPool: pair }[a.functionName as string]));
  expect(await mainPollV3Pool(token, anchor)).toBeNull();
});
it('records useful stages without retaining credentials or raw payloads', () => {
  const diagnostic = pollDiagnostic('snapshot', new PollPreparationError('main-pool', new Error('429 https://rpc.example/SECRET api_key=ABC')));
  expect(diagnostic).toBe('stage=main-pool; cause=provider-rate-limit');
  expect(diagnostic).not.toMatch(/SECRET|ABC|https/);
});
