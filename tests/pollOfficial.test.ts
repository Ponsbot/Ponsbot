import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BaseError, ContractFunctionZeroDataError } from 'viem';
const read = vi.hoisted(() => vi.fn());
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => ({ readContract: read }) }));
import { pollOfficial } from '../lib/poll-chain';
const token = '0x1111111111111111111111111111111111111111', wallet = '0x2222222222222222222222222222222222222222';
const anchor = { block: '100', blockHash: '0xabc', timestamp: 0 };
beforeEach(() => { vi.stubEnv('ROBINHOOD_RPC_URL', 'https://example.com'); read.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
it('verifies Pons launches without any Pons Bot indexing hint', async () => {
  read.mockResolvedValue({ exists: true, token, deployer: wallet, creatorFeeRecipient: token });
  expect(await pollOfficial(token, wallet, {}, anchor)).toBe(true);
  expect(read.mock.calls[0][0].blockNumber).toBe(100n);
});
it('verifies a non-Pons token contract owner', async () => {
  read.mockResolvedValueOnce({ exists: false }).mockResolvedValueOnce(wallet);
  expect(await pollOfficial(token, wallet, {}, anchor)).toBe(true);
  expect(read.mock.calls[1][0]).toMatchObject({ address: token, functionName: 'owner', blockNumber: 100n });
});
it('does not grant official status to an unrelated external wallet', async () => {
  read.mockResolvedValueOnce({ exists: false }).mockResolvedValueOnce(token);
  expect(await pollOfficial(token, wallet, {}, anchor)).toBe(false);
});
it('keeps a token without owner() community', async () => {
  read.mockResolvedValueOnce({ exists: false }).mockRejectedValueOnce(new ContractFunctionZeroDataError({ functionName: 'owner' }));
  expect(await pollOfficial(token, wallet, {}, anchor)).toBe(false);
});
it('does not treat an RPC failure as a definitive absence of rights', async () => {
  read.mockResolvedValueOnce({ exists: false }).mockRejectedValueOnce(new BaseError('RPC unavailable'));
  await expect(pollOfficial(token, wallet, {}, anchor)).rejects.toThrow('RPC unavailable');
});
