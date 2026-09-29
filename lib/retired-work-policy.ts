export function canRetireBlockedReply(row: { status: string; updatedAt: number; lastError?: string; responsePostId?: string }, now: number) {
  return row.status === "blocked" && row.updatedAt < now - 86400000 && !row.responsePostId
    && /^(You attempted to reply to a Tweet that is deleted or not visible to you\.|Posts are limited to a maximum of one cashtag)/.test(row.lastError ?? "");
}
export function canArchiveFinishedUncertain(row: { status: string; executionStage?: string; finalPublicationStatus?: string; finalResponsePostId?: string; updatedAt: number }, now: number) {
  return row.status === "uncertain" && row.executionStage === "finished" && row.finalPublicationStatus === "published"
    && Boolean(row.finalResponsePostId) && row.updatedAt < now - 86400000;
}
