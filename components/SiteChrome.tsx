import Image from "next/image";
import Link from "next/link";
import { MobileNav } from "@/components/MobileNav";
import { WalletAccountMenu } from "@/components/WalletAccountMenu";

export function SiteHeader() {
  return <header className="site-header">
    <div className="header-brand"><Link href="/" className="wordmark"><Image className="brand-logo" src="/ponsbot.png" alt="" width={42} height={42} priority /><span>Pons Bot</span></Link></div>
    <div className="header-ca" aria-label="Pons Bot ticker and contract address placeholder"><span className="header-ca-desktop">$PONSBOT: XXXXXXXXXXXXXXXXXXXXXXX</span><span className="header-ca-mobile">$PONSBOT</span></div>
    <nav><Link href="/how-it-works">HOW IT WORKS</Link><Link href="/#launches">LAUNCHES</Link><a className="x-nav-link" href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer" aria-label="Ponsbotfamily on X"><Image src="/x-logo.png" alt="" width={20} height={20} /></a><WalletAccountMenu /></nav><MobileNav />
  </header>;
}

export function SiteFooter() {
  return <footer className="site-footer">
    <div><Link href="/" className="wordmark"><Image className="brand-logo" src="/ponsbot.png" alt="" width={42} height={42} /><span>Pons Bot</span></Link><p>Wallet and launch tools for Robinhood Chain, direct on X.</p></div>
    <div><strong>Explore</strong><Link href="/how-it-works">How it works</Link><Link href="/#launches">Launches</Link><a href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer">@ponsbotfamily</a></div>
    <div><strong>Notice</strong><p>Independent interface. Not operated or endorsed by Pons or Robinhood.</p></div>
  </footer>;
}
