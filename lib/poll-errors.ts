// Convex wraps errors from nested functions with request IDs and stack traces.
// Match known internal errors but return only fixed public text, never the wrapper.
const votingErrors: [string, string][] = [
  ['No tokens held at the poll snapshot', '⚠️ This wallet did not hold any of this token at the holder snapshot.'],
  ['This wallet has no eligible voting balance.', '⚠️ This wallet has no eligible directly held tokens at the holder snapshot.'],
  ['Your snapshot balance is below the minimum holding requirement.', '⚠️ Your token balance at the holder snapshot was below this poll’s minimum holding requirement. Buying more now will not change eligibility for this poll.'],
  ['You have already voted in this poll.', 'ℹ️ You have already voted in this poll.'],
  ['This poll has closed.', '⚠️ This poll has closed. No new votes can be recorded.'],
  ['This poll is not ready for voting.', '⚠️ This poll is still being prepared. Wait for it to open, then try again.'],
  ['This address is excluded from voting.', '⚠️ This wallet is excluded from voting in this poll.'],
  ['Snapshot block changed; voting is unavailable', '⚠️ The saved snapshot block could not be confirmed. Voting is unavailable for this poll; no vote was recorded.'],
  ['Snapshot voting weight mismatch', '⚠️ The saved voting balance could not be reconciled. No new vote was recorded.'],
  ['Voting supply reconciliation failed', '⚠️ The poll’s voting totals could not be reconciled. No new vote was recorded.'],
  ['Historical RPC is not configured', '⚠️ Historical balance checks are temporarily unavailable. Please try again later.'],
];
export function safePollError(e: unknown): string {
  const message = e instanceof Error ? e.message : '';
  for (const [internal, publicText] of votingErrors) if (message.includes(internal)) return publicText;
  if (/missing trie|historical state|archive|state.*pruned|header not found/i.test(message)) return '⚠️ The network provider could not retrieve your balance at the holder snapshot. Please try again later. This does not mean you were ineligible.';
  if (/timeout|timed out|429|rate.?limit|fetch failed|503|502/i.test(message)) return '⚠️ The network provider did not finish checking your snapshot balance. Please try again. No new vote was recorded.';
  return /^(?:🗳️|⚠️|👛|This |Your |Only |Please |You can|Poll not found|A newer vote|Vote request mismatch)/.test(message) ? message : '⚠️ The voting check could not be completed. No new vote was recorded. Please try again.';
}
