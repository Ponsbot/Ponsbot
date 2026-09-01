import { expect, it, vi } from "vitest";
import { loadAuthorProfiles } from "../lib/x-author-profiles";

it("fetches no profiles for an empty admitted set", async () => {
  const fetch = vi.fn();
  expect((await loadAuthorProfiles([], fetch)).size).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it("deduplicates trusted author IDs and bounds batches to 100", async () => {
  const ids = Array.from({ length: 101 }, (_, i) => String(i + 1));
  const fetch = vi.fn(async (batch: string[]) => batch.map(id => ({ id, username: `u${id}`, verified: false })));
  const users = await loadAuthorProfiles([...ids, "1", "@attacker"], fetch);
  expect(fetch.mock.calls.map(c => c[0].length)).toEqual([100, 1]);
  expect(users.size).toBe(101);
});
it("rejects unrelated identities and invalid handles, and never invents omitted users", async () => {
  const users = await loadAuthorProfiles(["1", "2", "3"], async () => [
    { id: "99", username: "attacker", verified: true },
    { id: "1", username: "real", verified: false },
    { id: "2", username: "not a handle", verified: true },
  ]);
  expect([...users.keys()]).toEqual(["1"]);
  expect(users.get("1")?.verified).toBe(false);
});
it("does not cache verification across polls", async () => {
  const fetch = vi.fn().mockResolvedValueOnce([{ id: "1", username: "old", verified: true }])
    .mockResolvedValueOnce([{ id: "1", username: "new", verified: false }]);
  await loadAuthorProfiles(["1"], fetch);
  expect((await loadAuthorProfiles(["1"], fetch)).get("1")).toEqual({ id: "1", username: "new", verified: false });
});
it("propagates lookup failures instead of providing cached authorization", async () => {
  await expect(loadAuthorProfiles(["1"], async () => { throw Error("429"); })).rejects.toThrow("429");
});
