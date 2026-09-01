import Image from "next/image";
import Link from "next/link";
import type { PublicLaunch } from "@/lib/site-data";
import { CopyAddress } from "@/components/CopyAddress";
import { LaunchTime } from "@/components/LaunchTime";
import { tokenImageUrl } from "@/lib/token-image";

export function LaunchCard({ launch }: { launch: PublicLaunch }) {
  if (!launch.tokenAddress) return null;
  const username = launch.launcherUsername?.replace(/^@/, "");
  return <article className="launch-card">
    <Link className="token-art" href={`/launch/${launch.tokenAddress}`}>{launch.imageUri ? <Image unoptimized src={tokenImageUrl(launch.imageUri)} alt={`${launch.name} token`} width={700} height={700} sizes="(max-width: 600px) 100vw, (max-width: 900px) 50vw, 25vw" /> : <Image className="token-art-placeholder" src="/ponsbot.png" alt="Pons Bot placeholder" width={700} height={700} sizes="(max-width: 600px) 100vw, (max-width: 900px) 50vw, 25vw" />}{launch.graduated ? <strong className="graduated-badge">Graduated</strong> : null}{launch.marketCapUsd !== undefined ? <strong className="launch-card-mcap">MCap {formatMarketCap(launch.marketCapUsd)}</strong> : null}</Link>
    <div className="launch-card-copy"><Link href={`/launch/${launch.tokenAddress}`}><h3>{launch.name}</h3><p>${launch.symbol}</p></Link></div>
    <div className="launch-card-socials">{launch.website ? <SocialIconLink href={launch.website} label="Website" icon="web" /> : null}{launch.twitter ? <SocialIconLink href={launch.twitter} label="X" icon="x" /> : null}{launch.telegram ? <SocialIconLink href={launch.telegram} label="Telegram" icon="telegram" /> : null}</div>
    {launch.pairSymbol ? <p className="launch-card-pair">{launch.pairSymbol !== "ETH" ? `Paired with $${launch.pairSymbol}` : "\u00a0"}</p> : null}
    <div className="launch-card-footer">
      <p className="launch-card-volume">24h Volume <strong>{launch.volume24hUsd === undefined ? "—" : formatMarketCap(launch.volume24hUsd)}</strong></p>
      <CopyAddress address={launch.tokenAddress} compact />
      <div className="launch-card-meta"><span>{username ? <>Deployed by <a href={`https://x.com/${username}`} target="_blank" rel="noreferrer">@{username}</a></> : "Deployed with Pons Bot"}</span><LaunchTime createdAt={launch.createdAt} relative /></div>
    </div>
  </article>;
}

export function SocialIconLink({ href, label, icon }: { href: string; label: string; icon: "web" | "x" | "telegram" }) {
  return <a href={href} target="_blank" rel="noreferrer" aria-label={label} title={label}>{icon === "x" ? <Image className="social-x-logo" src="/x-logo.png" alt="" width={13} height={13} /> : <svg viewBox="0 0 24 24" aria-hidden="true">{icon === "web" ? <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></> : <><path d="M21 4L3 11l7 3 3 7 8-17Z"/><path d="M10 14l11-10"/></>}</svg>}</a>;
}
function formatMarketCap(value: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value); }
