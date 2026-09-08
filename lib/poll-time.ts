/** Display remaining time without implying that ended or cancelled polls are open. */
export function pollTimeRemaining(status: string, endsAt: number | undefined, now: number): string {
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'closed' || (endsAt !== undefined && endsAt <= now)) return 'Closed';
  if (!endsAt) return 'Preparing';
  const minutes = Math.ceil((endsAt - now) / 60_000);
  if (minutes < 60) return `(${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left)`;
  const hours = Math.ceil(minutes / 60);
  return `(${hours} ${hours === 1 ? 'hour' : 'hours'} left)`;
}
