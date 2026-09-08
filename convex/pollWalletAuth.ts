import { v } from 'convex/values';
import { isAddress, type Hex } from 'viem';
import { action, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { votingPreviewAllowed, anonymousVotingSession } from '../lib/voting-access';
import { verifyVotingContractSignature } from '../lib/poll-wallet-chain';
import { voteAuthHash, voteSignInMessage, verifyVoteSignature, validVoteSignIn, VOTE_CHALLENGE_TTL, VOTE_WALLET_TTL } from '../lib/vote-wallet-auth';

export const challenge = internalMutation({ args: { nonce: v.string(), binding: v.string(), address: v.string(), message: v.string() }, handler: async (ctx, a) => {
  await ctx.db.insert('pollWalletChallenges', { ...a, used: false, expiresAt: Date.now() + VOTE_CHALLENGE_TTL });
} });
export const consume = internalMutation({ args: { nonce: v.string(), binding: v.string() }, handler: async (ctx, a) => {
  const row = await ctx.db.query('pollWalletChallenges').withIndex('by_nonce', q => q.eq('nonce', a.nonce)).unique();
  if (!row || row.used || row.expiresAt <= Date.now() || row.binding !== a.binding) return null;
  await ctx.db.patch(row._id, { used: true });
  return { address: row.address, message: row.message };
} });
export const session = internalQuery({ args: { hash: v.string(), binding: v.string() }, handler: async (ctx, a) => {
  const row = await ctx.db.query('pollWalletSessions').withIndex('by_hash', q => q.eq('hash', a.hash)).unique();
  return row && row.binding === a.binding && row.expiresAt > Date.now() ? { address: row.address, expiresAt: row.expiresAt, contractProof: row.contractProof } : null;
} });
export const save = internalMutation({ args: { hash: v.string(), binding: v.string(), address: v.string(), contractProof: v.optional(v.object({ message: v.string(), signature: v.string() })) }, handler: async (ctx, a) => {
  if (await ctx.db.query('pollWalletSessions').withIndex('by_hash', q => q.eq('hash', a.hash)).unique()) throw new Error('Session already exists');
  const expiresAt = Date.now() + VOTE_WALLET_TTL;
  await ctx.db.insert('pollWalletSessions', { ...a, expiresAt });
  return { address: a.address, expiresAt };
} });
export const revoke = internalMutation({ args: { hash: v.string(), binding: v.string() }, handler: async (ctx, a) => {
  const row = await ctx.db.query('pollWalletSessions').withIndex('by_hash', q => q.eq('hash', a.hash)).unique();
  if (row?.binding === a.binding) await ctx.db.delete(row._id);
} });
export const cleanup = internalMutation({ args: {}, handler: async ctx => {
  let remaining = false;
  for (const table of ['pollWalletChallenges', 'pollWalletSessions'] as const) {
    const rows = await ctx.db.query(table).withIndex('by_expiry', q => q.lt('expiresAt', Date.now())).take(100);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === 100) remaining = true;
  }
  if (remaining) await ctx.scheduler.runAfter(1000, internal.pollWalletAuth.cleanup, {});
} });
type AuthResult = { address?: string; expiresAt?: number; nonce?: string; message?: string };
export const web = action({ args: { secret: v.string(), owner: v.string(), sessionId: v.string(), operation: v.union(v.literal('challenge'), v.literal('verify'), v.literal('status'), v.literal('disconnect')),
  origin: v.string(), address: v.optional(v.string()), nonce: v.optional(v.string()), signature: v.optional(v.string()), token: v.optional(v.string()) }, handler: async (ctx, a): Promise<AuthResult> => {
  if (!process.env.WEB_AUTH_SECRET || a.secret !== process.env.WEB_AUTH_SECRET || !votingPreviewAllowed(a.owner)
    || (!anonymousVotingSession(a.owner, a.sessionId) && !await ctx.runAction(internal.polls.checkWebSession, { secret: a.secret, owner: a.owner, sessionId: a.sessionId }))) throw new Error('Unauthorized');
  const binding = await voteAuthHash(`${a.owner}:${a.sessionId}`);
  const hash = a.token && /^[a-f0-9]{64}$/.test(a.token) ? await voteAuthHash(a.token) : undefined;
  if (a.operation === 'status') { const s = hash ? await ctx.runQuery(internal.pollWalletAuth.session, { hash, binding }) : null; return s ? { address: s.address, expiresAt: s.expiresAt } : {}; }
  if (a.operation === 'disconnect') { if (hash) await ctx.runMutation(internal.pollWalletAuth.revoke, { hash, binding }); return {}; }
  if (!await ctx.runMutation(internal.polls.gate, { key: `wallet-signin:${a.owner === 'guest' ? a.sessionId : a.owner}`, limit: 12, window: 60000 })) throw new Error('Too many sign-in attempts');
  if (a.operation === 'challenge') {
    if (!a.address || !isAddress(a.address, { strict: false })) throw new Error('Invalid address');
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const message = voteSignInMessage(a.address, a.origin, nonce, Date.now());
    await ctx.runMutation(internal.pollWalletAuth.challenge, { nonce, binding, address: a.address.toLowerCase(), message });
    return { nonce, message };
  }
  if (!hash || !a.nonce || !/^[a-f0-9]{32}$/.test(a.nonce) || !a.signature) throw new Error('Invalid verification');
  const challenge = await ctx.runMutation(internal.pollWalletAuth.consume, { nonce: a.nonce, binding });
  if (!challenge) throw new Error('Sign-in challenge expired or already used');
  if (!validVoteSignIn(challenge.message, challenge.address, a.origin, a.nonce)) throw new Error('Sign-in details expired or do not match');
  let contractSignature = false;
  const verified = await verifyVoteSignature(challenge.address, challenge.message, a.signature as Hex, async (address, digest, signature) => {
    contractSignature = await verifyVotingContractSignature(address, digest, signature);
    return contractSignature;
  });
  if (!verified) throw new Error('Wallet signature could not be verified');
  return ctx.runMutation(internal.pollWalletAuth.save, { hash, binding, address: challenge.address,
    ...(contractSignature ? { contractProof: { message: challenge.message, signature: a.signature } } : {}) });
} });
