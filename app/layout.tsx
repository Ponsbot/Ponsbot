import type { Metadata } from "next";
import "./globals.css";

const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://ponsbot-git-main-clawhammer.vercel.app";
const siteUrl = configuredSiteUrl.startsWith("http") ? configuredSiteUrl : `https://${configuredSiteUrl}`;
const description = "Claim a Robinhood Chain wallet, check holdings, buy, sell, send assets, and launch tokens on Pons V2 directly from X with Ponsbot.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "Ponsbot — Pons V2 launches direct on X", template: "%s · Ponsbot" },
  description,
  applicationName: "Ponsbot",
  authors: [{ name: "Ponsbot", url: "https://x.com/Ponsbotfamily" }],
  creator: "Ponsbot",
  publisher: "Ponsbot",
  category: "finance",
  keywords: ["Ponsbot", "Pons V2", "Robinhood Chain", "token launch", "crypto wallet", "X bot"],
  alternates: { canonical: "/" },
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png" }, { url: "/faviconlarge.png", type: "image/png" }],
    apple: "/ponsbot.png",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/",
    siteName: "Ponsbot",
    title: "Ponsbot — Pons V2 launches direct on X",
    description,
    images: [{ url: "/ponsbot-banner.png", width: 2172, height: 724, alt: "Ponsbot — wallet, trading, and Pons V2 launches on X" }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@Ponsbotfamily",
    creator: "@Ponsbotfamily",
    title: "Ponsbot — Pons V2 launches direct on X",
    description,
    images: [{ url: "/ponsbot-banner.png", alt: "Ponsbot — wallet, trading, and Pons V2 launches on X" }],
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
