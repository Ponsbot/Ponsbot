import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = { title: "How it works", description: "How to use Ponsbot for Robinhood Chain wallets and Pons V2 launches." };

const steps = [
  { number: "01", title: "Reply to Ponsbot", body: "Ask for your wallet, check a balance, send assets, buy or sell a token, burn tokens, or start a launch." },
  { number: "02", title: "Share the details", body: "Ponsbot understands natural requests. Include amounts, tickers, recipients, or launch details in the same reply." },
  { number: "03", title: "Review the response", body: "You receive a friendly confirmation with a link to your wallet, launch page, or transaction result." },
  { number: "04", title: "Launch on Pons V2", body: "For launches, provide a name and ticker. Artwork, description, links, pairing asset, and developer buy are optional." },
];

export default function HowItWorks() {
  return <main><SiteHeader /><section className="how-page"><div className="section-heading"><p className="eyebrow">How it works</p><h1>From an X reply<br />to Robinhood Chain.</h1><p className="page-lede">Ponsbot turns a simple conversation into a clear wallet or launch request. You stay in control and receive a page you can return to whenever you need it.</p></div><div className="steps">{steps.map((step) => <article key={step.number}><span>{step.number}</span><h3>{step.title}</h3><p>{step.body}</p></article>)}</div><div className="example-panel"><p className="eyebrow">Try saying</p><div><span>“What&apos;s my wallet?”</span><span>“Send 25 SNDK to @friend”</span><span>“Launch Neon Garden, ticker NGDN”</span></div></div></section><SiteFooter /></main>;
}
