"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** Format in the viewer's browser, never the server's timezone during hydration. */
export function BotLocalTime({ at, includeDate = false }: { at: number; includeDate?: boolean }) {
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const date = new Date(at);
  return <time dateTime={date.toISOString()} title={hydrated ? date.toLocaleString() : undefined}>
    {hydrated ? new Intl.DateTimeFormat(undefined, includeDate
      ? { dateStyle: "medium", timeStyle: "short" }
      : { hour: "2-digit", minute: "2-digit" }).format(date) : "…"}
  </time>;
}
