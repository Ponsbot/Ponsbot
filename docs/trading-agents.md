# Pons Bot trading agents: disabled infrastructure

This is a **connected, opt-in live/paper runtime and Bot Yard**, not enabled by default.
No flags were enabled, deployments performed, accounts provisioned, deposits sent,
approvals signed, or real trades executed during implementation. A gated cron and
gated X/web adapters are now registered in code but are inert by default.
Owner-initiated real-wallet sales and withdrawals are implemented under a separate
disabled execution flag. Autonomous real trading is implemented behind the separate
master/live/scheduler gates and has not been enabled or exercised on-chain.

## Scope

Agents primarily buy/sell **public Pons Bot launch tokens**, identified by contract
address in `tokenLaunches`, `launchMode=pons`, `publicPublished=true`, a recorded
launch transaction, and absence from `TOKEN_INDEX_EXCLUSIONS`. The generic token
registry is deliberately NOT the allowlist. A separate canonical allowlist permits
PONS and the supported pairing-asset catalog, collectively capped at 20% of each
bot's completed autonomous trades. Both bonding-curve and graduated platform launches qualify. Token symbols
are display labels, never authority. Membership is rechecked at paper settlement,
and before live signing, so model output cannot authorize a removed or private token.

Four platform fills unlock one secondary fill. Counters start at zero when this
policy is introduced, persist across restarts and UTC day boundaries, and are
separate for live and paper trading. Buys and sells each count once. Approvals,
funding/conversion hops, holds and failed target trades earn no quota. Receipt
reconciliation counts a confirmed target fill once even if its later conversion
fails. Owner-directed sales and withdrawals are outside this autonomous quota.
Consequently an autonomous secondary sale may wait for more platform fills; the
owner can still exit manually. Secondary trades may be less than 20%, never forced.

ETH is operating cash for purchases, sale proceeds and gas, not a target selected
by the agent. The live adapter uses a launch's paired asset as an internal
swap hop; independently selected pairing assets instead consume secondary quota. There are no transfers,
burns, launches, LP positions,
bridges, fee-control actions, or arbitrary contract calls in the agent action set.

## Flags

All flags are opt-in, exact `true`, and default to disabled:

```
TRADING_AGENTS_ENABLED=false
TRADING_AGENTS_OWNER_EXECUTION_ENABLED=false
TRADING_AGENTS_LIVE_ENABLED=false
TRADING_AGENTS_PAPER_ENABLED=false
TRADING_AGENTS_SCHEDULER_ENABLED=false
TRADING_AGENTS_X_ENABLED=false
TRADING_AGENTS_WEBSITE_ENABLED=false
TRADING_AGENTS_WALLETS_ENABLED=false
```

For a private paper test the master/paper/scheduler flags belong in Convex; the
master flag also belongs in the matching signer deployment. The website flag
must match in Vercel and Convex. Wallet provisioning requires its flag on both
sides. X commands require the X flag in Convex. None were written to environments.
Live trading and bot funding require the live flag. Convex and the signer must
both have master/live enabled; scheduling additionally requires scheduler in Convex.
The cron exits immediately while disabled.
Pausing remains possible even with the master flag disabled. Master disable does
not erase paper agents; re-enabling paper mode allows explicitly running agents
to be leased again. Existing paper bots require explicit internal `activateExisting`
migration before live scheduling; simulated balances never become real balances.

## Implemented components

- `lib/trading-agents/policy.ts`: strict structured decisions, exact uint256
  amounts, fresh scope-bound quotes, slippage/gas/reserve/position/daily-turnover
  checks and pure paper settlement. Buy amount is native wei, sell amount token
  base units. Daily budgets use UTC and count both buys and sells. Paper gas is
  modeled from the trusted quote, not reported as actual blockchain expenditure.
- `convex/tradingAgents.ts`: internal create, start/pause, policy changes,
  bounded token discovery and status, atomic cycle leases and immutable results.
  Each owner can create up to three bots total across creation paths, including draft and paused bots. New agents start in draft.
  Policy edits pause the agent; paper balances are not reset. Policy versions and
  lease fencing block late completions after pause/change/recovery. Missed cadence
  slots are skipped instead of backfilled in a burst. Repeating completion cannot
  fill the same paper trade twice. New leasing abandons expired paper work only.
- `paper-worker.ts`: dependency-injected, bounded one-cycle driver; never started
  on import. It accepts a reasoner and a separately trusted quote adapter. Provider
  failures request reconciliation, not blind re-execution. Underlying adapters
  must respect AbortSignal and must be read-only except for atomic paper completion.
