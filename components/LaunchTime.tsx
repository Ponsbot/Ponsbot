"use client";

export function LaunchTime({ createdAt, relative = false }: { createdAt: number; relative?: boolean }) {
  if (relative) return <time dateTime={new Date(createdAt).toISOString()} suppressHydrationWarning>{age(createdAt)}</time>;
  return <time dateTime={new Date(createdAt).toISOString()} suppressHydrationWarning>{new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(createdAt))}</time>;
}
function age(createdAt: number) { const minutes = Math.max(0, Math.floor((Date.now() - createdAt) / 60_000)); if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`; }
