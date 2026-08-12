import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export default function WalletSignInErrorPage() {
  return <main><SiteHeader /><section className="detail-shell"><div className="subtle-panel"><h1>Wallet sign-in didn&apos;t finish</h1><p>X could not securely connect this session to a Pons Bot wallet. No wallet action was performed.</p><Link className="button button-dark" href="/api/auth/x/start">Try again with X</Link></div></section><SiteFooter /></main>;
}
