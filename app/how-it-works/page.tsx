import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export const metadata: Metadata = {
  title: "How it works",
  description: "Learn how to claim your Ponsbot wallet, check holdings, buy, sell, send, burn, and launch tokens on Pons V2 directly from X.",
  alternates: { canonical: "/how-it-works" },
};

const steps = [
  { number: "01", title: "Post to @Ponsbotfamily", body: "Mention Ponsbot in a new X post or reply. Say whether you want to view your wallet, check a balance, trade, transfer assets, or launch on Pons V2." },
  { number: "02", title: "Include the essentials", body: "Trades need an amount and asset. Transfers also need a destination. Launches need a token name and ticker. Add optional details in the same post." },
  { number: "03", title: "Review the reply", body: "Ponsbot replies with the result and useful links. If an essential detail is missing or unclear, it will explain what is needed before anything can continue." },
  { number: "04", title: "Return whenever you want", body: "Your wallet stays connected to your X account. Ask for it again to revisit its address, holdings, and tokens launched through Ponsbot." },
];

const commands = [
  {
    title: "Claim or view your wallet",
    body: "Ask for your wallet to claim your Robinhood Chain wallet or retrieve the same address later. The reply links to your public Ponsbot wallet page, where you can view the address and holdings. Use that address when you want to deposit ETH or supported assets.",
    tips: ["No wallet address is required in your post.", "Your wallet remains associated with your X account.", "Never post a private key or recovery secret."],
    example: "@Ponsbotfamily what's my wallet?",
  },
  {
    title: "Check holdings",
    body: "Ask for your complete portfolio or name one asset to check a specific balance. You can identify a token by ticker or contract address. Ponsbot returns a link to your wallet page so you can review the latest available holdings.",
    tips: ["Ask for holdings to see the full wallet.", "Name ETH, $PONSBOT, or a token contract for one balance.", "A leading $ on the ticker is optional."],
    example: "@Ponsbotfamily how much $PONSBOT do I have?",
  },
  {
    title: "Buy",
    body: "Include the asset you want and how much to spend. Buy amounts can be written in USD, ETH, or an exact amount of the token's paired asset. When a USD or ETH buy needs another paired asset, Ponsbot swaps into that asset first, waits for confirmation, and completes the token purchase from the same post. You receive one final reply.",
    tips: ["Use $25, 0.02 ETH, or a paired amount such as 5 MSFT.", "For an asset-paired buy, Ponsbot automatically handles the intermediate swap.", "For a combined action, write: buy $100 of $PONSBOT and send it to @user."],
    example: "@Ponsbotfamily buy $25 of $PONSBOT",
  },
  {
    title: "Sell",
    body: "Name the token and specify an exact token amount, a percentage, half, or all. Ponsbot checks that the request identifies one asset and contains a valid amount before preparing the sale.",
    tips: ["Use an amount such as 10 $PONSBOT.", "Percentages, half, and all are supported.", "The token can also be identified by its contract address."],
    example: "@Ponsbotfamily sell half my $PONSBOT",
  },
  {
    title: "Send",
    body: "Send ETH or a supported token to another X user or directly to a wallet address. Include the amount, asset, and one destination. If you ask to buy and send in the same post, Ponsbot completes and confirms the buy first, then sends only the newly purchased tokens to that recipient.",
    tips: ["Use an @username or a complete 0x wallet address.", "Exact amounts, percentages, half, and all are supported for regular sends.", "Combined buy and send supports one purchase, one token, and one recipient."],
    example: "@Ponsbotfamily send 10 $PONSBOT to @friend",
  },
  {
    title: "Burn",
    body: "Burning permanently removes tokens from your wallet. Include the token and an exact amount, percentage, half, or all. Ponsbot requires explicit burn wording and complete details so a trade or transfer is never mistaken for a burn.",
    tips: ["Burns are permanent and cannot be recovered.", "Identify the asset with $PONSBOT or its contract address.", "Review the amount carefully before continuing."],
    example: "@Ponsbotfamily burn 10 $PONSBOT",
  },
  {
    title: "Claim creator fees",
    body: "Pons V2 creator fees are credited in each launch's paired asset. Claim available ETH-pair fees directly, or name a launch to claim its paired-asset fees. Ponsbot confirms the amount from the onchain claim event before replying.",
    tips: ["Say claim my fees for available ETH-pair fees.", "Name a launch such as $PONSBOT for its paired-asset fees.", "Fees held in different paired assets must be claimed individually."],
    example: "@Ponsbotfamily claim my fees for $PONSBOT",
  },
  {
    title: "Launch on Pons V2",
    body: "Launches are available to verified X accounts. Start with a token name and ticker. You can also include artwork, a description, website, X account, Telegram link, an available pairing asset, and an optional developer buy. For a linked-asset launch, Ponsbot can swap a USD or ETH dev-buy amount into the selected asset before launching, sequentially from one post with one final reply.",
    tips: ["Your X account must be verified to launch.", "Attach artwork to the same X post when you want custom token art.", "For a linked-asset pair, use a USD or ETH amount such as dev buy $100, or an exact asset amount such as dev buy 2 MSFT."],
    example: "@Ponsbotfamily launch Ponsbot ticker $PONSBOT, website ponsbot.family, pair with MSFT",
  },
  {
    title: "Check pairing assets",
    body: "Pons V2 determines which assets are currently available as launch pairs. Ask Ponsbot for the list before composing your launch, then include one supported asset in the launch post.",
    tips: ["Available pairing assets: NVDA, SPCX, GOOGL, TSLA, GME, AAPL, SPY, SNDK, AMD, AMZN, MSFT, META, CRCL, COIN, MU, PLTR, USDG, and ETH.", "The available list can change, so ask again before launching.", "Only include one pairing asset in a launch request."],
    example: "@Ponsbotfamily what assets can I pair with?",
  },
];

