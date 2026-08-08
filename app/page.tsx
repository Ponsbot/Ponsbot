import Image from "next/image";
import Link from "next/link";
import { LaunchCard } from "@/components/LaunchCard";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { listLaunches } from "@/lib/site-data";

export const revalidate = 30;

export default async function Home() {
  const launches = await listLaunches(18);
  return <main>
    <SiteHeader />
    <section className="home-hero">
      <div className="hero-copy">
        <h1>Pons V2 launches direct on X</h1>
        <p className="hero-lede">Claim your wallet, buy and sell, and launch tokens with a single X post.</p>
        <div className="hero-actions"><a className="button button-primary" href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer">@ponsbotfamily</a><Link className="button button-quiet" href="/how-it-works">HOW IT WORKS →</Link></div>
      </div>
      <div className="hero-visual">
        <div className="hero-blob" />
        <Image src="/ponsbot.png" alt="Ponsbot character" width={660} height={660} priority />
        <div className="message-stack" aria-label="Example X posts">
          <div className="message-bubble bubble-launch"><small>@Ponsbotfamily</small><strong>Launch Ponsbot ticker $PONSBOT</strong><span>Ready to launch on Pons V2 ✨</span></div>
          <div className="message-bubble bubble-buy"><small>@Ponsbotfamily</small><strong>Buy $25 of SNDK</strong></div>
          <div className="message-bubble bubble-send"><small>@Ponsbotfamily</small><strong>Send 10 SNDK to @friend</strong></div>
          <div className="message-bubble bubble-pair"><small>@Ponsbotfamily</small><strong>Launch Daybreak ticker $DAY</strong><span>Website daybreak.xyz · Pair with MSFT</span></div>
        </div>
      </div>
    </section>
    <section className="launch-section" id="launches">
      <div className="section-heading row"><div><p className="eyebrow">Fresh from Ponsbot</p><h2>Launches</h2></div></div>
      {launches.length ? <div className="launch-grid">{launches.map((launch) => <LaunchCard key={launch.tokenAddress} launch={launch} />)}</div> : <div className="empty-state"><span>✦</span><h3>The first launches are on their way.</h3><p>New tokens will appear here after they launch on Pons V2.</p></div>}
    </section>
    <SiteFooter />
  </main>;
}
