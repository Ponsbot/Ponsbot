"use client";
import { createContext, useContext } from "react";

export const TokenMarketSnapshotContext = createContext<{ marketCapUsd?: number; graduated?: boolean }>({});

export function TokenMarketCap({ badge = false }: { badge?: boolean }) {
  const { marketCapUsd } = useContext(TokenMarketSnapshotContext);
  if (badge && marketCapUsd === undefined) return null;
  const value = marketCapUsd === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(marketCapUsd);
  return <strong className={badge ? "detail-art-mcap" : undefined}>{badge ? `MCap ${value}` : value}</strong>;
}

export function TokenGraduationBadge() {
  const { graduated } = useContext(TokenMarketSnapshotContext);
  return graduated ? <strong className="graduated-badge">Graduated</strong> : null;
}
