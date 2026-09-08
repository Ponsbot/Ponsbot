import { type Hex } from 'viem';
import { pollRpc } from './poll-chain';
export async function verifyVotingContractSignature(address: Hex, digest: Hex, signature: Hex): Promise<boolean> {
  try {
    const client = pollRpc();
    if (await client.getChainId() !== 4663) return false;
    const code = await client.getCode({ address });
    if (!code || code === '0x') return false;
    const magic = await client.readContract({ address, abi: [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ type: 'bytes32', name: 'hash' }, { type: 'bytes', name: 'signature' }], outputs: [{ type: 'bytes4' }] }], functionName: 'isValidSignature', args: [digest, signature] });
    return magic === '0x1626ba7e';
  } catch { return false; }
}
