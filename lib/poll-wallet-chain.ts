import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, type Hex } from 'viem';
import { pollRpc } from './poll-chain';
export async function verifyVotingContractSignature(address: Hex, digest: Hex, signature: Hex): Promise<boolean> {
  try {
    const client = pollRpc();
    if (await client.getChainId() !== 4663) throw new Error('Wrong verification chain');
    const code = await client.getCode({ address });
    if (!code || code === '0x') return false;
    const magic = await client.readContract({ address, abi: [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ type: 'bytes32', name: 'hash' }, { type: 'bytes', name: 'signature' }], outputs: [{ type: 'bytes4' }] }], functionName: 'isValidSignature', args: [digest, signature] });
    return magic === '0x1626ba7e';
  } catch (error) {
    const cause = error instanceof BaseError ? error.walk(e => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) : error;
    if (cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError) return false;
    throw new Error('Your wallet verification is temporarily unavailable. Please retry.');
  }
}
