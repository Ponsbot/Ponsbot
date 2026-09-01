"use client";

import { useEffect } from "react";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(reset, 2_000);
    return () => window.clearTimeout(timer);
  }, [reset]);
  return <main className="not-found"><p className="eyebrow">Pons Bot</p><h1>This page is still loading.</h1><p>We&apos;ll retry automatically without treating missing data as an invalid wallet or token.</p><button className="button button-dark" type="button" onClick={reset}>Refresh now</button></main>;
}
