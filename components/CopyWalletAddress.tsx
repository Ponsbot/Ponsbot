"use client";

import { useState } from "react";

export function CopyWalletAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  async function copyAddress() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <button
      className="wallet-address-copy"
      type="button"
      onClick={copyAddress}
      aria-label={copied ? "Wallet address copied" : "Copy wallet address"}
      title={copied ? "Copied" : "Copy wallet address"}
    >
      <span className="wallet-address">{address}</span>
      <svg className="copy-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </svg>
      <span className="copy-feedback" aria-live="polite">{copied ? "Copied" : ""}</span>
    </button>
  );
}
