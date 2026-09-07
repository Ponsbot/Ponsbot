# Creator self-buyback layer: implementation checkpoint

Status: local signer/worker/reassignment/display integration built; replacement deployment
and an end-to-end live canary remain required. NOT approved for enrollment yet.
No token layers, fee-right transfers, public commands or launch pipeline changes have been made.

## Current revision: replacement layer v2, LOCAL ONLY

The addresses below are the older dormant foundation, not this revision. V2 changes ONLY
the new second-layer contracts. No source or deployed bytecode of the running primary
vault, primary factory, control, adapter, or primary executors is changed.

- Added unused-layer owner synchronization from live primary controller/beneficiary.
  This cannot select an arbitrary owner and cannot run on an already activated layer.
- Added replacement of a detached layer, retaining the historical layer and its ledgers.
  Full primary emergency exit remains irreversible; this is not primary reactivation.
- Added issued-at authorization and a ten-minute maximum signed quote lifetime.
- Classified unsolicited transfers as cash surplus, not fee income or automatic burns.
- Added independent payout/collection/burn timing policy and retry tests. The local
  production worker is now connected; it has not been deployed or exercised live.
- Deployment uses a separate `creator-burn-foundation-v2.json` private journal, exclusive
  local lock, unique lease instance, persistent uncertain-deployment marker and validated
  saved envelopes. Deploy the updated Convex lease functions before running this script.
  Never clear a crashed deployment marker or lock before reconciling its signed envelopes.
- Validation: 97 Solidity tests, 47 focused TypeScript tests, three deployment safety tests;
  application and Convex typechecks passed. External protocol contracts use test doubles.
- Read-only live check at block 56836555 confirmed the requested test primary remains active,
  wallet-controlled and not assigned a layer in the original deployed registry.

**Enrollment remains blocked pending replacement deployment and canary verification.**
The old deployed foundation must not be configured as the new layer. The signer requires
registry bindings, runtime code hashes, and the v2 quote-lifetime interface. This work does
not add an automatic enrollment path or enroll new launches.

## Production integration, local implementation

- Authenticated `/v1/creator-burn/` inspection, preparation, broadcast and receipt routes.
  Existing enrollment-proof authentication is required in addition to the signer token.
- Primary delivery calls `collectAndPay`, never direct delivery to the layer. Its receipt
  separates the upstream allocation, actual wallet cash and self-burn reserve.
- `creatorBurnEngine` stores immutable signed envelopes before broadcasting, reconciles
  their receipts across restarts, shares the global keeper lease and blocks overlapping
  primary processing/controller changes. A pending hash is never discarded on timeout.
- Cash payments precede burns. Historical beneficiaries are tracked separately. Confirmed
  receipts are deduplicated by chain/layer/transaction/log index. Conflicting copies fail.
- Existing reassignment signing maps to owner-only layer `reassign`; holder sharing maps
  to atomic `shareWithHolders` after verifying the holder registry. Reassignment resets
  future self-burn percentage to zero; old cash and reserves retain their original owner.
- Public token queries expose the human recipient plus verified self-burn percentage.
  Wallet history shows actual layer payouts, not the full upstream 95% or reserved funds.
  Layer payouts use a distinct label because recovered surplus is not necessarily fees.
- Permissionless collection is reconciled from finalized Allocation/Paid receipts since
  the primary processing block. A collection without payment triggers the remaining
  payout, not another buy. Ambiguous/missing evidence waits rather than inventing credit.
- A bounded historical scanner starts at the layer's creation block and persists a cursor.
  It ingests external transactions with the same deduplication keys as the live worker.
  Actual payouts update delivery totals once; upstream allocation no longer double-counts.
- Pending envelopes have a separate scheduling query even while disabled. Slow keeper
  transactions can receive a same-nonce, same-call fee replacement; all hashes are checked
  and signed envelopes retained in a private journal. Fees are capped relative to the
  current gas market. A provably consumed but unrecognized nonce quarantines only the
  affected program and releases the shared keeper reservation; it is not marked paid.
- Each owner's economically deferred reserve has its own retry time. Current-owner dust
  no longer prevents an older owner's reserve from being serviced.
