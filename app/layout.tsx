import type { Metadata } from "next";
import "./globals.css";

// Keep the first server-rendered paint stable even if the generated stylesheet
// is briefly delayed. These rules intentionally duplicate only structural
// styles; globals.css remains the source of truth for the finished design.
const criticalCss = `
:root{--paper:#f5f3eb;--card:#fffdf7;--ink:#171813;--muted:#6e7167;--line:#dcded2;--lime:#c9ff4a;--green:#1c5d3d;--soft:#e8edda;color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html{background:#f5f3eb}
body{margin:0;background:#f5f3eb;color:#171813;font-family:Arial,Helvetica,sans-serif}
a{color:inherit;text-decoration:none}
img,svg{display:block;max-width:100%}
button,input,select{font:inherit}
.site-header{height:76px;padding:0 clamp(20px,5vw,72px);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dcded2;position:relative;z-index:5}
.header-brand,.wordmark,.site-header nav{display:flex;align-items:center}
.header-brand,.wordmark{gap:10px}.wordmark{font-size:18px;font-weight:800;letter-spacing:-.04em}
.brand-logo{width:42px;height:42px;border-radius:50%;object-fit:cover;background:#c9ff4a}
.site-header nav{gap:28px;font-size:13px;color:#6e7167}
.header-ca{position:absolute;left:50%;transform:translateX(-50%);color:#6e7167;font:600 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap}
.header-ca-mobile,.mobile-nav{display:none}
.header-wallet-button{display:inline-flex;padding:9px 13px;border-radius:9px;background:#171813;color:#fff!important;font-size:12px;font-weight:750;white-space:nowrap}
.home-hero{min-height:0;padding:40px clamp(20px,5vw,72px) 20px;display:grid;grid-template-columns:1.03fr .97fr;gap:5vw;align-items:center;overflow:hidden}
.home-hero h1{max-width:780px;margin:0 0 24px;font-size:clamp(54px,7vw,106px);line-height:.9;letter-spacing:-.072em}
.hero-lede{max-width:670px;color:#6e7167;font-size:clamp(18px,1.6vw,23px);line-height:1.48}
.hero-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:32px}
.button{display:inline-flex;align-items:center;justify-content:center;padding:14px 19px;border-radius:11px;font-weight:750;font-size:14px}
.button-primary{background:#c9ff4a}.button-quiet{border:1px solid #dcded2;background:#ffffff70}.button-dark{background:#171813;color:#fff}
.hero-visual{min-height:570px;position:relative;display:grid;place-items:center}.hero-visual>img{position:relative;width:min(590px,96%);height:auto}
.hero-blob{position:absolute;width:82%;aspect-ratio:1;border-radius:44% 56% 63% 37%/43% 42% 58% 57%;background:#c9ff4a;transform:rotate(-8deg)}
.message-stack{position:absolute;inset:0;z-index:2;pointer-events:none}.message-bubble{position:absolute;width:min(300px,72%);padding:14px 16px;border:1px solid #d7dacd;border-radius:16px;background:#fffef8e8;font-size:13px;font-weight:700;line-height:1.4}
.bubble-launch{left:-2%;top:55%}.bubble-buy{right:-1%;top:13%}.bubble-send{right:0;top:70%}.bubble-pair{left:8%;top:4%}
.launch-section,.detail-shell,.how-page,.terminal-shell{padding-left:clamp(20px,5vw,72px);padding-right:clamp(20px,5vw,72px)}
.launch-section{padding-top:28px;padding-bottom:110px}.section-heading h2{margin:15px 0 0;font-size:clamp(46px,5.5vw,82px);line-height:.94;letter-spacing:-.06em}
.eyebrow{margin:0;color:#1c5d3d;font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
.launch-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-top:18px}.launch-card{min-width:0;padding:8px;border:1px solid #dcded2;border-radius:14px;background:#fffdf7}.token-art{position:relative;display:grid;place-items:center;aspect-ratio:1;overflow:hidden;border-radius:9px;background:#e8edda}.token-art img{width:100%;height:100%;object-fit:cover}
.site-footer{padding:55px clamp(20px,5vw,72px);display:grid;grid-template-columns:2fr 1fr 1.3fr;gap:50px;background:#171813;color:#f7f7ef}
.detail-shell{min-height:calc(100vh - 76px);padding-top:64px;padding-bottom:100px}.detail-art{position:relative;aspect-ratio:1;overflow:hidden;background:#e8edda}.detail-art img{width:100%;height:100%;object-fit:cover}
.facts,.direct-panel,.terminal-console,.terminal-holdings,.terminal-actions,.activity-table-wrap{border:1px solid #dcded2;background:#fffdf7}
@media(max-width:1200px){.launch-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(max-width:900px){.home-hero{grid-template-columns:1fr;padding-top:56px}.launch-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.header-ca{font-size:9px}.header-ca-desktop{display:none}.header-ca-mobile{display:inline}.site-footer{grid-template-columns:1.5fr 1fr}}
@media(max-width:600px){.site-header{height:66px;padding-inline:16px}.site-header nav{display:none}.mobile-nav{display:flex;align-items:center;gap:6px;margin-left:auto}.wordmark span:last-child{display:none}.brand-logo{width:38px;height:38px}.home-hero{padding-top:45px;padding-bottom:4px;min-height:auto}.home-hero h1{font-size:52px}.hero-visual{min-height:480px}.message-bubble{width:230px;padding:11px 13px;font-size:11px}.bubble-pair{top:2%;left:0}.bubble-buy{top:22%;right:0}.bubble-launch{top:63%;left:0}.bubble-send{top:82%;right:0}.launch-section{padding-top:24px;padding-bottom:76px}.launch-grid{grid-template-columns:1fr}.launch-card{max-width:420px;width:100%;margin-inline:auto}.site-footer{grid-template-columns:1fr}.detail-shell{padding-top:40px}}
`;

const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://ponsbot-one.vercel.app";
const siteUrl = configuredSiteUrl.startsWith("http") ? configuredSiteUrl : `https://${configuredSiteUrl}`;
const description = "Use a Robinhood Chain wallet to check holdings, buy, sell, swap, send, burn, claim creator fees, and launch tokens on Pons V2 with Pons Bot.";

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
  return <html lang="en"><head><style id="ponsbot-critical-css">{criticalCss}</style></head><body>{children}</body></html>;
}
