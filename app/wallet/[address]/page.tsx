import type { Metadata } from "next";
import { isAddress } from "viem";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { explorerAddress, explorerToken, getWalletHoldings, isPonsbotWallet, shortAddress } from "@/lib/site-data";

type Props = { params: Promise<{ address: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const address = (await params).address;
  const valid = isAddress(address);
  const title = valid ? `${shortAddress(address)} wallet` : "Wallet";
  const description = valid
    ? `View the public Robinhood Chain holdings for the Ponsbot wallet ${shortAddress(address)}.`
    : "This is not a valid Ponsbot wallet.";
  return {
    title,
    description,
    ...(valid ? {
      alternates: { canonical: `/wallet/${address}` },
      openGraph: { title, description, url: `/wallet/${address}`, type: "website" as const, images: [{ url: "/ponsbot-banner.png", width: 2172, height: 724, alt: "Ponsbot — wallet, trading, and Pons V2 launches on X" }] },
      twitter: { card: "summary_large_image" as const, title, description, images: ["/ponsbot-banner.png"] },
    } : {}),
  };
}

export default async function WalletPage({ params }: Props) {
  const address = (await params).address;
  if (!isAddress(address) || !(await isPonsbotWallet(address))) notFound();
  const { holdings, available } = await getWalletHoldings(address);
  return <main><SiteHeader /><section className="detail-shell"><div className="wallet-heading"><div><p className="eyebrow">Robinhood Chain wallet</p><h1>Your holdings</h1></div><a className="button button-quiet" href={explorerAddress(address)} target="_blank" rel="noreferrer">View on explorer ↗</a></div><p className="wallet-address">{address}</p><div className="holdings">{holdings.map((holding) => <a className="holding" key={`${holding.address || "eth"}-${holding.symbol}`} href={holding.address ? explorerToken(holding.address) : explorerAddress(address)} target="_blank" rel="noreferrer"><span className="holding-icon">{holding.iconUrl ? <img src={holding.iconUrl} alt="" /> : holding.symbol.slice(0, 1)}</span><span><h3>{holding.name}</h3><p>{holding.symbol}{holding.address ? ` · ${shortAddress(holding.address)}` : ""}</p></span><strong className="holding-balance">{holding.balance} {holding.symbol}</strong></a>)}</div>{!holdings.length ? <div className="subtle-panel"><h3>{available ? "No holdings yet" : "Holdings are taking a moment to load"}</h3><p>{available ? "Send Robinhood Chain ETH or supported tokens to this wallet and they will appear here." : "Open the explorer for the latest public wallet activity."}</p></div> : null}</section><SiteFooter /></main>;
}