- `internal.creatorBurnEngine.changePercentage` accepts requestId, immutable ownerXUserId,
  tokenAddress, and percentage (0–100, up to two decimal places). It checks the linked
  wallet, acquires its execution lock, and uses the existing durable controller journal.
  The signer independently verifies live layer ownership and the matching CDP wallet.
  Only `setPercentage(uint16)` is signed; collection uses the previous percentage first.
  This internal command-adapter entry point does not introduce new public X syntax or
  enroll a token. Background controller recovery resumes pending percentage changes.

Configuration for BOTH the signer host and Convex worker:
`CREATOR_SELF_BUYBACK_ENABLED` (default off), `CREATOR_SELF_BUYBACK_FACTORY_ADDRESS`.
The signer additionally requires `CREATOR_SELF_BUYBACK_EXECUTOR_ADDRESS`,
`CREATOR_SELF_BUYBACK_FACTORY_CODE_HASH`, `CREATOR_SELF_BUYBACK_EXECUTOR_CODE_HASH`.
Use runtime hashes of the verified replacement deployments, not creation-bytecode hashes.
Existing automated-fee keeper/quote roles and execution switches are also enforced.

Before enrollment: deploy/verify the replacement foundation, update both applications,
verify the above bindings, then exercise collect/pay/burn/reassign/holder exit with a
dedicated canary. Confirm that payout history agrees with actual transfers. No existing
primary-vault source or deployed contract is modified by this integration.

## September 7 deployment checkpoint

- Executor: `0x64173B93Ddc129D7F85Cc8aC73af20CadCD8C704`
- Layer factory: `0x2FcC0328306fAC558C3508C892263E4A2D9482dB`
- Registry binding is confirmed; compiled runtime comparisons passed for both contracts.
- Private signed-envelope journal: `.deployment-private/creator-burn-foundation.json`.
- Deployment runner: `scripts/deploy-creator-burn-foundation.mjs` (dry run by default).
  Execution requires the exact plan confirmation and an existing program for the shared
  Convex admin deployment lease. It cannot create a layer or enroll a token.
- At that checkpoint 83 Solidity tests passed, including 11 integration tests using the real primary vault,
  adapter, control, layer, executor and factories. External Pons curve/escrow/router behavior
  still uses test doubles; this is not a live execution test or independent audit.
- Executor accepts only registered active layers, canonical Pons token/pair routes, and
  a signed expected phase. It supports native/ERC-20 curves and canonical graduated V4 pools,
  clears allowances and verifies actual dead-address output. No arbitrary router calldata.
- This was the original deployment checkpoint. The local integration described above
  supersedes its missing backend work, but the old deployment remains unsuitable for v2.

## Implemented

- Dedicated per-primary-vault layer and an admin-only deployment registry.
- Current upstream controller becomes initial layer owner. Creating a layer grants no fee rights.
- 0–100% of the upstream beneficiary allocation, default zero, basis-point precision.
- Owner-only percentage changes and reassignment. Reassignment resets future percentage to zero.
- Existing cash and buyback reserves remain attributable to their original owner.
- Separate receipt/collection, cash delivery and quoted self-buyback execution.
- Fixed asset, fixed token, fixed executor, exact input-spend and dead-address output checks.
- Keeper execution gated by existing processing control; raw hash authorization binds chain,
  layer, upstream, asset, token, beneficiary, amount, minimum, deadline, executor, route and nonces.
- Owner can release their unspent reserve into their own cash allocation.
- Direct detach, emergency direct-wallet exit, and holder-registry-validated exit.
- Standalone backend percentage/split/ABI/digest helpers. Rollout flag defaults false.

## Required before token enrollment or public wiring

1. Further validate the executor against live Pons curve/graduated routing and taxed tokens.
   The test executor is deliberately a mock and MUST NEVER be deployed for real funds.
2. Extend adversarial/reentrancy and taxed-token tests. ERC-20 accounting, bad-signature,
   replay, registry, and real upstream-contract integration tests now exist; external Pons
   contracts still need live read-only simulation coverage.
3. Add versioned Convex layer records: primary program ID, layer address, actual owner,
   owner X ID (if known), policy nonce, beneficiary-ledger entries and separate self-burn runs.
   Never substitute the layer address for the human beneficiary in displayed fee ownership.
4. Signer must verify factory registration, bytecode, upstream association, current layer owner,
   token and pair at every privileged operation. Caller-supplied addresses are not authorization.
