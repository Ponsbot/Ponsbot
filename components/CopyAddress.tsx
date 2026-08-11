"use client";

import { useState, type MouseEvent } from "react";

export function CopyAddress({ address, compact = false, displayAddress }: { address: string; compact?: boolean; displayAddress?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault(); event.stopPropagation();
    await navigator.clipboard.writeText(address);
    setCopied(true); window.setTimeout(() => setCopied(false), 1_500);
  }
  return <button className={`address-copy${compact ? " address-copy-compact" : ""}`} type="button" onClick={copy} title={copied ? "Copied" : "Copy contract address"} aria-label={copied ? "Contract address copied" : "Copy contract address"}>
    <span>{displayAddress || address}</span><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>{copied ? <em>Copied</em> : null}
  </button>;
}