export default function HowItWorks() {
  return <main><SiteHeader /><section className="how-page">
    <div className="section-heading"><p className="eyebrow">How it works</p><h1>One X post.<br />A world of possibilities.</h1><p className="page-lede">Ponsbot gives you a Robinhood Chain wallet and a simple way to use it from X. Claim a wallet, check holdings, trade, send assets, burn tokens, or launch on Pons V2.</p></div>
    <div className="steps">{steps.map((step) => <article key={step.number}><span>{step.number}</span><h3>{step.title}</h3><p>{step.body}</p></article>)}</div>
    <section className="command-section"><p className="eyebrow">What you can do</p><h2>Everything you need, one post at a time.</h2><div className="command-grid">{commands.map((command) => <article key={command.title}><h3>{command.title}</h3><p>{command.body}</p><ul>{command.tips.map((tip) => <li key={tip}>{tip}</li>)}</ul><code>{command.example}</code></article>)}</div></section>
    <section className="launch-guide"><div><p className="eyebrow">Launch on Pons V2</p><h2>Start simple. Add the details that make it yours.</h2></div><div className="launch-detail-list"><p><strong>Account eligibility</strong><span>Your X account must be verified to launch through Ponsbot.</span></p><p><strong>Required details</strong><span>Choose a token name and ticker, such as Ponsbot and $PONSBOT.</span></p><p><strong>Make it recognizable</strong><span>Attach artwork and include a concise description in the launch post.</span></p><p><strong>Connect your community</strong><span>Add the token website, X account, and optional Telegram link so people can find the official channels.</span></p><p><strong>Choose the market</strong><span>Select a supported pair such as MSFT. A USD or ETH dev buy is automatically swapped into MSFT first; you can also write “dev buy 2 MSFT” to spend an exact asset amount.</span></p></div></section>
    <div className="example-panel"><p className="eyebrow">Example posts</p><div><span>“What&apos;s my wallet?”</span><span>“How much $PONSBOT do I have?”</span><span>“Buy $25 of $PONSBOT”</span><span>“Buy $100 of $PONSBOT and send it to @friend”</span><span>“Sell half my $PONSBOT”</span><span>“Send 10 $PONSBOT to @friend”</span><span>“Burn 10 $PONSBOT”</span><span>“Launch Ponsbot ticker $PONSBOT, website ponsbot.family, pair with MSFT”</span></div></div>
  </section><SiteFooter /></main>;
}
