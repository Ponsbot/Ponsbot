import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = {
  title: "How it works",
  description: "Learn how to use Pons Bot to manage a Robinhood Chain wallet, trade and swap tokens, manage liquidity, claim creator fees, and launch on Pons.",
  alternates: { canonical: "/how-it-works" },
};

const commands = [
  { title: "Claim or check your wallet", body: "Ask for your wallet to create it or retrieve the same address later. The reply links to its public Pons Bot page, where anyone can view the address and holdings.", tips: ["No wallet address is required in your post.", "Your wallet remains associated with your X account."], example: "@Ponsbotfamily what's my wallet?" },
  { title: "View balances", body: "Ask for your complete portfolio or name one asset to check a specific balance. Identify a token by ticker or contract address.", tips: ["Ask for holdings to see the full wallet.", "Name ETH, $PONSBOT, or a token contract for one balance.", "A leading $ on a ticker is optional."], example: "@Ponsbotfamily how much $PONSBOT do I have?" },
  { title: "Buy", body: "Include the token and an amount in USD, ETH, or its exact paired asset. If a USD or ETH purchase needs another pair, Pons Bot acquires that asset first and then completes the purchase with one final result.", tips: ["Use $25, 0.02 ETH, or a paired amount such as 5 MSFT.", "Paired-asset funding is handled automatically.", "You can also buy and send in one post."], example: "@Ponsbotfamily buy $25 of $PONSBOT" },
  { title: "Sell", body: "Name the token and specify an exact token amount, ETH value, dollar value, percentage, half, or all. Pons Bot confirms the actual asset received.", tips: ["Use an amount such as 10 $PONSBOT or sell 0.001 ETH of $PONSBOT.", "ETH and USD values, percentages, half, and all are supported.", "The token can be identified by contract address."], example: "@Ponsbotfamily sell half my $PONSBOT" },
  { title: "Swap any Robinhood tokens", body: "Swap a dollar value of one Robinhood Chain token into another from X, TG, or the terminal. Clearly name the asset you are swapping and the asset you want to receive.", tips: ["Format your request like: swap $25 of ETH to USDG.", "Use tickers or complete contract addresses.", "Keep enough ETH available for gas."], example: "@Ponsbotfamily swap $25 of ETH to USDG" },
  { title: "Cross-chain and private swaps", body: "Send ETH from your Pons Bot wallet on Robinhood Chain and receive a supported asset at a wallet address on another network through Houdini Swap. X handles are not accepted as destinations. A valid X command begins processing immediately.", tips: ["Use a clear format such as: Send $25 to WALLET ADDRESS as ASSET on CHAIN.", "You can specify the source as USD or ETH. The source is always Robinhood Chain ETH from your Pons Bot wallet.", "For ETH destinations, name the network, such as ETH on Ethereum or ETH on Base.", "Add private or privately to request private routing.", "Pons Bot posts a submitted message with the estimated wait, followed by the final success or failure result."], example: "@Ponsbotfamily Private send $25 to WALLET ADDRESS as ASSET on CHAIN" },
  { title: "Send", body: "Send ETH or a supported token to an X user or wallet address. Include the amount, asset, and destination. A combined buy and send transfers only the tokens received from that purchase.", tips: ["Use an @username or complete 0x address.", "Exact amounts, percentages, half, and all are supported.", "Combined buy and send supports one token and recipient."], example: "@Ponsbotfamily send 10 $PONSBOT to @friend" },
  { title: "Burn", body: "Burning permanently sends tokens to the burn address. Include the token and amount, or explicitly request a combined buy and burn to destroy only the tokens received from that purchase.", tips: ["Burns are permanent.", "Combined buy and burn must contain both words buy and burn.", "Review the amount carefully."], example: "@Ponsbotfamily buy $25 of $PONSBOT and burn it" },
];

export default function HowItWorks() {
  return <main><SiteHeader /><section className="how-page">
    <div className="section-heading"><p className="eyebrow">How it works</p><h1>One X post.<br />A world of possibilities.</h1></div>
    <div className="how-intro-row"><p className="page-lede">Pons Bot gives you a Robinhood Chain wallet you can use from X, TG, or the website terminal. Check balances, buy, sell, swap, send, burn, manage liquidity, claim creator fees, or launch on Pons.</p><div className="how-guide-links"><Link className="button how-guide-primary" href="/how-it-works/launches">HOW TO LAUNCH →</Link><Link className="button how-guide-button" href="/how-it-works/liquidity">LIQUIDITY GUIDE →</Link></div></div>
    <section className="command-section"><p className="eyebrow">What you can do</p><h2>Your everything bot on Robinhood.</h2><div className="command-grid">{commands.map((command) => <article key={command.title}><h3>{command.title}</h3><p>{command.body}</p><ul>{command.tips.map((tip) => <li key={tip}>{tip}</li>)}</ul><code>{command.example}</code></article>)}</div></section>
    <div className="example-panel"><p className="eyebrow">Example posts</p><div><span>“What&apos;s my wallet?”</span><span>“How much $PONSBOT do I have?”</span><span>“Buy $25 of $PONSBOT”</span><span>“Swap $25 of ETH to USDG”</span><span>“Private send $25 to WALLET ADDRESS as ASSET on CHAIN”</span><span>“Sell half my $PONSBOT”</span><span>“Send 10 $PONSBOT to @friend”</span><span>“Burn 10 $PONSBOT”</span></div></div>
  </section><SiteFooter /></main>;
}
