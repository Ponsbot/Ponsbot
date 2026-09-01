"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export function WalletTerminalLink({ address }: { address: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { fetch("/api/auth/x/session", { cache: "no-store" }).then((response) => response.json()).then((session) => setVisible(Boolean(session.authenticated && session.walletAddress?.toLowerCase() === address.toLowerCase()))).catch(() => undefined); }, [address]);
  return visible ? <Link className="button button-dark" href="/terminal">Go to Terminal</Link> : null;
}