- `eliza-bridge.ts`: staged Eliza-style provider/action boundary, bound to one
  runtime agent and Pons agent. Decisions cannot set wallets, recipients, policy,
  quote values, or owner. Old cycle/version submissions fail. No external Eliza
  runtime/package is installed or contacted yet. SDK integration remains to test.

## Authority and storage

All writes and worker queries are internal. The gated `publicYard` query returns
only display DTOs. Owner-facing adapters derive
the numeric X user ID from verified authentication, not a supplied username or
model output. Worker calls must be scoped to their leased cycle. Eliza must never
receive CDP credentials, raw signing tools, arbitrary plugins or access to a main
user wallet. Market/token/social content is untrusted data, not policy authority.
Paper holdings and history live only in the new tables, never in real wallet,
platform volume, public recent-actions or creator-fee statistics.

## Bot Yard product layer

- Staged grammar: `@ponsbotfamily create a bot named NAME everything after the
  name is its character description`. Use quotes for multi-word names. The full
  description is retained (maximum 2,000 characters, explicit error above it,
  never silently truncated). The first unquoted word is the name. Case and Unicode
  are supported. The X adapter is wired but gated off by default.
- `createYardBotFromPost` reads the owner and text from the recorded X interaction,
  not a model-supplied user ID. Each original post creates at most one draft.
  It does not create/fund a wallet, publish a reply or start an agent.
- Character descriptions are creative context, not execution authority. The Eliza
  context carries the saved character and can carry 15 recent public log summaries.
  The prompt builder retains the personality while prohibiting permission changes.
- One-time versioned SVG-native pixel-character designs derive from name and
  description, then are stored on the agent. They are deterministic procedural
  pixel art, **not AI-generated illustrations**. The renderer accepts only that
  bounded design format, not user/model SVG. No image service or per-visit image
  generation is used. A later reviewed image generator can replace creation only.
- Separate fixed slots: thoughts every 15 minutes, trades every 45 minutes. At a
  shared boundary the thought runs first, then one trade is eligible immediately.
  Public thoughts are short observations, not internal model chain-of-thought.
  Thought slots cannot trade. Failed/expired trade slots advance to the next slot
  instead of silently retrying trades every two minutes. Pause/resume skips missed
  slots. No real scheduled worker is running yet.
- Buys are limited in backend settlement to 20% of **current native Robinhood ETH
  cash**, with gas and a reserve retained. WETH/other holdings are not counted as
  native ETH cash. Sells may use any percentage up to 100% of a held platform token;
  the per-buy cap does not apply to sells. Token eligibility, available gas and
  applicable daily limits still apply. A trade slot can log a skip if not executable.
- Initial Yard paper defaults: 45-minute trade cadence, 32 trades/day, 20 positions,
  3% maximum slippage, 0.002 ETH modeled per-trade gas ceiling, 0.064 ETH daily gas
  ceiling and 0.001 ETH cash reserve. These are simulation policy defaults, not
  claims about actual gas costs. The dynamic 20% cap controls buy size. Yard drafts
  start with zero paper cash and do not receive sponsorship or funds.
- Internal `yardList`/`yardDetail` expose bounded presentation DTOs. They omit owner
  identifiers, creation keys, policies, worker leases and raw diagnostics. No public
  API proxy is added. Public log text is rendered as text, never HTML.
- `components/BotYard.tsx` provides a walking character yard, stationary selection
  buttons, a personality/log panel, reduced-motion support, and dedicated-wallet
  and explorer-history buttons. Wallet buttons are disabled without a verified
  wallet binding. The existing wallet-page integration still needs validation
  against newly provisioned agent wallets before launch.
- `/bot-yard` renders explicit demo fixtures only when BOTH
  `NODE_ENV=development` and `BOT_YARD_PREVIEW_ENABLED=true`. It returns 404 in
  production regardless of that preview flag. Separately, the explicit website
  feature flag enables real stored paper-bot data and navigation. The live-data
  client retains its last successful view on errors, cancels stale selections,
  pages 24 bots at a time and refreshes every 30 seconds only while visible.
  To preview fixtures locally, set the preview flag only in the dev-server process.

## Remaining integration before any live rollout

1. Run the connected paper runtime in a private deployment with actual OpenRouter
   and the authenticated signer market reader. Local tests use mocked providers.
   Eliza is optional; no separate Eliza service is necessary.
