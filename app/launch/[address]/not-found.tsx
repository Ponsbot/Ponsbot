import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export default function NotPonsbotToken() {
  return <main><SiteHeader /><section className="error-page"><span>404</span><h1>Not a Pons Bot Token</h1><p>This token was not launched through Pons Bot.</p><Link className="button button-dark" href="/#launches">View Pons Bot launches</Link></section><SiteFooter /></main>;
}
