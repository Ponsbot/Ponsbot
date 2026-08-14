import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { TerminalClient } from "@/components/TerminalClient";

export const metadata: Metadata = {
  title: { absolute: "Pons Bot" },
  description: "Connect X to check balances, buy, sell, swap, send, burn, and claim creator fees from your Pons Bot wallet.",
  alternates: { canonical: "/terminal" },
};

export default function TerminalPage() {
  return <main><SiteHeader /><TerminalClient /><SiteFooter /></main>;
}
