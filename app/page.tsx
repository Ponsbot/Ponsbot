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
        <p className="eyebrow">Ponsbot for Robinhood Chain</p>
        <h1>Wallets and launches, right from a reply.</h1>
        <p className="hero-lede">Create your wallet, view your holdings, send and trade assets, or launch a token through a friendly conversation on X.</p>
        <div className="hero-actions"><a className="button button-primary" href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer">Follow on X ↗</a><Link className="button button-quiet" href="/how-it-works">How it works →</Link></div>
      </div>
      <div className="hero-visual">
        <div className="hero-blob" />
        <Image src="/ponsbot.png" alt="Ponsbot character" width={660} height={660} priority />
        <div className="message-bubble"><small>@Ponsbot</small><strong>Launch Neon Garden, ticker NGDN</strong><span>Ready to launch on Pons V2 ✨</span></div>
      </div>
    </section>

    <section className="launch-section" id="launches">
      <div className="section-heading row"><div><p className="eyebrow">Fresh from Ponsbot</p><h2>Launches</h2></div><p>Tokens launched through Ponsbot appear here, with a permanent page for details and links.</p></div>
      {launches.length ? <div className="launch-grid">{launches.map((launch) => <LaunchCard key={launch.tokenAddress} launch={launch} />)}</div> : <div className="empty-state"><span>✦</span><h3>The first launches are on their way.</h3><p>New tokens will appear here after they launch on Pons V2.</p></div>}
    </section>

    <section className="cta-section"><p className="eyebrow">Your idea, onchain</p><h2>Start with a name.<br />Launch on Pons V2.</h2><p>Reply to Ponsbot with your token name and ticker. Add artwork, links, a pairing asset, or an initial buy whenever you want.</p><a className="button button-dark" href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer">Visit @Ponsbotfamily ↗</a></section>
    <SiteFooter />
  </main>;
}
