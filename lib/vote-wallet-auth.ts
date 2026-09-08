import { getAddress, hashMessage, verifyMessage, type Hex } from 'viem';
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from 'viem/siwe';

export const VOTE_WALLET_COOKIE = 'pons_vote_wallet';
export const VOTE_WALLET_TTL = 30 * 60 * 1000;
export const VOTE_CHALLENGE_TTL = 5 * 60 * 1000;
export function voteSignInMessage(address: string, origin: string, nonce: string, now: number) {
  const site = new URL(origin);
  if (site.protocol !== 'https:' && site.hostname !== 'localhost') throw new Error('Secure origin required');
  return createSiweMessage({ address: getAddress(address), domain: site.host, scheme: site.protocol.slice(0, -1), uri: `${site.origin}/votes`,
    version: '1', chainId: 4663, nonce, issuedAt: new Date(now), expirationTime: new Date(now + VOTE_CHALLENGE_TTL),
    statement: 'Verify this wallet for Pons Bot voting only. This does not authorize transactions, token approvals, or access to your funds.' });
}
export async function voteAuthHash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function validVoteSignIn(message: string, address: string, origin: string, nonce: string, now = Date.now()) {
  try {
    const parsed = parseSiweMessage(message), site = new URL(origin);
    return parsed.chainId === 4663 && parsed.version === '1' && parsed.uri === `${site.origin}/votes`
      && !!parsed.issuedAt && parsed.issuedAt.getTime() <= now && !!parsed.expirationTime
      && validateSiweMessage({ message: parsed, address: getAddress(address), domain: site.host, scheme: site.protocol.slice(0, -1), nonce, time: new Date(now) });
  } catch { return false; }
}
// Explicitly support EOAs and deployed ERC-1271 accounts, not counterfactual
// deployment signatures. Verification can only read chain state.
export async function verifyVoteSignature(address: string, message: string, signature: Hex,
  contractCheck: (address: Hex, digest: Hex, signature: Hex) => Promise<boolean>) {
  if (!/^0x[0-9a-f]+$/i.test(signature) || signature.length > 16386 || signature.length % 2 !== 0) return false;
  try { if (await verifyMessage({ address: getAddress(address), message, signature })) return true; } catch { /* Try a deployed smart account. */ }
  return contractCheck(getAddress(address), hashMessage(message), signature);
}
