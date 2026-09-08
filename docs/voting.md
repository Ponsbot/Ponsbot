# Token-holder voting

## Rollout

Current rollout is a private website preview for @ponsboyfamily (immutable X
account ID). `/votes`, its API, and Convex read/write actions require that
account's active session. Navigation is hidden for everybody else. Raw poll
queries are internal only. X creation, voting and result publication are disabled
in `lib/voting-access.ts`; the command examples below describe future rollout.

Deploy Convex (the existing `npx convex dev` workflow) and the website together.
No additional secrets are required. Uses existing X publication credentials,
`WEB_AUTH_SECRET`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_CONVEX_URL`, and the
historical-capable `ROBINHOOD_RPC_URL` in Convex.

No external wallet connection is implemented. Web creation, voting and
endorsement use the existing revocable X-authenticated Pons Bot wallet session.
Never expose an endpoint which accepts an arbitrary caller-supplied wallet as
proof of ownership. Future wallet connection needs signed, expiring, one-use
challenges scoped to chain, origin, poll and action.

## Commands

```text
@Ponsbotfamily Create a vote for $PONSBOT
Question: Should we hold a community event?
Options: Yes, No
Time: 1 day
```

Token can be a ticker, contract, or both. Both must match the onchain symbol.
Ambiguous/unknown tickers ask for a matching CA; only the creator may continue
that correction and it expires after ten minutes. Unicode symbols work.

Minimum holdings default to 0.1% of total supply. Override by adding a final
`Minimum holding: 0.05%` line (0–100%). Zero still requires a positive balance.
Polls support 2–8 distinct options and durations of 1 hour–7 days. Creation is
limited to 10 polls per user per day; voting endpoints allow 30 requests/minute.

Reply `vote 1` or the option text directly to the bot's Vote created post.
Standalone voting uses `vote POLL-XXXXXXXXXXXXXXXX 1`.
Endorse with `make POLL-XXXXXXXXXXXXXXXX official`, or the website button.
Existing X API intake filters and publication limits still apply.

## Snapshot and accounting

Anchor to head minus 20 blocks and store its hash. Read totalSupply and balances
at that exact block, never at vote-submission time. Recheck the hash when voting.
No holder transfer-history scan is necessary: each voter gets a historical
balance read. Recorded ballots retain that weight when their option changes.

Exclude the dead address, Pons launch locker/curve, supported V4 singleton
inventories and every matching V3 pool discovered from the supported factory.
Exclusions are address-deduplicated. Discovery is bounded and fails closed if
it cannot complete, rather than silently understating excluded liquidity.
Other protocols, rebasing-token semantics and LP beneficial ownership are not
supported by this direct-holdings policy. Display that scope on each poll.

Turnout = participating snapshot tokens / active snapshot supply. This is not
a holder count and is not the percentage of threshold-eligible tokens: the
active denominator can contain small holders below the chosen minimum.

One atomic ballot per lowercase wallet per poll, independent of channel. The
latest choice replaces the old tally without increasing participant weight or
wallet count. Idempotency events prevent replaying the same submission.
Closed polls reject all new ballots at the database mutation, even if a read
started before the deadline. No voting action signs a blockchain transaction.

## Official status

Read Pons factory launch data at the snapshot. Verify either the actual launcher
or current direct fee recipient. For managed fee rights, require the stored
trusted primary vault to still be the onchain recipient, verify its token and
controller, and follow only the trusted burn-layer address to its verified
token and current owner. Database labels alone cannot authorize endorsement.

An authorized wallet can endorse an open Community poll. No question, option,
deadline, threshold or snapshot changes. The Official flag records endorsement
at that time; it is not a binding governance instruction or automatic transfer.

## Recovery and publication

Snapshot workers use leases and bounded retries, backed by a minute recovery
cron. The duration starts once the verified snapshot is ready. X Vote created
posts and closing results are durable priority A publications with unique keys.
Closing results target the actual bot Vote created post, not the user command.
Website-only polls need no X publication. A delayed creation publication after
the deadline schedules the results once its post ID is known.

An ambiguous X publication remains uncertain under the existing queue policy;
it is not blindly resent. Inspect `polls`, `pollVotes`, `pollVoteEvents` and the
bound `xReplyQueue` rows when diagnosing. Never replay a wallet transaction to
recover a vote: voting does not require one.
