// Public rollout gates. Wallet authentication, holder eligibility and X
// creator verification are enforced separately by the voting handlers.
export const VOTING_PREVIEW_X_ID = '2085516993315188736';
export const X_VOTING_ENABLED = true;
export const WEBSITE_VOTING_PUBLIC = true;
export const votingPreviewAllowed = (xUserId: string | undefined) => WEBSITE_VOTING_PUBLIC || xUserId === VOTING_PREVIEW_X_ID;
export const anonymousVotingSession = (owner: string, sessionId: string) => WEBSITE_VOTING_PUBLIC && owner === 'guest' && /^[a-f0-9]{64}$/.test(sessionId);