5. Enrollment: resolve exact launch and current rights, create dormant layer, recheck ownership,
   settle/reassign upstream to layer as BOTH controller and beneficiary, verify receipt and state,
   then set requested percentage. Freeze upstream scheduling during this journaled transition.
   New tokens use normal primary enrollment first; existing tokens use the same opt-in transition.
6. Existing claim, keeper, reassignment, holder-sharing and ownership-display code assumes a
   wallet beneficiary. Update ALL these before enrolling any real layer. Stage-one delivery to
   a layer is not a user payout and must not be counted twice in stats or confirmations.
7. X commands require exact resolved token, wallet-owned layer authorization, percentage validation,
   durable sibling/retry deduplication and terminal confirmations. Reuse existing CA/ticker resolution.
   Never interpret setting a percentage as a one-off wallet buy or burn.
8. Holder distributor creation must precede holder exit. Verify distributorOf(token) on-chain.
   The upstream emergency-exit behavior intentionally has no 5% buyback during exit settlement.
9. Exit does not erase outstanding cash/reserve rights. Retain old layer history. The local
   replacement factory allows a fresh dormant layer after detach, but rejects replacement
   of an active/dormant unexited layer and cannot reactivate an exited primary vault.
10. Separate minimum-economic self-buyback threshold, signed envelopes, receipt reconciliation,
    lease locking and delayed retries. Do not recursively process fees generated by a buyback.
11. Deployment manifest, dry-run/confirmation scripts, pin checks and staged activation.

## Timing semantics

Percentage changes and reassignment first collect already-credited upstream fees. Unswept Pons
fees have no historical per-owner allocation here and follow the policy in force when credited,
consistent with the upstream system. In local v2, forced ETH/donations are separately allocated
as cash surplus. Only a layer-initiated upstream withdrawal is classified as fee income.

### Critical delivery boundary

DO NOT call primary `deliverBeneficiaryAllocation(layer, ...)` for an enrolled v2 layer.
That direct delivery is treated as cash surplus and would bypass the optional self-burn.
Instead call `layer.collectAndPay()` after primary processing confirms, reconcile the primary
withdrawal AND layer Allocation/Paid events. Separate `collect()` and `withdrawFor(owner)`
remain available for recovery and historical-owner balances. Self-buyback is deliberately
outside the cash-payout transaction. Receipt helpers distinguish actual cash transfer output,
allocated reserves, surplus and burned tokens; their deduplication keys still require durable
insertion by the worker. The local primary fee worker now implements this branch.

### Intended timing, covered by the local planner tests

- Leave the primary cadence unchanged: ten-minute checks for the first four hours after
  launch, hourly thereafter, subject to its existing threshold and chain availability.
- Once primary processing confirms, collect the 95% without waiting another primary slot.
- Deliver already allocated creator cash first, with no second accumulation threshold.
- After a receipt confirms, advance immediately. Pending receipts are checked every minute.
- Burn only after cash obligations are resolved; missing pricing or a failed self-buyback
  must not delay a successful cash payout. The local planner accumulates a reserve below
  $1 or below five times estimated burn gas cost; the local signer enforces this rule.
- Burn retries back off independently, capped at fifteen minutes. They do not move the
  primary sweep schedule and do not recursively sweep fees generated by the self-buyback.
- Keep reconciling existing transaction receipts after disabling; do not send new ones.
- Reassignment must preserve and service previous-owner ledger balances, not merely the
  current owner's balance. A full exit disables further self-burn; owners can release reserves.

`CREATOR_SELF_BUYBACK_ENABLED` gates the new keeper submissions. Read-only reconciliation
of stored transactions continues when it is disabled. It does not enable enrollment.

The token-page presentation is prepared for an optional `creatorSelfBurn` public field
(`active`, `percentageBps`). The site query must populate it ONLY from a verified active
layer and continue resolving `creatorFeeRecipient`/`feeRecipientUsername` to its human
owner, never the layer address. At 100% it replaces the recipient with "Buyback and burn
$TOKEN"; partial allocations append "(XX% buyback and burn $TOKEN)" to the recipient.
The local site query populates this field only for a verified enrolled program; ordinary
pages remain unchanged. Do not advertise the capability before canary verification.
