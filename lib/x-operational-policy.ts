export function shouldSendCooldownNotice(lastNoticeAt: number | undefined, lastAcceptedAt: number) {
  return lastNoticeAt === undefined || lastNoticeAt < lastAcceptedAt;
}

export function shouldSendDailyNotice(lastNoticeAt: number | undefined, utcDay: string) {
  return lastNoticeAt === undefined || new Date(lastNoticeAt).toISOString().slice(0, 10) !== utcDay;
}

export function shouldSendBurstNotice(lastNoticeAt: number | undefined, windowStartedAt: number) {
  return lastNoticeAt === undefined || lastNoticeAt < windowStartedAt;
}

export function paginationFailureState(previousFailures: number | undefined, resetAfter = 3) {
  const failures = (previousFailures || 0) + 1;
  return { failures: failures >= resetAfter ? 0 : failures, reset: failures >= resetAfter };
}

export function mentionPaginationProgress(
  requestedToken: string | undefined,
  returnedToken: string | undefined,
  previouslyVisited: string[] = [],
  historyLimit = 8,
) {
  const stalled = Boolean(requestedToken && returnedToken
    && (returnedToken === requestedToken || previouslyVisited.includes(returnedToken)));
  const visitedTokens = requestedToken
    ? [...previouslyVisited.filter((token) => token !== requestedToken), requestedToken].slice(-historyLimit)
    : [];
  return { stalled, nextToken: stalled ? undefined : returnedToken, visitedTokens: stalled || !returnedToken ? [] : visitedTokens };
}

export function isRetryableXReplyStatus(status: number) {
  return status === 429 || status >= 500;
}

export function xInteractionDispatchDelay(index: number, batchSize = 5, batchDelayMs = 1_000) {
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(batchSize) || batchSize < 1 || batchDelayMs < 0) {
    throw new Error("invalid X dispatch policy");
  }
  return Math.floor(index / batchSize) * batchDelayMs;
}

export function shouldRecoverXInteraction(input: {
  status: string; updatedAt: number; now: number; responsePostId?: string;
  publicationAttempted?: boolean; nextRetryAt?: number;
}) {
  if (input.responsePostId || input.publicationAttempted) return false;
  if (input.status === "received" || input.status === "processing") return input.updatedAt <= input.now - 20 * 60_000;
  return input.status === "failed" && input.nextRetryAt !== undefined && input.nextRetryAt <= input.now - 10 * 60_000;
}
