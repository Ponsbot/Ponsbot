import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { explorerAddress, explorerToken, getLaunch, shortAddress } from "@/lib/site-data";

type Props = { params: Promise<{ address: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> { const launch = await getLaunch((await params).address); return { title: launch ? `${launch.name} ($${launch.symbol})` : "Launch" }; }

export default async function LaunchPage({ params }: Props) {
  const launch = await getLaunch((await params).address);
  if (!launch?.tokenAddress) notFound();
  return <main><SiteHeader /><section className="detail-shell"><Link className="back-link" href="/#launches">← All launches</Link><div className="detail-grid"><div className="detail-art">{launch.imageUri ? <img src={launch.imageUri} alt={`${launch.name} token`} /> : <span>{launch.symbol.slice(0, 1)}</span>}</div><div className="detail-copy"><p className="eyebrow">Launched on Pons V2</p><h1>{launch.name}</h1><p className="ticker">${launch.symbol}</p><p className="description">{launch.description || `${launch.name} was launched through Ponsbot on Pons V2.`}</p><div className="facts"><div className="fact"><span>Token</span><strong>{shortAddress(launch.tokenAddress)}</strong></div><div className="fact"><span>Launched</span><strong>{new Date(launch.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</strong></div>{launch.creatorAddress ? <div className="fact"><span>Creator wallet</span><strong>{shortAddress(launch.creatorAddress)}</strong></div> : null}<div className="fact"><span>Network</span><strong>Robinhood Chain</strong></div></div><div className="detail-actions"><a className="button button-dark" href={`https://ponsfamily.com/token/${launch.tokenAddress}`} target="_blank" rel="noreferrer">View on Pons ↗</a><a className="button button-quiet" href={explorerToken(launch.tokenAddress)} target="_blank" rel="noreferrer">View token ↗</a>{launch.creatorAddress ? <Link className="button button-quiet" href={`/wallet/${launch.creatorAddress}`}>Creator wallet</Link> : null}{launch.website ? <a className="button button-quiet" href={launch.website} target="_blank" rel="noreferrer">Website ↗</a> : null}</div></div></div></section><SiteFooter /></main>;
}
