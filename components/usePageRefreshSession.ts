"use client";
import { useCallback, useEffect, useState } from "react";
import { PAGE_REFRESH_SESSION_MS, pageRefreshActive } from "../lib/website-refresh-policy";

/** Page lifetime, not an inactivity timer. Only a new page mount starts a new session. */
export function usePageRefreshSession() {
  const [startedAt] = useState(() => Date.now());
  const [expired, setExpired] = useState(false);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const onVisibility = () => {
      setVisible(document.visibilityState === "visible");
      if (!pageRefreshActive(startedAt, Date.now())) setExpired(true);
    };
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, startedAt + PAGE_REFRESH_SESSION_MS - Date.now()));
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [startedAt]);
  const canRefresh = useCallback(() => pageRefreshActive(startedAt, Date.now()) && document.visibilityState === "visible", [startedAt]);
  return { active: !expired && visible, expired, canRefresh };
}
