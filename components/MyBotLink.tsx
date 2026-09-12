"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

export function MyBotLink({ onNavigate, button = false }: { onNavigate?: () => void; button?: boolean }) {
  const [ownsBot, setOwnsBot] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/bot-yard/owner", { cache: "no-store", signal: abort.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!abort.signal.aborted) setOwnsBot(Array.isArray(data?.bots) && data.bots.length > 0); })
      .catch(() => {});
    return () => abort.abort();
  }, []);
  return ownsBot ? <Link href="/bot-yard/my-bot" className={button ? "header-wallet-button" : undefined} onClick={onNavigate}>My Bot</Link> : null;
}
