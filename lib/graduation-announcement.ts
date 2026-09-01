export const GRADUATION_CHECK_LIMIT = 24;

export function graduationNextCheckAt(createdAt: number, now: number) {
  const age = Math.max(0, now - createdAt);
  return now + (age < 60 * 60_000
    ? 2 * 60_000
    : age < 24 * 60 * 60_000
      ? 10 * 60_000
      : 60 * 60_000);
}

export function graduationTokenPageUrl(address: string, siteUrl?: string) {
  const site = siteUrl?.trim().replace(/\/$/, "") || "https://www.ponsbot.family";
  return `${site}/launch/${address}`;
}

export function graduationAnnouncementText(symbol: string, tokenUrl: string) {
  const ticker = symbol.replace(/^\$/, "").toUpperCase();
  return `🎓 $${ticker} has graduated! 🚀\nCheck it out! ✨\n${tokenUrl}`;
}
