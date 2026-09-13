import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { BotYard } from "@/components/BotYard";
import { botYardPreviewAllowed, tradingAgentCapabilities } from "@/lib/trading-agents/config";
import { LiveBotYard } from "@/components/LiveBotYard";
import { botYardPreviewBots } from "@/lib/trading-agents/yard-preview";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bot Yard", robots: { index: false, follow: false } };
export default function BotYardPage() {
  if (tradingAgentCapabilities().website) return <main><SiteHeader /><LiveBotYard /><SiteFooter /></main>;
  if (!botYardPreviewAllowed()) notFound();
  return <main><SiteHeader /><BotYard bots={botYardPreviewBots()} preview /><SiteFooter /></main>;
}
