import Image from "next/image";
import Link from "next/link";

export function SiteHeader() {
  return <header className="site-header">
    <Link href="/" className="wordmark"><Image className="brand-logo" src="/ponsbot.png" alt="" width={42} height={42} priority /><span>Ponsbot</span></Link>
    <nav><Link href="/how-it-works">HOW IT WORKS</Link><Link href="/#launches">LAUNCHES</Link><a className="x-nav-link" href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer" aria-label="Ponsbotfamily on X"><Image src="/x.webp" alt="" width={20} height={20} /></a></nav>
  </header>;
}

export function SiteFooter() {
  return <footer className="site-footer">
    <div><Link href="/" className="wordmark"><Image className="brand-logo" src="/ponsbot.png" alt="" width={42} height={42} /><span>Ponsbot</span></Link><p>Wallet and launch tools for Robinhood Chain, delivered through X replies.</p></div>
    <div><strong>Explore</strong><Link href="/how-it-works">How it works</Link><Link href="/#launches">Launches</Link><a href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer">@Ponsbotfamily</a></div>
    <div><strong>Notice</strong><p>Independent interface. Not operated or endorsed by Pons or Robinhood.</p></div>
  </footer>;
}
