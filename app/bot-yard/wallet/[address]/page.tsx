import { notFound } from "next/navigation";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { tradingAgentCapabilities } from "@/lib/trading-agents/config";
import type { BotYardBot } from "@/lib/trading-agents/yard-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bot wallet", robots: { index: false, follow: false } };
export default async function BotWalletPage({ params }: { params: Promise<{ address: string }> }) {
  if (!tradingAgentCapabilities().website) notFound();
  const { address } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !process.env.NEXT_PUBLIC_CONVEX_URL) notFound();
  const page = await new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL).query(makeFunctionReference<"query", { walletAddress: string }, { bots: BotYardBot[] }>("tradingAgents:publicYard"), { walletAddress: address });
  const bot = page.bots[0]; if (!bot) notFound();
  return <main><SiteHeader /><section className="content-section"><h1>{bot.name} wallet</h1>
    <p style={{ overflowWrap: "anywhere" }}>{address}</p>
    <p>{bot.mode === "live" ? "This bot uses its dedicated wallet for live trades. View confirmed activity below or on the explorer." : "This bot is in paper mode. Its simulated trades are not blockchain transactions."}</p>
    <p><a href={`https://robinhoodchain.blockscout.com/address/${address}?tab=txs`} target="_blank" rel="noreferrer">View wallet balances and transaction history ↗</a></p>
    <p><a href="/bot-yard">Back to the Bot Yard</a></p>
    <h2>Recent bot activity</h2><ol>{bot.logs.map(log => <li key={log.id}><p>{log.summary}</p><time>{new Date(log.at).toISOString()}</time></li>)}</ol>
  </section><SiteFooter /></main>;
}
