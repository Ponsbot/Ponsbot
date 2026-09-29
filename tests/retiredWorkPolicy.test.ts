import { expect, it } from "vitest";
import { canArchiveFinishedUncertain, canRetireBlockedReply } from "../lib/retired-work-policy";
const now = 200000000;
it("only retires old conclusively blocked publications", () => {
  const row = { status: "blocked", updatedAt: 0, lastError: "You attempted to reply to a Tweet that is deleted or not visible to you." };
  expect(canRetireBlockedReply(row, now)).toBe(true);
  for (const change of [{ status: "sending" }, { status: "uncertain" }, { updatedAt: now }, { responsePostId: "123" }, { lastError: "timeout" }]) expect(canRetireBlockedReply({ ...row, ...change }, now)).toBe(false);
});
it("archives only already-notified terminal uncertainty, never pending execution", () => {
  const row = { status: "uncertain", executionStage: "finished", finalPublicationStatus: "published", finalResponsePostId: "123", updatedAt: 0 };
  expect(canArchiveFinishedUncertain(row, now)).toBe(true);
  for (const change of [{ executionStage: "funding" }, { finalPublicationStatus: "pending" }, { finalResponsePostId: undefined }, { updatedAt: now }]) expect(canArchiveFinishedUncertain({ ...row, ...change }, now)).toBe(false);
});
