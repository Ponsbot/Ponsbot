import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getFunctionName } from 'convex/server';
import { voteSignInMessage, validVoteSignIn, verifyVoteSignature, voteAuthHash, VOTE_CHALLENGE_TTL } from '../lib/vote-wallet-auth';
import * as authFunctions from '../convex/pollWalletAuth';
import { web as pollWeb, correctToken } from '../convex/polls';
import { VOTING_PREVIEW_X_ID } from '../lib/voting-access';
import * as contractVerification from '../lib/poll-wallet-chain';
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const other = privateKeyToAccount(`0x${'2'.repeat(64)}`);
const origin = 'https://example.com';
const nonce = 'a'.repeat(32);
const token = 'c'.repeat(64);
const common = { secret: 'local-test', owner: VOTING_PREVIEW_X_ID, sessionId: 'web_test', origin };
vi.mock('../lib/poll-chain', async original => ({ ...await original<typeof import('../lib/poll-chain')>(), pollAnchor: vi.fn(async () => ({ block: '123', blockHash: '0x123', timestamp: Date.now() })) }));
beforeEach(() => vi.stubEnv('WEB_AUTH_SECRET', common.secret));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('voting SIWE messages', () => {
  it('signs only the voting purpose with a nonce and expiry', async () => {
    const now = Date.now(), message = voteSignInMessage(account.address, origin, nonce, now);
    expect(message).toContain('Chain ID: 4663'); expect(message).toContain('does not authorize transactions');
    expect(validVoteSignIn(message, account.address, origin, nonce, now)).toBe(true);
    const signature = await account.signMessage({ message });
    const read = vi.fn();
    expect(await verifyVoteSignature(account.address, message, signature, read)).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['domain', 'nonce', 'address', 'chain', 'uri', 'expired', 'future'])('rejects wrong %s', what => {
    const now = Date.now(); let message = voteSignInMessage(account.address, origin, nonce, now);
    if (what === 'chain') message = message.replace('Chain ID: 4663', 'Chain ID: 1');
    if (what === 'uri') message = message.replace('/votes', '/terminal');
    expect(validVoteSignIn(message, what === 'address' ? other.address : account.address, what === 'domain' ? 'https://evil.example' : origin, what === 'nonce' ? 'b'.repeat(32) : nonce,
      what === 'expired' ? now + VOTE_CHALLENGE_TTL : what === 'future' ? now - 1000 : now)).toBe(false);
  });
  it('rejects changed message and another signer', async () => {
    const message = voteSignInMessage(account.address, origin, nonce, Date.now()), signature = await other.signMessage({ message });
    expect(await verifyVoteSignature(account.address, message, signature, async () => false)).toBe(false);
    const valid = await account.signMessage({ message });
    expect(await verifyVoteSignature(account.address, message + 'changed', valid, async () => false)).toBe(false);
  });
  it('supports read-only ERC-1271 verification', async () => {
    const check = vi.fn(async () => true);
    expect(await verifyVoteSignature(account.address, 'test', '0x1234', check)).toBe(true);
    expect(check).toHaveBeenCalledWith(account.address, expect.stringMatching(/^0x/), '0x1234');
  });
  it('rejects oversized signatures before RPC', async () => {
    const check = vi.fn(); expect(await verifyVoteSignature(account.address, 'test', `0x${'aa'.repeat(9000)}`, check)).toBe(false); expect(check).not.toHaveBeenCalled();
  });
});
describe('single-use and scoped voting authentication', () => {
  function database(row: any) {
    const q: any = { withIndex: () => q, unique: async () => row };
    return { query: () => q, patch: vi.fn(async (_id, update) => Object.assign(row, update)), delete: vi.fn() };
  }
  it('consumes a challenge once and rejects replay', async () => {
    const row = { _id: 'c', used: false, binding: 'correct', expiresAt: Date.now() + 10000, address: account.address, message: 'test' }, db = database(row);
    expect(await invoke(authFunctions.consume, { db }, { nonce, binding: 'correct' })).toMatchObject({ address: account.address });
    expect(await invoke(authFunctions.consume, { db }, { nonce, binding: 'correct' })).toBeNull();
    expect(db.patch).toHaveBeenCalledTimes(1);
  });
  it.each(['wrong-browser', 'expired', 'already-used'])('rejects %s challenges', kind => {
    const row = { used: kind === 'already-used', binding: 'correct', expiresAt: kind === 'expired' ? 0 : Date.now() + 10000 }, db = database(row);
    return expect(invoke(authFunctions.consume, { db }, { nonce, binding: kind === 'wrong-browser' ? 'wrong' : 'correct' })).resolves.toBeNull();
  });
  it.each(['wrong-browser', 'expired'])('does not accept %s sessions', kind => {
    const db = database({ address: account.address, binding: 'correct', expiresAt: kind === 'expired' ? 0 : Date.now() + 10000 });
    return expect(invoke(authFunctions.session, { db }, { hash: 'hash', binding: kind === 'wrong-browser' ? 'wrong' : 'correct' })).resolves.toBeNull();
  });
  it('revokes only the current browser session', async () => {
    const db = database({ _id: 's', binding: 'correct' });
    await invoke(authFunctions.revoke, { db }, { hash: 'hash', binding: 'wrong' }); expect(db.delete).not.toHaveBeenCalled();
    await invoke(authFunctions.revoke, { db }, { hash: 'hash', binding: 'correct' }); expect(db.delete).toHaveBeenCalledWith('s');
  });
  it('rejects revoked X preview authentication before issuing a nonce', async () => {
    const ctx = { runAction: vi.fn(async () => false), runMutation: vi.fn() };
    await expect(invoke(authFunctions.web, ctx, { ...common, operation: 'challenge', address: account.address })).rejects.toThrow('Unauthorized');
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });
  it('verifies a real signature, consuming the nonce before saving a hashed token', async () => {
    const message = voteSignInMessage(account.address, origin, nonce, Date.now());
    const signature = await account.signMessage({ message });
    const ctx = { runAction: vi.fn(async () => true), runMutation: vi.fn(async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === 'polls:gate') return true;
      if (name === 'pollWalletAuth:consume') return { address: account.address.toLowerCase(), message };
      if (name === 'pollWalletAuth:save') return { address: args.address, expiresAt: Date.now() + 1000 };
    }) };
    expect(await invoke(authFunctions.web, ctx, { ...common, operation: 'verify', nonce, signature, token })).toMatchObject({ address: account.address.toLowerCase() });
    const calls = ctx.runMutation.mock.calls;
    expect(calls.map(c => getFunctionName(c[0]))).toEqual(['polls:gate', 'pollWalletAuth:consume', 'pollWalletAuth:save']);
    expect(calls[2][1]).toMatchObject({ hash: await voteAuthHash(token), binding: await voteAuthHash(`${common.owner}:${common.sessionId}`) });
    expect(JSON.stringify(calls[2][1])).not.toContain(token);
  });
});
describe('website vote authorization', () => {
  it('resolves a selected Pons wallet from the authenticated owner, never the supplied address', async () => {
    const ctx = { runAction: vi.fn(async () => true), runQuery: vi.fn(async () => ({ user: { username: 'Ponsboyfamily' }, wallet: { address: account.address, status: 'active', chainId: 4663 } })),
      runMutation: vi.fn(async (ref: any, _args: any) => getFunctionName(ref) === 'polls:gate' ? true : 'POLL-1234567890ABCDEF') };
    const args = { ...common, eventId: 'valid_event_123', operation: 'create', walletSource: 'pons', expectedWallet: account.address,
      spec: { token: '$TEST', question: 'Proceed?', options: ['Yes', 'No'], durationMinutes: 60, minimumHoldingPercent: 0.1 } };
    expect((await invoke(pollWeb, ctx, args)).ok).toBe(true);
    expect(ctx.runQuery.mock.calls[0]).toHaveLength(2);
    expect(ctx.runMutation.mock.calls[1][1]).toMatchObject({ creatorWallet: account.address.toLowerCase(), creatorXUsername: 'Ponsboyfamily' });
    await expect(invoke(pollWeb, ctx, { ...args, expectedWallet: other.address })).rejects.toThrow('changed');
  });
  it('creates using the signed external wallet, without selecting the X custodial wallet', async () => {
    const ctx = { runAction: vi.fn(async () => true), runQuery: vi.fn(async (_ref: any, _args: any) => ({ address: account.address.toLowerCase() })),
      runMutation: vi.fn(async (ref: any, _args: any) => getFunctionName(ref) === 'polls:gate' ? true : 'POLL-1234567890ABCDEF') };
    const result = await invoke(pollWeb, ctx, { ...common, eventId: 'valid_event_123', operation: 'create', walletToken: token, expectedWallet: account.address,
      spec: { token: '$TEST', question: 'Proceed?', options: ['Yes', 'No'], durationMinutes: 60, minimumHoldingPercent: 0.1 } });
    expect(result.ok).toBe(true);
    expect(ctx.runMutation.mock.calls[1][1]).toMatchObject({ creatorWallet: account.address.toLowerCase(), source: 'web' });
    expect(ctx.runQuery.mock.calls.map(c => getFunctionName(c[0]))).toEqual(['pollWalletAuth:session']);
  });
  it('revokes a smart-account session when its old signature is no longer valid', async () => {
    const ctx = { runAction: vi.fn(async () => true), runQuery: vi.fn(async () => ({ address: account.address.toLowerCase(), contractProof: { message: 'test', signature: '0x1234' } })), runMutation: vi.fn() };
    vi.spyOn(contractVerification, 'verifyVotingContractSignature').mockResolvedValue(false);
    await expect(invoke(pollWeb, ctx, { ...common, eventId: 'valid_event_123', operation: 'vote', walletToken: token, expectedWallet: account.address })).rejects.toThrow('authorization changed');
    expect(getFunctionName(ctx.runMutation.mock.calls[0][0])).toBe('pollWalletAuth:revoke');
  });
  it('preserves a smart-account session when its RPC check is unavailable', async () => {
    const ctx = { runAction: vi.fn(async () => true), runQuery: vi.fn(async () => ({ address: account.address.toLowerCase(), contractProof: { message: 'test', signature: '0x1234' } })), runMutation: vi.fn() };
    vi.spyOn(contractVerification, 'verifyVotingContractSignature').mockRejectedValue(new Error('Your wallet verification is temporarily unavailable. Please retry.'));
    expect(await invoke(pollWeb, ctx, { ...common, eventId: 'valid_event_123', operation: 'vote', walletToken: token, expectedWallet: account.address })).toMatchObject({ ok: false, message: expect.stringContaining('temporarily unavailable') });
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });
  it.each(['create', 'vote', 'endorse', 'correct'])('requires a verified wallet for %s', async operation => {
    const ctx = { runAction: vi.fn(async () => true), runQuery: vi.fn(async () => null), runMutation: vi.fn() };
    await expect(invoke(pollWeb, ctx, { ...common, eventId: 'valid_event_123', operation, walletToken: token, expectedWallet: account.address })).rejects.toThrow('verify');
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });
  it('rejects cross-tab account switching rather than voting as the wrong wallet', async () => {
    const ctx = { runAction: vi.fn(async () => true), runQuery: vi.fn(async () => ({ address: other.address.toLowerCase() })), runMutation: vi.fn() };
    await expect(invoke(pollWeb, ctx, { ...common, eventId: 'valid_event_123', operation: 'vote', walletToken: token, expectedWallet: account.address })).rejects.toThrow('changed');
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });
  it('requires the actual creating wallet for token corrections', async () => {
    const row = { ownerXUserId: common.owner, status: 'needs_token', source: 'web', creatorWallet: account.address.toLowerCase() };
    const q: any = { withIndex: () => q, unique: async () => row };
    await expect(invoke(correctToken, { db: { query: () => q } }, { code: 'POLL-test', owner: common.owner, address: account.address, creatorWallet: other.address })).rejects.toThrow('creating wallet');
  });
});
