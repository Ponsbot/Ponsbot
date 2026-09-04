import Image from "next/image";
import Link from "next/link";
import { LaunchGrid } from "@/components/LaunchGrid";
import { DataLoadingPanel } from "@/components/DataLoadingPanel";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { getPlatformStats, highestMarketCapLaunches } from "@/lib/site-data";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [launchesResult, statsResult] = await Promise.allSettled([highestMarketCapLaunches(), getPlatformStats()]);
  const launches = launchesResult.status === "fulfilled" ? launchesResult.value : [];
  // Use the same public-statistics value shown on /stats so the two pages
  // cannot disagree because of separate frontend cache windows.
  const launchCount = statsResult.status === "fulfilled" ? statsResult.value.launches : null;
  const launchesAvailable = launchesResult.status === "fulfilled";
  return <main>
    <SiteHeader />
    <section className="home-hero">
      <div className="hero-copy">
        <h1>Your <span style={{ color: "var(--lime)" }}>everything</span> bot on <span style={{ color: "var(--lime)", whiteSpace: "nowrap" }}>Robinhood.</span></h1>
        <p className="hero-lede" style={{ maxWidth: "none" }}>Launch on Pons, swap, send, liquidity, and more with just an X post.</p>
        <div className="hero-actions"><a className="button button-primary" href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer">@ponsbotfamily</a><Link className="button button-quiet" href="/how-it-works">HOW IT WORKS →</Link></div>
      </div>
      <div className="hero-visual">
        <div className="hero-blob" />
        <Image src="/ponsbot.png" alt="Pons Bot character" width={660} height={660} priority />
        <div className="message-stack" aria-label="Example X posts">
          <div className="message-bubble bubble-launch">@ponsbotfamily Launch Pons Bot ticker $PONSBOT</div>
          <div className="message-bubble bubble-buy">@ponsbotfamily Buy $25 of $PONSBOT</div>
          <div className="message-bubble bubble-send">@ponsbotfamily Send 10 $PONSBOT to @friend</div>
          <div className="message-bubble bubble-pair">@ponsbotfamily Launch Pons Bot ticker $PONSBOT, website ponsbot.family</div>
        </div>
      </div>
    </section>
    <section className="launch-section" id="launches">
      <div className="section-heading row"><div><p className="eyebrow">Fresh From Pons Bot - {launchCount === null ? "" : `${launchCount.toLocaleString("en-US")} `}Launches and Counting</p><h2>Launches</h2></div></div>
      {launches.length ? <LaunchGrid launches={launches} launchCount={launchCount ?? launches.length} /> : launchesAvailable ? <div className="empty-state"><span>✦</span><h3>The first launches are on their way.</h3><p>New tokens will appear here after they launch on Pons V2.</p></div> : <DataLoadingPanel title="Launches are loading" />}
    </section>
    <SiteFooter />
  </main>;
}
