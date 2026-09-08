# Voting wallet authentication

The Votes page uses ERC-4361 (Sign-In with Ethereum). Connecting an injected EIP-1193 wallet only selects an account; a verified signature is required before creating, voting, correcting a token, or endorsing a poll. This connection never invokes Pons Bot's wallet signer or requests an approval, transfer, or transaction.

## Authentication boundaries

- Website browsing and X voting are enabled publicly. Website actions require a verified external-wallet session or an active Pons Bot wallet session. X poll creation still requires a verified X account; voting depends on holder eligibility, not X verification.
- `WEBSITE_VOTING_PUBLIC` also remains false. When opened, external-wallet visitors do not need X sign-in. An HMAC-signed, HttpOnly browser cookie binds their CSRF tokens and wallet challenges; it never grants wallet authority. External writes still require the verified signature session. Pons Bot wallet operations still require the revocable X session.
- Account changes, failed connections, and expiry lock voting instead of silently selecting the Pons Bot wallet. Only an intentional successful disconnect permits fallback. Passive previews have a separate rate budget from voting actions.
- Challenges contain the canonical website origin, `/votes` URI, Robinhood Chain ID 4663, random one-use nonce, and five-minute expiry. The server supplies the entire message; the browser cannot substitute one.
- Nonces are atomically consumed before signature verification and cannot be retried or used by a different X/browser session.
- EOAs use local signature recovery. Deployed smart accounts use read-only ERC-1271 verification on chain 4663 and revalidation before every voting write. Counterfactual account deployment is not supported.
- A successful signature creates a random, thirty-minute, voting-only HttpOnly session cookie. Convex stores only its hash, scoped to the current X/browser session. Disconnect revokes the session; expiry is enforced server-side.
- Origin and CSRF checks protect all website writes. Client wallet addresses are consistency checks only, never authorization. The backend chooses the address from the verified session.
- Historical voting weight and official status are checked separately. Signing does not prove eligibility or token ownership by itself.
- One wallet has one final ballot per poll, shared across website and future X voting. A recorded vote cannot be changed.
- Website creators display their wallet; future X-created polls display the authenticated X username. Connecting an external wallet does not link it to a public X profile.

## Deployment and manual check

Existing `WEB_AUTH_SECRET`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_CONVEX_URL`, and Convex's `ROBINHOOD_RPC_URL` are used. No WalletConnect project ID or extra key is required. The browser URL must match the canonical site URL. Update Convex and Vercel together with the normal project workflow.

Open Votes, select a browser wallet, switch it to Robinhood Chain if requested, and sign the clearly labelled voting-only message. Create a poll, then cast a vote. Confirm duplicate ballots cannot change votes, and that changing the selected account or session expiry locks voting. Test a second wallet for eligibility and official endorsement. Test wallet-only participation without X login as well as an authenticated Pons Bot wallet.

Browser extensions and wallet-app browsers use EIP-6963 discovery with an injected-provider fallback. Mobile users must open the site inside their wallet app's browser. Ordinary mobile browsers without an injected wallet cannot connect directly. No relay, QR connector, or WalletConnect SDK is used. Only a verified SIWE signature authenticates the wallet. Restored providers are monitored for account, chain, and disconnect events before a saved identity is displayed.

Manual acceptance checks: connect from a desktop extension and supported iOS/Android wallet-app browsers; cancel during signing; reload and change accounts; expire the session; disconnect. Confirm no transaction approval is requested. Real-device testing remains required; automated tests do not interact with a user's wallet.

References: https://eips.ethereum.org/EIPS/eip-4361 and https://eips.ethereum.org/EIPS/eip-6963
