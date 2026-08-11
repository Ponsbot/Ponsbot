import Image from "next/image";
import Link from "next/link";
import type { PublicLaunch } from "@/lib/site-data";
import { shortAddress } from "@/lib/site-data";

export function LaunchCard({ launch }: { launch: PublicLaunch }) {
  if (!launch.tokenAddress) return null;
  return <Link className="launch-card" href={`/launch/${launch.tokenAddress}`}>
    <div className="token-art">
      {launch.imageUri ? <Image src={launch.imageUri} alt={`${launch.name} token`} width={700} height={700} sizes="(max-width: 600px) 100vw, (max-width: 900px) 50vw, 33vw" /> : <span>{launch.symbol.slice(0, 1)}</span>}
    </div>
    <div className="launch-card-copy"><h3>{launch.name}</h3><p>${launch.symbol}</p>{launch.marketCapUsd !== undefined ? <strong className="launch-card-mcap">MCap {formatMarketCap(launch.marketCapUsd)}</strong> : null}</div>
    <div className="launch-card-meta"><span>Launched on Pons</span><span>{shortAddress(launch.tokenAddress)}</span></div>
  </Link>;
}

function formatMarketCap(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value);
}
