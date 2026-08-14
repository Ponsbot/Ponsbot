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