2. Implement fresh executable route quotes, durable signed-envelope persistence,
   approval recovery and paired-asset conversion recovery for the live executor. Do not
   equate a recorded public launch with a guaranteed safe/liquid investment.
3. Run paper strategies and concurrency/restart/failure tests against a private
   deployment. The current tests are local simulations, not a claim of profitable
   strategy performance or chain execution readiness.
4. The gated CDP provisioner now uses the separate `agent:<id>` HMAC identity
   namespace. Review actual wallet provisioning and binding in a private test,
   then connect it to the live executor and its budget reservations before signing.
   Never reuse paper lease-expiry recovery for possibly broadcast real trades.
5. Add real portfolio valuation, full on-site chain history and live transaction
   outcome display. The implemented wallet page links to the chain explorer;
   owner controls use actual balances and the shared execution journal (see below).

## Owner management page (staged)

`/bot-yard/my-bot` lists only bots belonging to the authenticated X account.
The My Bot links in desktop/mobile navigation and the yard appear only after
an authenticated ownership lookup. The server validates the signed cookie and
Convex checks the active, non-revoked web session before reading the owner index.
Responses are private/no-store. No browser-supplied owner or recipient is used.

The page includes per-token Sell all controls and an ETH amount field with the
owner's signed-session Pons Bot wallet as the displayed withdrawal destination.
The owner page now shows on-chain holdings, with explorer token discovery and
RPC balance validation (up to 100 discovered/known assets). Partial discovery
is labelled. It never treats the paper portfolio as real funds.

`TRADING_AGENTS_OWNER_EXECUTION_ENABLED=true` together with the master flag
enables owner sales and withdrawals in Convex and the signer. The website flag
is also required for the UI. No flags have been changed as part of development.
POST requires same-origin CSRF, a recent signed X session and active Convex
session. Convex derives the destination from the owner's active Robinhood wallet,
checks ownership, and permits only one active operation per bot. The signer
independently verifies both CDP account identities. Each bot's account uses its
own `agent:<id>` namespace; the owner's ordinary `x:<id>` wallet is not the source.

Sell all uses existing bonding-curve/V3/V4 routes with 3% slippage; paired-token
proceeds may remain in the pairing asset. Withdrawal sends an exact selected ETH
amount, reserving transaction gas, only to the registered owner wallet. There are
no arbitrary recipients, calldata, token transfers or user-supplied signer identities.

`tradingAgentExecutions` persists unsigned envelopes before signing and signed
bytes before broadcast. Step-fenced writes, immutable request keys and nonce
floors make retries reuse the same spend. Approval receipts schedule the next
step; a one-minute recovery tick resumes interrupted jobs. Uncertain signed
transactions remain locked, never silently replaced or timed out as failures.
Stuck/dropped or underpriced transactions may require operator reconciliation;
there is no automatic fee replacement or lock release. Secrets and signed bytes
are excluded from the owner response. No live transaction has been tested yet.

This executor handles explicit owner sales/withdrawals and autonomous live jobs
through the same per-bot lock. Live decisions reserve independent budgets and
use actual balances, never the paper portfolio. X funding is gated by live mode.
6. Review and explicitly authorize rollout. Keep the current application and
   other projects' credentials/deployments untouched until then.

## Unique names and status command (staged)

All creation mutations reserve a global `nameKey` in the same serializable Convex
transaction as creation. Keys use NFKC normalization, lowercase and collapsed
whitespace. Pausing does not release a name. Idempotent replay of the same creation
returns the original bot; another creation receives `BOT_NAME_TAKEN`.
The schema now requires `nameKey`: if paper records were deployed elsewhere before
this change, backfill keys and resolve collisions before deploying this schema.
No production records or deployments were changed here.

The internal read-only `checkBotPost` accepts `@ponsbotfamily check on BOTNAME`,
including case variations, quoted/multiword names and ending punctuation. It returns
a long-format reply with the latest successful thought, last completed paper trade
and saved paper holdings. Dedicated indexes prevent a long thought history from
hiding the last trade. Registry decimals are used only for display; missing decimals
are explicitly labeled base units rather than guessed. No live RPC balances are
claimed. The reply adapter is connected to the gated X handler and reply queue.

## Bot funding command (staged)

