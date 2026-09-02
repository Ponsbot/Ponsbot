import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = {
  title: "Liquidity guide",
  description: "Learn how to create and manage Delta Liquidity positions through Pons Bot.",
  alternates: { canonical: "/how-it-works/liquidity" },
};

const liquidityDetails = [
  { title: "Start a position", body: "Ask Pons Bot to create a liquidity position and identify the token by ticker or contract address. You can begin with only the token, or include a budget and other settings immediately." },
  { title: "Set the budget and pair", body: "Choose a position budget in USD or ETH, then choose an ETH or USDG pool. Pons Bot can buy missing pool assets, but it will not sell the position token to cover a shortfall." },
  { title: "Compare available pools", body: "Pons Bot checks live market activity and presents ranked pool cards with the version, fee, active depth, total liquidity, volume, and relevant benefits or warnings. Choose a listed pool or create a custom one." },
  { title: "Shape the range", body: "For a custom position, choose V3 or V4, the swap fee, a market-cap range, distribution shape, and number of bands. Your position earns fees only while market cap is inside its selected range." },
  { title: "Review and confirm", body: "Pons Bot presents a final position quote before moving funds. Review the assets, position budget, range, fee, shape, and bands, then confirm or request a change." },
  { title: "Manage the position", body: "Each completed position receives an LP identifier. Use it to check the position, view its Delta Liquidity NFTs, collect LP fees, or withdraw the entire position. A full withdrawal also collects available LP fees." },
];

export default function LiquidityGuidePage() {
  return <main><SiteHeader /><section className="how-page guide-page">
    <Link className="back-link guide-back-link" href="/how-it-works">← How it works</Link>
    <div className="section-heading"><p className="eyebrow">Delta Liquidity</p><h1>Build liquidity<br />with guidance.</h1><p className="page-lede">Create and manage liquidity positions from X or through the interactive Liquidity Positions workspace in the terminal.</p></div>
    <div className="guide-card-grid">{liquidityDetails.map((detail) => <article key={detail.title}><h2>{detail.title}</h2><p>{detail.body}</p></article>)}</div>
    <section className="guide-example"><p className="eyebrow">Get started</p><code>@Ponsbotfamily create a $100 liquidity position for $PONSBOT</code><p>You can ask what a setting means at any step. Pons Bot explains the current choice and then returns you to the same point in the workflow.</p><a href="https://deltaliquidity.app/" target="_blank" rel="noreferrer">Powered by Delta Liquidity ↗</a></section>
  </section><SiteFooter /></main>;
}
