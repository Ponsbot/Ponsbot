import type { Metadata } from "next";
import "./globals.css";

const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://ponsbot-one.vercel.app";
const siteUrl = configuredSiteUrl.startsWith("http") ? configuredSiteUrl : `https://${configuredSiteUrl}`;
const description = "Claim a Robinhood Chain wallet, check holdings, buy, sell, send assets, and launch tokens on Pons V2 directly from X with Pons Bot.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "Pons Bot - Pons V2 launches direct on X", template: "%s - Pons Bot" },
  description,
  applicationName: "Pons Bot",
  authors: [{ name: "Pons Bot", url: "https://x.com/Ponsbotfamily" }],
  creator: "Pons Bot",
  publisher: "Pons Bot",
  category: "finance",
  keywords: ["Pons Bot", "Pons V2", "Robinhood Chain", "token launch", "crypto wallet", "X bot"],
  alternates: { canonical: "/" },
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png" }, { url: "/faviconlarge.png", type: "image/png" }],
    apple: "/ponsbot.png",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/",
    siteName: "Pons Bot",
    title: "Pons Bot - Pons V2 launches direct on X",
    description,
    images: [{ url: "/ponsbot-banner.png", width: 2172, height: 724, alt: "Pons Bot - wallet, trading, and Pons V2 launches on X" }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@ponsbotfamily",
    creator: "@ponsbotfamily",
    title: "Pons Bot - Pons V2 launches direct on X",
    description,
    images: [{ url: "/ponsbot-banner.png", alt: "Pons Bot - wallet, trading, and Pons V2 launches on X" }],
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
