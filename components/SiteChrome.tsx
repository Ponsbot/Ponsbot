import Image from "next/image";
import Link from "next/link";
import { MobileNav } from "@/components/MobileNav";
import { WalletAccountMenu } from "@/components/WalletAccountMenu";

export function SiteHeader() {
  return <header className="site-header">
    <div className="header-brand"><Link href="/" className="wordmark"><Image className="brand-logo" src="/ponsbot.png" alt="" width={42} height={42} priority /><span>Pons Bot</span></Link></div>
    <Link href="/launch/0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07" className="header-ca" aria-label="View the Pons Bot token page"><span className="header-ca-desktop">$PONSBOT: 0xB1E9b822b81bbbdab375F7f4D86e44fA04d12b07</span><span className="header-ca-mobile">$PONSBOT</span></Link>
    <nav><Link href="/stats">STATS</Link><Link href="/terminal">TERMINAL</Link><Link href="/how-it-works">HOW IT WORKS</Link><Link href="/#launches">LAUNCHES</Link><a className="x-nav-link" href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer" aria-label="Ponsbotfamily on X"><Image src="/x-logo.png" alt="" width={20} height={20} /></a><WalletAccountMenu /></nav><MobileNav />
  </header>;
}

export function SiteFooter() {
  return <footer className="site-footer">
    <div><Link href="/" className="wordmark"><Image className="brand-logo" src="/ponsbot.png" alt="" width={42} height={42} /><span>Pons Bot</span></Link><p>Wallet and launch tools for Robinhood Chain, direct on X.</p></div>
    <div><strong>Explore</strong><Link href="/how-it-works">How it works</Link><Link href="/#launches">Launches</Link><a href="https://x.com/Ponsbotfamily" target="_blank" rel="noreferrer">@ponsbotfamily</a></div>
    <div className="footer-legal"><strong>Legal</strong><nav aria-label="Legal"><Link href="/privacy">Privacy Policy</Link><Link href="/terms">Terms of Use</Link></nav><p>Blockchain transactions may be irreversible. Tokens and liquidity positions can be volatile or lose all value. Pons Bot provides no warranties or financial advice. Independent interface. Not operated or endorsed by Pons or Robinhood.</p></div>
  </footer>;
}
