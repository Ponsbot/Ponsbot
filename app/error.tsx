"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="not-found"><p className="eyebrow">Temporarily unavailable</p><h1>Pons Bot data is taking a moment.</h1><p>That wallet or token may still be valid. Please try again shortly.</p><button className="button button-dark" type="button" onClick={reset}>Try again</button></main>;
}
