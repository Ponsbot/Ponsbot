export type ReferencePost = { id: string; referenced_tweets?: Array<{ id: string; type: "replied_to" | "quoted" | "retweeted" }> };

// No parent text or media is needed for thread protection. Reuse this poll's
// posts and persisted depths before making one batched, bounded X lookup.
export async function loadReplyMetadata(
  posts: ReferencePost[], eligible: Set<string>,
  getDepth: (parentId: string) => Promise<number | undefined>,
  fetchParents: (ids: string[]) => Promise<ReferencePost[]>,
) {
  const references = new Map(posts.map(post => [post.id, post]));
  const depths = new Map<string, number | undefined>();
  const parents = [...new Set(posts.filter(p => eligible.has(p.id)).flatMap(p =>
    p.referenced_tweets?.filter(r => r.type === "replied_to").map(r => r.id) ?? []))];
  for (let i = 0; i < parents.length; i += 5) await Promise.all(parents.slice(i, i + 5).map(async id => depths.set(id, await getDepth(id))));
  const missing = parents.filter(id => depths.get(id) === undefined && !references.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    const requested = new Set(missing.slice(i, i + 100));
    for (const post of await fetchParents([...requested])) if (requested.has(post.id))
      references.set(post.id, { id: post.id, referenced_tweets: post.referenced_tweets });
  }
  return { references, depths };
}
