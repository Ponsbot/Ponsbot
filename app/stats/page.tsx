import type { Metadata } from "next";
import { Suspense } from "react";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { getPlatformStats } from "@/lib/site-data";
import { getAutomaticPonsbotBurned, getTotalPonsbotBurned } from "@/lib/burn-stats-data";
import { formatPonsbotBurned } from "@/lib/burn-stats";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pons Bot Stats",
  description: "Pons Bot launches, wallets, lifetime trading volume, creator fees, and PONSBOT burned.",
  alternates: { canonical: "/stats" },
};

export default function StatsPage() {
  return <main>
    <SiteHeader />
    <section className="stats-page">
      <div className="stats-heading">
        <h1>Pons Bot Stats</h1>
      </div>
      <div className="stats-layout">
        <Suspense fallback={<PlatformBubbles stats={null} />}><PlatformTotals /></Suspense>
        <section className="stats-burns" aria-labelledby="stats-burns-heading">
          <h2 id="stats-burns-heading">$PONSBOT Burned</h2>
          <Suspense fallback={<StatLine label="Automatically From Creator Fees" value="—" />}>
            <BurnTotal automatic />
          </Suspense>
          <Suspense fallback={<StatLine label="Total" value="—" />}>
            <BurnTotal />
          </Suspense>
        </section>
      </div>
    </section>
    <SiteFooter />
  </main>;
}

async function PlatformTotals() {
  const stats = await getPlatformStats().catch(() => null);
  return <PlatformBubbles stats={stats} />;
}

function PlatformBubbles({ stats }: { stats: Awaited<ReturnType<typeof getPlatformStats>> | null }) {
  return <div className="stats-bubbles">
    <StatLine label="Launches" value={stats ? formatInteger(stats.launches) : "—"} />
    <StatLine label="Pons Bot Wallets" value={stats ? formatInteger(stats.wallets) : "—"} />
    <div className="stats-generated-banner">Tokens Launched on Pons Bot Have Generated</div>
    <StatLine label="Lifetime Volume" value={stats ? formatUsd(stats.lifetimeVolumeUsd) : "—"} />
    <StatLine label="Creator Fees" value={stats?.feeValuationVersion === 1 ? formatUsd(stats.feesClaimedUsd) : "—"} />
  </div>;
}

async function BurnTotal({ automatic = false }: { automatic?: boolean }) {
  const amount = await (automatic ? getAutomaticPonsbotBurned() : getTotalPonsbotBurned());
  return <StatLine label={automatic ? "Automatically From Creator Fees" : "Total"} value={formatPonsbotBurned(amount)} />;
}

function StatLine({ label, value }: { label: string; value: string }) {
  return <article className="stats-bubble"><span>{label}</span><strong>{value}</strong></article>;
}

function formatInteger(value: number) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value < 100 ? 2 : 0 }).format(value);
}
