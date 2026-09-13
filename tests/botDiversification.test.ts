import { expect, it } from "vitest";
import { diverseCandidates } from "../lib/trading-agents/diversification";

const tokens = Array.from({length: 120}, (_, i) => ({address: `token${i}`}));
it("rotates the shortlist across cycles and bots while preserving held tokens", () => {
  const owned = new Set(["token0", "token119"]);
  const a = diverseCandidates(tokens, owned, "botA:1", 60);
  expect(a).toHaveLength(60);
  expect(a.slice(-2)).toEqual([tokens[0], tokens[119]]);
  expect(a).toEqual(diverseCandidates(tokens, owned, "botA:1", 60));
  expect(a).not.toEqual(diverseCandidates(tokens, owned, "botA:2", 60));
  expect(a).not.toEqual(diverseCandidates(tokens, owned, "botB:1", 60));
});
it("deduplicates addresses and handles empty or all-held universes", () => {
  expect(diverseCandidates([], new Set(), "seed", 60)).toEqual([]);
  expect(diverseCandidates([{address:"ABC"},{address:"abc"}], new Set(["abc"]), "seed", 60)).toEqual([{address:"abc"}]);
  expect(diverseCandidates(tokens, new Set(tokens.map(t=>t.address)), "seed", 60)).toHaveLength(60);
});
