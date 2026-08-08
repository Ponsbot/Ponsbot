# Ponsbot

Ponsbot is a focused X reply bot for Robinhood Chain wallets and Pons V2 token launches.

## Current state

- Pons-inspired landing page
- Two-stage AI intent classification and command extraction
- Per-X-user Robinhood Chain wallets
- Wallet command parsing and prepared responses
- Pons V2 factory and launch-and-buy router documented
- All transaction execution disabled by default
- Pons signer integration still requires a dedicated security pass before use

## Local setup

1. Copy `.env.example` to `.env.local` and add your test-environment credentials.
2. Run `npm install` if dependencies are not already present.
3. Run `npm run dev`.

## Pons reference

- Chain: Robinhood Chain (`4663`)
- V2 factory: `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
- Launch-and-buy router: `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948`
- Factory method: `launchToken(TokenParams,uint256,address)`
- Router method: `launchAndBuy(...)`
- Token metadata: name, symbol, logo, description, socials, fee wallet
- Launch configuration and pair economics must be read and verified immediately before production enablement
