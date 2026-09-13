import { notFound } from "next/navigation";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { tradingAgentCapabilities } from "@/lib/trading-agents/config";
import type { BotYardBot } from "@/lib/trading-agents/yard-view";
import { botAmount, botAsset, botBuyLabel } from "@/lib/trading-agents/display";
import { CopyWalletAddress } from "@/components/CopyWalletAddress";
import { botSpriteDataUrl } from "@/lib/trading-agents/sprite";
import styles from "./wallet.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bot wallet", robots: { index: false, follow: false } };
export default async function BotWalletPage({ params }: { params: Promise<{ address: string }> }) {
  if (!tradingAgentCapabilities().website) notFound();
  const { address } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !process.env.NEXT_PUBLIC_CONVEX_URL) notFound();
  const page = await new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL).query(makeFunctionReference<"query", { walletAddress: string }, { bots: BotYardBot[] }>("tradingAgents:publicYard"), { walletAddress: address });
  const bot = page.bots[0]; if (!bot) notFound();
  const holdings = bot.liveHoldings;
  const time = (at: number) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(at) + " UTC";
  const creator = bot.creatorUsername && /^[A-Za-z0-9_]{1,15}$/.test(bot.creatorUsername) ? bot.creatorUsername : undefined;
  return <main><SiteHeader /><section className={styles.page}>
    <a className={styles.back} href="/bot-yard">← Back to Bot Yard</a>
    <header className={styles.header}>
      <div className={styles.identity}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={botSpriteDataUrl(bot.sprite)} width={60} height={72} alt="" />
        <div><span className={styles.eyebrow}>Bot wallet · Robinhood Chain</span><h1>{bot.name}</h1>
          {creator && <p>Created by <a href={`https://x.com/${creator}`} target="_blank" rel="noreferrer">@{creator}</a></p>}</div>
      </div>
      <a className={styles.action} href={`https://robinhoodchain.blockscout.com/address/${address}?tab=txs`} target="_blank" rel="noreferrer">View on Blockscout ↗</a>
    </header>
    <div className={styles.address}><span className={styles.eyebrow}>Wallet address</span><CopyWalletAddress address={address} /></div>
    <div className={styles.stats}>
      <article><span>ETH balance</span><strong>{holdings ? `${botAmount(holdings.cashWei)} ETH` : "Not checked yet"}</strong></article>
      <article><span>Token holdings</span>{holdings?.complete ? holdings.tokens.length ? holdings.tokens.map(token => <p key={token.token}>{botAsset(token)}</p>) : <strong>No tokens held</strong> : <strong>Not confirmed</strong>}</article>
      <article><span>Bot status</span><strong>{bot.status === "running" ? "Active" : bot.status === "paused" ? "Paused" : "Getting ready"}</strong></article>
    </div>
    <p className={styles.caption}>{holdings ? `Balances last checked ${time(holdings.observedAt)}.` : "Balances will appear after the first wallet check."} View the explorer for current balances and full transaction history.</p>
    <section className={styles.activity}><header><h2>Recent activity</h2><span>{bot.logs.length} entries</span></header>
      {bot.logs.length ? <ol>{bot.logs.map(log => <li key={log.id}>
        <div className={styles.meta}><span className={styles.badge}>{log.kind === "thought" ? "Thought" : log.outcome === "live_filled" ? "Trade completed" : log.outcome === "executing" ? "Processing" : log.outcome === "failed" ? "Trade incomplete" : "Holding"}</span><time dateTime={new Date(log.at).toISOString()}>{time(log.at)}</time></div>
        {botBuyLabel(log) && <p><strong>{botBuyLabel(log)}</strong></p>}
        <p>{log.summary}</p>
        {!!log.transactionHashes?.length && <div className={styles.transactions}>{log.transactionHashes.filter(hash => /^0x[0-9a-fA-F]{64}$/.test(hash)).map((hash, i) => <a key={hash} href={`https://robinhoodchain.blockscout.com/tx/${hash}`} target="_blank" rel="noreferrer">Transaction {i + 1} ↗</a>)}</div>}
      </li>)}</ol> : <p className={styles.empty}>No activity yet. Your bot’s thoughts and trading activity will appear here.</p>}
    </section>
  </section><SiteFooter /></main>;
}
