export type XAuthorProfile = {
  id: string;
  username: string;
  verified?: boolean;
  verified_type?: string;
  subscription_type?: string;
};

// Only IDs supplied by X's post author_id are eligible. Never resolve an author
// from a handle in post text, and never use a cached badge as authorization.
export async function loadAuthorProfiles(
  authorIds: string[],
  fetchProfiles: (ids: string[]) => Promise<XAuthorProfile[]>,
) {
  const ids = [...new Set(authorIds.filter(id => /^\d+$/.test(id)))];
  const profiles = new Map<string, XAuthorProfile>();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const requested = new Set(batch);
    for (const profile of await fetchProfiles(batch)) {
      if (!requested.has(profile.id) || !/^[a-zA-Z0-9_]{1,15}$/.test(profile.username)) continue;
      profiles.set(profile.id, profile);
    }
  }
  return profiles;
}
