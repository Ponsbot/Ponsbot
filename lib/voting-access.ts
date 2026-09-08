// Temporary website-only preview. Use the immutable X ID, not a reusable
// handle or a caller-supplied username, for authorization.
export const VOTING_PREVIEW_X_ID = '2085516993315188736';
export const X_VOTING_ENABLED = false;
export const votingPreviewAllowed = (xUserId: string | undefined) => xUserId === VOTING_PREVIEW_X_ID;
