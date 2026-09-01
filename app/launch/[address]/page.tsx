import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyAddress } from "@/components/CopyAddress";
import { DataLoadingPanel } from "@/components/DataLoadingPanel";
import { LaunchTime } from "@/components/LaunchTime";
import { SocialIconLink } from "@/components/LaunchCard";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { TokenActivity } from "@/components/TokenActivity";
import { TokenMarketCap, TokenGraduationBadge } from "@/components/TokenMarketSnapshot";
import { tokenImageUrl } from "@/lib/token-image";
import { getLaunch } from "@/lib/site-data";

type Props = { params: Promise<{ address: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const address = (await params).address;
  const launch = await getLaunch(address).catch(() => null);
  if (!launch) return { title: "Launch", description: "This token is not a Pons Bot launch." };
  const title = `${launch.name} ($${launch.symbol})`; const description = launch.description || "";
  return { title, description, alternates: { canonical: `/launch/${address}` }, openGraph: { title, description, url: `/launch/${address}`, type: "website", images: [{ url: "/ponsbot-banner.png", width: 2172, height: 724, alt: "Pons Bot - wallet, trading, and Pons V2 launches on X" }] }, twitter: { card: "summary_large_image", title, description, images: ["/ponsbot-banner.png"] } };
}

export default async function LaunchPage({ params }: Props) {
  const address = (await params).address;
  let launch: Awaited<ReturnType<typeof getLaunch>>;
  try {
    launch = await getLaunch(address);
  } catch {
    return <main><SiteHeader /><section className="detail-shell"><DataLoadingPanel title="Token details are loading" /></section><SiteFooter /></main>;
  }
  if (!launch?.tokenAddress) notFound();
  const username = launch.launcherUsername?.replace(/^@/, "");
  const artwork = <div className="detail-art">{launch.imageUri ? <Image unoptimized src={tokenImageUrl(launch.imageUri)} alt={`${launch.name} token`} width={520} height={520} sizes="(max-width: 900px) 42vw, 240px" priority /> : <Image className="detail-art-placeholder" src="/ponsbot.png" alt="Pons Bot placeholder" width={520} height={520} sizes="(max-width: 900px) 42vw, 240px" priority />}<TokenGraduationBadge /><TokenMarketCap badge /></div>;
  const summary = <div className="detail-copy"><h1>{launch.name}</h1><p className="ticker">${launch.symbol}</p><div className="token-summary-address"><CopyAddress address={launch.tokenAddress} /></div><p className="description">{launch.description || "\u00a0"}</p>
    <div className="detail-link-row"><div className="detail-socials">{launch.website ? <SocialIconLink href={launch.website} label="Website" icon="web" /> : null}{launch.twitter ? <SocialIconLink href={launch.twitter} label="X" icon="x" /> : null}{launch.telegram ? <SocialIconLink href={launch.telegram} label="Telegram" icon="telegram" /> : null}</div>
    <div className="detail-actions"><Link className="button button-primary" href={`/terminal?action=buy&token=${launch.tokenAddress}`}>Buy</Link><Link className="button button-quiet" href={`/terminal?action=sell&token=${launch.tokenAddress}`}>Sell</Link><a className="button button-dark" href={`https://www.ponsfamily.com/launchpad/${launch.tokenAddress}`} target="_blank" rel="noreferrer">View Token on Pons ↗</a></div></div></div>;
  const feeRecipientUsername = launch.feeRecipientUsername?.replace(/^@/, "");
  const details = <>
    <div className="facts">
      <div className="fact fact-launched"><span>Launched</span><strong><LaunchTime createdAt={launch.createdAt} /></strong></div>
      <div className="fact fact-launcher"><span>Launched by</span><strong>{username ? <a href={`https://x.com/${username}`} target="_blank" rel="noreferrer">@{username}</a> : "Pons Bot"}</strong></div>
      <div className="fact fact-market"><span>Market cap</span><TokenMarketCap /></div>
      <div className="fact fact-pair"><span>Pairing</span><strong>{launch.pairSymbol ? `Paired with $${launch.pairSymbol}` : "\u00a0"}</strong></div>
      <div className="fact fact-fee-recipient"><span>CREATOR FEES ASSIGNED TO</span><strong>{launch.holderFeeSharing ? "Holders" : feeRecipientUsername ? <a href={`https://x.com/${feeRecipientUsername}`} target="_blank" rel="noreferrer">@{feeRecipientUsername}</a> : launch.creatorFeeRecipient ? <CopyAddress address={launch.creatorFeeRecipient} displayAddress={shortAddress(launch.creatorFeeRecipient)} /> : "—"}</strong></div>
      <div className="fact fact-launch-post"><span>Launch Post</span><strong>{launch.launchPostUrl ? <a href={launch.launchPostUrl} target="_blank" rel="noreferrer">View Post ↗</a> : "—"}</strong></div>
    </div>
    {launch.automatedFeeBuybackEnabled ? <p className="token-fee-buyback-strip">5% of creator fees from this token buyback and burn $PONSBOT</p> : null}
  </>;
  return <main><SiteHeader /><section className="detail-shell"><TokenActivity key={launch.tokenAddress} tokenAddress={launch.tokenAddress} poolAddress={launch.poolAddress} symbol={launch.symbol} currentMarketCapUsd={launch.marketCapUsd} currentMarketCapUpdatedAt={launch.marketCapUpdatedAt} volume24hUsd={launch.volume24hUsd} graduated={launch.graduated} artwork={artwork} summary={summary} details={details} /></section><SiteFooter /></main>;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
