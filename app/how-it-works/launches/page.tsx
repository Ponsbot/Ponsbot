import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { PUBLISHED_PAIR_LIST } from "@/lib/pair-catalog";

export const metadata: Metadata = {
  title: "How to launch",
  description: "Learn how to launch a token on Pons through Pons Bot.",
  alternates: { canonical: "/how-it-works/launches" },
};

const launchDetails = [
  { title: "Choose a name and ticker", body: "Include a name and ticker for your launch." },
  { title: "Add optional details", body: "You can attach artwork and include a description, website, X profile, and Telegram link." },
  { title: "Select a paired asset", body: `ETH is the default. Published alternatives are: ${PUBLISHED_PAIR_LIST}.` },
  { title: "Add a developer buy", body: "A dev buy is optional. Enter it in USD, ETH, or the exact paired asset. For non-ETH pairs, USD and ETH funding is converted to the paired asset before the launch." },
  { title: "Choose where creator fees go", body: "By default, creator fees go to the launcher. Use the exact phrase assign fees to followed by an X handle or wallet address, or use holder fee sharing." },
  { title: "Claim creator fees", body: "Creator-fee claims happen automatically. For eligible launches, 95% goes to the assigned recipient and 5% buys and burns $PONSBOT. Launches using holder fee sharing distribute their creator fees to holders instead." },
];

export default function LaunchGuidePage() {
  return <main><SiteHeader /><section className="how-page guide-page">
    <Link className="back-link guide-back-link" href="/how-it-works">← How it works</Link>
    <div className="section-heading"><p className="eyebrow">Launch on Pons</p><h1>Launch on Pons with<br />just one X post.</h1><p className="page-lede">Tell Pons Bot the token you want to launch. Start with a name and ticker, then add as many optional details as you want.</p></div>
    <div className="guide-card-grid">{launchDetails.map((detail) => <article key={detail.title}><h2>{detail.title}</h2><p>{detail.body}</p></article>)}</div>
    <section className="guide-example"><p className="eyebrow">Example launches</p><div className="guide-example-list"><code>@Ponsbotfamily launch NAME $TICKER</code><code>@Ponsbotfamily launch NAME $TICKER, description “DESCRIPTION”, website WEBSITE</code><code>@Ponsbotfamily launch NAME $TICKER, dev buy $100</code><code>@Ponsbotfamily launch NAME $TICKER paired with NVDA</code><code>@Ponsbotfamily launch NAME $TICKER, assign fees to @USER</code><code>@Ponsbotfamily launch NAME $TICKER with holder fee sharing</code></div><p>For a guided setup, ask “How do I launch?” and reply “get started.” Pons Bot will collect the required and optional details one step at a time.</p></section>
  </section><SiteFooter /></main>;
}
