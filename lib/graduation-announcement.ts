export const GRADUATION_ACTIVITY_WINDOW_MS = 24 * 60 * 60_000;
export const GRADUATION_RECENT_LAUNCH_WINDOW_MS = 24 * 60 * 60_000;
export const GRADUATION_CHECK_LIMIT = 24;

export function graduationTokenPageUrl(address: string, siteUrl?: string) {
  const site = siteUrl?.trim().replace(/\/$/, "") || "https://ponsbot-one.vercel.app";
  return `${site}/launch/${address}`;
}

export function graduationAnnouncementText(symbol: string, tokenUrl: string) {
  const ticker = symbol.replace(/^\$/, "").toUpperCase();
  return `🎓 $${ticker} has graduated! 🚀\nCheck it out! ✨\n${tokenUrl}`;
}
