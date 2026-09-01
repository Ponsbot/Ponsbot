"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const RETRY_DELAYS_MS = [2_000, 3_000, 5_000, 8_000];

export function WalletHoldingsLoading({ message = "Holdings are taking a moment to load" }: { message?: string }) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => {
    if (attempt >= RETRY_DELAYS_MS.length) {
      setRefreshing(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setAttempt((current) => current + 1);
      router.refresh();
    }, RETRY_DELAYS_MS[attempt]);
    return () => window.clearTimeout(timer);
  }, [attempt, router]);

  function retry() {
    setRefreshing(true);
    setAttempt(0);
    router.refresh();
  }

  return (
    <div className="subtle-panel" role="status" aria-live="polite">
      <h3>{refreshing ? message : "Holdings are still loading"}</h3>
      <p>
        {refreshing
          ? "The wallet page will retry automatically."
          : "The wallet is still valid, but its public balances could not be reached yet."}
      </p>
      {!refreshing ? <button className="button button-quiet" type="button" onClick={retry}>Try again</button> : null}
    </div>
  );
}
