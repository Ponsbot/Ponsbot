import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export default function NotPonsbotWallet() {
  return <main><SiteHeader /><section className="error-page"><span>404</span><h1>Not a Ponsbot Wallet</h1><p>This address is not connected to a wallet created by Ponsbot.</p><Link className="button button-dark" href="/">Return home</Link></section><SiteFooter /></main>;
}
