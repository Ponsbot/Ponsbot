import Link from "next/link";

export function SiteHeader() {
  return <header className="site-header">
    <Link href="/" className="wordmark"><span className="mark">P</span><span>Ponsbot</span></Link>
    <nav><Link href="/how-it-works">How it works</Link><Link href="/#launches">Launches</Link><a href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer">X ↗</a></nav>
  </header>;
}

export function SiteFooter() {
  return <footer className="site-footer">
    <div><Link href="/" className="wordmark"><span className="mark">P</span><span>Ponsbot</span></Link><p>Wallet and launch tools for Robinhood Chain, delivered through X replies.</p></div>
    <div><strong>Explore</strong><Link href="/how-it-works">How it works</Link><Link href="/#launches">Launches</Link><a href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer">@Ponsbotfamily</a></div>
    <div><strong>Notice</strong><p>Independent interface. Not operated or endorsed by Pons or Robinhood.</p></div>
  </footer>;
}
