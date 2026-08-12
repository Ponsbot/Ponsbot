import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyAddress } from "@/components/CopyAddress";
import { LaunchTime } from "@/components/LaunchTime";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { explorerToken, getLaunch } from "@/lib/site-data";

type Props = { params: Promise<{ address: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const address = (await params).address; const launch = await getLaunch(address);
  if (!launch) return { title: "Launch", description: "This token is not a Pons Bot launch." };
  const title = `${launch.name} ($${launch.symbol})`; const description = launch.description || "";
  return { title, description, alternates: { canonical: `/launch/${address}` }, openGraph: { title, description, url: `/launch/${address}`, type: "website", images: [{ url: "/ponsbot-banner.png", width: 2172, height: 724, alt: "Pons Bot - wallet, trading, and Pons V2 launches on X" }] }, twitter: { card: "summary_large_image", title, description, images: ["/ponsbot-banner.png"] } };
}

export default async function LaunchPage({ params }: Props) {
  const launch = await getLaunch((await params).address); if (!launch?.tokenAddress) notFound();
  const username = launch.launcherUsername?.replace(/^@/, "");
  return <main><SiteHeader /><section className="detail-shell"><Link className="back-link" href="/#launches">← All launches</Link><div className="detail-grid">
    <div className="detail-art">{launch.imageUri ? <Image src={launch.imageUri} alt={`${launch.name} token`} width={960} height={960} sizes="(max-width: 900px) 100vw, 480px" priority /> : <Image className="detail-art-placeholder" src="/ponsbot.png" alt="Pons Bot placeholder" width={960} height={960} sizes="(max-width: 900px) 100vw, 480px" priority />}</div>
    <div className="detail-copy"><h1>{launch.name}</h1><p className="ticker">${launch.symbol}</p><p className="description">{launch.description || "\u00a0"}</p>
      <div className="detail-socials">{launch.website ? <a className="button button-quiet" href={launch.website} target="_blank" rel="noreferrer">Website ↗</a> : null}{launch.twitter ? <a className="button button-quiet social-x-button" href={launch.twitter} target="_blank" rel="noreferrer" aria-label="X page"><Image src="/x.webp" alt="" width={14} height={14} /></a> : null}{launch.telegram ? <a className="button button-quiet" href={launch.telegram} target="_blank" rel="noreferrer">Telegram ↗</a> : null}</div>
      <div className="facts"><div className="fact fact-contract"><span>Contract</span><strong><CopyAddress address={launch.tokenAddress} /></strong></div><div className="fact fact-launched"><span>Launched</span><strong><LaunchTime createdAt={launch.createdAt} /></strong></div><div className="fact fact-launcher"><span>Launched by</span><strong>{username ? <a href={`https://x.com/${username}`} target="_blank" rel="noreferrer">@{username}</a> : "Pons Bot"}</strong></div><div className="fact fact-market"><span>Market cap</span><strong>{launch.marketCapUsd !== undefined ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(launch.marketCapUsd) : "—"}</strong></div><div className="fact fact-pair"><span>Pairing</span><strong>{launch.pairSymbol && launch.pairSymbol !== "ETH" ? `Paired with $${launch.pairSymbol}` : "\u00a0"}</strong></div></div>
      <div className="detail-actions"><a className="button button-dark" href={`https://www.ponsfamily.com/launchpad/${launch.tokenAddress}`} target="_blank" rel="noreferrer">View Token on Pons ↗</a><a className="button button-quiet" href={explorerToken(launch.tokenAddress)} target="_blank" rel="noreferrer">View Token on Blockscout ↗</a>{launch.creatorAddress ? <Link className="button button-quiet" href={`/wallet/${launch.creatorAddress}`}>Creator wallet</Link> : null}</div>
    </div></div></section><SiteFooter /></main>;
}
