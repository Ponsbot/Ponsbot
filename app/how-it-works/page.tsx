import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = { title: "How it works", description: "How to use Ponsbot for Robinhood Chain wallets and Pons V2 launches." };

const steps = [
  { number: "01", title: "Post to @Ponsbotfamily", body: "Mention Ponsbot in a new X post or reply. Write naturally—tell it whether you want your wallet, a trade, a transfer, or a Pons V2 launch." },
  { number: "02", title: "Include what matters", body: "For trades and sends, include the amount, asset, and destination when needed. For launches, start with a token name and ticker." },
  { number: "03", title: "Check the reply", body: "Ponsbot replies with a clear result or asks you to supply anything essential that is missing. Wallet and token links stay easy to revisit and share." },
  { number: "04", title: "Keep using the same wallet", body: "Your wallet is connected to your X account. Ask for it again whenever you want to view the address and current holdings." },
];

const commands = [
  { title: "Wallet", body: "Claim your Robinhood Chain wallet, get its receiving address, or ask for your holdings.", example: "What's my wallet?" },
  { title: "Buy & sell", body: "Name an amount in USD or ETH for buys. Sell a token amount, a percentage, half, or all.", example: "Buy $25 of SNDK" },
  { title: "Send", body: "Send ETH or supported tokens to a wallet address or an X username.", example: "Send 10 SNDK to @friend" },
  { title: "Launch", body: "Launch on Pons V2 with a name and ticker, then add the optional details you want.", example: "Launch Ponsbot ticker $PONSBOT" },
];

export default function HowItWorks() {
  return <main><SiteHeader /><section className="how-page">
    <div className="section-heading"><p className="eyebrow">How it works</p><h1>One X post.<br />A wallet full of possibilities.</h1><p className="page-lede">Ponsbot gives you a Robinhood Chain wallet and a simple way to use it from X. Claim a wallet, check holdings, trade, send assets, or launch on Pons V2 without memorizing commands.</p></div>
    <div className="steps">{steps.map((step) => <article key={step.number}><span>{step.number}</span><h3>{step.title}</h3><p>{step.body}</p></article>)}</div>
    <section className="command-section"><p className="eyebrow">What you can do</p><h2>Just say what you want.</h2><div className="command-grid">{commands.map((command) => <article key={command.title}><h3>{command.title}</h3><p>{command.body}</p><code>{command.example}</code></article>)}</div></section>
    <section className="launch-guide"><div><p className="eyebrow">Launch on Pons V2</p><h2>Start simple. Add the details that make it yours.</h2></div><div className="launch-detail-list"><p><strong>Required</strong><span>Token name and ticker.</span></p><p><strong>Make it recognizable</strong><span>Add artwork and a short description.</span></p><p><strong>Connect your community</strong><span>Include a website and X link.</span></p><p><strong>Choose the market</strong><span>Select an available pairing asset and, if you want, include a developer buy.</span></p></div></section>
    <div className="example-panel"><p className="eyebrow">Example posts</p><div><span>“What&apos;s my wallet?”</span><span>“Buy $25 of SNDK”</span><span>“Send 10 SNDK to @friend”</span><span>“Launch Daybreak ticker $DAY, website daybreak.xyz, pair with MSFT”</span></div></div>
  </section><SiteFooter /></main>;
}
