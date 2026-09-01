import React from "react";

export function TerminalActionToken({ token }: { token?: string }) {
  const label = token || "—";
  const separator = /\s+on\s+/i.exec(label);
  return <span className="terminal-action-token">
    {separator ? <>{label.slice(0, separator.index)}<span className="terminal-action-token-chain">{label.slice(separator.index + separator[0].length)}</span></> : label}
  </span>;
}
