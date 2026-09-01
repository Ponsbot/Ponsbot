# Private automated-fee testing gates

This subsystem must remain invisible and unreachable from normal Pons Bot use while it is under test.

## Invariants during private testing

- Keep `AUTOMATED_BUYBACK_BURN_ENABLED=false` in every Convex environment.
- Enable `AUTOMATED_FEE_MANUAL_TEST_ENABLED` only in the private test deployment and list every permitted existing token explicitly in `AUTOMATED_FEE_MANUAL_TEST_TOKEN_ADDRESSES`.
- Keep the compile-time production execution lock disabled.
- Do not call enrollment from the launch pipeline.
- Do not add website, terminal, X-command, help-response, or wallet-command entry points.
- Do not automatically enroll newly launched tokens.
- Test only an explicitly selected existing token controlled by the test operator.
- Keep shared on-chain processing disabled except for the single transaction being manually tested.
- Use a quote-authorizer signing key distinct from the keeper. Every processing test must sign one exact EIP-712 execution envelope and confirm that altered or replayed envelopes revert.
- Pause processing immediately after each live test transaction.

## Required test progression

1. Compile all contracts with Solidity 0.8.24 and retain compiler output and bytecode sizes.
2. Run local unit tests with mock Pons factory, curve, escrow, ERC-20 tokens, routers, and holder distributor.
3. Run adversarial tests for reentrancy, malicious routers, unusual ERC-20 return values, stale deadlines, insufficient output, reassignment, exit, and administrative rotation.
4. Verify the current Pons factory, curve, escrow, creator-recipient transfer, fee sweep, and holder-distributor interfaces through source analysis and read-only live calls.
5. Deploy the control contract with processing disabled, followed by implementation, factory, and adapter.
6. Deploy and verify both dedicated route executors, then configure the adapter and executors while processing remains disabled.
7. Simulate every supported call with `eth_call` against the intended live state before broadcasting anything.
8. Manually upgrade one operator-controlled existing launch. Never use a newly created token for the first test.
9. Reconcile every receipt from emitted events and independent post-state reads before updating Convex totals.
10. Keep automatic scheduling disabled until an external audit and explicit production activation decision.

Local commands:

```powershell
npm run automated-fees:compile
npm run automated-fees:test
npm run automated-fees:manual-status
```

After compiling, `npm run automated-fees:plan-deployment` calculates the constructor wiring and predicted addresses from the configured admin's pending nonce. It validates the pinned live Pons dependencies and does not sign or broadcast. Predicted addresses are a nonce-sensitive planning snapshot, not deployed contracts.

`npm run automated-fees:deploy-core` repeats the live dependency, CDP-account,
artifact, nonce, address, and balance checks and prints a dry-run deployment
plan. It never signs or broadcasts by default. Live deployment requires both
`--execute` and the exact plan-bound confirmation token printed by that same
dry run:

```powershell
npm run automated-fees:deploy-core
npm run automated-fees:deploy-core -- --execute --confirm 0xPLAN_TOKEN
```

The execution script writes a git-ignored receipt manifest under
`.deployment-private/`, waits for every deployment receipt, verifies the
created address and code before advancing, configures the adapter and both
executors while processing is paused, and verifies that processing remains
disabled. If execution stops partway through, rerun the exact command; it will
only resume from a manifest whose plan identity and completed on-chain state
still match. Do not send unrelated transactions from the admin account between
the dry run and deployment.

After the paused core deployment verifies, prepare the isolated `Test / TEST`
launch with:

```powershell
npm run automated-fees:prepare-test-launch
```

This command is read-only. It verifies the dedicated CDP launcher, predicts a
deterministic fee vault, mines and persists no `b07` salt, predicts the Pons
token and curve, checks address collisions and balances, and simulates the
exact ETH-paired launch with no developer buy. It does not invoke the Pons Bot
launch pipeline, write Convex records, sign a transaction, or broadcast.

The scripts require the git-ignored official Solidity 0.8.24 binary and Foundry v1.7.1 binaries. They verify pinned SHA-256 checksums before running.

- Solidity: `https://github.com/ethereum/solidity/releases/download/v0.8.24/solc-windows.exe`
  - SHA-256: `580EE56B61BBCAAD953117E1E4A0874D90E6AF5CB4CE4359571D7DA25F6620E9`
- Foundry: `https://github.com/foundry-rs/foundry/releases/download/v1.7.1/foundry_v1.7.1_win32_amd64.zip`
  - Archive SHA-256: `6D41121B4BBB809845821C903619CFEE75ED364F2BDC58A6787C9B0454114537`

## Stop conditions

Immediately pause shared processing and stop testing if any receipt is uncertain, accounting differs from the 95/5 invariant, the dead-address balance delta differs from the adapter result, creator-recipient ownership is unexpected, or beneficiary delivery cannot be independently verified.
