import Image from "next/image";
import Link from "next/link";
import { LaunchGrid } from "@/components/LaunchGrid";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { listLaunches } from "@/lib/site-data";

export const revalidate = 30;

export default async function Home() {
  const launches = await listLaunches(60);
  return <main>
    <SiteHeader />
    <section className="home-hero">
      <div className="hero-copy">
        <h1>Pons V2 launches direct on X</h1>
        <p className="hero-lede">Claim your wallet, buy and sell, and launch tokens with a single X post.</p>
        <div className="hero-actions"><a className="button button-primary" href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer">@Ponsbotfamily</a><Link className="button button-quiet" href="/how-it-works">HOW IT WORKS →</Link></div>
      </div>
      <div className="hero-visual">
        <div className="hero-blob" />
        <Image src="/ponsbot.png" alt="Ponsbot character" width={660} height={660} priority />
        <div className="message-stack" aria-label="Example X posts">
          <div className="message-bubble bubble-launch">@Ponsbotfamily Launch Ponsbot ticker $PONSBOT</div>
          <div className="message-bubble bubble-buy">@Ponsbotfamily Buy $25 of $PONSBOT</div>
          <div className="message-bubble bubble-send">@Ponsbotfamily Send 10 $PONSBOT to @friend</div>
          <div className="message-bubble bubble-pair">@Ponsbotfamily Launch Ponsbot ticker $PONSBOT, website ponsbot.family, pair with MSFT</div>
        </div>
      </div>
    </section>
    <section className="launch-section" id="launches">
      <div className="section-heading row"><div><p className="eyebrow">Fresh from Ponsbot</p><h2>Launches</h2></div></div>
      {launches.length ? <LaunchGrid launches={launches} /> : <div className="empty-state"><span>✦</span><h3>The first launches are on their way.</h3><p>New tokens will appear here after they launch on Pons V2.</p></div>}
    </section>
    <SiteFooter />
  </main>;
}
