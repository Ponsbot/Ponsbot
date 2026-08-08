import Link from "next/link";
import type { PublicLaunch } from "@/lib/site-data";
import { shortAddress } from "@/lib/site-data";

export function LaunchCard({ launch }: { launch: PublicLaunch }) {
  if (!launch.tokenAddress) return null;
  return <Link className="launch-card" href={`/launch/${launch.tokenAddress}`}>
    <div className="token-art">
      {launch.imageUri ? <img src={launch.imageUri} alt="" /> : <span>{launch.symbol.slice(0, 1)}</span>}
    </div>
    <div className="launch-card-copy"><h3>{launch.name}</h3><p>${launch.symbol}</p></div>
    <div className="launch-card-meta"><span>Launched on Pons</span><span>{shortAddress(launch.tokenAddress)}</span></div>
  </Link>;
}
