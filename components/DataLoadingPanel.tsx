"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const RETRY_DELAYS_MS = [2_000, 3_000, 5_000, 8_000];

export function DataLoadingPanel({
  title = "Data is still loading",
  message = "This section will fill in automatically as soon as its data is available.",
}: {
  title?: string;
  message?: string;
}) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (attempt >= RETRY_DELAYS_MS.length) return;
    const timer = window.setTimeout(() => {
      setAttempt((current) => current + 1);
      router.refresh();
    }, RETRY_DELAYS_MS[attempt]);
    return () => window.clearTimeout(timer);
  }, [attempt, router]);

  return (
    <div className="subtle-panel" role="status" aria-live="polite">
      <h3>{title}</h3>
      <p>{message}</p>
      {attempt >= RETRY_DELAYS_MS.length ? (
        <button className="button button-quiet" type="button" onClick={() => { setAttempt(0); router.refresh(); }}>
          Refresh data
        </button>
      ) : null}
    </div>
  );
}
