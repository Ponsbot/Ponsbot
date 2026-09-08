import { beforeEach, expect, it, vi } from 'vitest';
const client = vi.hoisted(() => ({ getChainId: vi.fn(), getCode: vi.fn(), readContract: vi.fn() }));
vi.mock('../lib/poll-chain', () => ({ pollRpc: () => client }));
import { verifyVotingContractSignature } from '../lib/poll-wallet-chain';
const address = '0x1111111111111111111111111111111111111111';
beforeEach(() => { vi.clearAllMocks(); client.getChainId.mockResolvedValue(4663); client.getCode.mockResolvedValue('0x1234'); client.readContract.mockResolvedValue('0x1626ba7e'); });
it('accepts only the ERC-1271 success magic value', async () => {
  expect(await verifyVotingContractSignature(address, '0x1234', '0x5678')).toBe(true);
  client.readContract.mockResolvedValue('0xffffffff'); expect(await verifyVotingContractSignature(address, '0x1234', '0x5678')).toBe(false);
});
it('fails closed on another chain', async () => { client.getChainId.mockResolvedValue(1); expect(await verifyVotingContractSignature(address, '0x1234', '0x5678')).toBe(false); expect(client.readContract).not.toHaveBeenCalled(); });
it('does not attempt to deploy counterfactual accounts', async () => { client.getCode.mockResolvedValue('0x'); expect(await verifyVotingContractSignature(address, '0x1234', '0x5678')).toBe(false); expect(client.readContract).not.toHaveBeenCalled(); });
it('fails closed on RPC errors', async () => { client.readContract.mockRejectedValue(new Error('RPC')); expect(await verifyVotingContractSignature(address, '0x1234', '0x5678')).toBe(false); });