`Send 0.01 ETH to bot Moss`, `Send $20 of ETH to the bot Moss`, and
`Send 1,000 PONSBOT to bot Moss` are explicit, anchored funding requests, optionally
preceded by the bot mention. Dollar-only amounts default to ETH. Percentages and
`all` require an asset. The name lookup uses the global normalized bot namespace.
Normal sends to accounts/addresses and promotional text do not match this parser.

`prepareBotFundingPost` reads an existing X interaction, derives the sender from
its author, and resolves the destination from the stored bot wallet only. Anyone
may propose funding another user's bot; this grants no control over it. Missing or
invalid wallet bindings fail closed. The adapter never signs or changes balances.
It returns `requires_transfer_validation` with execution disabled. Before public
rollout, connect the existing authenticated send pipeline (asset resolution,
ambiguity continuation, dollar conversion, gas simulation and durable exactly-once
execution) and verified bot wallet provisioning. Unknown assets must never be
guessed. Depositing a token does not authorize the agent to trade outside the
Pons Bot launch-token restriction. The send adapter is wired to the existing
authenticated send pipeline, gated by the explicit live-trading flag.

## Connected runtime details

- `convex/tradingAgentRuntime.ts` supplies OpenRouter model calls, bounded market
  snapshots, paper quotes and fenced completion to the existing worker. Twenty
  staggered worker slots per minute are scheduled only when enabled; idle workers
  make no provider calls. A newly created X bot starts at the next thought slot.
- Model calls are limited atomically to 160 per bot per UTC day and 12,800 globally.
  Token limits are 1,200 per thought and 2,500 per trade decision. No automatic
  model retry loop is used. No credentials enter model messages.
- `/v1/agents/markets` is authenticated, read-only and chain-checked. It batches
  Gecko prices through the existing shared quota/cache and reads metadata by
  multicall. Missing or stale prices cannot produce a paper fill.
- Paper fills use mark prices with a 1% execution haircut and modeled gas from
  the current gas price (300,000 units plus 10%). They do not model real pool
  price impact and must not be represented as executable liquidity quotes.
- `seedPaperCapital` is internal only, capped at 100 virtual ETH, and only applies
  before any cycle runs while the agent is not running. It never transfers money.
- The dedicated bot wallet page links to Blockscout balances/history, explicitly
  distinguishes paper activity, and never relies on the regular X wallet index.
- Real-money owner sales and withdrawals have a durable signer/broadcaster,
  gated separately and not enabled. Live autonomous jobs use the same journal.

## Autonomous live execution

New X bots use `mode=live` when live is enabled, otherwise paper. Only the
matching mode's worker leases them. Thoughts have 15-minute slots and trade
decisions 45-minute slots; missed slots are skipped, not replayed in a burst.
OpenRouter returns only a structured decision and public rationale, never calldata.

Before reserving a job, Convex verifies a complete fresh inventory, public launch
membership, the 20% native-ETH buy cap, held sell quantity, reserve, position and
daily budgets. It atomically reserves one execution shared with owner controls.
Before signing, the signer verifies the dedicated account, policy version,
public token membership, actual balance and remaining whole-job gas budget.

Native purchases/sales use existing Pons curve/graduated routes. Paired purchases
first buy the paired asset with the selected ETH amount, then use only the net
ERC20 proceeds recorded in that receipt to buy the platform token. Paired sales
record the paired proceeds before converting that exact amount to ETH. Existing
paired balances and outside deposits are not swept into the conversion. Routes
must be supported by the existing executor and simulations; no route is invented.

Approvals retain their phase. Confirmed money-moving phases advance durably,
with nonce/block floors. Retries reuse persisted signed bytes. A reverted or
unreconciled partial trade is not marked filled; its hashes remain visible and
leftover assets remain in the wallet. A failed conversion is not automatically
restarted as a new sale. Ambiguous signing/broadcast jobs remain locked for
reconciliation, including when a saved quote becomes stale or policy changes.

Default policy: 3% slippage per swap leg, 0.001 ETH reserve, 0.002 ETH maximum
gas allowance per complete job, 0.064 ETH reserved gas per UTC day, 32 trade
attempts per UTC day, up to 20 positions. Daily native purchase and gas budgets
are reserved once per job; they are conservatively retained even on failure.
Compound paired-route price impact can exceed a single leg's slippage tolerance.

Live results use confirmed receipt amounts and hashes. Holdings show the last
successful live observation and refresh following execution; missing observations
are unavailable, not a fabricated zero balance. The current build received static
TypeScript/lint checks only; new regression sources were added but not run, in
accordance with the no-testing instruction. No deployment or live funds were used.
