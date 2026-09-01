import { afterEach, expect, it, vi } from "vitest";
import { reserveLookupSlot } from "../lib/x-wallet-flood-policy";
import { publicationCapacity } from "../convex/xPublicationBudget";
afterEach(() => vi.unstubAllEnvs());
it("halves category throughput without banking burst capacity", () => {
  vi.stubEnv("X_REPLY_BUDGET_SCALE", "0.5");
  const slots = reserveLookupSlot([], "1", "a", 1000000).slots;
  expect(reserveLookupSlot(slots, "2", "b", 1119999).allowed).toBe(false);
  expect(reserveLookupSlot(slots, "2", "b", 1120000).allowed).toBe(true);
});
it("halves shared publication budgets and counts existing attempts", async () => {
  vi.stubEnv("X_REPLY_BUDGET_SCALE", "0.5");
  const now=10000000;
  const events=Array.from({length:12},(_,i)=>({_id:String(i),postId:String(i),replyCategory:i<10?"wallet":"other",createdAt:now-1000,status:"published"}));
  const ctx:any={db:{query:(table:string)=>({withIndex:()=>({collect:async()=>table==="xPublicationEvents"?events:[]})})}};
  expect(await publicationCapacity(ctx,now)).toMatchObject({totalLimit:12,lowPriorityLimit:10,lowPriorityFull:true,waitMs:899000});
});
