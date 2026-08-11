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
  if (!launch) return { title: "Launch", description: "This token is not a Ponsbot launch." };
  const title = `${launch.name} ($${launch.symbol})`; const description = launch.description || "";
  return { title, description, alternates: { canonical: `/launch/${address}` }, openGraph: { title, description, url: `/launch/${address}`, type: "website", images: [{ url: "/ponsbot-banner.png", width: 2172, height: 724, alt: "Ponsbot - wallet, trading, and Pons V2 launches on X" }] }, twitter: { card: "summary_large_image", title, description, images: ["/ponsbot-banner.png"] } };
}

export default async function LaunchPage({ params }: Props) {
  const launch = await getLaunch((await params).address); if (!launch?.tokenAddress) notFound();
  const username = launch.launcherUsername?.replace(/^@/, "");
  return <main><SiteHeader /><section className="detail-shell"><Link className="back-link" href="/#launches">← All launches</Link><div className="detail-grid">
    <div className="detail-art">{launch.imageUri ? <Image src={launch.imageUri} alt={`${launch.name} token`} width={960} height={960} sizes="(max-width: 900px) 100vw, 480px" priority /> : <span>{launch.symbol.slice(0, 1)}</span>}</div>
    <div className="detail-copy"><h1>{launch.name}</h1><p className="ticker">${launch.symbol}</p><p className="description">{launch.description || "\u00a0"}</p>
      <div className="detail-socials">{launch.website ? <a className="button button-quiet" href={launch.website} target="_blank" rel="noreferrer">Website ↗</a> : null}{launch.twitter ? <a className="button button-quiet" href={launch.twitter} target="_blank" rel="noreferrer">X ↗</a> : null}{launch.telegram ? <a className="button button-quiet" href={launch.telegram} target="_blank" rel="noreferrer">Telegram ↗</a> : null}</div>
      <div className="facts"><div className="fact fact-contract"><span>Contract</span><strong><CopyAddress address={launch.tokenAddress} /></strong></div><div className="fact"><span>Launched</span><strong><LaunchTime createdAt={launch.createdAt} /></strong></div>{username ? <div className="fact"><span>Launched by</span><strong><a href={`https://x.com/${username}`} target="_blank" rel="noreferrer">@{username}</a></strong></div> : null}{launch.marketCapUsd !== undefined ? <div className="fact"><span>Market cap</span><strong>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(launch.marketCapUsd)}</strong></div> : null}</div>
      <div className="detail-actions"><a className="button button-dark" href={`https://www.ponsfamily.com/launchpad/${launch.tokenAddress}`} target="_blank" rel="noreferrer">View on Pons ↗</a><a className="button button-quiet" href={explorerToken(launch.tokenAddress)} target="_blank" rel="noreferrer">View token ↗</a>{launch.creatorAddress ? <Link className="button button-quiet" href={`/wallet/${launch.creatorAddress}`}>Creator wallet</Link> : null}</div>
    </div></div></section><SiteFooter /></main>;
}
