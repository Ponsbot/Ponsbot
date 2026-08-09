# Ponsbot

Ponsbot is a focused X reply bot for Robinhood Chain wallets and Pons V2 token launches.

## Current state

- Pons-inspired landing page
- Two-stage AI intent classification and command extraction
- Per-X-user Robinhood Chain wallets
- Wallet command parsing and prepared responses
- Pons V2 contracts and pair assets maintained in updateable Convex registries
- All transaction execution disabled by default
- Pons signer integration still requires a dedicated security pass before use

## Local setup

1. Copy `.env.example` to `.env.local` and add your test-environment credentials.
2. Run `npm install` if dependencies are not already present.
3. Run `npm run dev`.

## Pons reference

- Chain: Robinhood Chain (`4663`)
- Factory, launch router, swap contracts, and approved pair candidates are read from Convex tables at runtime
- Factory method: `launchToken(TokenParams,uint256,address)`
- Router method: `launchAndBuy(...)`
- Token metadata: name, symbol, logo, description, socials, fee wallet
- Launch configuration and pair economics must be read and verified immediately before production enablement
