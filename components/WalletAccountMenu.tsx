"use client";

import { useEffect, useState } from "react";

type WalletSession = { authenticated: true; username: string; walletAddress: string } | { authenticated: false };

export function WalletAccountMenu() {
  const [session, setSession] = useState<WalletSession | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/x/session", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<WalletSession> : { authenticated: false } as const)
      .then((value) => { if (active) setSession(value); })
      .catch(() => { if (active) setSession({ authenticated: false }); });
    return () => { active = false; };
  }, []);

  if (!session?.authenticated) return <a className="header-wallet-button" href="/api/auth/x/start">My Wallet</a>;

  const signOut = async () => {
    const response = await fetch("/api/auth/x/session", { method: "DELETE" }).catch(() => null);
    if (response?.ok) setSession({ authenticated: false });
  };

  return <details className="wallet-account-menu">
    <summary className="header-wallet-button">My Wallet</summary>
    <div className="wallet-account-dropdown">
      <strong>@{session.username}</strong>
      <a href={`/wallet/${session.walletAddress}`}>View Wallet</a>
      <button type="button" onClick={signOut}>Sign out</button>
    </div>
  </details>;
}
