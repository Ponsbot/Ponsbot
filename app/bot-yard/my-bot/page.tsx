import { notFound } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/SiteChrome";
import { MyBots } from "@/components/MyBots";
import { tradingAgentCapabilities } from "@/lib/trading-agents/config";
export const dynamic = "force-dynamic";
export const metadata = { title: "My Bot", robots: { index: false, follow: false } };
export default function MyBotPage() {
  if (!tradingAgentCapabilities().website) notFound();
  return <main><SiteHeader /><MyBots /><SiteFooter /></main>;
}
