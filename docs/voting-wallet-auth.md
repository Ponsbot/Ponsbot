# Voting wallet authentication

The Votes page uses ERC-4361 (Sign-In with Ethereum). Connecting an injected EIP-1193 wallet only selects an account; a verified signature is required before creating, voting, correcting a token, or endorsing a poll. This connection never invokes Pons Bot's wallet signer or requests an approval, transfer, or transaction.

## Authentication boundaries

- Temporary preview access still requires the existing, revocable X session and the immutable preview account ID. X voting remains disabled.
- Challenges contain the canonical website origin, `/votes` URI, Robinhood Chain ID 4663, random one-use nonce, and five-minute expiry. The server supplies the entire message; the browser cannot substitute one.
- Nonces are atomically consumed before signature verification and cannot be retried or used by a different X/browser session.
- EOAs use local signature recovery. Deployed smart accounts use read-only ERC-1271 verification on chain 4663 and revalidation before every voting write. Counterfactual account deployment is not supported.
- A successful signature creates a random, thirty-minute, voting-only HttpOnly session cookie. Convex stores only its hash, scoped to the current X/browser session. Disconnect revokes the session; expiry is enforced server-side.
- Origin and CSRF checks protect all website writes. Client wallet addresses are consistency checks only, never authorization. The backend chooses the address from the verified session.
- Historical voting weight and official status are checked separately. Signing does not prove eligibility or token ownership by itself.
- One wallet has one ballot per poll, shared across website and future X voting. Updating a choice replaces the old ballot.
- Website creators display their wallet; future X-created polls display the authenticated X username. Connecting an external wallet does not link it to a public X profile.

## Deployment and manual check

No new keys are needed. Existing `WEB_AUTH_SECRET`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_CONVEX_URL`, and Convex's `ROBINHOOD_RPC_URL` are used. The browser URL must match the canonical site URL. Deploy Convex with the normal project workflow (including the new tables/functions), then Vercel.

Sign in as the preview account, open Votes, select a browser wallet, switch it to Robinhood Chain if requested, and sign the clearly labelled voting-only message. Create a poll, then cast/update a vote. Confirm that disconnecting, changing the selected account, session expiry, and using a different browser all require verification. Test a second wallet against the same poll to check eligibility and official endorsement.

Browser extensions and wallet-app browsers are supported through EIP-6963 discovery with a legacy injected-provider fallback. QR-based WalletConnect and native mobile deep links are not included. A live browser-wallet signature test is still required after deployment; automated tests do not interact with a user's real wallet.

References: https://eips.ethereum.org/EIPS/eip-4361 and https://eips.ethereum.org/EIPS/eip-6963
