import { v } from 'convex/values';
import { formatUnits, hashMessage, isAddress, type Hex } from 'viem';
import { action, internalAction, internalMutation, internalQuery, type ActionCtx } from './_generated/server';
import { votingPreviewAllowed, X_VOTING_ENABLED } from '../lib/voting-access';
import { voteAuthHash } from '../lib/vote-wallet-auth';
import { verifyVotingContractSignature } from '../lib/poll-wallet-chain';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { pollSpecValidator, pollSnapshotValidator } from './lib/pollSchema';
import { isPollCommand, parsePollCreate, pollChoice, pollCreatedText, pollPercent, pollTokenIdentity, pollUrl, updatePollTotals, validatePollSpec } from '../lib/polls';
import { assertPollBlock, buildPollSnapshot, pollAnchor, pollOfficial, pollVotingBalance } from '../lib/poll-chain';

type Result = { message: string; code?: string; pending?: boolean; ok: boolean };
const find = (ctx: Parameters<typeof publicPoll>[0], code: string) => ctx.db.query('polls').withIndex('by_code', q => q.eq('code', code.toUpperCase())).unique();
function publicPoll(_ctx: import('./_generated/server').QueryCtx, p: Doc<'polls'>) {
  return { code: p.code, status: p.status === 'open' && (p.endsAt ?? 0) <= Date.now() ? 'closed' : p.status,
    tokenAddress: p.tokenAddress, question: p.spec.question, options: p.spec.options, minimumHoldingPercent: p.spec.minimumHoldingPercent,
    durationMinutes: p.spec.durationMinutes, official: p.official, officialBy: p.officialBy, officialAt: p.officialAt,
    creatorWallet: p.creatorWallet, creatorXUsername: p.source === 'x' ? p.creatorXUsername : undefined, createdAt: p.createdAt, endsAt: p.endsAt, snapshot: p.snapshot, totals: p.totals,
    votedWeight: p.votedWeight, voterCount: p.voterCount, xPostId: p.xPostId, resultPostId: p.resultPostId,
    turnout: p.snapshot ? pollPercent(p.votedWeight, p.snapshot.activeSupply) : 0 };
}
export const list = internalQuery({ args: { closed: v.optional(v.boolean()), cursor: v.optional(v.number()) }, handler: async (ctx, args) => {
  const rows = await ctx.db.query('polls').withIndex('by_status_created', q => q.eq('status', args.closed ? 'closed' : 'open').lt('createdAt', args.cursor ?? Number.MAX_SAFE_INTEGER)).order('desc').take(31);
  return { items: rows.slice(0, 30).map(p => publicPoll(ctx, p)), next: rows.length > 30 ? rows[29].createdAt : null };
} });
export const get = internalQuery({ args: { code: v.string() }, handler: async (ctx, { code }) => { const p = await find(ctx, code); return p ? publicPoll(ctx, p) : null; } });
export const browse = action({ args: { secret: v.string(), owner: v.string(), sessionId: v.string(), code: v.optional(v.string()), closed: v.optional(v.boolean()), cursor: v.optional(v.number()) }, handler: async (ctx, a): Promise<{ poll: ReturnType<typeof publicPoll> | null } | { items: ReturnType<typeof publicPoll>[]; next: number | null }> => {
  if (!process.env.WEB_AUTH_SECRET || a.secret !== process.env.WEB_AUTH_SECRET || !votingPreviewAllowed(a.owner)) throw new Error('Unauthorized');
  if (!await ctx.runAction(internal.polls.checkWebSession, { secret: a.secret, owner: a.owner, sessionId: a.sessionId })) throw new Error('Unauthorized');
  if (a.code) return { poll: await ctx.runQuery(internal.polls.get, { code: a.code }) };
  return ctx.runQuery(internal.polls.list, { closed: a.closed, cursor: a.cursor });
} });
export const record = internalQuery({ args: { code: v.string() }, handler: (ctx, { code }) => find(ctx, code) });
export const context = internalQuery({ args: { parentPostId: v.optional(v.string()) }, handler: async (ctx, { parentPostId }) => {
  if (!parentPostId) return null;
  const poll = await ctx.db.query('polls').withIndex('by_x_post', q => q.eq('xPostId', parentPostId)).unique();
  if (poll) return { code: poll.code, correction: false, owner: poll.ownerXUserId };
  const parent = await ctx.db.query('xReplyInteractions').withIndex('by_response_post_id', q => q.eq('responsePostId', parentPostId)).unique();
  if (!parent || parent.commandKind !== 'poll') return null;
  const pending = await ctx.db.query('polls').withIndex('by_source_post', q => q.eq('sourcePostId', parent.postId)).unique();
  return pending?.status === 'needs_token' ? { code: pending.code, correction: true, owner: pending.ownerXUserId } : null;
} });
export const hints = internalQuery({ args: { token: v.string() }, handler: async (ctx, { token }) => {
  const program = await ctx.db.query('automatedFeePrograms').withIndex('by_token', q => q.eq('normalizedTokenAddress', token.toLowerCase())).unique();
  return program ? { vault: program.vaultAddress, layer: program.creatorBurnLayerAddress } : {};
} });
export const gate = internalMutation({ args: { key: v.string(), limit: v.number(), window: v.number() }, handler: async (ctx, a) => {
  const row = await ctx.db.query('pollRequestLimits').withIndex('by_key', q => q.eq('key', a.key)).unique();
  const times = (row?.times ?? []).filter(t => t > Date.now() - a.window);
  if (times.length >= a.limit) return false;
  times.push(Date.now());
  if (row) await ctx.db.patch(row._id, { times }); else await ctx.db.insert('pollRequestLimits', { key: a.key, times });
  return true;
} });
export const request = internalMutation({ args: { requestKey: v.string(), ownerXUserId: v.string(), creatorWallet: v.string(), source: v.union(v.literal('x'), v.literal('web')),
  sourcePostId: v.optional(v.string()), creatorXUsername: v.optional(v.string()), spec: pollSpecValidator, anchor: v.object({ block: v.string(), blockHash: v.string(), timestamp: v.number() }) }, handler: async (ctx, a): Promise<string> => {
  if (!votingPreviewAllowed(a.ownerXUserId) || (a.source === 'x' && !X_VOTING_ENABLED)) throw new Error('Voting preview is website-only');
  const existing = await ctx.db.query('polls').withIndex('by_request', q => q.eq('requestKey', a.requestKey)).unique();
  if (existing) { if (existing.ownerXUserId !== a.ownerXUserId || existing.creatorWallet !== a.creatorWallet.toLowerCase() || JSON.stringify(existing.spec) !== JSON.stringify(validatePollSpec(a.spec))) throw new Error('Request owner or details mismatch'); return existing.code; }
  const spec = validatePollSpec(a.spec);
  const recent = await ctx.db.query('polls').withIndex('by_owner_created', q => q.eq('ownerXUserId', a.ownerXUserId).gte('createdAt', Date.now() - 86400000)).take(10);
  if (recent.length >= 10) throw new Error('You can create up to 10 polls per day.');
  const code = `POLL-${crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
  if (await find(ctx, code)) throw new Error('Please retry creating your poll.');
  await ctx.db.insert('polls', { ...a, spec, code, creatorWallet: a.creatorWallet.toLowerCase(), status: 'preparing', createdAt: Date.now(), official: false,
    totals: spec.options.map(() => '0'), votedWeight: '0', voterCount: 0, nextAttemptAt: Date.now(), attempts: 0 });
  await ctx.scheduler.runAfter(0, internal.polls.prepare, { code });
  return code;
} });
export const reserve = internalMutation({ args: { code: v.string() }, handler: async (ctx, { code }) => {
  const p = await find(ctx, code);
  if (!p || p.status !== 'preparing' || (p.leaseUntil ?? 0) > Date.now()) return null;
  const lease = crypto.randomUUID();
  await ctx.db.patch(p._id, { lease, leaseUntil: Date.now() + 240000, nextAttemptAt: Date.now() + 240000, attempts: p.attempts + 1 });
  return { ...p, lease };
} });
export const prepared = internalMutation({ args: { code: v.string(), lease: v.string(), tokenAddress: v.string(), snapshot: pollSnapshotValidator, official: v.boolean() }, handler: async (ctx, a) => {
  const p = await find(ctx, a.code);
  if (!p || p.status !== 'preparing' || p.lease !== a.lease) return;
  if (p.anchor.blockHash !== a.snapshot.blockHash) throw new Error('Snapshot anchor mismatch');
  const endsAt = Date.now() + p.spec.durationMinutes * 60000;
  await ctx.db.patch(p._id, { status: 'open', tokenAddress: a.tokenAddress.toLowerCase(), snapshot: a.snapshot, endsAt, nextAttemptAt: endsAt, official: a.official,
    ...(a.official ? { officialBy: p.creatorWallet, officialAt: Date.now() } : {}), lease: undefined, leaseUntil: undefined, diagnostic: undefined });
  await ctx.scheduler.runAfter(p.spec.durationMinutes * 60000, internal.polls.close, { code: p.code });
  if (X_VOTING_ENABLED && p.sourcePostId) {
    await ctx.runMutation(internal.xReplies.updateInteraction, { postId: p.sourcePostId, status: 'processing', commandKind: 'poll' });
    await ctx.runMutation(internal.xReplyQueue.enqueue, { key: `poll-created:${p.code}`, postId: p.sourcePostId, pollId: p._id, kind: 'poll_created', ok: true, allowLong: true,
      text: pollCreatedText({ ...p, symbol: a.snapshot.symbol, options: p.spec.options, question: p.spec.question, minimumHoldingPercent: p.spec.minimumHoldingPercent, endsAt, official: a.official }) });
  }
} });
export const prepareFailed = internalMutation({ args: { code: v.string(), lease: v.string(), needsToken: v.boolean(), message: v.string() }, handler: async (ctx, a) => {
  const p = await find(ctx, a.code); if (!p || p.status !== 'preparing' || p.lease !== a.lease) return;
  const terminal = a.needsToken || p.attempts >= 3;
  await ctx.db.patch(p._id, { status: a.needsToken ? 'needs_token' : terminal ? 'failed' : 'preparing', diagnostic: a.message, lease: undefined, leaseUntil: undefined, nextAttemptAt: Date.now() + 60000 });
  if (!terminal) { await ctx.scheduler.runAfter(60000, internal.polls.prepare, { code: p.code }); return; }
  if (X_VOTING_ENABLED && p.sourcePostId) {
    await ctx.runMutation(internal.xReplies.updateInteraction, { postId: p.sourcePostId, status: 'processing', commandKind: 'poll' });
    await ctx.runMutation(internal.xReplyQueue.enqueue, { key: `poll-setup:${p.code}:${p.sourcePostId}:${p.attempts}`, postId: p.sourcePostId, text: a.needsToken
      ? `⚠️ I couldn't identify one matching token. Double-check the ticker and reply with its contract address to continue this poll. ${p.code}`
      : `⚠️ The poll snapshot could not be verified. No voting was opened. Please create a new poll.`, kind: 'reply', ok: false, allowLong: true });
  }
} });
export const prepare = internalAction({ args: { code: v.string() }, handler: async (ctx, { code }): Promise<void> => {
  const p = await ctx.runMutation(internal.polls.reserve, { code }); if (!p) return;
  try {
    const identity = pollTokenIdentity(p.spec.token);
    let address = p.tokenAddress ?? identity.address;
    if (!address) {
      const who = await ctx.runQuery(internal.wallets.getXUserAndWallet, { xUserId: p.ownerXUserId });
      const useCustodialWallet = who?.wallet?.address.toLowerCase() === p.creatorWallet.toLowerCase();
      const matches = await ctx.runQuery(internal.wallets.listKnownTokenMatches, { identifier: identity.ticker!, walletId: useCustodialWallet ? who?.wallet?._id : undefined });
      if (matches.length === 1) address = matches[0];
      else if (!matches.length && useCustodialWallet && who?.wallet) {
        const held = await ctx.runAction(internal.wallets.resolveHeldTokenTicker, { walletId: who.wallet._id, ownerXUserId: p.ownerXUserId, identifier: identity.ticker! });
        if (held.status === 'found') address = held.tokenAddress;
      }
    }
    if (!address || !isAddress(address, { strict: false })) throw new Error('TOKEN_MISMATCH');
    const snapshot = await buildPollSnapshot(address, p.spec.token, p.anchor);
    const hints = await ctx.runQuery(internal.polls.hints, { token: address });
    const official = await pollOfficial(address, p.creatorWallet, hints, p.anchor);
    await ctx.runMutation(internal.polls.prepared, { code, lease: p.lease, tokenAddress: address, snapshot, official });
  } catch (e) {
    await ctx.runMutation(internal.polls.prepareFailed, { code, lease: p.lease, needsToken: e instanceof Error && e.message === 'TOKEN_MISMATCH', message: 'Snapshot verification failed' });
  }
} });
export const correctToken = internalMutation({ args: { code: v.string(), owner: v.string(), address: v.string(), creatorWallet: v.optional(v.string()), sourcePostId: v.optional(v.string()) }, handler: async (ctx, a) => {
  const p = await find(ctx, a.code); if (!p || p.ownerXUserId !== a.owner || p.status !== 'needs_token') throw new Error('This poll is not waiting for your correction.');
  if (p.source === 'web' && a.creatorWallet?.toLowerCase() !== p.creatorWallet) throw new Error('Only the creating wallet can correct this poll.');
  if (Date.now() - p.createdAt > 600000) throw new Error('This request has expired. Please create a new poll.');
  if (!isAddress(a.address, { strict: false })) throw new Error('Please supply a full contract address.');
  await ctx.db.patch(p._id, { tokenAddress: a.address.toLowerCase(), status: 'preparing', attempts: 0, nextAttemptAt: Date.now(), sourcePostId: a.sourcePostId ?? p.sourcePostId });
  await ctx.scheduler.runAfter(0, internal.polls.prepare, { code: p.code });
} });
export const ballot = internalQuery({ args: { code: v.string(), wallet: v.string(), event: v.optional(v.string()) }, handler: async (ctx, a) => {
  const p = await find(ctx, a.code); if (!p) return null;
  const vote = await ctx.db.query('pollVotes').withIndex('by_poll_wallet', q => q.eq('pollId', p._id).eq('wallet', a.wallet.toLowerCase())).unique();
  const event = a.event ? await ctx.db.query('pollVoteEvents').withIndex('by_key', q => q.eq('key', a.event!)).unique() : null;
  return { poll: p, vote, event };
} });
export const saveVote = internalMutation({ args: { code: v.string(), wallet: v.string(), option: v.number(), weight: v.string(), event: v.string(), source: v.union(v.literal('x'), v.literal('web')), eventOrder: v.string() }, handler: async (ctx, a) => {
  const p = await find(ctx, a.code); if (!p) throw new Error('Poll not found.');
  const wallet = a.wallet.toLowerCase();
  const event = await ctx.db.query('pollVoteEvents').withIndex('by_key', q => q.eq('key', a.event)).unique();
  if (event) { if (event.pollId !== p._id || event.wallet !== wallet || event.option !== a.option) throw new Error('Vote request mismatch'); return { changed: false, weight: event.weight }; }
  if (p.status !== 'open' || !p.endsAt || p.endsAt <= Date.now() || !p.snapshot) throw new Error('This poll has closed.');
  if (!/^[0-9]+$/.test(a.weight) || BigInt(a.weight) <= 0n || BigInt(a.weight) > BigInt(p.snapshot.activeSupply)) throw new Error('This wallet has no eligible voting balance.');
  if (p.snapshot.exclusions.some(x => x.address === wallet)) throw new Error('This address is excluded from voting.');
  const threshold = BigInt(Math.round(p.spec.minimumHoldingPercent * 1_000_000));
  if (BigInt(a.weight) * 100_000_000n < BigInt(p.snapshot.supply) * threshold) throw new Error('Your snapshot balance is below the minimum holding requirement.');
  const old = await ctx.db.query('pollVotes').withIndex('by_poll_wallet', q => q.eq('pollId', p._id).eq('wallet', wallet)).unique();
  if (old && old.weight !== a.weight) throw new Error('Snapshot voting weight mismatch');
  if (old && BigInt(a.eventOrder) < BigInt(old.eventOrder)) throw new Error('A newer vote from this wallet was already recorded.');
  const totals = updatePollTotals(p.totals, old, a.option, a.weight);
  const votedWeight = (BigInt(p.votedWeight) + (old ? 0n : BigInt(a.weight))).toString();
  if (BigInt(votedWeight) > BigInt(p.snapshot.activeSupply)) throw new Error('Voting supply reconciliation failed');
  const fields = { pollId: p._id, wallet, option: a.option, weight: a.weight, source: a.source, eventOrder: a.eventOrder, updatedAt: Date.now() };
  if (old) await ctx.db.patch(old._id, fields); else await ctx.db.insert('pollVotes', fields);
  await ctx.db.patch(p._id, { totals, votedWeight, voterCount: p.voterCount + (old ? 0 : 1) });
  await ctx.db.insert('pollVoteEvents', { key: a.event, pollId: p._id, wallet, option: a.option, weight: a.weight, createdAt: Date.now() });
  return { changed: !!old, weight: a.weight };
} });
async function vote(ctx: ActionCtx, code: string, wallet: string, choice: string, source: 'x' | 'web', event: string, order: string): Promise<Result> {
  const c = await ctx.runQuery(internal.polls.ballot, { code, wallet, event });
  if (!c?.poll.snapshot || !c.poll.tokenAddress) throw new Error('This poll is not ready for voting.');
  const option = pollChoice(choice, c.poll.spec.options);
  if (option < 0) throw new Error(`🗳️ Choose one option:\n${c.poll.spec.options.map((x, i) => `${i + 1}. ${x}`).join('\n')}`);
  if (!c.event && (c.poll.status !== 'open' || (c.poll.endsAt ?? 0) <= Date.now())) throw new Error('This poll has closed.');
  if (c.poll.snapshot.exclusions.some(x => x.address === wallet.toLowerCase())) throw new Error('This address is excluded from voting.');
  const weight = c.vote?.weight ?? await pollVotingBalance(c.poll.tokenAddress, wallet, c.poll.snapshot);
  if (c.vote) await assertPollBlock(c.poll.snapshot);
  const saved = await ctx.runMutation(internal.polls.saveVote, { code, wallet, option, weight, event, source, eventOrder: order });
  return { ok: true, code, message: `🗳️ ${saved.changed ? 'Vote updated' : 'Vote recorded'} for ${code}: ${c.poll.spec.options[option]}\nVoting power: ${Number(formatUnits(BigInt(saved.weight), c.poll.snapshot.decimals)).toLocaleString('en-US', { maximumFractionDigits: 2 })} $${c.poll.snapshot.symbol}\n${pollUrl(code)}` };
}
export const markOfficial = internalMutation({ args: { code: v.string(), wallet: v.string() }, handler: async (ctx, a) => {
  const p = await find(ctx, a.code); if (!p || p.status !== 'open' || (p.endsAt ?? 0) <= Date.now()) throw new Error('Only open polls can be endorsed.');
  if (!p.official) await ctx.db.patch(p._id, { official: true, officialBy: a.wallet.toLowerCase(), officialAt: Date.now() });
} });
async function endorse(ctx: ActionCtx, code: string, wallet: string): Promise<Result> {
  const p = await ctx.runQuery(internal.polls.record, { code }); if (!p?.tokenAddress) throw new Error('Poll not found.');
  const a = await pollAnchor(); const hints = await ctx.runQuery(internal.polls.hints, { token: p.tokenAddress });
  if (!await pollOfficial(p.tokenAddress, wallet, hints, a)) throw new Error('Only the token launcher or current fee-rights holder can make this poll official.');
  await assertPollBlock(a);
  await ctx.runMutation(internal.polls.markOfficial, { code, wallet });
  return { ok: true, code, message: `🗳️ ${code} is now an Official poll. Its question, options, snapshot, and existing votes are unchanged.\n${pollUrl(code)}` };
}
export const close = internalMutation({ args: { code: v.string() }, handler: async (ctx, { code }) => {
  const p = await find(ctx, code); if (!p || !p.endsAt || p.endsAt > Date.now() || !['open', 'closed'].includes(p.status)) return;
  if (p.status === 'open') await ctx.db.patch(p._id, { status: 'closed', nextAttemptAt: Date.now() });
  if (!X_VOTING_ENABLED || !p.xPostId || p.resultPublication || !p.snapshot) return;
  const total = BigInt(p.votedWeight);
  const max = p.totals.reduce((m, x) => BigInt(x) > m ? BigInt(x) : m, 0n);
  const winners = p.spec.options.filter((_, i) => BigInt(p.totals[i]) === max);
  const title = total === 0n ? 'No votes were cast.' : `${winners.length > 1 ? 'Tie' : 'Leading option'}: ${winners.join(', ')}`;
  const text = `🗳️ Voting closed: ${p.code}\n${p.official ? 'Official' : 'Community'} $${p.snapshot.symbol} poll\n\n${p.spec.question}\n\n${p.spec.options.map((x, i) => `${i + 1}. ${x}: ${pollPercent(p.totals[i], p.votedWeight).toFixed(2)}%`).join('\n')}\n\n${title}\n${p.voterCount} wallets voted. ${pollPercent(p.votedWeight, p.snapshot.activeSupply).toFixed(2)}% of active voting supply participated.\nAdvisory result; no automatic transactions.\n${pollUrl(code)}`;
  const queued = await ctx.runMutation(internal.xReplyQueue.enqueue, { key: `poll-result:${code}`, pollId: p._id, replyTargetPostId: p.xPostId, text, kind: 'poll_result', ok: true, allowLong: true });
  await ctx.db.patch(p._id, { resultPublication: queued.status });
} });
export const recover = internalMutation({ args: {}, handler: async ctx => {
  const pending = await ctx.db.query('polls').withIndex('by_status_due', q => q.eq('status', 'preparing').lte('nextAttemptAt', Date.now())).take(10);
  for (const p of pending) { await ctx.db.patch(p._id, { nextAttemptAt: Date.now() + 60000 }); await ctx.scheduler.runAfter(0, internal.polls.prepare, { code: p.code }); }
  const due = await ctx.db.query('polls').withIndex('by_status_due', q => q.eq('status', 'open').lte('nextAttemptAt', Date.now())).take(50);
  for (const p of due) await ctx.runMutation(internal.polls.close, { code: p.code });
} });
export const handleX = internalAction({ args: { postId: v.string(), owner: v.string(), text: v.string(), parentPostId: v.optional(v.string()) }, handler: async (ctx, a): Promise<{ handled: boolean; result?: Result }> => {
  const parent = await ctx.runQuery(internal.polls.context, { parentPostId: a.parentPostId });
  if (!X_VOTING_ENABLED) return { handled: isPollCommand(a.text) || Boolean(parent) };
  if (!isPollCommand(a.text) && !parent) return { handled: false };
  // Polls are public threads. Their replies never enter another user's wallet workflow.
  if (parent && !isPollCommand(a.text) && !/^\s*(?:[1-8][.!]?|0x[0-9a-f]{40})\s*$/i.test(a.text)) {
    const p = await ctx.runQuery(internal.polls.record, { code: parent.code });
    if (!p || pollChoice(a.text, p.spec.options) < 0) return { handled: true };
  }
  try {
    const who = await ctx.runQuery(internal.wallets.getXUserAndWallet, { xUserId: a.owner });
    if (!who?.wallet || who.wallet.status !== 'active' || who.wallet.chainId !== 4663) throw new Error('👛 Ask for your Pons Bot wallet first, or vote on the website with your Pons Bot account.');
    const wallet = who.wallet.address;
    if (parent?.correction && !isPollCommand(a.text)) {
      if (parent.owner !== a.owner) return { handled: true };
      await ctx.runMutation(internal.polls.correctToken, { code: parent.code, owner: a.owner, address: a.text.trim(), sourcePostId: a.postId });
      return { handled: true, result: { ok: true, pending: true, code: parent.code, message: 'Preparing the holder snapshot.' } };
    }
    const spec = parsePollCreate(a.text);
    if (spec) {
      const code = await ctx.runMutation(internal.polls.request, { requestKey: `x:${a.postId}`, ownerXUserId: a.owner, creatorWallet: wallet, creatorXUsername: who.user.username, source: 'x', sourcePostId: a.postId, spec, anchor: await pollAnchor() });
      return { handled: true, result: { ok: true, pending: true, code, message: 'Preparing the holder snapshot.' } };
    }
    const code = a.text.match(/\bPOLL-[a-f0-9]{16}\b/i)?.[0].toUpperCase() ?? parent?.code;
    if (!code) throw new Error('🗳️ Reply to a Vote created post with “vote 1”, or say “vote POLL-ID 1”.');
    if (!await ctx.runMutation(internal.polls.gate, { key: `vote:${a.owner}`, limit: 30, window: 60000 })) throw new Error('Please wait a minute before another voting request.');
    const result = /^(?:make|upgrade|endorse)\b/i.test(a.text) ? await endorse(ctx, code, wallet) : await vote(ctx, code, wallet, a.text, 'x', `x:${a.postId}`, ((BigInt(a.postId) >> 22n) + 1288834974657n).toString());
    return { handled: true, result };
  } catch (e) { return { handled: true, result: { ok: false, message: safePollError(e) } }; }
} });
function safePollError(e: unknown) {
  const m = e instanceof Error ? e.message : '';
  return /^(?:🗳️|⚠️|👛|This |Your |Only |Please |You can|Poll not found|A newer vote|Vote request mismatch)/.test(m) ? m : '⚠️ The voting check could not be completed. No new vote was recorded. Please try again.';
}
export const web = action({ args: { secret: v.string(), owner: v.string(), sessionId: v.string(), walletToken: v.string(), expectedWallet: v.string(), eventId: v.string(), operation: v.union(v.literal('create'), v.literal('vote'), v.literal('endorse'), v.literal('correct')), spec: v.optional(pollSpecValidator), code: v.optional(v.string()), choice: v.optional(v.string()) }, handler: async (ctx, a): Promise<Result> => {
  if (!process.env.WEB_AUTH_SECRET || a.secret !== process.env.WEB_AUTH_SECRET || !votingPreviewAllowed(a.owner)) throw new Error('Unauthorized');
  if (!/^[a-zA-Z0-9_-]{12,100}$/.test(a.eventId)) throw new Error('Invalid request identifier');
  const valid = await ctx.runAction(internal.polls.checkWebSession, { secret: a.secret, owner: a.owner, sessionId: a.sessionId });
  if (!valid) throw new Error('Unauthorized');
  if (!/^[a-f0-9]{64}$/.test(a.walletToken)) throw new Error('Connect and verify your voting wallet.');
  const verifiedWallet = await ctx.runQuery(internal.pollWalletAuth.session, { hash: await voteAuthHash(a.walletToken), binding: await voteAuthHash(`${a.owner}:${a.sessionId}`) });
  if (!verifiedWallet) throw new Error('Connect and verify your voting wallet.');
  const wallet = verifiedWallet.address;
  if (a.expectedWallet.toLowerCase() !== wallet) throw new Error('Your connected wallet changed. Refresh and verify the intended wallet.');
  // Smart-account ownership can change during a session. Revalidate ERC-1271
  // before each write rather than treating an old owner signature as permanent.
  if (verifiedWallet.contractProof && !await verifyVotingContractSignature(wallet as Hex, hashMessage(verifiedWallet.contractProof.message), verifiedWallet.contractProof.signature as Hex)) {
    await ctx.runMutation(internal.pollWalletAuth.revoke, { hash: await voteAuthHash(a.walletToken), binding: await voteAuthHash(`${a.owner}:${a.sessionId}`) });
    throw new Error('Your wallet authorization changed. Connect and sign again.');
  }
  if (!await ctx.runMutation(internal.polls.gate, { key: `vote:${a.owner}`, limit: 30, window: 60000 })) return { ok: false, message: 'Please wait a minute before another voting request.' };
  try {
    if (a.operation === 'create') {
      if (!a.spec) throw new Error('Provide the poll details.');
      const code = await ctx.runMutation(internal.polls.request, { requestKey: `web:${a.owner}:${wallet}:${a.eventId}`, ownerXUserId: a.owner, creatorWallet: wallet, source: 'web', spec: validatePollSpec(a.spec), anchor: await pollAnchor() });
      return { ok: true, pending: true, code, message: 'Preparing the holder snapshot.' };
    }
    if (!a.code) throw new Error('Poll not found.');
    if (a.operation === 'correct') { await ctx.runMutation(internal.polls.correctToken, { code: a.code, owner: a.owner, address: a.choice ?? '', creatorWallet: wallet }); return { ok: true, code: a.code, pending: true, message: 'Preparing the holder snapshot.' }; }
    if (a.operation === 'endorse') return await endorse(ctx, a.code, wallet);
    return await vote(ctx, a.code, wallet, a.choice ?? '', 'web', `web:${wallet}:${a.eventId}`, Date.now().toString());
  } catch (e) { return { ok: false, message: safePollError(e) }; }
} });
export const checkWebSession = internalAction({ args: { secret: v.string(), owner: v.string(), sessionId: v.string() }, handler: async (ctx, a): Promise<boolean> => {
  // Reuse the actual revocable session registry, not only a signed browser cookie.
  const { api } = await import('./_generated/api');
  return ctx.runAction(api.wallets.verifyWebSession, { secret: a.secret, ownerXUserId: a.owner, sessionId: a.sessionId });
} });
